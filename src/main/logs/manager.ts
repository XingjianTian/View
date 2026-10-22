import { LogRingBuffer } from './buffer.js';
import { LogPoller } from './poller.js';
import type { LogDiagnosticOutcome, LogDiagnosticPhase, LogReadDiagnostic, LogSourceKey, LogSourceState } from './types.js';
import type { DockerTransport } from '../transport/types.js';
import type { SshDockerTraceEvent } from '../transport/ssh-docker.js';

const MAX_ACTIVE_SOURCES = 4;
let nextReadAttemptId = 1;

type Session = {
  refs: number;
  deviceId: string;
  generation: string | null;
  continuous: boolean;
  releaseTransport?: () => void;
  transport: DockerTransport;
  poller: LogPoller;
  lastPollAt: number;
  inFlight: Promise<LogSourceState | undefined> | null;
  activeAttemptId: number | null;
  attemptStartedAtMs: number;
  trace: TraceAccumulator | null;
};

type TraceAccumulator = {
  phases: Set<SshDockerTraceEvent['phase']>;
  latest: SshDockerTraceEvent | null;
};

export type LogSourceOptions = {
  sourceKey: LogSourceKey;
  deviceId: string;
  containerId: string;
  generation?: string;
  continuous?: boolean;
  transport: DockerTransport;
  releaseTransport?: () => void;
  secrets?: readonly string[];
};

export class LogManager {
  readonly buffer = new LogRingBuffer();
  private readonly sessions = new Map<LogSourceKey, Session>();

  open(options: LogSourceOptions): boolean {
    const existing = this.sessions.get(options.sourceKey);
    const generation = options.generation ?? null;
    const continuous = options.continuous ?? true;
    if (existing && existing.generation === generation && existing.continuous === continuous) {
      existing.refs += 1;
      return true;
    }
    if (existing) {
      this.sessions.delete(options.sourceKey);
      this.buffer.remove(options.sourceKey);
      void closeSessionTransport(existing);
    }
    if (this.sessions.size >= MAX_ACTIVE_SOURCES) return false;
    this.sessions.set(options.sourceKey, {
      refs: 1,
      deviceId: options.deviceId,
      generation,
      continuous,
      ...(options.releaseTransport ? { releaseTransport: options.releaseTransport } : {}),
      transport: options.transport,
      poller: new LogPoller(options),
      lastPollAt: 0,
      inFlight: null,
      activeAttemptId: null,
      attemptStartedAtMs: 0,
      trace: null,
    });
    this.buffer.ensure(options.sourceKey, { deviceId: options.deviceId, containerId: options.containerId, generation });
    return true;
  }

  retainIfCompatible(sourceKey: LogSourceKey, generation: string, continuous: boolean): boolean {
    const session = this.sessions.get(sourceKey);
    if (!session || session.generation !== generation || session.continuous !== continuous) return false;
    session.refs += 1;
    return true;
  }

  retain(sourceKey: LogSourceKey): boolean {
    const session = this.sessions.get(sourceKey);
    if (!session) return false;
    session.refs += 1;
    return true;
  }

  async poll(sourceKey: LogSourceKey): Promise<LogSourceState | undefined> {
    const session = this.sessions.get(sourceKey);
    if (!session) return undefined;
    const now = Date.now();
    if (session.inFlight) return session.inFlight;
    if (!session.continuous && session.lastPollAt > 0) return this.buffer.get(sourceKey);
    if (now - session.lastPollAt < 1_500) return this.buffer.get(sourceKey);
    session.lastPollAt = now;
    const attemptId = nextReadAttemptId++;
    session.activeAttemptId = attemptId;
    session.attemptStartedAtMs = now;
    session.trace = { phases: new Set(), latest: null };
    session.inFlight = this.pollOnce(sourceKey, session, attemptId);
    try {
      return await session.inFlight;
    } finally {
      session.inFlight = null;
      session.activeAttemptId = null;
      session.attemptStartedAtMs = 0;
      session.trace = null;
    }
  }

