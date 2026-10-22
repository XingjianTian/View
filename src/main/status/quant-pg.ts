import { createHash } from 'node:crypto';
import { Client, type ClientConfig, type QueryResult } from 'pg';
import { sanitizeId, statusSourceRef, type StatusActivity, type StatusFeedError, type StatusOutcome, type StatusRecord } from '../../shared/status.js';
import type { DockerTransport } from '../transport/types.js';
import type { RegisteredQuantPgSource } from './source-registry.js';

type QuantRecord = Omit<StatusRecord, 'serviceId'>;

export type QuantPgReadResult = {
  sourceRef: string;
  observedAt: string;
  health: 'fresh' | 'error';
  lastSuccessAt: string | null;
  records: QuantRecord[];
  hasMore: boolean;
  gap: boolean;
  errorCode: QuantPgErrorCode | null;
};

type QuantPgErrorCode = Extract<StatusFeedError, 'status_timeout' | 'status_incomplete' | 'status_source' | 'status_auth' | 'status_permission' | 'status_schema' | 'status_connection'>;

export type QuantPgSourceResolver = (profileId: string, sourceRef: string) => Promise<RegisteredQuantPgSource | null>;
export type QuantPgTransportLease = { transport: DockerTransport; release: () => void | Promise<void> };
export type QuantPgTransportAcquirer = (profileId: string) => Promise<QuantPgTransportLease | null>;
export type QuantPgClientLike = {
  connect: () => Promise<void>;
  query: (query: string | { text: string; values?: unknown[] }) => Promise<QueryResult<Record<string, unknown>>>;
  on: (event: 'error', listener: (error: Error) => void) => unknown;
  end: () => Promise<void>;
};
export type QuantPgClientFactory = (config: ClientConfig) => QuantPgClientLike;

export const QUANT_SCANS_COLUMNS = 'id, scan_id, status, task_id, total_stocks, passed_stocks, trigger_source, started_at, completed_at, analytics_completed_at';
export const QUANT_TASK_COLUMNS = 'id, task_name, task_id, status, triggered_by, started_at, completed_at, duration_seconds';
export const QUANT_SESSION_SQL = `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout = '1500ms'; SET LOCAL lock_timeout = '250ms'; SET LOCAL idle_in_transaction_session_timeout = '2000ms'`;
export const QUANT_METADATA_SQL = `WITH relation_info AS (SELECT c.oid, c.relname, c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname IN ('scans', 'task_execution_history')) SELECT current_database() AS database_name, current_user AS user_name, current_setting('transaction_read_only') AS read_only, (SELECT relkind FROM relation_info WHERE relname = 'scans') AS scans_relkind, (SELECT relkind FROM relation_info WHERE relname = 'task_execution_history') AS task_history_relkind, (SELECT COUNT(*) = 10 FROM pg_catalog.pg_attribute a JOIN relation_info r ON r.oid = a.attrelid WHERE r.relname = 'scans' AND a.attnum > 0 AND NOT a.attisdropped AND a.attname IN ('id', 'scan_id', 'status', 'task_id', 'total_stocks', 'passed_stocks', 'trigger_source', 'started_at', 'completed_at', 'analytics_completed_at')) AS scans_columns_ok, (SELECT COUNT(*) = 8 FROM pg_catalog.pg_attribute a JOIN relation_info r ON r.oid = a.attrelid WHERE r.relname = 'task_execution_history' AND a.attnum > 0 AND NOT a.attisdropped AND a.attname IN ('id', 'task_name', 'task_id', 'status', 'triggered_by', 'started_at', 'completed_at', 'duration_seconds')) AS task_history_columns_ok`;
export const QUANT_SESSION_METADATA_SQL = `${QUANT_SESSION_SQL}; ${QUANT_METADATA_SQL}`;
export const QUANT_SCANS_RECENT_SQL = `SELECT ${QUANT_SCANS_COLUMNS} FROM public.scans ORDER BY started_at DESC NULLS LAST, id DESC LIMIT 41`;
export const QUANT_SCANS_FILTERED_SQL = `SELECT ${QUANT_SCANS_COLUMNS} FROM public.scans WHERE scan_id = ANY($1::text[]) ORDER BY started_at DESC NULLS LAST, id DESC LIMIT 41`;
export const QUANT_SCANS_AFTER_SQL = `SELECT ${QUANT_SCANS_COLUMNS} FROM public.scans WHERE (started_at, id) < ($1::timestamptz, $2::bigint) ORDER BY started_at DESC NULLS LAST, id DESC LIMIT 41`;
export const QUANT_TASKS_RECENT_SQL = `SELECT ${QUANT_TASK_COLUMNS} FROM public.task_execution_history ORDER BY started_at DESC NULLS LAST, id DESC LIMIT 41`;
export const QUANT_TASKS_FILTERED_SQL = `SELECT ${QUANT_TASK_COLUMNS} FROM public.task_execution_history WHERE task_name = ANY($1::text[]) ORDER BY started_at DESC NULLS LAST, id DESC LIMIT 41`;
export const QUANT_TASKS_AFTER_SQL = `SELECT ${QUANT_TASK_COLUMNS} FROM public.task_execution_history WHERE (started_at, id) < ($1::timestamptz, $2::bigint) ORDER BY started_at DESC NULLS LAST, id DESC LIMIT 41`;
// The private source may opt into this only after the registry records the
// audited single-Quant-database scope. Metadata is queried and validated in a
// separate statement before this business-only batch is sent.
export const QUANT_RECENT_DATA_BATCH_SQL = `${QUANT_SCANS_RECENT_SQL}; ${QUANT_TASKS_RECENT_SQL}`;

