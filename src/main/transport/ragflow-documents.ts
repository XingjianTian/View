import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { TransportError } from './types.js';

/** Limits shared by the summary and historical file-log readers. */
export const RAGFLOW_LIMITS = Object.freeze({
  maxDatasets: 8,
  maxLogPages: 512,
  maxPageBytes: 256 * 1024,
  maxTotalBytes: 512 * 1024,
  timeoutMs: 5_000,
  maxProgressMessageBytes: 8 * 1024,
});

const SOURCE_REF = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const DATASET_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const RUN_VALUES = new Set(['UNSTART', 'SCHEDULED', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED']);

export type RagflowRun = 'UNSTART' | 'SCHEDULED' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED';
export type RagflowFailureCode = 'model_not_found' | 'invalid_api_key' | 'rate_limit' | 'context_length' | 'vector_dimension' | 'timeout' | 'http_4xx' | 'http_5xx' | 'unclassified';
export type RagflowFailureStage = 'parsing' | 'embedding' | 'indexing' | 'metadata' | 'unknown';
export type RagflowFailureEvidenceLevel = 'stage_only' | 'message_classified' | 'unclassified_description' | 'source_no_detail';
export type RagflowFailureMessageClass = Exclude<RagflowFailureCode, 'unclassified'>;
export type RagflowFailureShape = {
  readonly charLength: number;
  readonly byteLength: number;
  readonly hasLF: boolean;
  readonly hasCR: boolean;
  readonly hasTab: boolean;
  readonly hasOtherControl: boolean;
  readonly oldParserWouldDrop: boolean;
};

// Narrow read of common/constants.py: the runtime enum is string-valued and
// these are the only numeric values mapped by the audited service.
const RUN_NUMERIC_VALUES: Readonly<Record<string, RagflowRun>> = Object.freeze({
  '0': 'UNSTART',
  '1': 'RUNNING',
  '2': 'CANCELLED',
  '3': 'DONE',
  '4': 'FAILED',
  '5': 'SCHEDULED',
});

export type RagflowAggregateDataset = {
  readonly datasetId: string;
  readonly total: number;
  readonly pendingCount: number;
  readonly processingCount: number;
  readonly completedCount: number;
  readonly failedCount: number;
  readonly cancelledCount: number;
  /** Difference between doc_num and known buckets; null means a conflict. */
  readonly unknownCount: number | null;
  readonly countConflict: boolean;
  /** True when all five buckets are valid and their sum does not exceed total. */
  readonly countersComplete: boolean;
};

export type RagflowAggregateRead = {
  readonly sourceRef: string;
  readonly datasets: readonly RagflowAggregateDataset[];
  readonly failedDatasetIds: readonly string[];
  readonly complete: boolean;
  readonly observedAt: string;
  /** Main-process transport window; fixtures may omit these legacy fields. */
  readonly requestStartedAt?: string;
  readonly requestCompletedAt?: string;
};

export type RagflowDiagnosticPhase = 'connection' | 'deadline' | 'target' | 'channel_wait' | 'channel' | 'http_sent' | 'http_complete' | 'schema_complete';
export type RagflowDiagnosticEvent = {
  readonly phase: RagflowDiagnosticPhase;
  readonly httpStatus: number | null;
  readonly bytes: number;
  readonly observedAt: string;
};
export type RagflowDiagnosticSink = (event: RagflowDiagnosticEvent) => void;

/** Main-process-only budget shared by one logical refresh. */
export type RagflowReadBudget = {
  readonly deadlineAtMs: number;
  remainingBytes: number;
  readonly onDiagnostic?: RagflowDiagnosticSink;
};

export function monotonicRagflowNowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

export function createRagflowReadBudget(startedAtMs = monotonicRagflowNowMs(), onDiagnostic?: RagflowDiagnosticSink): RagflowReadBudget {
  return onDiagnostic === undefined
    ? { deadlineAtMs: startedAtMs + RAGFLOW_LIMITS.timeoutMs, remainingBytes: RAGFLOW_LIMITS.maxTotalBytes }
    : { deadlineAtMs: startedAtMs + RAGFLOW_LIMITS.timeoutMs, remainingBytes: RAGFLOW_LIMITS.maxTotalBytes, onDiagnostic };
}

export function remainingRagflowReadMs(budget: RagflowReadBudget): number {
  return Math.max(0, budget.deadlineAtMs - monotonicRagflowNowMs());
}

export function emitRagflowDiagnostic(budget: RagflowReadBudget | undefined, phase: RagflowDiagnosticPhase, httpStatus: number | null = null, bytes = 0): void {
  const sink = budget?.onDiagnostic;
  if (!sink) return;
  const safeStatus = httpStatus !== null && Number.isSafeInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null;
  const safeBytes = Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0;
  try {
    sink({ phase, httpStatus: safeStatus, bytes: safeBytes, observedAt: new Date().toISOString() });
  } catch {
    // Diagnostics are observational only and must never alter a read.
  }
}

/** Main-process-only source. Never accept this shape from IPC. */
export type RagflowDocumentsSource = {
  readonly sourceRef: string;
  readonly target: RagflowForwardTarget;
  readonly bearerToken: string;
  readonly datasetIds?: readonly string[];
  /** Main-process-only next historical log page by registered dataset. */
  readonly ingestionLogPages?: Readonly<Record<string, number>>;
  /** Main-process-only fixed filter selected from a trusted summary. */
  readonly ingestionFailureOnly?: true;
};

export type RagflowForwardTarget = {
  readonly containerId: string;
  readonly ip: string;
  readonly port: number;
  readonly network?: string;
  readonly hostHeader?: string;
};

export type RagflowTargetMetadata = {
  readonly containerId: string;
  readonly ip: string;
  readonly port: number;
  readonly network: string;
  readonly state: 'running';
  readonly observedAt: string;
};

/** Only safe, renderer-eligible fields from one historical file operation. */
export type RagflowIngestionLog = {
  readonly logIdHash: string | null;
  readonly documentHash: string | null;
  readonly run: RagflowRun | null;
  readonly progress: number | null;
  readonly failureCode: RagflowFailureCode | null;
  /** Fixed text classification only; never a confirmed source error code. */
  readonly messageClassified?: RagflowFailureMessageClass | null;
  readonly failureStage: RagflowFailureStage | null;
  readonly failureEvidenceLevel: RagflowFailureEvidenceLevel | null;
  readonly failureShape: RagflowFailureShape | null;
  readonly sourceAt: string | null;
};

export type RagflowIngestionLogsDataset = {
  readonly datasetId: string;
  readonly page: number;
  /** This is a log count, never a document inventory count. */
  readonly total: number;
  readonly filter: 'all_file_logs' | 'failed_operations';
  readonly logs: readonly RagflowIngestionLog[];
  readonly hasMore: boolean;
};

export type RagflowIngestionLogsRead = {
  readonly sourceRef: string;
  readonly datasets: readonly RagflowIngestionLogsDataset[];
  readonly failedDatasetIds: readonly string[];
  readonly complete: boolean;
  readonly hasMore: boolean;
  readonly gap: boolean;
  readonly observedAt: string;
};

export type RagflowHttpResponse = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
};

export type RagflowJsonGetter = (path: string, signal?: AbortSignal) => Promise<RagflowHttpResponse>;
export type RagflowAggregateProgress = (read: RagflowAggregateRead) => void;
export type RagflowIngestionLogsProgress = (read: RagflowIngestionLogsRead) => void;

export function assertRagflowSource(source: RagflowDocumentsSource): RagflowDocumentsSource {
  if (!source || typeof source !== 'object') throw new TransportError('profile_invalid', 'RAGFlow 来源登记无效。');
  if (typeof source.sourceRef !== 'string' || !SOURCE_REF.test(source.sourceRef)) {
    throw new TransportError('profile_invalid', 'RAGFlow 来源登记无效。');
  }
  assertRagflowTarget(source.target);
  if (typeof source.bearerToken !== 'string' || source.bearerToken.length === 0 || source.bearerToken.length > 4096 || !/^[\x21-\x7e]+$/.test(source.bearerToken)) {
    throw new TransportError('profile_invalid', 'RAGFlow 私有身份引用无效。');
  }
  if (source.datasetIds !== undefined) {
    if (!Array.isArray(source.datasetIds) || source.datasetIds.length > RAGFLOW_LIMITS.maxDatasets) {
      throw new TransportError('profile_invalid', 'RAGFlow 数据集范围无效。');
    }
    const ids = new Set<string>();
    for (const id of source.datasetIds) {
      if (typeof id !== 'string' || !DATASET_ID.test(id) || ids.has(id)) {
        throw new TransportError('profile_invalid', 'RAGFlow 数据集范围无效。');
      }
      ids.add(id);
    }
  }
  if (source.ingestionLogPages !== undefined) {
    if (!source.datasetIds || typeof source.ingestionLogPages !== 'object' || Array.isArray(source.ingestionLogPages)) {
      throw new TransportError('profile_invalid', 'RAGFlow 日志分页检查点无效。');
    }
    for (const [datasetId, page] of Object.entries(source.ingestionLogPages)) {
      if (!source.datasetIds.includes(datasetId) || !Number.isSafeInteger(page) || page < 1 || page > RAGFLOW_LIMITS.maxLogPages) {
        throw new TransportError('profile_invalid', 'RAGFlow 日志分页检查点无效。');
      }
    }
  }
  if (source.ingestionFailureOnly !== undefined && source.ingestionFailureOnly !== true) {
    throw new TransportError('profile_invalid', 'RAGFlow 失败日志筛选标记无效。');
  }
  return source;
}

export function assertRagflowTarget(target: RagflowForwardTarget): RagflowForwardTarget {
  if (!target || typeof target !== 'object') throw new TransportError('profile_invalid', 'RAGFlow 部署目标无效。');
  if (typeof target.containerId !== 'string' || !CONTAINER_ID.test(target.containerId)) {
    throw new TransportError('profile_invalid', 'RAGFlow 部署目标无效。');
  }
  if (typeof target.ip !== 'string' || isIP(target.ip) === 0 || target.ip === '0.0.0.0' || target.ip === '::') {
    throw new TransportError('profile_invalid', 'RAGFlow 部署目标无效。');
  }
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
    throw new TransportError('profile_invalid', 'RAGFlow 部署目标无效。');
  }
  if (target.network !== undefined && (typeof target.network !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(target.network))) {
    throw new TransportError('profile_invalid', 'RAGFlow 部署目标无效。');
  }
  if (target.hostHeader !== undefined && (typeof target.hostHeader !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(target.hostHeader))) {
    throw new TransportError('profile_invalid', 'RAGFlow 部署目标无效。');
  }
  return target;
}

