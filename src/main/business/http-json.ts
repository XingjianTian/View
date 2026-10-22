import { BusinessPayloadSchema, businessLimits, computeBusinessProgress, emptyBusinessMetrics, type BusinessObservation, type BusinessPayload, type BusinessProgress } from '../../shared/business.js';
import type { BusinessAdapter } from '../../shared/contracts.js';

export type EndpointResolver = (endpointRef: string) => Promise<string | undefined>;
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class HttpJsonBusinessAdapter {
  private readonly fetcher: FetchLike;
  private readonly resolveEndpoint: EndpointResolver;
  private inFlight = false;
  private last: BusinessObservation | null = null;

  constructor(options: { fetcher?: FetchLike; resolveEndpoint: EndpointResolver }) {
    this.fetcher = options.fetcher ?? fetch;
    this.resolveEndpoint = options.resolveEndpoint;
  }

  async read(adapter: BusinessAdapter, now = new Date()): Promise<BusinessObservation> {
    const observedAt = now.toISOString();
    if (adapter.kind === 'none') return notConfigured(observedAt);
    if (this.inFlight) return this.last ?? errorObservation(observedAt, 'business_timeout');
    this.inFlight = true;
    try {
      const endpoint = await this.resolveEndpoint(adapter.endpointRef);
      if (!endpoint) return this.remember(errorObservation(observedAt, 'business_unconfigured'));
      let url: string;
      try {
        url = validateEndpoint(endpoint);
      } catch {
        return this.remember(errorObservation(observedAt, 'business_invalid'));
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), businessLimits.timeoutMs);
      let response: Response;
      try {
        response = await this.fetcher(url, { method: 'GET', redirect: 'manual', signal: controller.signal, headers: { accept: 'application/json' } });
      } catch (error) {
        return this.remember(errorObservation(observedAt, isAbort(error) ? 'business_timeout' : 'business_http'));
      } finally {
        clearTimeout(timer);
      }
      if (response.status >= 300 && response.status < 400) return this.remember(errorObservation(observedAt, 'business_redirect'));
      if (!response.ok) return this.remember(errorObservation(observedAt, 'business_http'));
      const body = await readLimitedBody(response, businessLimits.maxResponseBytes).catch(() => null);
      if (body === null) return this.remember(errorObservation(observedAt, 'business_invalid'));
      let raw: unknown;
      try { raw = JSON.parse(body) as unknown; } catch { return this.remember(errorObservation(observedAt, 'business_invalid')); }
      const payload = mapPayload(raw, adapter.mapping);
      if (!payload) return this.remember(errorObservation(observedAt, 'business_invalid'));
      return this.remember(observationFromPayload(payload, observedAt, now));
    } finally {
      this.inFlight = false;
    }
  }

  getLast(): BusinessObservation | null {
    return this.last ? structuredClone(this.last) : null;
  }

  private remember(value: BusinessObservation): BusinessObservation {
    this.last = value;
    return value;
  }
}

function validateEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BusinessAdapterError('business_invalid');
  if (url.username || url.password || url.hash) throw new BusinessAdapterError('business_invalid');
  return url.toString();
}

function mapPayload(raw: unknown, mapping: Record<string, string>): BusinessPayload | null {
  const read = (field: string): unknown => pointerGet(raw, mapping[field] ?? `/${field}`);
  const value = {
    scopeType: read('scopeType'),
    scopeId: read('scopeId'),
    sourceAt: read('sourceAt') ?? null,
    total: read('total') ?? null,
    succeeded: read('succeeded') ?? null,
    failed: read('failed') ?? null,
    active: read('active') ?? null,
    waiting: read('waiting') ?? null,
    cancelled: read('cancelled') ?? null,
  };
  const parsed = BusinessPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
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

function observationFromPayload(payload: BusinessPayload, observedAt: string, now: Date): BusinessObservation {
  const metrics = { total: payload.total, succeeded: payload.succeeded, failed: payload.failed, active: payload.active, waiting: payload.waiting, cancelled: payload.cancelled };
  const progress = computeBusinessProgress(metrics);
  const expired = payload.sourceAt === null || now.getTime() - Date.parse(payload.sourceAt) > businessLimits.ttlMs;
  return {
    status: expired ? 'stale' : progress ? 'fresh' : 'uncomputable',
    metrics,
    scopeType: payload.scopeType,
    scopeId: payload.scopeId,
    sourceAt: payload.sourceAt,
    observedAt,
    progress,
    errorCode: expired ? 'business_expired' : progress ? null : 'business_uncomputable',
  };
}

function notConfigured(observedAt: string): BusinessObservation {
  return { status: 'not_configured', metrics: emptyBusinessMetrics(), scopeType: null, scopeId: null, sourceAt: null, observedAt, progress: null, errorCode: 'business_unconfigured' };
}

function errorObservation(observedAt: string, errorCode: BusinessObservation['errorCode']): BusinessObservation {
  return { status: errorCode === 'business_unconfigured' ? 'not_configured' : 'error', metrics: emptyBusinessMetrics(), scopeType: null, scopeId: null, sourceAt: null, observedAt, progress: null, errorCode };
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export class BusinessAdapterError extends Error {
  constructor(readonly code: BusinessObservation['errorCode']) {
    super(code ?? 'business_invalid');
  }
}

export function progressLabel(progress: BusinessProgress | null): string {
  return progress ? `${progress.completedPercent}% 完成，成功率 ${progress.successPercent}%` : '不可计算';
}