const MAX_ROWS = 40;
const MAX_BYTES = 256 * 1024;
const TOTAL_DEADLINE_MS = 5_000;
// The overall reader deadline remains five seconds.  The connection allowance
// may use the remaining budget after SSH verification/channel setup; keeping
// this above two seconds avoids cutting off the final SCRAM response on a
// private forwarded link while the outer deadline still bounds the operation.
const CONNECT_TIMEOUT_MS = 3_000;
const STATEMENT_TIMEOUT_MS = 1_500;
const LOCK_TIMEOUT_MS = 250;
const VALID_SCAN_STATUS = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);
const VALID_TASK_STATUS = new Set(['queued', 'running', 'completed', 'failed']);
const VALID_TRIGGER = new Set(['manual', 'auto']);
const VALID_TRIGGERED_BY = new Set(['schedule', 'manual']);

type ScanRow = Record<string, unknown>;
type TaskRow = Record<string, unknown>;

class QuantSchemaError extends Error {
  readonly code = 'quant_schema';

  constructor() {
    super('Quant 只读合同未确认。');
    this.name = 'QuantSchemaError';
  }
}

export class QuantPgStatusAdapter {
  private readonly inFlight = new Map<string, Promise<QuantPgReadResult>>();

  constructor(private readonly resolveSource: QuantPgSourceResolver, private readonly acquireTransport: QuantPgTransportAcquirer, private readonly createClient: QuantPgClientFactory = (config) => new Client(config)) {}

