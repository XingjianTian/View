import { z } from 'zod';
import { INFRASTRUCTURE_PYTHON, INFRASTRUCTURE_LIMITS, InfrastructureSourceSchema, type InfrastructureRead, type RegisteredInfrastructureSource } from './infrastructure.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as http from 'node:http';
import path from 'node:path';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import { resolveSecret, type PrivateSshProfile } from '../credentials/profile-reader.js';
import { DEADLINES_MS } from './deadlines.js';
import { inspectCommand, listCommand, logsCommand, quantPostgresTargetInspectCommand, ragflowTargetInspectCommand, statsCommand, versionCommand, type CommandSpec } from './readonly-commands.js';
import { ARTICLE_RECEIPT_PYTHON, parseRemoteArticleReceiptRead, type RemoteArticleReceiptRead } from './article-receipts.js';
import {
  assertRagflowSource,
  assertRagflowTarget,
  createRagflowReadBudget,
  emitRagflowDiagnostic,
  RAGFLOW_LIMITS,
  parseRagflowTargetInspect,
  remainingRagflowReadMs,
  readRagflowAggregates,
  readRagflowIngestionLogs,
  type RagflowAggregateRead,
  type RagflowIngestionLogsRead,
  type RagflowDocumentsSource,
  type RagflowHttpResponse,
  type RagflowReadBudget,
  type RagflowTargetMetadata,
} from './ragflow-documents.js';
import { TransportError, type CommandResult, type DockerTransport, type LogReadContext } from './types.js';
import { ConnectableForwardDuplex, type QuantPostgresChannelLease, type QuantPostgresTarget, type QuantPostgresTargetMetadata } from './quant-postgres.js';

type KnownHostRecord = {
  hostPatterns: string[];
  fingerprint: string;
  fingerprintHex: string;
};

export type SshDockerOptions = {
  profile: PrivateSshProfile;
  clientFactory?: () => Client;
  trace?: (event: SshDockerTraceEvent) => void;
};

export type SshDockerTimeoutSource = 'local_timer' | 'ssh2_error';

export type SshDockerTraceEvent = {
  phase: 'known_hosts_start' | 'known_hosts_end' | 'credentials_start' | 'credentials_end' | 'connect_start' | 'tcp_connected' | 'ssh_handshake' | 'ssh_banner' | 'ssh_ready' | 'client_end' | 'client_close' | 'client_error' | 'deadline_start' | 'deadline_end' | 'exec_start' | 'channel_open' | 'first_byte' | 'output_end';
  clientId: number;
  requestId?: number | undefined;
  operation?: string | undefined;
  outcome?: string | undefined;
  timeoutSource?: SshDockerTimeoutSource | undefined;
  bytes?: number | undefined;
  readAttemptId?: number | undefined;
  connectionGeneration: number;
  channels: number;
  elapsedMs: number;
  budgetMs?: number | undefined;
  atMs: number;
};

type SshDockerTraceEventInput = {
  phase: SshDockerTraceEvent['phase'];
  clientId: number;
  requestId?: number | undefined;
  operation?: string | undefined;
  outcome?: string | undefined;
  timeoutSource?: SshDockerTimeoutSource | undefined;
  bytes?: number | undefined;
  readAttemptId?: number | undefined;
  connectionGeneration?: number | undefined;
  channels?: number | undefined;
  budgetMs?: number | undefined;
  startedAtMs?: number | undefined;
  monotonicStartedAtMs?: number | undefined;
};

function monotonicNowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

export class SshDockerTransport implements DockerTransport {
  readonly kind = 'ssh' as const;
  private readonly profile: PrivateSshProfile;
  private readonly clientFactory: () => Client;
  private readonly trace: ((event: SshDockerTraceEvent) => void) | undefined;
  private client: Client | null = null;
  private deadlineCommand: 'timeout' | 'gtimeout' | null = null;
  private channels = new Set<ClientChannel>();
  private connecting: Promise<Client> | null = null;
  private detectingDeadline: { client: Client; promise: Promise<'timeout' | 'gtimeout' | null> } | null = null;
  private nextClientId = 1;
  private nextRequestId = 1;
  private readonly clientIds = new WeakMap<Client, number>();
  private readonly invalidClients = new WeakSet<Client>();
  private connectionGeneration = 0;

  constructor(options: SshDockerOptions) {
    this.profile = options.profile;
    this.clientFactory = options.clientFactory ?? (() => new Client());
    this.trace = options.trace;
  }

  version(signal?: AbortSignal) { return this.run(versionCommand(), signal); }
  list(signal?: AbortSignal) { return this.run(listCommand(), signal); }
  inspect(ids: readonly string[], signal?: AbortSignal) { return this.run(inspectCommand(ids), signal); }
  stats(ids: readonly string[], signal?: AbortSignal) { return this.run(statsCommand(ids), signal); }
  logs(id: string, since?: string, signal?: AbortSignal, context?: LogReadContext) { return this.run(logsCommand(id, since), signal, context); }