export function parseRagflowTargetInspect(stdout: string, target: RagflowForwardTarget, observedAt: string): RagflowTargetMetadata {
  assertRagflowTarget(target);
  const lines = stdout.trim().split(/\r?\n/).filter((value) => value.trim().length > 0);
  if (lines.length !== 1) throw new TransportError('incomplete', 'RAGFlow 部署身份观察结果无效。');
  const fields = lines[0]!.split('\t');
  if (fields.length !== 6) throw new TransportError('incomplete', 'RAGFlow 部署身份观察结果无效。');
  let containerId: unknown;
  let state: unknown;
  let network: unknown;
  let ip: unknown;
  let exposedPorts: unknown;
  let publishedPorts: unknown;
  try {
    containerId = JSON.parse(fields[0]!) as unknown;
    state = JSON.parse(fields[1]!) as unknown;
    network = JSON.parse(fields[2]!) as unknown;
    ip = JSON.parse(fields[3]!) as unknown;
    exposedPorts = JSON.parse(fields[4]!) as unknown;
    publishedPorts = JSON.parse(fields[5]!) as unknown;
  } catch {
    throw new TransportError('incomplete', 'RAGFlow 部署身份观察结果无效。');
  }
  if (containerId !== target.containerId || state !== 'running') throw new TransportError('profile_invalid', 'RAGFlow 部署身份已变化。');
  if (typeof network !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(network) || ip !== target.ip || (target.network !== undefined && network !== target.network)) {
    throw new TransportError('profile_invalid', 'RAGFlow 部署身份已变化。');
  }
  if (!portIsTcp(exposedPorts, target.port) && !portIsTcp(publishedPorts, target.port)) throw new TransportError('profile_invalid', 'RAGFlow 部署端口未获确认。');
  return { containerId: target.containerId, ip: target.ip, port: target.port, network, state: 'running', observedAt };
}

