import { createHash } from 'node:crypto';
import { StatusEvidenceKindSchema, StatusOutcomeSchema, statusLimits, statusSourceRef, sanitizeId, type StatusRecord } from '../../shared/status.js';
import type { StatusAdapter } from '../../shared/contracts.js';

export type EndpointResolver = (profileId: string, endpointRef: string) => Promise<string | undefined>;
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type StatusReadResult = {
  sourceRef: string;
  observedAt: string;
  health: 'fresh' | 'error';
  lastSuccessAt: string | null;
  records: StatusRecord[];
  errorCode: 'status_timeout' | 'status_http' | 'status_invalid' | 'status_redirect' | null;
};

const SAFE_STAGE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  archive: '归档',
  download: '下载',
  download_task: '下载任务',
  github: 'GitHub同步',
  github_sync: 'GitHub同步',
  index: '知识库索引',
  metadata: '元数据',
  queue: '队列',
  reading: '精读',
  registration: '登记',
  status: '状态记录',
  zotero: 'Zotero入库',
  zotero_sync: 'Zotero入库',
  '归档': '归档',
  '下载': '下载',
  '下载任务': '下载任务',
  '处理队列': '处理队列',
  '分组结果': '分组结果',
  '知识库索引': '知识库索引',
  '全文': '全文',
  '登记': '登记',
  '精读': '精读',
  '论文终态': '论文终态',
  '元数据': '元数据',
  '队列': '队列',
  '状态': '状态记录',
  '状态记录': '状态记录',
  'GitHub同步': 'GitHub同步',
  'NAS归档': 'NAS归档',
  'Zotero入库': 'Zotero入库',
});
const SAFE_FACT_KEYS = new Set([
  'archived', 'completed', 'confirmed', 'containers', 'failed', 'hasCommit', 'hasPaperId', 'members', 'missing',
  'paperNumber', 'papers', 'partial', 'required', 'retried', 'succeeded', 'taskStatus', 'terminal', 'total',
  'observed', 'status', 'sourceStatus', 'zoteroSynced', 'githubSynced',
]);
const SAFE_FACT_STRING_VALUES = new Set([
  'active', 'cancelled', 'canceled', 'completed', 'downloaded', 'failed', 'pending', 'rejected', 'retry_pending',
  'running', 'started', 'succeeded', 'synced', 'unknown', 'unavailable',
]);

export class HttpJsonStatusAdapter {
  private readonly fetcher: FetchLike;
  private readonly resolveEndpoint: EndpointResolver;
  private inFlight = false;
  private last: StatusReadResult | null = null;

  constructor(options: { fetcher?: FetchLike; resolveEndpoint: EndpointResolver }) {
    this.fetcher = options.fetcher ?? fetch;
    this.resolveEndpoint = options.resolveEndpoint;
  }

  async read(serviceId: string, adapter: StatusAdapter, now = new Date(), sourceRefOverride?: string, externalSignal?: AbortSignal): Promise<StatusReadResult> {
    const startedAt = now.toISOString();
    const sourceRef = sourceRefOverride ?? statusSourceRef('http_json', serviceId);
    if (adapter.kind !== 'http_json') return this.remember({ sourceRef, observedAt: startedAt, health: 'error', lastSuccessAt: null, records: [], errorCode: 'status_invalid' });
    if (this.inFlight) return this.last ?? errorResult(sourceRef, startedAt, 'status_timeout');
    this.inFlight = true;
    try {
      const endpoint = await this.resolveEndpoint(adapter.profileId, adapter.endpointRef);
      if (!endpoint) return this.remember(errorResult(sourceRef, new Date().toISOString(), 'status_invalid'));
      let url: string;
      try {
        url = validateEndpoint(endpoint);
      } catch {
        return this.remember(errorResult(sourceRef, new Date().toISOString(), 'status_invalid'));
      }
      const controller = new AbortController();
      const abortFromCaller = () => controller.abort();
      if (externalSignal?.aborted) controller.abort();
      externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
      const timer = setTimeout(() => controller.abort(), statusLimits.httpTimeoutMs);
      try {
        const response = await this.fetcher(url, { method: 'GET', redirect: 'manual', signal: controller.signal, headers: { accept: 'application/json' } });
        const observedAt = new Date().toISOString();
        if (response.status >= 300 && response.status < 400) return this.remember(errorResult(sourceRef, observedAt, 'status_redirect'));
        if (!response.ok) return this.remember(errorResult(sourceRef, observedAt, 'status_http'));
        let body: string;
        try {
          body = await readLimitedBody(response, statusLimits.maxHttpResponseBytes);
        } catch (error) {
          return this.remember(errorResult(sourceRef, new Date().toISOString(), isAbort(error) ? 'status_timeout' : 'status_invalid'));
        }
        let raw: unknown;
        try { raw = JSON.parse(body) as unknown; } catch { return this.remember(errorResult(sourceRef, new Date().toISOString(), 'status_invalid')); }
        const values = extractEvents(raw, adapter.mapping);
        if (!values) return this.remember(errorResult(sourceRef, new Date().toISOString(), 'status_invalid'));
        const records = values.map((value, index) => mapRecord(value, serviceId, sourceRef, adapter.mapping, observedAt, index)).filter((value): value is StatusRecord => value !== null);
        if (records.length !== values.length) return this.remember(errorResult(sourceRef, new Date().toISOString(), 'status_invalid'));
        const completedAt = new Date().toISOString();
        return this.remember({ sourceRef, observedAt: completedAt, health: 'fresh', lastSuccessAt: completedAt, records: records.map((record) => ({ ...record, observedAt: completedAt, sourceAt: record.sourceAt ?? completedAt })), errorCode: null });
      } catch (error) {
        return this.remember(errorResult(sourceRef, new Date().toISOString(), isAbort(error) ? 'status_timeout' : 'status_invalid'));
      } finally {
        clearTimeout(timer);
        externalSignal?.removeEventListener('abort', abortFromCaller);
      }
    } finally {
      this.inFlight = false;
    }
  }