  private async pollOnce(sourceKey: LogSourceKey, session: Session, attemptId: number): Promise<LogSourceState | undefined> {
    try {
      const batch = await session.poller.poll(attemptId);
      if (this.sessions.get(sourceKey) !== session) return this.poll(sourceKey);
      const diagnostic = successDiagnostic(session, attemptId, batch.entries.length, batch.gap, batch.truncated, batch.bytes ?? 0, batch.observedAt);
      this.buffer.append(sourceKey, { deviceId: session.poller.deviceId, containerId: session.poller.containerId, generation: session.generation }, batch.entries, batch.gap, batch.truncated, diagnostic);
      this.buffer.setCursor(sourceKey, batch.cursor);
      return this.buffer.get(sourceKey);
    } catch (error) {
      if (this.sessions.get(sourceKey) !== session) return this.poll(sourceKey);
      if (this.sessions.get(sourceKey) === session) {
        const errorCode = error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code ?? 'log_unavailable') : 'log_unavailable';
        this.buffer.setError(sourceKey, errorCode, failureDiagnostic(session, attemptId, errorCode));
      }
      return this.buffer.get(sourceKey);
    }
  }

  /** Receives only fixed trace fields from the transport; no command or output is retained. */
  recordTransportTrace(deviceId: string, event: SshDockerTraceEvent): void {
    for (const session of this.sessions.values()) {
      if (session.deviceId !== deviceId || session.activeAttemptId === null) continue;
      if (event.readAttemptId !== undefined && event.readAttemptId !== session.activeAttemptId) continue;
      if (event.readAttemptId === undefined) continue;
      session.trace ??= { phases: new Set(), latest: null };
      session.trace.phases.add(event.phase);
      session.trace.latest = event;
      return;
    }
  }

  pause(sourceKey: LogSourceKey, paused: boolean): void {
    this.buffer.setPaused(sourceKey, paused);
  }

  search(sourceKey: LogSourceKey, query: string) {
    return this.buffer.search(sourceKey, query);
  }

  get(sourceKey: LogSourceKey): LogSourceState | undefined {
    return this.buffer.get(sourceKey);
  }

  list(): LogSourceState[] {
    return this.buffer.list();
  }

  release(sourceKey: LogSourceKey, generation?: string, continuous?: boolean): void {
    const session = this.sessions.get(sourceKey);
    if (!session) return;
    if (generation !== undefined && session.generation !== generation) return;
    if (continuous !== undefined && session.continuous !== continuous) return;
    session.refs -= 1;
    if (session.refs > 0) return;
    this.sessions.delete(sourceKey);
    this.buffer.remove(sourceKey);
    void closeSessionTransport(session);
  }

  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.buffer.clear();
    await Promise.all(sessions.map((session) => closeSessionTransport(session)));
  }

  stats() {
    return { activeSources: this.sessions.size, ...this.buffer.stats() };
  }
}

function tracePhase(trace: TraceAccumulator | null, fallback: LogDiagnosticPhase): LogDiagnosticPhase {
  if (fallback !== 'read') return fallback;
  const phase = trace?.latest?.phase;
  if (trace?.latest?.operation === 'deadline') return 'deadline';
  if (phase === 'known_hosts_start' || phase === 'known_hosts_end' || phase === 'credentials_start' || phase === 'credentials_end' || phase === 'connect_start' || phase === 'tcp_connected' || phase === 'ssh_handshake' || phase === 'ssh_banner' || phase === 'ssh_ready' || phase === 'client_error' || phase === 'client_end' || phase === 'client_close') return 'connection';
  if (phase === 'deadline_start' || phase === 'deadline_end') return 'deadline';
  if (phase === 'channel_open') return 'channel';
  if (phase === 'exec_start') return 'remote';
  if (phase === 'output_end' && (trace?.latest?.outcome === 'channel_error' || trace?.latest?.outcome === 'exec_error')) return 'channel';
  if (phase === 'first_byte' || phase === 'output_end') return 'output';
  return fallback;
}