function portIsTcp(value: unknown, port: number): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).some((key) => key === `${port}/tcp`);
}

/** Read one bounded summary response for each registered dataset. */
export async function readRagflowAggregates(
  source: RagflowDocumentsSource,
  get: RagflowJsonGetter,
  signal?: AbortSignal,
  onProgress?: RagflowAggregateProgress,
  budget = createRagflowReadBudget(),
): Promise<RagflowAggregateRead> {
  assertRagflowSource(source);
  if (signal?.aborted) throw new TransportError('cancelled', 'RAGFlow 读取请求已取消。');
  const datasetIds = source.datasetIds ?? [];
  if (datasetIds.length === 0) throw new TransportError('profile_invalid', 'RAGFlow 汇总范围为空。');
  const datasets: RagflowAggregateDataset[] = [];
  const succeeded = new Set<string>();
  let firstError: unknown;
  for (const datasetId of datasetIds) {
    try {
      const dataset = await readAggregateDataset(datasetId, get, signal, budget);
      datasets.push(dataset);
      succeeded.add(datasetId);
      onProgress?.({ sourceRef: source.sourceRef, datasets: [...datasets], failedDatasetIds: datasetIds.filter((id) => !succeeded.has(id)), complete: false, observedAt: new Date().toISOString() });
    } catch (error) {
      firstError ??= error;
      break;
    }
  }
  const failedDatasetIds = datasetIds.filter((datasetId) => !succeeded.has(datasetId));
  if (datasets.length === 0 && firstError) throw firstError;
  const complete = failedDatasetIds.length === 0 && datasets.length === datasetIds.length && datasets.every((dataset) => dataset.countersComplete);
  return { sourceRef: source.sourceRef, datasets, failedDatasetIds, complete, observedAt: new Date().toISOString() };
}