  async readInfrastructure(source: RegisteredInfrastructureSource, signal?: AbortSignal): Promise<InfrastructureRead> {
    const registered = InfrastructureSourceSchema.safeParse(source);
    if (!registered.success) throw new TransportError('profile_invalid', '基础服务来源登记无效。');
    if (signal?.aborted) throw new TransportError('cancelled', '基础服务读取已取消。');
    const startedAt = monotonicNowMs();
    const generation = this.connectionGeneration;
    const requestId = this.nextRequestId++;
    const controller = new AbortController();
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let rejectCancelled: (error: TransportError) => void = () => undefined;
    const remaining = () => Math.max(0, INFRASTRUCTURE_LIMITS.timeoutMs - (monotonicNowMs() - startedAt));
    const check = () => {
      if (timedOut || remaining() <= 0) throw new TransportError('timeout', '基础服务读取超时。');
      if (signal?.aborted || controller.signal.aborted) throw new TransportError('cancelled', '基础服务读取已取消。');
      if (generation !== this.connectionGeneration) throw new TransportError('cancelled', '基础服务连接已变更。');
    };
    const cancelled = new Promise<never>((_, reject) => { rejectCancelled = reject; });
    const onAbort = () => {
      controller.abort();
      rejectCancelled(new TransportError('cancelled', '基础服务读取已取消。'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new TransportError('timeout', '基础服务读取超时。'));
        controller.abort();
      }, INFRASTRUCTURE_LIMITS.timeoutMs);
    });
    const operation = (async () => {
      const client = await this.getClient();
      check();
      await this.ensureDeadline(client, requestId);
      check();
      const password = await this.resolveCredential(client, 'sudoPassword', registered.data.kind, Date.now(), INFRASTRUCTURE_LIMITS.timeoutMs);
      check();
      const timeoutMs = Math.floor(remaining());
      if (timeoutMs <= 0) throw new TransportError('timeout', '基础服务读取超时。');
      const seconds = (timeoutMs / 1000).toFixed(3);
      const wrapped = `${quote(this.deadlineCommand!)} --signal=TERM --kill-after=1 ${seconds}s ${quote('python3')} -c ${quote(INFRASTRUCTURE_PYTHON)} ${quote(JSON.stringify(registered.data))} ${quote(seconds)} ${quote(this.profile.dockerPath)}`;
      const command = password === undefined ? wrapped : `sudo -S -p '' -- ${wrapped}`;
      const result = await this.execRaw(client, command, timeoutMs, INFRASTRUCTURE_LIMITS.maxResponseBytes, password, controller.signal, requestId, registered.data.kind);
      check();
      let value: unknown;
      try { value = JSON.parse(result.stdout.trim()); } catch { throw new TransportError('invalid_response', '基础服务读取结果无效。'); }
      const failure = z.object({ error: z.enum(['permission', 'timeout', 'schema_or_source']) }).strict().safeParse(value);
      if (failure.success) throw new TransportError(failure.data.error === 'permission' ? 'sudo_denied' : failure.data.error === 'timeout' ? 'timeout' : 'invalid_response', '基础服务来源未能完成读取。');
      const parsed = z.object({ kind: z.literal(registered.data.kind), complete: z.boolean(), data: z.record(z.string(), z.unknown()) }).strict().safeParse(value);
      if (!parsed.success) throw new TransportError('invalid_response', '基础服务读取结果无效。');
      return parsed.data;
    })();
    try {
      return await Promise.race([operation, deadline, cancelled]);
    } catch (error) {
      if (timedOut) throw new TransportError('timeout', '基础服务读取超时。');
      if (error instanceof TransportError) throw error;
      throw new TransportError('internal', '基础服务读取未完成。');
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async readArticleReceipts(rootPath: string, signal?: AbortSignal): Promise<RemoteArticleReceiptRead> {
    if (!path.isAbsolute(rootPath) || /[\u0000-\u001f\u007f]/.test(rootPath)) {
      throw new TransportError('profile_invalid', '回执来源登记无效。');
    }
    if (signal?.aborted) throw new TransportError('cancelled', '观察请求已取消。');
    const requestId = this.nextRequestId++;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TransportError('timeout', '远端回执读取请求超时。'));
      }, DEADLINES_MS.statusSource);
    });
    const operation = (async () => {
      const client = await this.getClient();
      if (controller.signal.aborted) throw new TransportError(signal?.aborted ? 'cancelled' : 'timeout', '远端回执读取请求已取消。');
      await this.ensureDeadline(client, requestId);
      if (controller.signal.aborted) throw new TransportError(signal?.aborted ? 'cancelled' : 'timeout', '远端回执读取请求已取消。');
      const sudoPassword = await resolveSecret(this.profile, 'sudoPassword');
      const seconds = Math.ceil(DEADLINES_MS.statusSource / 1000);
      const wrapped = `${quote(this.deadlineCommand ?? 'timeout')} --signal=TERM ${seconds} ${quote('python3')} -c ${quote(ARTICLE_RECEIPT_PYTHON)} ${quote(rootPath)}`;
      const command = sudoPassword === undefined ? wrapped : `sudo -S -p '' -- ${wrapped}`;
      const result = await this.execRaw(client, command, DEADLINES_MS.statusSource, 768 * 1024, sudoPassword, controller.signal, requestId, 'article_receipt_json');
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout.trim()) as unknown;
      } catch {
        throw new TransportError('incomplete', '远端回执读取结果无效。');
      }
      const read = parseRemoteArticleReceiptRead(parsed);
      if (!read) throw new TransportError('incomplete', '远端回执读取结果无效。');
      return read;
    })();
    try {
      return await Promise.race([operation, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Main-process-only RAGFlow reader. The source contract is resolved by the
   * caller from private deployment evidence; it is never accepted from IPC.
   */
  /** Main-process-only fixed aggregate reader for the registered datasets. */
  async readRagflowAggregates(source: RagflowDocumentsSource, signal?: AbortSignal, budget = createRagflowReadBudget()): Promise<RagflowAggregateRead> {
    assertRagflowSource(source);
    if (signal?.aborted) throw new TransportError('cancelled', 'RAGFlow 读取请求已取消。');
    const timeoutMs = remainingRagflowReadMs(budget);
    if (timeoutMs <= 0 || budget.remainingBytes <= 0) throw new TransportError(timeoutMs <= 0 ? 'timeout' : 'incomplete', 'RAGFlow 逻辑读取期限已到。');
    const requestId = this.nextRequestId++;
    const startedAtMs = Date.now();
    const requestStartedAt = new Date(startedAtMs).toISOString();
    const controller = new AbortController();
    let timedOut = false;
    let partial: RagflowAggregateRead | undefined;
    let timer: NodeJS.Timeout | undefined;
    let removeAbortListener: () => void = () => undefined;
    const missingDatasets = (read: RagflowAggregateRead): string[] => {
      const complete = new Set(read.datasets.map((dataset) => dataset.datasetId));
      return (source.datasetIds ?? []).filter((datasetId) => !complete.has(datasetId));
    };
    const timeoutResult = (read: RagflowAggregateRead): RagflowAggregateRead => ({
      ...read,
      complete: false,
      failedDatasetIds: missingDatasets(read),
      observedAt: new Date().toISOString(),
      requestStartedAt: read.requestStartedAt ?? requestStartedAt,
      requestCompletedAt: new Date().toISOString(),
    });
    const deadline = new Promise<RagflowAggregateRead>((resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        if (partial) resolve(timeoutResult(partial));
        else reject(new TransportError('timeout', 'RAGFlow 汇总读取请求超时。'));
      }, Math.max(1, timeoutMs));
    });
    const cancelled = signal ? new Promise<never>((_, reject) => {
      const onAbort = () => {
        controller.abort();
        reject(new TransportError('cancelled', 'RAGFlow 汇总读取请求已取消。'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      if (signal.aborted) onAbort();
    }) : undefined;
    const operation = (async () => {
      const client = await this.getClient();
      if (controller.signal.aborted) throw new TransportError(timedOut ? 'timeout' : 'cancelled', timedOut ? 'RAGFlow 汇总读取请求超时。' : 'RAGFlow 汇总读取请求已取消。');
      emitRagflowDiagnostic(budget, 'connection');
      await this.ensureDeadline(client, requestId);
      if (controller.signal.aborted) throw new TransportError(timedOut ? 'timeout' : 'cancelled', timedOut ? 'RAGFlow 汇总读取请求超时。' : 'RAGFlow 汇总读取请求已取消。');
      emitRagflowDiagnostic(budget, 'deadline');
      await this.verifyRagflowTarget(source.target, controller.signal);
      if (controller.signal.aborted) throw new TransportError(timedOut ? 'timeout' : 'cancelled', timedOut ? 'RAGFlow 汇总读取请求超时。' : 'RAGFlow 汇总读取请求已取消。');
      emitRagflowDiagnostic(budget, 'target');
      const result = await readRagflowAggregates(
        source,
        (requestPath, requestSignal) => this.readRagflowHttp(client, source, requestPath, requestSignal, requestId, startedAtMs, budget),
        controller.signal,
        (progress) => { partial = progress; },
        budget,
      );
      return timedOut
        ? timeoutResult(result)
        : {
          ...result,
          requestStartedAt: result.requestStartedAt ?? requestStartedAt,
          requestCompletedAt: result.requestCompletedAt ?? new Date().toISOString(),
        };
    })();
    try {
      const promises: Array<Promise<never> | Promise<RagflowAggregateRead>> = [operation, deadline];
      if (cancelled) promises.push(cancelled);
      return await Promise.race(promises);
    } catch (error) {
      if (timedOut) {
        if (partial) return timeoutResult(partial);
        throw new TransportError('timeout', 'RAGFlow 汇总读取请求超时。');
      }
      if (partial && error instanceof TransportError && (error.code === 'timeout' || error.code === 'incomplete')) return timeoutResult(partial);
      if (signal?.aborted) throw new TransportError('cancelled', 'RAGFlow 读取请求已取消。');
      if (error instanceof TransportError) throw error;
      throw new TransportError('engine_unavailable', 'RAGFlow 汇总只读通道不可用。');
    } finally {
      if (timer) clearTimeout(timer);
      removeAbortListener();
    }
  }

  /** Main-process-only fixed historical file-log reader. */
  async readRagflowIngestionLogs(source: RagflowDocumentsSource, signal?: AbortSignal, budget = createRagflowReadBudget()): Promise<RagflowIngestionLogsRead> {
    assertRagflowSource(source);
    if (signal?.aborted) throw new TransportError('cancelled', 'RAGFlow 读取请求已取消。');
    const timeoutMs = remainingRagflowReadMs(budget);
    if (timeoutMs <= 0 || budget.remainingBytes <= 0) throw new TransportError(timeoutMs <= 0 ? 'timeout' : 'incomplete', 'RAGFlow 逻辑读取期限已到。');
    const requestId = this.nextRequestId++;
    const startedAtMs = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    let partial: RagflowIngestionLogsRead | undefined;
    let timer: NodeJS.Timeout | undefined;
    let removeAbortListener: () => void = () => undefined;
    const missingDatasets = (read: RagflowIngestionLogsRead): string[] => {
      const complete = new Set(read.datasets.map((dataset) => dataset.datasetId));
      return (source.datasetIds ?? []).filter((datasetId) => !complete.has(datasetId));
    };
    const timeoutResult = (read: RagflowIngestionLogsRead): RagflowIngestionLogsRead => ({
      ...read,
      complete: false,
      failedDatasetIds: missingDatasets(read),
      gap: true,
      observedAt: new Date().toISOString(),
    });
    const deadline = new Promise<RagflowIngestionLogsRead>((resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        if (partial) resolve(timeoutResult(partial));
        else reject(new TransportError('timeout', 'RAGFlow 日志读取请求超时。'));
      }, Math.max(1, timeoutMs));
    });
    const cancelled = signal ? new Promise<never>((_, reject) => {
      const onAbort = () => {
        controller.abort();
        reject(new TransportError('cancelled', 'RAGFlow 日志读取请求已取消。'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      if (signal.aborted) onAbort();
    }) : undefined;
    const operation = (async () => {
      const client = await this.getClient();
      if (controller.signal.aborted) throw new TransportError(timedOut ? 'timeout' : 'cancelled', timedOut ? 'RAGFlow 日志读取请求超时。' : 'RAGFlow 日志读取请求已取消。');
      emitRagflowDiagnostic(budget, 'connection');
      await this.ensureDeadline(client, requestId);
      if (controller.signal.aborted) throw new TransportError(timedOut ? 'timeout' : 'cancelled', timedOut ? 'RAGFlow 日志读取请求超时。' : 'RAGFlow 日志读取请求已取消。');
      emitRagflowDiagnostic(budget, 'deadline');
      await this.verifyRagflowTarget(source.target, controller.signal);
      if (controller.signal.aborted) throw new TransportError(timedOut ? 'timeout' : 'cancelled', timedOut ? 'RAGFlow 日志读取请求超时。' : 'RAGFlow 日志读取请求已取消。');
      emitRagflowDiagnostic(budget, 'target');
      const result = await readRagflowIngestionLogs(
        source,
        (requestPath, requestSignal) => this.readRagflowHttp(client, source, requestPath, requestSignal, requestId, startedAtMs, budget),
        controller.signal,
        (progress) => { partial = progress; },
        budget,
      );
      return timedOut ? timeoutResult(result) : result;
    })();
    try {
      const promises: Array<Promise<never> | Promise<RagflowIngestionLogsRead>> = [operation, deadline];
      if (cancelled) promises.push(cancelled);
      return await Promise.race(promises);
    } catch (error) {
      if (timedOut) {
        if (partial) return timeoutResult(partial);
        throw new TransportError('timeout', 'RAGFlow 日志读取请求超时。');
      }
      if (partial && error instanceof TransportError && (error.code === 'timeout' || error.code === 'incomplete')) return timeoutResult(partial);
      if (signal?.aborted) throw new TransportError('cancelled', 'RAGFlow 读取请求已取消。');
      if (error instanceof TransportError) throw error;
      throw new TransportError('engine_unavailable', 'RAGFlow 日志只读通道不可用。');
    } finally {
      if (timer) clearTimeout(timer);
      removeAbortListener();
    }
  }

  /**
   * Verify the private RAGFlow target immediately before forwarding. The
   * projection contains only identity, state and network IP; the port remains
   * the private registered value. A changed or ambiguous container fails
   * closed before any HTTP channel is opened.
   */
  async verifyRagflowTarget(target: RagflowDocumentsSource['target'], signal?: AbortSignal): Promise<RagflowTargetMetadata> {
    assertRagflowTarget(target);
    const result = await this.run(ragflowTargetInspectCommand(target.containerId), signal);
    if (result.truncated || result.code !== 0) throw new TransportError('incomplete', 'RAGFlow 部署身份观察结果不完整。');
    return parseRagflowTargetInspect(result.stdout, target, result.observedAt);
  }

  async verifyQuantPostgresTarget(target: QuantPostgresTarget, signal?: AbortSignal): Promise<QuantPostgresTargetMetadata> {
    assertQuantPostgresTarget(target);
    const result = await this.run(quantPostgresTargetInspectCommand(target.containerId), signal);
    if (result.truncated || result.code !== 0) throw new TransportError('incomplete', 'Quant 数据库部署身份观察结果不完整。');
    return parseQuantPostgresTargetInspect(result.stdout, target, result.observedAt);
  }

  async openQuantPostgresChannel(target: QuantPostgresTarget, signal?: AbortSignal): Promise<QuantPostgresChannelLease> {
    assertQuantPostgresTarget(target);
    if (signal?.aborted) throw new TransportError('cancelled', 'Quant 数据库读取请求已取消。');
    const client = await this.getClient();
    return new Promise<QuantPostgresChannelLease>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(new TransportError('cancelled', 'Quant 数据库读取请求已取消。'));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        client.forwardOut('127.0.0.1', 0, target.ip, target.port, (error, channel) => {
          signal?.removeEventListener('abort', onAbort);
          if (settled) {
            channel?.destroy();
            return;
          }
          if (error || !channel) {
            settled = true;
            reject(new TransportError('engine_unavailable', 'Quant 数据库转发通道不可用。'));
            return;
          }
          settled = true;
          this.channels.add(channel);
          const stream = new ConnectableForwardDuplex(channel);
          let closed = false;
          const cleanup = () => {
            if (closed) return;
            closed = true;
            this.channels.delete(channel);
            signal?.removeEventListener('abort', onAbort);
          };
          stream.once('close', cleanup);
          channel.once('close', cleanup);
          resolve({
            stream,
            close: () => {
              cleanup();
              if (!stream.destroyed) stream.destroy();
              else if (!channel.destroyed) channel.destroy();
            },
          });
        });
      } catch {
        signal?.removeEventListener('abort', onAbort);
        if (!settled) {
          settled = true;
          reject(new TransportError('engine_unavailable', 'Quant 数据库转发通道不可用。'));
        }
      }
    });
  }

  async close() {
    this.connectionGeneration += 1;
    for (const channel of this.channels) channel.destroy();
    this.channels.clear();
    if (this.client) {
      this.client.end();
      this.client = null;
    }
    this.connecting = null;
    this.detectingDeadline = null;
  }

  private clearClientIfCurrent(client: Client) {
    // A late end/close from an older SSH connection must not clear a newer one.
    if (this.client !== client) return;
    this.client = null;
    this.deadlineCommand = null;
  }

  private watchClient(client: Client, onTerminated?: () => void) {
    client.on('end', () => {
      this.traceEvent({ phase: 'client_end', clientId: this.clientId(client) });
      onTerminated?.();
      if (!onTerminated) this.clearClientIfCurrent(client);
    });
    client.on('close', () => {
      this.traceEvent({ phase: 'client_close', clientId: this.clientId(client) });
      onTerminated?.();
      if (!onTerminated) this.clearClientIfCurrent(client);
    });
  }

  diagnostics() {
    return { connections: this.client ? 1 : 0, channels: this.channels.size };
  }

  private async run(spec: CommandSpec, signal?: AbortSignal, logContext?: LogReadContext): Promise<CommandResult> {
    if (signal?.aborted) throw new TransportError('cancelled', '观察请求已取消。');
    const requestId = this.nextRequestId++;
    const startedAtMs = Date.now();
    const client = await this.getClient(logContext);
    await this.ensureDeadline(client, requestId, logContext);
    const password = await this.resolveCredential(client, 'sudoPassword', spec.operation, startedAtMs, spec.timeoutMs, logContext);
    const command = this.remoteCommand(spec, password !== undefined);
    return this.exec(client, command, spec, password, signal, requestId, logContext);
  }

  private async resolveCredential(
    client: Client,
    key: 'password' | 'sudoPassword',
    operation: string,
    startedAtMs: number,
    budgetMs: number,
    logContext?: LogReadContext,
  ): Promise<string | undefined> {
    this.traceEvent({ phase: 'credentials_start', clientId: this.clientId(client), operation, startedAtMs, budgetMs }, logContext);
    try {
      const value = await resolveSecret(this.profile, key);
      this.traceEvent({ phase: 'credentials_end', clientId: this.clientId(client), operation, outcome: value === undefined ? 'none' : 'resolved', startedAtMs, budgetMs }, logContext);
      return value;
    } catch (error) {
      this.traceEvent({ phase: 'credentials_end', clientId: this.clientId(client), operation, outcome: error instanceof TransportError ? error.code : 'error', startedAtMs, budgetMs }, logContext);
      throw error;
    }
  }

  private async ensureDeadline(client: Client, requestId: number, logContext?: LogReadContext): Promise<void> {
    if (this.deadlineCommand) return;
    const existingDetection = this.detectingDeadline;
    let detecting = existingDetection?.client === client ? existingDetection.promise : undefined;
    if (!detecting) {
      let promise: Promise<'timeout' | 'gtimeout' | null>;
      promise = this.detectDeadline(client, requestId, logContext).finally(() => {
        const current = this.detectingDeadline;
        if (current?.client === client && current.promise === promise) this.detectingDeadline = null;
      });
      detecting = promise;
      this.detectingDeadline = { client, promise };
    }
    const detected = await detecting;
    if (this.client !== client) throw new TransportError('engine_unavailable', 'SSH 连接已断开。');
    this.deadlineCommand = detected;
    if (!this.deadlineCommand) throw new TransportError('deadline_unavailable', '远端没有可确认的命令期限工具。');
  }

  private async getClient(logContext?: LogReadContext): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    const generation = this.connectionGeneration;
    const opening = this.connect(logContext);
    this.connecting = opening;
    try {
      const client = await opening;
      if (generation !== this.connectionGeneration || this.invalidClients.has(client)) {
        this.invalidClients.add(client);
        try {
          client.end();
        } catch {
          this.traceEvent({ phase: 'client_error', clientId: this.clientId(client), outcome: 'stale_end_error' }, logContext);
        }
        throw new TransportError('engine_unavailable', 'SSH 连接已断开。');
      }
      this.client = client;
      return client;
    } finally {
      if (this.connecting === opening) this.connecting = null;
    }
  }

  private async connect(logContext?: LogReadContext): Promise<Client> {
    const startedAtMs = Date.now();
    const monotonicStartedAtMs = monotonicNowMs();
    const connectionId = this.nextClientId++;
    const traceConnection = (event: Omit<SshDockerTraceEventInput, 'startedAtMs' | 'monotonicStartedAtMs'>) => {
      this.traceEvent({ ...event, startedAtMs, monotonicStartedAtMs }, logContext);
    };
    traceConnection({ phase: 'known_hosts_start', clientId: connectionId, operation: 'ssh_connect', budgetMs: DEADLINES_MS.connection });
    let records: KnownHostRecord[];
    try {
      records = await readKnownHosts(this.profile.knownHostsPath, this.profile.host, this.profile.port);
      traceConnection({ phase: 'known_hosts_end', clientId: connectionId, operation: 'ssh_connect', outcome: records.length > 0 ? 'available' : 'missing', budgetMs: DEADLINES_MS.connection });
    } catch (error) {
      traceConnection({ phase: 'known_hosts_end', clientId: connectionId, operation: 'ssh_connect', outcome: error instanceof TransportError ? error.code : 'error', budgetMs: DEADLINES_MS.connection });
      throw error;
    }
    if (!records.length) throw new TransportError('host_key_untrusted', '设备主机密钥不在既有信任记录中。');
    traceConnection({ phase: 'credentials_start', clientId: connectionId, operation: 'ssh_connect', budgetMs: DEADLINES_MS.connection });
    let password: string | undefined;
    let identity: Buffer | undefined;
    try {
      password = await resolveSecret(this.profile, 'password');
      if (this.profile.identityFile) {
        try {
          identity = await readFile(this.profile.identityFile);
        } catch {
          if (password === undefined) throw new TransportError('profile_missing', 'SSH 身份引用不可读取。');
        }
      }
      traceConnection({ phase: 'credentials_end', clientId: connectionId, operation: 'ssh_connect', outcome: password !== undefined || identity !== undefined ? 'resolved' : 'none', budgetMs: DEADLINES_MS.connection });
    } catch (error) {
      traceConnection({ phase: 'credentials_end', clientId: connectionId, operation: 'ssh_connect', outcome: error instanceof TransportError ? error.code : 'error', budgetMs: DEADLINES_MS.connection });
      throw error;
    }
    const client = this.clientFactory();
    this.invalidClients.delete(client);
    this.clientIds.set(client, connectionId);
    traceConnection({ phase: 'connect_start', clientId: connectionId, operation: 'ssh_connect', budgetMs: DEADLINES_MS.connection });
    let hostKeyRejected = false;
    const config: ConnectConfig = {
      host: this.profile.host,
      port: this.profile.port,
      username: this.profile.username,
      readyTimeout: DEADLINES_MS.connection,
      hostHash: 'sha256',
      hostVerifier: (fingerprint: string) => {
        const trusted = records.some((record) => record.fingerprint === normalizeFingerprint(fingerprint) || record.fingerprintHex === fingerprint.replace(/^SHA256:/, ''));
        if (!trusted) hostKeyRejected = true;
        return trusted;
      },
      ...(identity ? { privateKey: identity } : {}),
      ...(password !== undefined ? { password } : {}),
    };
    return new Promise<Client>((resolve, reject) => {
      type ConnectionState = 'connecting' | 'ready' | 'failed';
      let state: ConnectionState = 'connecting';
      let settled = false;
      let endIssued = false;
      let timer: NodeJS.Timeout | undefined;
      const clearTimer = () => {
        if (timer) clearTimeout(timer);
        timer = undefined;
      };
      const endClient = () => {
        if (endIssued) return;
        endIssued = true;
        try {
          client.end();
        } catch {
          traceConnection({ phase: 'client_error', clientId: this.clientId(client), operation: 'ssh_connect', outcome: 'end_error', budgetMs: DEADLINES_MS.connection });
        }
      };
      const settleOnce = (nextState: Exclude<ConnectionState, 'connecting'>, callback: () => void) => {
        if (settled) return false;
        settled = true;
        state = nextState;
        clearTimer();
        callback();
        return true;
      };
      const classify = (error: unknown) => {
        const message = error instanceof Error ? error.message.toLowerCase() : '';
        if (hostKeyRejected || (message.includes('host') && message.includes('verif'))) return new TransportError('host_key_untrusted', '设备主机密钥校验失败。');
        if (message.includes('auth') || message.includes('password') || message.includes('publickey')) return new TransportError('auth_failed', 'SSH 认证失败。');
        return new TransportError('engine_unavailable', 'SSH 连接不可用。');
      };
      const fail = (error: unknown) => {
        traceConnection({
          phase: 'client_error',
          clientId: this.clientId(client),
          operation: 'ssh_connect',
          outcome: state === 'connecting' ? 'connect_error' : 'late_error',
          timeoutSource: state === 'connecting' ? 'ssh2_error' : undefined,
          budgetMs: DEADLINES_MS.connection,
        });
        if (state !== 'connecting') {
          if (state === 'ready') {
            this.invalidClients.add(client);
            this.clearClientIfCurrent(client);
          }
          return;
        }
        if (settleOnce('failed', () => reject(classify(error)))) endClient();
      };
      const terminate = () => {
        if (state === 'connecting') {
          if (settleOnce('failed', () => reject(classify(undefined)))) return;
        } else if (state === 'ready') {
          this.invalidClients.add(client);
          this.clearClientIfCurrent(client);
        }
      };
      const ready = () => {
        if (state === 'ready') return;
        if (state !== 'connecting') {
          endClient();
          return;
        }
        settleOnce('ready', () => {
          traceConnection({ phase: 'ssh_ready', clientId: this.clientId(client), operation: 'ssh_connect', budgetMs: DEADLINES_MS.connection });
          resolve(client);
        });
      };
      // Install the single persistent error listener before connect so every
      // handshake and post-ready error is handled by this transport.
      client.on('error', fail);
      this.watchClient(client, terminate);
      client.once('connect', () => {
        traceConnection({ phase: 'tcp_connected', clientId: this.clientId(client), operation: 'ssh_connect', budgetMs: DEADLINES_MS.connection });
      });
      client.once('handshake', () => {
        traceConnection({ phase: 'ssh_handshake', clientId: this.clientId(client), operation: 'ssh_connect', budgetMs: DEADLINES_MS.connection });
      });
      client.once('banner', () => {
        traceConnection({ phase: 'ssh_banner', clientId: this.clientId(client), operation: 'ssh_connect', budgetMs: DEADLINES_MS.connection });
      });
      client.once('ready', ready);
      timer = setTimeout(() => {
        if (settleOnce('failed', () => {
          traceConnection({ phase: 'client_error', clientId: this.clientId(client), operation: 'ssh_connect', outcome: 'connect_timeout', timeoutSource: 'local_timer', budgetMs: DEADLINES_MS.connection });
          reject(new TransportError('timeout', 'SSH 连接超时。'));
        })) endClient();
      }, DEADLINES_MS.connection);
      try {
        client.connect(config);
      } catch (error) {
        fail(error);
      }
    });
  }

  private async detectDeadline(client: Client, requestId: number, logContext?: LogReadContext): Promise<'timeout' | 'gtimeout' | null> {
    const startedAtMs = Date.now();
    this.traceEvent({ phase: 'deadline_start', clientId: this.clientId(client), requestId, operation: 'deadline', startedAtMs, budgetMs: 5_000 }, logContext);
    try {
      const result = await this.execRaw(client, 'command -v timeout || command -v gtimeout', 5_000, 64 * 1024, undefined, undefined, requestId, 'deadline', logContext);
      const command = path.basename(result.stdout.trim().split(/\r?\n/)[0] ?? '');
      const detected = command === 'timeout' || command === 'gtimeout' ? command : null;
      this.traceEvent({ phase: 'deadline_end', clientId: this.clientId(client), requestId, operation: 'deadline', outcome: detected ?? 'none', startedAtMs, budgetMs: 5_000 }, logContext);
      return detected;
    } catch (error) {
      this.traceEvent({ phase: 'deadline_end', clientId: this.clientId(client), requestId, operation: 'deadline', outcome: error instanceof TransportError ? error.code : 'error', startedAtMs, budgetMs: 5_000 }, logContext);
      throw error;
    }
  }

  private remoteCommand(spec: CommandSpec, useSudo: boolean) {
    const seconds = Math.max(1, Math.ceil(spec.timeoutMs / 1000));
    const docker = [quote(this.profile.dockerPath), ...spec.argv.map(quote)].join(' ');
    const wrapped = `${quote(this.deadlineCommand ?? 'timeout')} --signal=TERM ${seconds} ${docker}`;
    return useSudo ? `sudo -S -p '' -- ${wrapped}` : wrapped;
  }

  private async exec(client: Client, command: string, spec: CommandSpec, sudoPassword: string | undefined, signal: AbortSignal | undefined, requestId: number, logContext?: LogReadContext): Promise<CommandResult> {
    const result = await this.execRaw(client, command, spec.timeoutMs, spec.maxOutputBytes, sudoPassword, signal, requestId, spec.operation, logContext);
    return { ...result, operation: spec.operation, observedAt: new Date().toISOString() };
  }

  private async readRagflowHttp(
    client: Client,
    source: RagflowDocumentsSource,
    requestPath: string,
    signal: AbortSignal | undefined,
    requestId: number,
    startedAtMs = Date.now(),
    budget?: RagflowReadBudget,
  ): Promise<RagflowHttpResponse> {
    assertRagflowTarget(source.target);
    if (!isRagflowPath(requestPath)) throw new TransportError('profile_invalid', 'RAGFlow 请求路径无效。');
    const datasetMatch = requestPath.match(/^\/api\/v1\/datasets\/([^/]+)\/ingestions(?:\/summary|\?)/);
    const registeredDatasetIds = source.datasetIds ?? [];
    if (!datasetMatch || !registeredDatasetIds.includes(decodeURIComponent(datasetMatch[1]!))) {
      throw new TransportError('profile_invalid', 'RAGFlow 请求数据集未登记。');
    }
    if (budget && remainingRagflowReadMs(budget) <= 0) throw new TransportError('timeout', 'RAGFlow 逻辑读取期限已到。');
    if (budget && budget.remainingBytes <= 0) throw new TransportError('incomplete', 'RAGFlow 逻辑读取响应超过轮次上限。');
    emitRagflowDiagnostic(budget, 'channel_wait');
    const channel = await this.openRagflowChannel(client, source.target, signal, requestId, startedAtMs, budget);
    return new Promise<RagflowHttpResponse>((resolve, reject) => {
      let settled = false;
      let responseEnded = false;
      let destroyed = false;
      let request: http.ClientRequest | undefined;
      const agent = new http.Agent({ keepAlive: false, maxSockets: 1, maxFreeSockets: 0 });
      const chunks: Buffer[] = [];
      let total = 0;
      let firstByteSeen = false;
      let declaredContentLength: number | undefined;

      const destroyChannel = () => {
        if (destroyed) return;
        destroyed = true;
        this.channels.delete(channel);
        if (!channel.destroyed) channel.destroy();
      };
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
        destroyChannel();
        channel.removeListener('close', onChannelClose);
        channel.removeListener('error', onChannelError);
      };
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (!responseEnded) request?.destroy();
        cleanup();
        fn();
      };
      const fail = (code: 'cancelled' | 'incomplete' | 'engine_unavailable' | 'timeout', message: string) => {
        this.traceEvent({ phase: 'output_end', clientId: this.clientId(client), requestId, operation: 'ragflow_http', outcome: code, bytes: total, startedAtMs, budgetMs: RAGFLOW_LIMITS.timeoutMs });
        finish(() => reject(new TransportError(code, message)));
      };
      const finishResponse = (outcome: string, fn: () => void) => {
        this.traceEvent({ phase: 'output_end', clientId: this.clientId(client), requestId, operation: 'ragflow_http', outcome, bytes: total, startedAtMs, budgetMs: RAGFLOW_LIMITS.timeoutMs });
        finish(fn);
      };
      const onAbort = () => fail('cancelled', 'RAGFlow 读取请求已取消。');
      const onChannelError = () => fail('engine_unavailable', 'RAGFlow 只读通道失败。');
      const onChannelClose = () => {
        if (!responseEnded) fail('incomplete', 'RAGFlow 响应未完成。');
      };
      const onResponse = (response: http.IncomingMessage) => {
        response.once('error', () => {
          if (!settled) fail('engine_unavailable', 'RAGFlow 响应读取失败。');
        });
        response.once('aborted', () => {
          if (!settled) fail('incomplete', 'RAGFlow 响应未完成。');
        });
        if (response.statusCode !== undefined && response.statusCode >= 300 && response.statusCode < 400) {
          response.resume();
          finishResponse('redirect', () => reject(new TransportError('redirect', 'RAGFlow 来源禁止重定向。')));
          return;
        }
        if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          finishResponse('http_error', () => reject(new TransportError('http_error', 'RAGFlow HTTP 读取失败。')));
          return;
        }
        const contentLength = response.headers['content-length'];
        const contentLengthText = Array.isArray(contentLength) ? contentLength[0] : contentLength;
        if (contentLengthText !== undefined) {
          const declared = Number(contentLengthText);
          if (!Number.isSafeInteger(declared) || declared < 0) {
            response.resume();
            fail('incomplete', 'RAGFlow 响应长度无效。');
            return;
          }
          if (declared > RAGFLOW_LIMITS.maxPageBytes || (budget && declared > budget.remainingBytes)) {
            response.resume();
            fail('incomplete', 'RAGFlow 单页响应超过上限。');
            return;
          }
          declaredContentLength = declared;
        }
        const contentType = Array.isArray(response.headers['content-type']) ? response.headers['content-type'][0] : response.headers['content-type'];
        if (!contentType || !/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
          response.resume();
          finishResponse('invalid_response', () => reject(new TransportError('invalid_response', 'RAGFlow 响应类型无效。')));
          return;
        }
        response.on('data', (chunk: Buffer | string) => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (!firstByteSeen && buffer.byteLength > 0) {
            firstByteSeen = true;
            this.traceEvent({ phase: 'first_byte', clientId: this.clientId(client), requestId, operation: 'ragflow_http', outcome: 'http', bytes: Math.min(RAGFLOW_LIMITS.maxPageBytes, buffer.byteLength), startedAtMs, budgetMs: RAGFLOW_LIMITS.timeoutMs });
          }
          if (total + buffer.byteLength > RAGFLOW_LIMITS.maxPageBytes || (budget && total + buffer.byteLength > budget.remainingBytes)) {
            fail('incomplete', 'RAGFlow 单页响应超过上限。');
            return;
          }
          total += buffer.byteLength;
          chunks.push(buffer);
        });
        response.once('end', () => {
          responseEnded = true;
          if (settled) return;
          if (declaredContentLength !== undefined && total !== declaredContentLength) {
            finishResponse('incomplete', () => reject(new TransportError('incomplete', 'RAGFlow 响应长度不一致。')));
            return;
          }
          emitRagflowDiagnostic(budget, 'http_complete', response.statusCode ?? null, total);
          finishResponse('success', () => resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }));
        });
      };

      channel.once('close', onChannelClose);
      channel.once('error', onChannelError);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        agent.createConnection = () => decorateHttpChannel(channel);
        request = http.request({
          host: source.target.ip,
          port: source.target.port,
          path: requestPath,
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${source.bearerToken}`,
            Host: source.target.hostHeader ?? source.target.ip,
            Connection: 'close',
          },
          agent,
        }, onResponse);
        request.once('error', () => {
          if (!settled) fail('engine_unavailable', 'RAGFlow HTTP 请求失败。');
        });
        request.once('finish', () => emitRagflowDiagnostic(budget, 'http_sent'));
        if (settled) request.destroy();
        else request.end();
      } catch {
        fail('engine_unavailable', 'RAGFlow HTTP 请求失败。');
      }
    });
  }

  private openRagflowChannel(client: Client, target: RagflowDocumentsSource['target'], signal: AbortSignal | undefined, requestId: number, startedAtMs = Date.now(), budget?: RagflowReadBudget): Promise<ClientChannel> {
    return new Promise<ClientChannel>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(new TransportError('cancelled', 'RAGFlow 读取请求已取消。'));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        client.forwardOut('127.0.0.1', 0, target.ip, target.port, (error, channel) => {
          signal?.removeEventListener('abort', onAbort);
          if (settled) {
            channel?.destroy();
            return;
          }
          settled = true;
          if (error || !channel) {
            this.traceEvent({ phase: 'output_end', clientId: this.clientId(client), requestId, operation: 'ragflow_forward', outcome: 'engine_unavailable', startedAtMs, budgetMs: RAGFLOW_LIMITS.timeoutMs });
            reject(new TransportError('engine_unavailable', 'RAGFlow 转发通道不可用。'));
            return;
          }
          this.channels.add(channel);
          emitRagflowDiagnostic(budget, 'channel');
          this.traceEvent({ phase: 'channel_open', clientId: this.clientId(client), requestId, operation: 'ragflow_http', startedAtMs, budgetMs: RAGFLOW_LIMITS.timeoutMs });
          resolve(channel);
        });
      } catch {
        signal?.removeEventListener('abort', onAbort);
        if (!settled) {
          settled = true;
          reject(new TransportError('engine_unavailable', 'RAGFlow 转发通道不可用。'));
        }
      }
    });
  }

  private execRaw(client: Client, command: string, timeoutMs: number, maxOutputBytes: number, stdinSecret?: string, signal?: AbortSignal, requestId?: number, operation?: string, logContext?: LogReadContext): Promise<Omit<CommandResult, 'operation' | 'observedAt'>> {
    return new Promise((resolve, reject) => {
      const startedAtMs = Date.now();
      let channel: ClientChannel | undefined;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let total = 0;
      let observedBytes = 0;
      let truncated = false;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (channel) this.channels.delete(channel);
      };
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const abort = (code: 'timeout' | 'cancelled' | 'incomplete', message: string) => {
        this.traceEvent({ phase: 'output_end', clientId: this.clientId(client), requestId, operation, outcome: code, bytes: observedBytes, startedAtMs, budgetMs: timeoutMs }, logContext);
        if (channel) channel.destroy();
        finish(() => reject(new TransportError(code, message)));
      };
      const onAbort = () => abort('cancelled', '观察请求已取消。');
      const collect = (chunk: Buffer, target: Buffer[]) => {
        if (settled) return;
        observedBytes = Math.min(maxOutputBytes, observedBytes + chunk.byteLength);
        const remaining = maxOutputBytes - total;
        if (chunk.byteLength > remaining) {
          if (remaining > 0) target.push(chunk.subarray(0, remaining));
          truncated = true;
          abort('incomplete', '远端观察输出超过上限。');
          return;
        }
        target.push(chunk);
        total += chunk.byteLength;
      };
      timer = setTimeout(() => abort('timeout', '远端观察请求超时。'), timeoutMs);
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        this.traceEvent({ phase: 'exec_start', clientId: this.clientId(client), requestId, operation, startedAtMs, budgetMs: timeoutMs }, logContext);
        client.exec(command, { pty: false }, (error, stream) => {
          if (settled) {
            stream?.destroy();
            return;
          }
          if (error || !stream) {
            this.traceEvent({ phase: 'output_end', clientId: this.clientId(client), requestId, operation, outcome: 'channel_error', bytes: observedBytes, startedAtMs, budgetMs: timeoutMs }, logContext);
            finish(() => reject(new TransportError('engine_unavailable', '远端 Docker 只读请求无法启动。')));
            return;
          }
          channel = stream;
          this.channels.add(stream);
          this.traceEvent({ phase: 'channel_open', clientId: this.clientId(client), requestId, operation, startedAtMs, budgetMs: timeoutMs }, logContext);
          let firstByteSeen = false;
          const markFirstByte = (streamName: 'stdout' | 'stderr', chunk: Buffer) => {
            if (firstByteSeen || chunk.byteLength === 0) return;
            firstByteSeen = true;
            this.traceEvent({ phase: 'first_byte', clientId: this.clientId(client), requestId, operation, outcome: streamName, bytes: Math.min(maxOutputBytes, chunk.byteLength), startedAtMs, budgetMs: timeoutMs }, logContext);
          };
          stream.on('data', (chunk: Buffer) => { markFirstByte('stdout', chunk); collect(chunk, stdout); });
          stream.stderr.on('data', (chunk: Buffer) => { markFirstByte('stderr', chunk); collect(chunk, stderr); });
          stream.once('error', () => {
            this.traceEvent({ phase: 'output_end', clientId: this.clientId(client), requestId, operation, outcome: 'stream_error', bytes: observedBytes, startedAtMs, budgetMs: timeoutMs }, logContext);
            finish(() => reject(new TransportError('engine_unavailable', '远端 Docker 只读请求失败。')));
          });
          stream.once('close', (code: number | null) => finish(() => {
            this.traceEvent({ phase: 'output_end', clientId: this.clientId(client), requestId, operation, outcome: truncated ? 'incomplete' : String(code ?? 'null'), bytes: observedBytes, startedAtMs, budgetMs: timeoutMs }, logContext);
            if (truncated) reject(new TransportError('incomplete', '远端观察输出超过上限。'));
            else if (code !== 0 && /sudo|password|permission denied/i.test(Buffer.concat(stderr).toString('utf8'))) reject(new TransportError('sudo_denied', '远端只读权限不足。'));
            else if (code !== 0) reject(new TransportError('engine_unavailable', '远端 Docker 只读请求未完成。'));
            else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), code, truncated });
          }));
          if (stdinSecret !== undefined) {
            stream.stdin.write(`${stdinSecret}\n`);
            stream.stdin.end();
          }
        });
      } catch {
        this.traceEvent({ phase: 'output_end', clientId: this.clientId(client), requestId, operation, outcome: 'exec_error', bytes: observedBytes, startedAtMs, budgetMs: timeoutMs }, logContext);
        finish(() => reject(new TransportError('engine_unavailable', '远端 Docker 只读请求失败。')));
      }
    });
  }

  private clientId(client: Client) {
    return this.clientIds.get(client) ?? 0;
  }

  private traceEvent(event: SshDockerTraceEventInput, context?: LogReadContext) {
    if (!this.trace) return;
    try {
      const atMs = Date.now();
      const { startedAtMs, monotonicStartedAtMs, ...safeEvent } = event;
      this.trace({
        ...safeEvent,
        ...(context && event.readAttemptId === undefined ? { readAttemptId: context.readAttemptId } : {}),
        connectionGeneration: event.connectionGeneration ?? this.connectionGeneration,
        channels: event.channels ?? this.channels.size,
        elapsedMs: monotonicStartedAtMs === undefined
          ? startedAtMs === undefined ? 0 : Math.max(0, atMs - startedAtMs)
          : Math.max(0, monotonicNowMs() - monotonicStartedAtMs),
        atMs,
      });
    } catch {
      // Trace consumers must never affect read-only collection.
    }
  }
}

export async function readKnownHosts(filePath: string, host: string, port: number): Promise<KnownHostRecord[]> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    throw new TransportError('host_key_untrusted', '既有 known_hosts 不可读取。');
  }
  const target = port === 22 ? host : `[${host}]:${port}`;
  const records: KnownHostRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3 || line.startsWith('#')) continue;
    const hostField = fields[0];
    const key = fields[2];
    if (!hostField || !key || hostField.startsWith('|')) continue;
    if (!hostField.split(',').some((pattern) => pattern === target || (port === 22 && pattern === host))) continue;
    records.push({ hostPatterns: hostField.split(','), fingerprint: fingerprintForBase64Key(key), fingerprintHex: fingerprintHexForBase64Key(key) });
  }
  return records;
}

export function fingerprintForBase64Key(base64Key: string): string {
  const digest = createHash('sha256').update(Buffer.from(base64Key, 'base64')).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

export function fingerprintHexForBase64Key(base64Key: string): string {
  return createHash('sha256').update(Buffer.from(base64Key, 'base64')).digest('hex');
}

function normalizeFingerprint(value: string) {
  return value.replace(/=+$/, '');
}

function assertQuantPostgresTarget(target: QuantPostgresTarget): void {
  if (!/^[a-f0-9]{64}$/.test(target.containerId)
    || !/^[0-9a-fA-F:.]+$/.test(target.ip)
    || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535
    || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(target.network)
    || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(target.composeProject)
    || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(target.composeService)) {
    throw new TransportError('profile_invalid', 'Quant 数据库目标登记无效。');
  }
}

function parseQuantPostgresTargetInspect(stdout: string, target: QuantPostgresTarget, observedAt: string): QuantPostgresTargetMetadata {
  const fields = stdout.trim().split(/\r?\n/)[0]?.split('\t') ?? [];
  if (fields.length !== 6) throw new TransportError('incomplete', 'Quant 数据库部署身份字段不完整。');
  const [idText, stateText, labelsText, networksText, exposedText, publishedText] = fields;
  const id = parseJsonString(idText);
  const state = parseJsonString(stateText);
  const labels = parseObject(labelsText);
  const networks = parseObject(networksText);
  const exposed = parseObject(exposedText);
  const published = parseObject(publishedText);
  const network = networks?.[target.network];
  const ip = isRecord(network) && typeof network.IPAddress === 'string'
    ? network.IPAddress
    : undefined;
  const exposedKey = `${target.port}/tcp`;
  const publishedKey = published && Object.prototype.hasOwnProperty.call(published, exposedKey);
  if (id !== target.containerId || state !== 'running'
    || labels?.['com.docker.compose.project'] !== target.composeProject
    || labels?.['com.docker.compose.service'] !== target.composeService
    || ip !== target.ip
    || !(exposed && Object.prototype.hasOwnProperty.call(exposed, exposedKey))
    || (!publishedKey && target.port !== 5432)) {
    throw new TransportError('engine_unavailable', 'Quant 数据库部署身份已变化。');
  }
  return {
    containerId: target.containerId,
    state: 'running',
    network: target.network,
    ip: target.ip,
    port: target.port,
    composeProject: target.composeProject,
    composeService: target.composeService,
    observedAt,
  };
}

function parseJsonString(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    throw new TransportError('incomplete', 'Quant 数据库部署身份字段无效。');
  }
}

function parseObject(value: string | undefined): Record<string, unknown> | null {
  if (!value || value === 'null') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    throw new TransportError('incomplete', 'Quant 数据库部署身份格式无效。');
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isRagflowPath(value: string): boolean {
  return /^\/api\/v1\/datasets\/[a-zA-Z0-9_-]{1,128}\/ingestions\/summary$/.test(value)
    || /^\/api\/v1\/datasets\/[a-zA-Z0-9_-]{1,128}\/ingestions\?page=(?:[1-9]|[1-9][0-9]|[1-4][0-9]{2}|50[0-9]|51[0-2])&page_size=1&orderby=create_time&desc=true&log_type=file(?:&operation_status=4)?$/.test(value);
}

function decorateHttpChannel(channel: ClientChannel): import('node:stream').Duplex {
  type HttpSocket = ClientChannel & {
    setKeepAlive?: (enable?: boolean, initialDelay?: number) => HttpSocket;
    setNoDelay?: (noDelay?: boolean) => HttpSocket;
    setTimeout?: (msecs: number, callback?: () => void) => HttpSocket;
    ref?: () => HttpSocket;
    unref?: () => HttpSocket;
    destroySoon?: () => void;
  };
  const socket = channel as HttpSocket;
  socket.setKeepAlive ??= () => socket;
  socket.setNoDelay ??= () => socket;
  socket.setTimeout ??= () => socket;
  socket.ref ??= () => socket;
  socket.unref ??= () => socket;
  socket.destroySoon ??= () => socket.destroy();
  return socket;
}