  getLast(): StatusReadResult | null {
    return this.last ? structuredClone(this.last) : null;
  }

  private remember(value: StatusReadResult): StatusReadResult {
    this.last = value;
    return value;
  }
}

function validateEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('invalid protocol');
  if (url.username || url.password || url.hash) throw new Error('unsafe endpoint');
  return url.toString();
}

function extractEvents(raw: unknown, mapping: Record<string, string>): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return null;
  const mapped = pointerGet(raw, mapping.events ?? '/events');
  if (Array.isArray(mapped)) return mapped;
  if (Object.prototype.hasOwnProperty.call(raw, 'events')) return null;
  return [raw];
}

function mapRecord(raw: unknown, serviceId: string, sourceRef: string, mapping: Record<string, string>, observedAt: string, index: number): StatusRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const read = (field: string): unknown => pointerGet(raw, mapping[field] ?? `/${field}`);
  const taskKeyValue = read('taskKey') ?? read('requestId');
  const stage = safeStage(read('stage'));
  const outcome = StatusOutcomeSchema.safeParse(read('outcome'));
  const occurredAt = readDate(read('occurredAt'));
  const evidenceKind = StatusEvidenceKindSchema.safeParse(read('evidenceKind'));
  if (!stage || !outcome.success || !evidenceKind.success) return null;
  const eventId = safeReference(read('id'), `event-${hashIdentity(serviceId, sourceRef, taskKeyValue, stage, outcome.data, occurredAt, index)}`);
  const taskKey = taskKeyValue === undefined || taskKeyValue === null ? null : `task-${hashIdentity(sourceRef, taskKeyValue)}`;
  const evidenceValue = read('evidenceRef');
  const evidenceRef = evidenceValue === undefined || evidenceValue === null ? null : safeReference(evidenceValue, 'evidence');
  const facts = sanitizeFacts(read('facts'));
  const summary = formatStatus(stage, outcome.data, facts);
  return {
    id: sanitizeId(eventId, `event-${index}`),
    serviceId: sanitizeId(serviceId, 'service'),
    sourceRef,
    taskKey,
    stage,
    outcome: outcome.data,
    summary,
    occurredAt,
    sourceAt: readDate(read('sourceAt')) ?? observedAt,
    observedAt,
    evidenceKind: evidenceKind.data,
    facts,
    evidenceRef,
  };
}

function sanitizeFacts(value: unknown): Record<string, string | number | boolean | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const facts: Record<string, string | number | boolean | null> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (Object.keys(facts).length >= 32 || !SAFE_FACT_KEYS.has(key)) continue;
    if (raw === null || typeof raw === 'boolean' || (typeof raw === 'number' && Number.isFinite(raw))) {
      facts[key] = raw;
    } else if (typeof raw === 'string' && SAFE_FACT_STRING_VALUES.has(raw)) {
      facts[key] = raw;
    }
  }
  return facts;
}

function pointerGet(root: unknown, pointer: string): unknown {
  if (!pointer.startsWith('/') || pointer.includes('/__proto__') || pointer.includes('/constructor') || pointer.includes('/prototype')) return undefined;
  return pointer.slice(1).split('/').reduce<unknown>((current, token) => {
    if (!current || typeof current !== 'object') return undefined;
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) return /^\d+$/.test(key) ? current[Number(key)] : undefined;
    return Object.prototype.hasOwnProperty.call(current, key) ? (current as Record<string, unknown>)[key] : undefined;
  }, root);
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error('response too large');
    return new TextDecoder().decode(bytes);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('response too large');
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function safeStage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128 || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  const lower = trimmed.toLowerCase();
  const direct = Object.prototype.hasOwnProperty.call(SAFE_STAGE_LABELS, trimmed) ? SAFE_STAGE_LABELS[trimmed] : undefined;
  const normalized = Object.prototype.hasOwnProperty.call(SAFE_STAGE_LABELS, lower) ? SAFE_STAGE_LABELS[lower] : undefined;
  return direct ?? normalized ?? '状态记录';
}

function safeReference(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(value) || hasSensitiveText(value)) return fallback;
  return `ref-${hashIdentity(value)}`;
}

function hasSensitiveText(value: string): boolean {
  return /(?:https?|ssh|ftp):\/\//i.test(value)
    || /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(value)
    || /(?:^|[\\/])(?:Users|Volumes|private|tmp|var|home|etc|opt|mnt|Applications|Library)(?:[\\/]|$)/i.test(value)
    || /\b(?:api[_-]?key|authorization|bearer|cookie|credential|password|secret|token)\b/i.test(value);
}

function readDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const date = new Date(parsed);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function hashIdentity(...values: unknown[]): string {
  return createHash('sha256').update(values.map((value) => String(value ?? '')).join('\u001f')).digest('hex').slice(0, 24);
}

function formatStatus(stage: string, outcome: StatusRecord['outcome'], facts: Record<string, string | number | boolean | null>): string {
  const detail = typeof facts.completed === 'number' && typeof facts.total === 'number' ? `（${facts.completed}/${facts.total}）` : '';
  const labels: Record<StatusRecord['outcome'], string> = { active: '进行中', succeeded: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消', unknown: '状态未知' };
  return `${stage}：${labels[outcome]}${detail}`;
}

function errorResult(sourceRef: string, observedAt: string, errorCode: StatusReadResult['errorCode']): StatusReadResult {
  return { sourceRef, observedAt, health: 'error', lastSuccessAt: null, records: [], errorCode };
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