async function readAggregateDataset(datasetId: string, get: RagflowJsonGetter, signal: AbortSignal | undefined, budget: RagflowReadBudget): Promise<RagflowAggregateDataset> {
  ensureRagflowReadBudget(budget);
  const response = await get(`/api/v1/datasets/${encodeURIComponent(datasetId)}/ingestions/summary`, signal);
  const parsed = parseBoundedJson(response, budget);
  const value = parsed.value;
  const data = asObject(envelopeData(value));
  const total = requiredSafeInteger(data?.doc_num);
  const status = asObject(data?.status);
  const pendingCount = requiredSafeInteger(status?.unstart_count);
  const processingCount = requiredSafeInteger(status?.running_count);
  const cancelledCount = requiredSafeInteger(status?.cancel_count);
  const completedCount = requiredSafeInteger(status?.done_count);
  const failedCount = requiredSafeInteger(status?.fail_count);
  const known = pendingCount + processingCount + cancelledCount + completedCount + failedCount;
  const countConflict = known > total;
  emitRagflowDiagnostic(budget, 'schema_complete', parsed.httpStatus, parsed.bytes);
  return {
    datasetId,
    total,
    pendingCount,
    processingCount,
    completedCount,
    failedCount,
    cancelledCount,
    unknownCount: countConflict ? null : total - known,
    countConflict,
    countersComplete: !countConflict,
  };
}

/** Read one fixed page of historical file operation logs per dataset. */
export async function readRagflowIngestionLogs(
  source: RagflowDocumentsSource,
  get: RagflowJsonGetter,
  signal?: AbortSignal,
  onProgress?: RagflowIngestionLogsProgress,
  budget = createRagflowReadBudget(),
): Promise<RagflowIngestionLogsRead> {
  assertRagflowSource(source);
  if (signal?.aborted) throw new TransportError('cancelled', 'RAGFlow 读取请求已取消。');
  const datasetIds = source.datasetIds ?? [];
  if (datasetIds.length === 0) throw new TransportError('profile_invalid', 'RAGFlow 日志范围为空。');
  const datasets: RagflowIngestionLogsDataset[] = [];
  const succeeded = new Set<string>();
  let firstError: unknown;
  for (const datasetId of datasetIds) {
    const page = source.ingestionLogPages?.[datasetId] ?? 1;
    try {
      ensureRagflowReadBudget(budget);
      const filter: RagflowIngestionLogsDataset['filter'] = source.ingestionFailureOnly === true ? 'failed_operations' : 'all_file_logs';
      const filterSuffix = source.ingestionFailureOnly === true ? '&operation_status=4' : '';
      const path = `/api/v1/datasets/${encodeURIComponent(datasetId)}/ingestions?page=${page}&page_size=1&orderby=create_time&desc=true&log_type=file${filterSuffix}`;
      const parsed = parseBoundedJson(await get(path, signal), budget);
      const value = parsed.value;
      const data = asObject(envelopeData(value));
      const total = requiredSafeInteger(data?.total);
      const logsValue = data?.logs;
      if (!Array.isArray(logsValue) || logsValue.length > 1) throw new TransportError('invalid_response', 'RAGFlow 日志响应无效。');
      const logs = logsValue.map(parseIngestionLog);
      const hasMore = total > page;
      const entry = { datasetId, page, total, filter, logs, hasMore };
      emitRagflowDiagnostic(budget, 'schema_complete', parsed.httpStatus, parsed.bytes);
      datasets.push(entry);
      succeeded.add(datasetId);
      onProgress?.({ sourceRef: source.sourceRef, datasets: [...datasets], failedDatasetIds: datasetIds.filter((id) => !succeeded.has(id)), complete: false, hasMore, gap: hasMore, observedAt: new Date().toISOString() });
    } catch (error) {
      firstError ??= error;
      break;
    }
  }
  const failedDatasetIds = datasetIds.filter((datasetId) => !succeeded.has(datasetId));
  if (datasets.length === 0 && firstError) throw firstError;
  const hasMore = datasets.some((dataset) => dataset.hasMore);
  return {
    sourceRef: source.sourceRef,
    datasets,
    failedDatasetIds,
    complete: failedDatasetIds.length === 0 && datasets.length === datasetIds.length,
    hasMore,
    gap: failedDatasetIds.length > 0 || hasMore,
    observedAt: new Date().toISOString(),
  };
}