function diagnosticBase(session: Session, attemptId: number, outcome: LogDiagnosticOutcome, phase: LogDiagnosticPhase, bytes: number, observedAt: string): LogReadDiagnostic {
  const trace = session.trace;
  const latest = trace?.latest;
  return {
    readAttemptId: attemptId,
    source: 'container_logs',
    connectionGeneration: latest?.connectionGeneration ?? null,
    phase: tracePhase(trace, phase),
    elapsedMs: Math.max(0, Date.now() - session.attemptStartedAtMs),
    budgetMs: latest?.budgetMs ?? 5_000,
    channels: latest?.channels ?? null,
    bytes: latest?.bytes ?? bytes,
    outcome,
    observedAt,
  };
}

function successDiagnostic(session: Session, attemptId: number, entries: number, gap: number, truncated: boolean, bytes: number, observedAt: string): LogReadDiagnostic {
  if (truncated) return diagnosticBase(session, attemptId, 'output_truncated', 'output', bytes, observedAt);
  if (gap > 0) return diagnosticBase(session, attemptId, 'parse_error', 'parse', bytes, observedAt);
  return diagnosticBase(session, attemptId, entries > 0 ? 'success_new' : 'success_idle', 'read', bytes, observedAt);
}

function failureDiagnostic(session: Session, attemptId: number, errorCode: string): LogReadDiagnostic {
  const phases = session.trace?.phases ?? new Set<SshDockerTraceEvent['phase']>();
  const latest = session.trace?.latest;
  if (errorCode === 'cancelled') return diagnosticBase(session, attemptId, 'cancelled', 'read', 0, new Date().toISOString());
  if (errorCode === 'incomplete') return diagnosticBase(session, attemptId, 'output_truncated', 'output', 0, new Date().toISOString());
  if (!latest) return diagnosticBase(session, attemptId, 'unknown_error', 'read', 0, new Date().toISOString());
  if (phases.has('first_byte') && latest.outcome === 'incomplete') {
    return diagnosticBase(session, attemptId, 'output_truncated', 'output', 0, new Date().toISOString());
  }
  if (latest.operation === 'deadline' && (errorCode === 'deadline_unavailable' || errorCode === 'timeout' || errorCode === 'engine_unavailable')) {
    return diagnosticBase(session, attemptId, 'deadline_error', 'deadline', 0, new Date().toISOString());
  }
  if (connectionFailureEvidence(latest, errorCode)) {
    return diagnosticBase(session, attemptId, 'ssh_connection_error', 'connection', 0, new Date().toISOString());
  }
  if (latest.operation === 'logs' && latest.phase === 'output_end' && latest.outcome === '124') {
    return diagnosticBase(session, attemptId, 'remote_timeout', phases.has('first_byte') ? 'output' : 'remote', 0, new Date().toISOString());
  }
  if (errorCode === 'timeout') {
    if (!phases.has('channel_open')) return diagnosticBase(session, attemptId, 'channel_error', 'channel', 0, new Date().toISOString());
    return diagnosticBase(session, attemptId, 'remote_timeout', phases.has('first_byte') ? 'output' : 'remote', 0, new Date().toISOString());
  }
  if (!phases.has('channel_open')) return diagnosticBase(session, attemptId, 'channel_error', 'channel', 0, new Date().toISOString());
  return diagnosticBase(session, attemptId, 'remote_error', 'remote', 0, new Date().toISOString());
}

function connectionFailureEvidence(event: SshDockerTraceEvent, errorCode: string): boolean {
  if (errorCode === 'host_key_untrusted' || errorCode === 'auth_failed' || errorCode === 'profile_missing') return true;
  if (event.operation !== 'ssh_connect') return false;
  return event.phase === 'known_hosts_start'
    || event.phase === 'known_hosts_end'
    || event.phase === 'credentials_start'
    || event.phase === 'credentials_end'
    || event.phase === 'connect_start'
    || event.phase === 'tcp_connected'
    || event.phase === 'ssh_handshake'
    || event.phase === 'ssh_banner'
    || event.phase === 'client_error';
}

async function closeSessionTransport(session: Session): Promise<void> {
  if (session.releaseTransport) session.releaseTransport();
  else await session.transport.close().catch(() => undefined);
}

export const logManagerLimits = { maxActiveSources: MAX_ACTIVE_SOURCES } as const;
