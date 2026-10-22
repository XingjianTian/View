import { z } from 'zod';

const SafeId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/);
const BoundedText = z.string().trim().min(1).max(512).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const NullableDateTime = z.string().datetime().nullable();
const FactValue = z.union([z.string().max(256), z.number().finite(), z.boolean(), z.null()]);

export const StatusOutcomeSchema = z.enum(['active', 'succeeded', 'partial', 'failed', 'cancelled', 'unknown']);
export type StatusOutcome = z.infer<typeof StatusOutcomeSchema>;

export const StatusActivitySchema = z.enum(['idle', 'active', 'historical', 'unknown', 'unsupported']);
export type StatusActivity = z.infer<typeof StatusActivitySchema>;

export const StatusEvidenceKindSchema = z.enum(['business_event', 'stage_receipt', 'snapshot_diff', 'container_observation']);
export type StatusEvidenceKind = z.infer<typeof StatusEvidenceKindSchema>;

export const StatusFactsSchema = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/), FactValue)
  .refine((facts) => Object.keys(facts).length <= 32, 'status facts are limited to 32 fields');
export type StatusFacts = z.infer<typeof StatusFactsSchema>;

export const StatusRecordSchema = z.object({
  id: SafeId,
  serviceId: SafeId,
  sourceRef: SafeId,
  taskKey: BoundedText.nullable(),
  stage: BoundedText,
  outcome: StatusOutcomeSchema,
  summary: BoundedText,
  occurredAt: NullableDateTime,
  sourceAt: NullableDateTime,
  observedAt: z.string().datetime(),
  evidenceKind: StatusEvidenceKindSchema,
  facts: StatusFactsSchema,
  evidenceRef: SafeId.nullable(),
}).strict();
export type StatusRecord = z.infer<typeof StatusRecordSchema>;

export const StatusFeedHealthSchema = z.enum(['unconfigured', 'fresh', 'stale', 'error']);
export type StatusFeedHealth = z.infer<typeof StatusFeedHealthSchema>;

export const StatusFeedErrorSchema = z.enum(['status_unconfigured', 'status_timeout', 'status_http', 'status_invalid', 'status_redirect', 'status_expired', 'status_incomplete', 'status_source', 'status_auth', 'status_permission', 'status_schema', 'status_connection']);
export type StatusFeedError = z.infer<typeof StatusFeedErrorSchema>;

export const StatusFeedSchema = z.object({
  sourceRef: SafeId,
  health: StatusFeedHealthSchema,
  lastSuccessAt: z.string().datetime().nullable(),
  observedAt: z.string().datetime(),
  cursor: BoundedText.nullable(),
  hasMore: z.boolean(),
  gap: z.boolean(),
  errorCode: StatusFeedErrorSchema.nullable(),
}).strict();
export type StatusFeed = z.infer<typeof StatusFeedSchema>;

export const StatusPageSchema = z.object({
  serviceId: SafeId,
  records: z.array(StatusRecordSchema).max(40),
  nextCursor: BoundedText.nullable(),
  hasMore: z.boolean(),
  feeds: z.array(StatusFeedSchema).max(16),
}).strict();
export type StatusPage = z.infer<typeof StatusPageSchema>;

export const StatusSourceSummarySchema = z.discriminatedUnion('kind', [
  z.object({
    sourceRef: SafeId,
    profileId: SafeId,
    kind: z.literal('article_receipt_json'),
    displayName: BoundedText,
  }).strict(),
  z.object({
    sourceRef: SafeId,
    profileId: SafeId,
    kind: z.literal('ragflow_documents'),
    displayName: BoundedText,
  }).strict(),
  z.object({
    endpointRef: z.string().trim().min(1).max(128),
    profileId: SafeId,
    kind: z.literal('http_json'),
    displayName: BoundedText,
  }).strict(),
  z.object({
    sourceRef: SafeId,
    profileId: SafeId,
    kind: z.literal('quant_pg_receipts'),
    displayName: BoundedText,
  }).strict(),
  z.object({
    sourceRef: SafeId,
    profileId: SafeId,
    kind: z.literal('tailscale_status'),
    displayName: BoundedText,
  }).strict(),
  z.object({
    sourceRef: SafeId,
    profileId: SafeId,
    kind: z.literal('acme_certificates'),
    displayName: BoundedText,
  }).strict(),
  z.object({
    sourceRef: SafeId,
    profileId: SafeId,
    kind: z.literal('openresty_status'),
    displayName: BoundedText,
  }).strict(),
]);
export type StatusSourceSummary = z.infer<typeof StatusSourceSummarySchema>;

export const statusLimits = {
  maxPageItems: 40,
  maxPageBytes: 48 * 1024,
  maxRecordsPerService: 200,
  maxServiceBytes: 256 * 1024,
  maxHistoryBytes: 4 * 1024 * 1024,
  maxHttpResponseBytes: 256 * 1024,
  httpTimeoutMs: 5_000,
  staleAfterMs: 90_000,
} as const;

export function statusSourceRef(kind: 'docker' | 'http_json' | 'article_receipt_json' | 'ragflow_documents' | 'quant_pg_receipts' | 'tailscale_status' | 'acme_certificates' | 'openresty_status', id: string): string {
  return `${kind}:${sanitizeId(id, 'source').slice(0, 150)}`;
}

export function sanitizeId(value: string, fallback: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 155);
  return sanitized || fallback;
}

export function emptyStatusPage(serviceId: string): StatusPage {
  return { serviceId: sanitizeId(serviceId, 'service'), records: [], nextCursor: null, hasMore: false, feeds: [] };
}