function parseIngestionLog(value: unknown): RagflowIngestionLog {
  const object = asObject(value);
  if (!object) throw new TransportError('invalid_response', 'RAGFlow 日志响应无效。');
  // Read only the audited allowlist. Sensitive fields such as dsl,
  // document_name, tenant_id and unknown response extensions are ignored.
  const logIdHash = hashOptional(object.id);
  const documentHash = hashOptional(object.document_id);
  const run = normalizeRun(object.operation_status);
  const progress = boundedNullableNumber(object.progress, 0, 1);
  const progressInfo = boundedProgressMessage(object.progress_msg);
  const descriptionPresent = (progressInfo?.value.trim().length ?? 0) > 0;
  const failureStage = run === 'FAILED' ? classifyFailureStage(progressInfo?.value ?? null) : null;
  const failureCode = run === 'FAILED' ? classifyFailureCode(progressInfo?.value ?? null) : null;
  const messageClassified = run === 'FAILED' && failureCode && failureCode !== 'unclassified' ? failureCode : null;
  const failureEvidenceLevel = run !== 'FAILED'
    ? null
    : messageClassified
      ? 'message_classified'
      : descriptionPresent
      ? 'unclassified_description'
      : failureStage !== 'unknown'
        ? 'stage_only'
        : 'source_no_detail';
  return {
    logIdHash,
    documentHash,
    run,
    progress,
    failureCode,
    messageClassified,
    failureStage,
    failureEvidenceLevel,
    failureShape: run === 'FAILED' ? progressInfo?.shape ?? null : null,
    sourceAt: sourceDate(object.update_time),
  };
}

function hashOptional(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  if (!text || text.length > 256 || /[\u0000-\u001f\u007f]/.test(text)) return null;
  return createHash('sha256').update(text).digest('hex').slice(0, 24);
}

function normalizeRun(value: unknown): RagflowRun | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return RUN_NUMERIC_VALUES[String(value)] ?? null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  if (RUN_VALUES.has(normalized)) return normalized as RagflowRun;
  if (normalized === 'FAIL') return 'FAILED';
  if (normalized === 'CANCEL') return 'CANCELLED';
  return RUN_NUMERIC_VALUES[normalized] ?? null;
}

/** Bounded main-only inspection of progress_msg. The value never leaves here. */
function boundedProgressMessage(value: unknown): { value: string; shape: RagflowFailureShape } | null {
  if (typeof value !== 'string') return null;
  const bytes = Buffer.from(value, 'utf8');
  const shape: RagflowFailureShape = {
    charLength: value.length,
    byteLength: bytes.byteLength,
    hasLF: value.includes('\n'),
    hasCR: value.includes('\r'),
    hasTab: value.includes('\t'),
    hasOtherControl: /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),
    // The former parser dropped any control character and every message over
    // 512 characters; retain this fact only as a safe diagnostic boolean.
    oldParserWouldDrop: value.length > 512 || /[\u0000-\u001f\u007f]/.test(value),
  };
  if (shape.hasOtherControl) return { value: '', shape };
  const bounded = bytes.byteLength <= RAGFLOW_LIMITS.maxProgressMessageBytes
    ? bytes
    : bytes.subarray(0, RAGFLOW_LIMITS.maxProgressMessageBytes);
  return { value: bounded.toString('utf8'), shape };
}

