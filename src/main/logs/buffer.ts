import type { LogDiagnosticOutcome, LogEntry, LogReadDiagnostic, LogSourceKey, LogSourceState } from './types.js';
import { logLimits } from './parser.js';

type SourceMeta = Pick<LogSourceState, 'deviceId' | 'containerId'> & { generation?: string | null };

export class LogRingBuffer {
  private readonly sources = new Map<LogSourceKey, LogSourceState>();
  private totalBytes = 0;

  ensure(sourceKey: LogSourceKey, meta: SourceMeta): void {
    if (this.sources.has(sourceKey)) return;
    this.sources.set(sourceKey, createSourceState(sourceKey, meta));
  }

  append(sourceKey: LogSourceKey, meta: SourceMeta, entries: readonly LogEntry[], gap = 0, truncated = false, diagnostic?: LogReadDiagnostic): void {
    const generation = meta.generation ?? null;
    const current = this.sources.get(sourceKey);
    if (current && current.generation !== generation) this.remove(sourceKey);
    const state = this.sources.get(sourceKey) ?? createSourceState(sourceKey, { ...meta, generation });
    this.sources.set(sourceKey, state);
    state.gap += gap;
    state.complete = state.complete && gap === 0 && !truncated;
    if (diagnostic) {
      state.diagnostic = diagnostic;
      if (diagnostic.outcome === 'success_new' || diagnostic.outcome === 'success_idle') {
        state.errorCode = null;
      } else {
        state.errorCode = diagnosticErrorCode(diagnostic.outcome);
        this.rememberError(state, state.errorCode, diagnostic);
      }
    } else if (gap === 0 && !truncated) {
      state.errorCode = null;
    }
    if (!diagnostic || diagnostic.outcome === 'success_new' || diagnostic.outcome === 'success_idle') {
      state.lastSuccessAt = new Date().toISOString();
    }
    for (const entry of entries) {
      state.entries.push(entry);
      const bytes = entryBytes(entry);
      state.bytes += bytes;
      this.totalBytes += bytes;
    }
    this.pruneSource(state);
    this.pruneTotal();
  }

  setCursor(sourceKey: LogSourceKey, cursor: string | null): void {
    const state = this.sources.get(sourceKey);
    if (state) state.cursor = cursor;
  }

  setPaused(sourceKey: LogSourceKey, paused: boolean): void {
    const state = this.sources.get(sourceKey);
    if (state) state.paused = paused;
  }

  setError(sourceKey: LogSourceKey, errorCode: string | null, diagnostic?: LogReadDiagnostic): void {
    const state = this.sources.get(sourceKey);
    if (state) {
      state.errorCode = errorCode;
      if (errorCode) {
        this.rememberError(state, errorCode, diagnostic);
        if (errorCode === 'incomplete' || errorCode === 'parse_gap' || diagnostic?.outcome === 'output_truncated' || diagnostic?.outcome === 'parse_error') {
          state.complete = false;
        }
      }
      if (diagnostic) state.diagnostic = diagnostic;
    }
  }

  get(sourceKey: LogSourceKey): LogSourceState | undefined {
    const state = this.sources.get(sourceKey);
    return state ? structuredClone(state) : undefined;
  }

  list(): LogSourceState[] {
    return [...this.sources.values()].map((state) => structuredClone(state));
  }

  search(sourceKey: LogSourceKey, query: string): LogEntry[] {
    const state = this.sources.get(sourceKey);
    if (!state || !query) return state ? structuredClone(state.entries) : [];
    return state.entries.filter((entry) => entry.message.includes(query)).map((entry) => structuredClone(entry));
  }

  remove(sourceKey: LogSourceKey): void {
    const state = this.sources.get(sourceKey);
    if (!state) return;
    this.totalBytes = Math.max(0, this.totalBytes - state.bytes);
    this.sources.delete(sourceKey);
  }

  clear(): void {
    this.sources.clear();
    this.totalBytes = 0;
  }

  stats(): { sources: number; entries: number; bytes: number; gap: number } {
    return {
      sources: this.sources.size,
      entries: [...this.sources.values()].reduce((sum, state) => sum + state.entries.length, 0),
      bytes: this.totalBytes,
      gap: [...this.sources.values()].reduce((sum, state) => sum + state.gap, 0),
    };
  }

  private pruneSource(state: LogSourceState): void {
    while (state.entries.length > logLimits.sourceEntries || state.bytes > logLimits.sourceBytes) {
      const removed = state.entries.shift();
      if (!removed) break;
      state.complete = false;
      const bytes = entryBytes(removed);
      state.bytes = Math.max(0, state.bytes - bytes);
      this.totalBytes = Math.max(0, this.totalBytes - bytes);
      state.gap += 1;
    }
  }

  private pruneTotal(): void {
    while (this.totalBytes > logLimits.totalBytes) {
      const oldest = [...this.sources.values()]
        .filter((state) => state.entries.length > 0)
        .sort((left, right) => Date.parse(left.entries[0]?.observedAt ?? '') - Date.parse(right.entries[0]?.observedAt ?? ''))[0];
      if (!oldest) break;
      const removed = oldest.entries.shift();
      if (!removed) break;
      oldest.complete = false;
      const bytes = entryBytes(removed);
      oldest.bytes = Math.max(0, oldest.bytes - bytes);
      this.totalBytes = Math.max(0, this.totalBytes - bytes);
      oldest.gap += 1;
    }
  }

  private rememberError(state: LogSourceState, errorCode: string, diagnostic?: LogReadDiagnostic): void {
    state.lastErrorCode = errorCode;
    state.lastErrorAt = new Date().toISOString();
    state.lastErrorDiagnostic = diagnostic ?? null;
  }
}

function entryBytes(entry: LogEntry): number {
  return Buffer.byteLength(entry.message, 'utf8') + Buffer.byteLength(entry.timestamp ?? '', 'utf8') + 64;
}

function createSourceState(sourceKey: LogSourceKey, meta: SourceMeta): LogSourceState {
  return {
    sourceKey,
    deviceId: meta.deviceId,
    containerId: meta.containerId,
    generation: meta.generation ?? null,
    cursor: null,
    entries: [],
    bytes: 0,
    gap: 0,
    paused: false,
    complete: true,
    lastSuccessAt: null,
    errorCode: null,
    lastErrorCode: null,
    lastErrorAt: null,
    lastErrorDiagnostic: null,
    diagnostic: null,
  };
}

function diagnosticErrorCode(outcome: LogDiagnosticOutcome): string {
  if (outcome === 'channel_error') return 'channel_error';
  if (outcome === 'remote_timeout') return 'timeout';
  if (outcome === 'remote_error') return 'engine_unavailable';
  if (outcome === 'output_truncated') return 'incomplete';
  if (outcome === 'parse_error') return 'parse_gap';
  if (outcome === 'cancelled') return 'cancelled';
  if (outcome === 'ssh_connection_error') return 'engine_unavailable';
  if (outcome === 'deadline_error') return 'deadline_unavailable';
  return 'log_unavailable';
}
