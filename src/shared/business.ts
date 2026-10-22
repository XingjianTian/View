import { z } from 'zod';

const Count = z.number().finite().int().nonnegative().nullable();

export const BusinessScopeTypeSchema = z.enum(['batch', 'queue', 'archive']);
export type BusinessScopeType = z.infer<typeof BusinessScopeTypeSchema>;

export const BusinessMetricsSchema = z.object({
  total: Count,
  succeeded: Count,
  failed: Count,
  active: Count,
  waiting: Count,
  cancelled: Count,
}).strict();
export type BusinessMetrics = z.infer<typeof BusinessMetricsSchema>;

export const BusinessPayloadSchema = z.object({
  scopeType: BusinessScopeTypeSchema,
  scopeId: z.string().trim().min(1).max(256),
  sourceAt: z.string().datetime().nullable(),
  total: Count,
  succeeded: Count,
  failed: Count,
  active: Count,
  waiting: Count,
  cancelled: Count,
}).strict();
export type BusinessPayload = z.infer<typeof BusinessPayloadSchema>;

export type BusinessProgress = {
  completedPercent: number;
  successPercent: number;
};

export type BusinessObservation = {
  status: 'not_configured' | 'fresh' | 'stale' | 'error' | 'uncomputable';
  metrics: BusinessMetrics;
  scopeType: BusinessScopeType | null;
  scopeId: string | null;
  sourceAt: string | null;
  observedAt: string;
  progress: BusinessProgress | null;
  errorCode: 'business_unconfigured' | 'business_timeout' | 'business_http' | 'business_invalid' | 'business_expired' | 'business_redirect' | 'business_uncomputable' | null;
};

export function emptyBusinessObservation(observedAt = new Date().toISOString()): BusinessObservation {
  return {
    status: 'not_configured',
    metrics: emptyBusinessMetrics(),
    scopeType: null,
    scopeId: null,
    sourceAt: null,
    observedAt,
    progress: null,
    errorCode: 'business_unconfigured',
  };
}

export const businessLimits = {
  ttlMs: 90_000,
  timeoutMs: 5_000,
  maxResponseBytes: 256 * 1024,
  maxInFlight: 2,
} as const;

export function emptyBusinessMetrics(): BusinessMetrics {
  return { total: null, succeeded: null, failed: null, active: null, waiting: null, cancelled: null };
}

export function computeBusinessProgress(metrics: BusinessMetrics): BusinessProgress | null {
  const { total, succeeded, failed, active, waiting, cancelled } = metrics;
  if (total === null || total <= 0 || succeeded === null || failed === null || cancelled === null) return null;
  const known = [succeeded, failed, cancelled, active, waiting].filter((value): value is number => value !== null);
  if (known.some((value) => value < 0) || known.reduce((sum, value) => sum + value, 0) > total) return null;
  const completed = succeeded + failed + cancelled;
  return {
    completedPercent: roundPercent((completed / total) * 100),
    successPercent: roundPercent((succeeded / total) * 100),
  };
}

function roundPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}