  async readSnapshots(profileId: string, sourceRef: string, signal?: AbortSignal, now = new Date()): Promise<QuantPgReadResult> {
    const key = `${profileId}\u001f${sourceRef}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const read = this.readSnapshotsInternal(profileId, sourceRef, signal, now);
    this.inFlight.set(key, read);
    try {
      return await read;
    } finally {
      if (this.inFlight.get(key) === read) this.inFlight.delete(key);
    }
  }

  private async readSnapshotsInternal(profileId: string, sourceRef: string, signal: AbortSignal | undefined, now: Date): Promise<QuantPgReadResult> {
    const feedSourceRef = statusSourceRef('quant_pg_receipts', `${profileId}:${sourceRef}`);
    if (signal?.aborted) return this.error(feedSourceRef, now.toISOString(), 'status_timeout');
    const deadline = new AbortController();
    const startedAt = Date.now();
    let timer: NodeJS.Timeout | undefined;
    let lease: QuantPgTransportLease | null = null;
    let channel: { close: () => void } | null = null;
    let client: QuantPgClientLike | null = null;
    let timedOut = false;
    const abort = () => deadline.abort();
    const remainingMs = () => Math.max(1, TOTAL_DEADLINE_MS - (Date.now() - startedAt));
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(abort, TOTAL_DEADLINE_MS);
    try {
      const registered = await this.resolveSource(profileId, sourceRef);
      if (!registered) return this.error(feedSourceRef, new Date().toISOString(), 'status_source');
      throwIfAborted(deadline.signal);
      const pendingLease = this.acquireTransport(profileId).then((value) => {
        if (deadline.signal.aborted) {
          if (value) void withCleanupBudget(Promise.resolve(value.release()), 200).catch(() => undefined);
          return null;
        }
        return value;
      });
      lease = await withDeadline(pendingLease, deadline.signal, remainingMs());
      if (!lease?.transport.verifyQuantPostgresTarget || !lease.transport.openQuantPostgresChannel) return this.error(feedSourceRef, new Date().toISOString(), 'status_source');
      throwIfAborted(deadline.signal);
      const pendingChannel = lease.transport.openQuantPostgresChannel(registered.target, deadline.signal).then((value) => {
        if (deadline.signal.aborted) {
          value.close();
          throw new Error('timeout');
        }
        return value;
      });
      // The verification path may abort before the channel promise is
      // awaited. Mark its rejection handled immediately so a late SSH error
      // cannot become an unhandled rejection after this reader returns.
      void pendingChannel.catch(() => undefined);
      // Open the SSH direct-tcpip channel while the fixed Docker identity
      // projection is checked, but do not create the PostgreSQL client or send
      // bytes until verification succeeds. This keeps the target check directly
      // adjacent to forwarding while leaving the five-second budget for reads.
      try {
        await withDeadline(lease.transport.verifyQuantPostgresTarget(registered.target, deadline.signal), deadline.signal, remainingMs());
      } catch (error) {
        void pendingChannel.then((value) => value.close()).catch(() => undefined);
        throw error;
      }
      throwIfAborted(deadline.signal);
      const opened = await withDeadline(pendingChannel, deadline.signal, remainingMs());
      channel = opened;
      client = this.createClient({
        user: registered.credential.username,
        password: registered.credential.password,
        database: registered.credential.database,
        host: registered.target.ip,
        port: registered.target.port,
        stream: () => opened.stream,
        connectionTimeoutMillis: Math.min(CONNECT_TIMEOUT_MS, remainingMs()),
        query_timeout: Math.min(STATEMENT_TIMEOUT_MS, remainingMs()),
        statement_timeout: STATEMENT_TIMEOUT_MS,
        application_name: 'service-observatory-readonly',
      });
      client.on('error', () => undefined);
      await withDeadline(client.connect(), deadline.signal, remainingMs());
      let scans: { rows: ScanRow[]; hasMore: boolean };
      let tasks: { rows: TaskRow[]; hasMore: boolean };
      if (registered.scanIds.length === 0 && registered.taskNames.length === 0 && registered.allowRecent && registered.scopeVerified) {
        const metadata = await querySimpleResult(client, QUANT_SESSION_METADATA_SQL, deadline.signal, remainingMs());
        validateMetadata(metadata.rows[0], registered.credential.database);
        const results = await queryBatch(client, QUANT_RECENT_DATA_BATCH_SQL, deadline.signal, remainingMs());
        const scansResult = results.at(-2);
        const tasksResult = results.at(-1);
        if (!scansResult || !tasksResult) throw new Error('Quant 只读结果不完整。');
        scans = { rows: boundRows(scansResult.rows), hasMore: scansResult.rows.length > MAX_ROWS };
        tasks = { rows: boundRows(tasksResult.rows), hasMore: tasksResult.rows.length > MAX_ROWS };
      } else {
        const metadata = await querySimpleResult(client, QUANT_SESSION_METADATA_SQL, deadline.signal, remainingMs());
        validateMetadata(metadata.rows[0], registered.credential.database);
        [scans, tasks] = await Promise.all([
          readScans(client, registered, deadline.signal, remainingMs()),
          readTasks(client, registered, deadline.signal, remainingMs()),
        ]);
      }
      const observedAt = new Date().toISOString();
      const records = mapRecords(feedSourceRef, scans.rows, tasks.rows, observedAt, scans.hasMore || tasks.hasMore);
      const partial = scans.hasMore || tasks.hasMore;
      const snapshot = mapScopeSnapshot(feedSourceRef, scans.rows, tasks.rows, observedAt, partial, scans.hasMore || tasks.hasMore);
      const allRecords = [snapshot, ...records];
      if (Buffer.byteLength(JSON.stringify(allRecords), 'utf8') > MAX_BYTES) return this.error(feedSourceRef, observedAt, 'status_incomplete');
      return {
        sourceRef: feedSourceRef,
        observedAt,
        health: partial ? 'error' : 'fresh',
        lastSuccessAt: partial ? null : observedAt,
        records: allRecords,
        hasMore: scans.hasMore || tasks.hasMore,
        gap: partial,
        errorCode: partial ? 'status_incomplete' : null,
      };
    } catch (cause) {
      timedOut = isTimeout(cause, signal, deadline.signal);
      const errorCode: QuantPgErrorCode = timedOut ? 'status_timeout' : classifyQuantError(cause);
      return this.error(feedSourceRef, new Date().toISOString(), errorCode);
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      // A local query/connection deadline also needs to stop the underlying
      // pg operation immediately.  Promise.race alone would leave it running
      // on the forwarded channel after the reader has returned.
      const expired = timedOut || deadline.signal.aborted || remainingMs() <= 1;
      if (expired) channel?.close();
      if (client) await closeClient(client, Math.max(0, TOTAL_DEADLINE_MS - (Date.now() - startedAt)));
      if (!expired) channel?.close();
      if (lease) {
        const release = Promise.resolve().then(() => lease?.release()).catch(() => undefined);
        try {
          const budget = Math.max(0, TOTAL_DEADLINE_MS - (Date.now() - startedAt));
          if (budget > 0) await withCleanupBudget(release, budget);
          else void release;
        } catch { /* reader cleanup cannot reject the feed */ }
      }
    }
  }

  private error(sourceRef: string, observedAt: string, errorCode: QuantPgReadResult['errorCode']): QuantPgReadResult {
    return { sourceRef, observedAt, health: 'error', lastSuccessAt: null, records: [], hasMore: false, gap: false, errorCode };
  }
}

async function readScans(client: QuantPgClientLike, source: RegisteredQuantPgSource, signal: AbortSignal, timeoutMs: number): Promise<{ rows: ScanRow[]; hasMore: boolean }> {
  if (source.scanIds.length === 0 && (!source.allowRecent || !source.scopeVerified)) throw new Error('Quant 扫描范围未登记。');
  const queryConfig = source.scanIds.length > 0 ? QUANT_SCANS_FILTERED_SQL : QUANT_SCANS_RECENT_SQL;
  const result = await query(client, queryConfig, source.scanIds.length > 0 ? [source.scanIds] : [], signal, timeoutMs);
  return { rows: boundRows(result.rows), hasMore: result.rows.length > MAX_ROWS };
}

async function readTasks(client: QuantPgClientLike, source: RegisteredQuantPgSource, signal: AbortSignal, timeoutMs: number): Promise<{ rows: TaskRow[]; hasMore: boolean }> {
  if (source.taskNames.length === 0 && (!source.allowRecent || !source.scopeVerified)) throw new Error('Quant 任务范围未登记。');
  const useNames = source.taskNames.length > 0;
  const queryConfig = useNames ? QUANT_TASKS_FILTERED_SQL : QUANT_TASKS_RECENT_SQL;
  const result = await query(client, queryConfig, useNames ? [source.taskNames] : [], signal, timeoutMs);
  return { rows: boundRows(result.rows), hasMore: result.rows.length > MAX_ROWS };
}

function mapRecords(sourceRef: string, scans: readonly ScanRow[], tasks: readonly TaskRow[], observedAt: string, incomplete: boolean): QuantRecord[] {
  const records = [
    ...scans.map((row) => mapScan(sourceRef, row, observedAt, incomplete)),
    ...tasks.map((row) => mapTask(sourceRef, row, observedAt, incomplete)),
  ];
  return records.filter((record): record is QuantRecord => record !== null);
}

function mapScan(sourceRef: string, row: ScanRow, observedAt: string, incomplete: boolean): QuantRecord | null {
  const id = safePositiveInt(row.id);
  const scanId = safeOpaque(row.scan_id);
  if (id === null || !scanId) return null;
  const status = safeEnum(row.status, VALID_SCAN_STATUS);
  const taskId = safeOpaqueNullable(row.task_id);
  const startedAt = safeDate(row.started_at);
  const completedAt = safeDate(row.completed_at);
  const analyticsCompletedAt = safeDate(row.analytics_completed_at);
  const triggerSource = safeEnum(row.trigger_source, VALID_TRIGGER) ?? 'unknown';
  const outcome = outcomeFor(status);
  const label = scanStage(status);
  const hash = shortHash(sourceRef, 'scan', scanId, id, status, startedAt, completedAt, analyticsCompletedAt, row.total_stocks, row.passed_stocks);
  const facts: Record<string, string | number | boolean | null> = {
    businessKind: 'scan',
    status,
    scanHash: shortHash(scanId),
    taskHash: taskId ? shortHash(taskId) : null,
    triggerSource,
    totalStocks: safeCount(row.total_stocks),
    passedStocks: safeCount(row.passed_stocks),
    analyticsCompleted: analyticsCompletedAt !== null,
    attempt: null,
    incomplete,
  };
  return {
    id: sanitizeId(`quant-scan-${hash}`, 'quant-scan'),
    sourceRef,
    taskKey: sanitizeId(`quant-task-${shortHash(taskId ?? scanId)}`, 'quant-task'),
    stage: label,
    outcome,
    summary: status === 'failed' ? `扫描：${label}（来源未提供详细原因）` : `扫描：${label}`,
    occurredAt: terminal(status) ? completedAt : null,
    sourceAt: terminal(status) ? completedAt ?? startedAt : startedAt,
    observedAt,
    evidenceKind: 'stage_receipt',
    facts,
    evidenceRef: sanitizeId(`quant-scan-${shortHash(scanId)}`, 'quant-scan-evidence'),
  };
}

function mapTask(sourceRef: string, row: TaskRow, observedAt: string, incomplete: boolean): QuantRecord | null {
  const id = safePositiveInt(row.id);
  const taskName = safeOpaque(row.task_name);
  if (id === null || !taskName) return null;
  const status = safeEnum(row.status, VALID_TASK_STATUS);
  const taskId = safeOpaqueNullable(row.task_id);
  const startedAt = safeDate(row.started_at);
  const completedAt = safeDate(row.completed_at);
  const triggeredBy = safeEnum(row.triggered_by, VALID_TRIGGERED_BY) ?? 'unknown';
  const outcome = outcomeFor(status);
  const historyKey = `${taskName}:${id}`;
  const hash = shortHash(sourceRef, 'task', taskName, id, taskId, status, startedAt, completedAt, row.duration_seconds);
  const facts: Record<string, string | number | boolean | null> = {
    businessKind: 'task_history',
    taskType: taskLabel(taskName),
    status,
    taskHash: shortHash(historyKey),
    externalTaskHash: taskId ? shortHash(taskId) : null,
    triggeredBy,
    durationSeconds: safeDuration(row.duration_seconds),
    attempt: null,
    incomplete,
  };
  return {
    id: sanitizeId(`quant-task-${hash}`, 'quant-task'),
    sourceRef,
    taskKey: sanitizeId(`quant-task-${shortHash(historyKey)}`, 'quant-task'),
    stage: taskStage(status),
    outcome,
    summary: status === 'failed'
      ? `后台任务：${taskLabel(taskName)} · ${taskStage(status)}（来源未提供详细原因）`
      : `后台任务：${taskLabel(taskName)} · ${taskStage(status)}`,
    occurredAt: terminal(status) ? completedAt : null,
    sourceAt: terminal(status) ? completedAt ?? startedAt : startedAt,
    observedAt,
    evidenceKind: 'stage_receipt',
    facts,
    evidenceRef: sanitizeId(`quant-history-${shortHash(taskName, id)}`, 'quant-history-evidence'),
  };
}

function mapScopeSnapshot(sourceRef: string, scans: readonly ScanRow[], tasks: readonly TaskRow[], observedAt: string, partial: boolean, hasMore: boolean): QuantRecord {
  const scanCounts = countStatuses(scans, VALID_SCAN_STATUS);
  const taskCounts = countStatuses(tasks, VALID_TASK_STATUS);
  const activeScans = (scanCounts.queued ?? 0) + (scanCounts.running ?? 0);
  const activeTasks = (taskCounts.queued ?? 0) + (taskCounts.running ?? 0);
  const active = activeScans + activeTasks;
  const failedScans = scanCounts.failed ?? 0;
  const failedTasks = taskCounts.failed ?? 0;
  const failed = failedScans + failedTasks;
  const completedScans = scanCounts.completed ?? 0;
  const completedTasks = taskCounts.completed ?? 0;
  const completed = completedScans + completedTasks;
  const cancelledScans = scanCounts.cancelled ?? 0;
  const cancelledTasks = taskCounts.cancelled ?? 0;
  const cancelled = cancelledScans + cancelledTasks;
  const unknownScans = scanCounts.unknown ?? 0;
  const unknownTasks = taskCounts.unknown ?? 0;
  const unknown = unknownScans + unknownTasks;
  const recorded = scans.length + tasks.length;
  const range = partial ? (hasMore ? '仍有更多记录' : '范围尚不完整') : '范围完整';
  const summaryParts: string[] = [];
  if (completedScans > 0) summaryParts.push(`扫描完成${completedScans}`);
  if (completedTasks > 0) summaryParts.push(`任务完成${completedTasks}`);
  if (failed > 0) summaryParts.push(`失败${failed}`);
  if (cancelled > 0) summaryParts.push(`取消${cancelled}`);
  if (unknown > 0) summaryParts.push(`未知${unknown}`);
  if (active > 0) summaryParts.push(`源记录排队/运行${active}`);
  if (tasks.length === 0) summaryParts.push('任务历史0条');
  const summary = recorded === 0 ? `本次范围暂无可用记录；${range}；当前活动未由历史记录确认` : `${summaryParts.join('，')}；${range}；当前活动未由历史记录确认`;
  const activityState: StatusActivity = 'historical';
  const sourceAt = [...scans, ...tasks].map((row) => safeDate(row.completed_at) ?? safeDate(row.started_at)).filter((value): value is string => value !== null).sort().at(-1) ?? null;
  const facts: Record<string, string | number | boolean | null> = {
    businessKind: 'scope',
    scansRead: scans.length,
    tasksRead: tasks.length,
    recorded,
    activeRecorded: active,
    activeScans,
    activeTasks,
    completedScans,
    completedTasks,
    failedScans,
    failedTasks,
    failedRecorded: failed,
    cancelledScans,
    cancelledTasks,
    unknownScans,
    unknownTasks,
    hasMore,
    incomplete: partial,
    activityState,
  };
  const outcome: StatusOutcome = recorded === 0 || unknown > 0 || active > 0
    ? 'unknown'
    : failed > 0 && completed === 0 && cancelled === 0
      ? 'failed'
      : failed > 0 || cancelled > 0 || partial
        ? 'partial'
        : completed > 0
          ? 'succeeded'
          : 'unknown';
  return {
    id: sanitizeId(`quant-scope-${shortHash(sourceRef, scans.length, tasks.length, activeScans, activeTasks, completedScans, completedTasks, failedScans, failedTasks, cancelledScans, cancelledTasks, unknownScans, unknownTasks, partial, hasMore)}`, 'quant-scope'),
    sourceRef,
    taskKey: null,
    stage: '已读范围',
    outcome,
    summary,
    occurredAt: null,
    sourceAt,
    observedAt,
    evidenceKind: 'snapshot_diff',
    facts,
    evidenceRef: `quant-scope-${shortHash(sourceRef)}`,
  };
}

function validateMetadata(row: unknown, database: string): void {
  if (!isRecord(row) || row.read_only !== 'on' || row.database_name !== database || row.scans_relkind !== 'r' || row.task_history_relkind !== 'r' || row.scans_columns_ok !== true || row.task_history_columns_ok !== true) {
    throw new QuantSchemaError();
  }
}

async function query(client: QuantPgClientLike, text: string, values: readonly unknown[], signal: AbortSignal, timeoutMs: number): Promise<QueryResult<Record<string, unknown>>> {
  throwIfAborted(signal);
  return withDeadline(client.query({ text, values: [...values] }), signal, timeoutMs);
}

async function querySimpleResult(client: QuantPgClientLike, text: string, signal: AbortSignal, timeoutMs: number): Promise<QueryResult<Record<string, unknown>>> {
  throwIfAborted(signal);
  const raw = await withDeadline(client.query(text), signal, timeoutMs) as unknown;
  if (Array.isArray(raw)) return (raw.at(-1) as QueryResult<Record<string, unknown>> | undefined) ?? { command: '', rowCount: 0, oid: 0, fields: [], rows: [] };
  return raw as QueryResult<Record<string, unknown>>;
}

async function queryBatch(client: QuantPgClientLike, text: string, signal: AbortSignal, timeoutMs: number): Promise<QueryResult<Record<string, unknown>>[]> {
  throwIfAborted(signal);
  const raw = await withDeadline(client.query(text), signal, timeoutMs) as unknown;
  return Array.isArray(raw) ? raw as QueryResult<Record<string, unknown>>[] : [raw as QueryResult<Record<string, unknown>>];
}

function boundRows(rows: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.slice(0, MAX_ROWS);
}

function countStatuses(rows: readonly Record<string, unknown>[], allowed: ReadonlySet<string>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const row of rows) {
    const status = safeEnum(row.status, allowed) ?? 'unknown';
    result[status] = (result[status] ?? 0) + 1;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeEnum(value: unknown, allowed: ReadonlySet<string>): string {
  return typeof value === 'string' && allowed.has(value) ? value : 'unknown';
}

function safeOpaque(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[a-zA-Z0-9_.:-]+$/.test(value) ? value : null;
}

function safeOpaqueNullable(value: unknown): string | null {
  return value === null || value === undefined ? null : safeOpaque(value);
}

function safePositiveInt(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function safeCount(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function safeDuration(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 && number <= 86_400 ? number : null;
}

function safeDate(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:?\d{2})$/.test(value.trim())) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function terminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function outcomeFor(status: string): StatusOutcome {
  if (status === 'completed') return 'succeeded';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  // Database history has no heartbeat. A queued/running row is not proof of
  // current activity, so keep the fact while avoiding a false live headline.
  return 'unknown';
}

function scanStage(status: string): string {
  if (status === 'queued') return '记录排队';
  if (status === 'running') return '记录运行中';
  if (status === 'completed') return '扫描完成';
  if (status === 'failed') return '扫描失败';
  if (status === 'cancelled') return '扫描已取消';
  return '扫描状态未知';
}

function taskStage(status: string): string {
  if (status === 'queued') return '记录排队';
  if (status === 'running') return '记录运行中';
  if (status === 'completed') return '后台任务完成';
  if (status === 'failed') return '后台任务失败';
  return '后台任务状态未知';
}

function taskLabel(taskName: string): string {
  if (taskName.startsWith('daily-market-pipeline-')) return '市场流水线';
  if (taskName.startsWith('weekly-universe-refresh-')) return '市场范围刷新';
  if (taskName === 'weekly-full-refresh') return '全量缓存刷新';
  if (taskName === 'weekly-orphaned-scan-cleanup') return '扫描清理';
  if (taskName === 'weekly-fundamental-refresh') return '基本面刷新';
  if (taskName === 'monthly-price-data-cleanup') return '历史价格清理';
  return '已登记后台任务';
}

function shortHash(...values: unknown[]): string {
  return createHash('sha256').update(values.map((value) => String(value ?? '')).join('\u001f')).digest('hex').slice(0, 12);
}

async function withDeadline<T>(promise: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  if (signal.aborted) throw new Error('timeout');
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), Math.max(1, timeoutMs)); });
  const abort = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('timeout'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, timeout, abort]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('timeout');
}

function isTimeout(error: unknown, external: AbortSignal | undefined, internal: AbortSignal): boolean {
  if (external?.aborted === true || internal.aborted) return true;
  if (!(error instanceof Error)) return false;
  const message = error.message.trim().toLowerCase();
  const errorCode = (error as unknown as { code?: unknown }).code;
  const code = typeof errorCode === 'string'
    ? errorCode.toLowerCase()
    : '';
  return message === 'timeout'
    || message.includes('timeout')
    || code === 'etimedout'
    || code === '57014'
    || code === 'timeout';
}

function classifyQuantError(error: unknown): QuantPgErrorCode {
  if (error instanceof QuantSchemaError) return 'status_schema';
  const code = safeErrorCode(error);
  if (code === '28p01' || code === '28000' || code === 'auth_failed' || code === 'authentication_failed') return 'status_auth';
  if (code === '42501' || code === 'insufficient_privilege' || code === 'permission_denied' || code === 'sudo_denied') return 'status_permission';
  if (code === '42p01' || code === '42703' || code === '42883' || code === 'quant_schema') return 'status_schema';
  if (code === 'engine_unavailable' || code === 'econnrefused' || code === 'econnreset' || code === 'epipe' || code === 'enotfound' || code === 'ehostunreach' || code === 'eai_again' || code === '08000' || code === '08001' || code === '08003' || code === '08004' || code === '08006' || code === '08007' || code === '08p01' || code === '57p01') return 'status_connection';
  if (code === 'incomplete') return 'status_incomplete';
  const message = error instanceof Error ? error.message.trim().toLowerCase() : '';
  if (message.includes('password authentication failed') || message.includes('authentication failed')) return 'status_auth';
  if (message.includes('permission denied') || message.includes('insufficient privilege')) return 'status_permission';
  if (message.includes('does not exist') || message.includes('undefined column') || message.includes('undefined table')) return 'status_schema';
  if (message.includes('connection refused') || message.includes('connection reset') || message.includes('channel') || message.includes('socket')) return 'status_connection';
  return 'status_source';
}

function safeErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code.trim().toLowerCase() : '';
}

async function closeClient(client: QuantPgClientLike, budgetMs: number): Promise<void> {
  let remaining = Math.max(0, budgetMs);
  if (remaining > 0) {
    const started = Date.now();
    try { await withCleanupBudget(client.query('ROLLBACK').catch(() => undefined), Math.min(200, remaining)); } catch { /* rollback is best effort */ }
    remaining = Math.max(0, remaining - (Date.now() - started));
  }
  if (remaining > 0) {
    try { await withCleanupBudget(client.end(), Math.min(250, remaining)); } catch { /* channel cleanup follows */ }
  }
}

async function withCleanupBudget<T>(promise: Promise<T>, budgetMs: number): Promise<T> {
  if (budgetMs <= 0) throw new Error('cleanup timeout');
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('cleanup timeout')), budgetMs); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