function classifyFailureCode(value: string | null): RagflowFailureCode {
  if (!value) return 'unclassified';
  const normalized = value.toLowerCase();
  const httpStatus = /(?:\bhttp(?:[\s_-]+status)?(?:[\s_-]+code)?\b|\bstatus[\s_-]*code\b|\berror[\s_-]*code\b)\s*(?:[:=]\s*)?([45]\d{2})\b/.exec(normalized)?.[1];
  if (/model[\s_-]*not[\s_-]*found/.test(normalized) || (httpStatus === '404' && /model/.test(normalized))) return 'model_not_found';
  if (/invalid[\s_-]*(api[\s_-]*)?key|api[\s_-]*key.*(invalid|unauthori[sz]ed)/.test(normalized) || httpStatus === '401') return 'invalid_api_key';
  if (/rate[\s_-]*limit|too many requests/.test(normalized) || httpStatus === '429') return 'rate_limit';
  if (/context[\s_-]*length|maximum.*token|token.*(limit|too long)/.test(normalized)) return 'context_length';
  if (/vector[\s_-]*dimension|dimension.*(mismatch|inconsistent|expected)/.test(normalized)) return 'vector_dimension';
  if (/timed?[\s_-]*out|timeout|deadline/.test(normalized)) return 'timeout';
  if (httpStatus?.startsWith('4')) return 'http_4xx';
  if (httpStatus?.startsWith('5')) return 'http_5xx';
  return 'unclassified';
}

function classifyFailureStage(value: string | null): RagflowFailureStage {
  if (!value) return 'unknown';
  const normalized = value.toLowerCase();
  if (/embed/.test(normalized)) return 'embedding';
  if (/index|vector/.test(normalized)) return 'indexing';
  if (/metadata/.test(normalized)) return 'metadata';
  if (/parse|extract|chunk/.test(normalized)) return 'parsing';
  return 'unknown';
}

type ParsedRagflowJson = { readonly value: Record<string, unknown>; readonly bytes: number; readonly httpStatus: number };

function parseBoundedJson(response: RagflowHttpResponse, budget: RagflowReadBudget): ParsedRagflowJson {
  if (!response || typeof response !== 'object' || response.status < 200 || response.status >= 300) {
    if (response && response.status >= 300 && response.status < 400) throw new TransportError('redirect', 'RAGFlow 来源禁止重定向。');
    throw new TransportError('http_error', 'RAGFlow HTTP 读取失败。');
  }
  if (typeof response.body !== 'string') throw new TransportError('invalid_response', 'RAGFlow 响应格式无效。');
  const bytes = Buffer.byteLength(response.body, 'utf8');
  if (bytes > RAGFLOW_LIMITS.maxPageBytes) throw new TransportError('incomplete', 'RAGFlow 单页响应超过上限。');
  consumeRagflowReadBytes(budget, bytes);
  const contentType = headerValue(response.headers, 'content-type');
  if (!contentType || !/^application\/json(?:\s*;|\s*$)/i.test(contentType)) throw new TransportError('invalid_response', 'RAGFlow 响应类型无效。');
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body) as unknown;
  } catch {
    throw new TransportError('invalid_response', 'RAGFlow 响应格式无效。');
  }
  const object = asObject(parsed);
  if (typeof object?.code !== 'number' || object.code !== 0) throw new TransportError('http_error', 'RAGFlow 业务读取失败。');
  return { value: object, bytes, httpStatus: response.status };
}

function ensureRagflowReadBudget(budget: RagflowReadBudget): void {
  if (remainingRagflowReadMs(budget) <= 0) throw new TransportError('timeout', 'RAGFlow 逻辑读取期限已到。');
  if (budget.remainingBytes <= 0) throw new TransportError('incomplete', 'RAGFlow 逻辑读取响应超过轮次上限。');
}

function consumeRagflowReadBytes(budget: RagflowReadBudget, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > budget.remainingBytes) throw new TransportError('incomplete', 'RAGFlow 逻辑读取响应超过轮次上限。');
  budget.remainingBytes -= bytes;
}

function envelopeData(value: Record<string, unknown>): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, 'data')) throw new TransportError('invalid_response', 'RAGFlow 响应结构无效。');
  return value.data;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requiredSafeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TransportError('invalid_response', 'RAGFlow 汇总响应无效。');
  return value;
}

function boundedNullableNumber(value: unknown, minimum: number, maximum: number): number | null {
  if (value === undefined || value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum ? value : null;
}

function sourceDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function headerValue(headers: Readonly<Record<string, string | string[] | undefined>>, name: string): string | null {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const raw = key ? headers[key] : undefined;
  if (Array.isArray(raw)) return raw[0] ?? null;
  return typeof raw === 'string' ? raw : null;
}
