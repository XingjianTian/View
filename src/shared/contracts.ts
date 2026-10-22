import { z } from 'zod';
import type { ContainerEntity, ContainerObservation, DeviceObservation, ServiceObservation } from './entities.js';
import type { LogSourceState } from './logs.js';

const Id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const Name = z.string().trim().min(1).max(160);
const NonEmptyPath = z.string().trim().min(1).max(1024);

export const SelectorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('container_id'), value: z.string().regex(/^[a-f0-9]{12,64}$/) }),
  z.object({ kind: z.literal('name'), value: Name }),
  z.object({
    kind: z.literal('compose'),
    project: Name,
    service: Name,
    ordinal: z.number().int().min(0).max(999).optional(),
  }),
]);

export const BindingSchema = z.object({
  id: Id,
  deviceId: Id,
  selector: SelectorSchema,
  required: z.boolean(),
  expectedPolicy: z.enum(['continuous', 'job', 'manual']),
});

export const BusinessAdapterSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({
    kind: z.literal('http_json'),
    profileId: Id,
    endpointRef: NonEmptyPath,
    mapping: z.record(z.string(), z.string().max(256)).default({}),
  }),
]);

export const StatusAdapterSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({
    kind: z.literal('http_json'),
    profileId: Id,
    endpointRef: NonEmptyPath,
    mapping: z.record(z.string(), z.string().max(256)).default({}),
  }),
  z.object({
    kind: z.literal('article_receipt_json'),
    profileId: Id,
    sourceRef: Id,
  }),
  z.object({
    kind: z.literal('ragflow_documents'),
    profileId: Id,
    sourceRef: Id,
  }),
  z.object({
    kind: z.literal('quant_pg_receipts'),
    profileId: Id,
    sourceRef: Id,
  }),
  z.object({
    kind: z.literal('tailscale_status'),
    profileId: Id,
    sourceRef: Id,
  }),
  z.object({
    kind: z.literal('acme_certificates'),
    profileId: Id,
    sourceRef: Id,
  }),
  z.object({
    kind: z.literal('openresty_status'),
    profileId: Id,
    sourceRef: Id,
  }),
]);

export const ServiceSchema = z.object({
  id: Id,
  name: Name,
  category: z.string().trim().min(1).max(64),
  bindings: z.array(BindingSchema).max(32),
  businessAdapter: BusinessAdapterSchema,
  statusAdapter: StatusAdapterSchema.default({ kind: 'none' }),
});

export const DeviceSchema = z.object({
  id: Id,
  name: Name,
  transport: z.enum(['local', 'ssh']),
  profileId: Id,
  enabled: z.boolean(),
});

export const SlotSchema = z.object({
  serviceId: Id.nullable(),
  logBindingId: Id.nullable(),
});

export const DisplayPrefsSchema = z.object({
  layout: z.enum(['columns4', 'grid2x2', 'focus']),
  focusSlot: z.number().int().min(0).max(3).default(0),
  asciiMode: z.enum(['dynamic', 'static', 'off']),
  asciiBrightness: z.number().int().min(0).max(100),
  asciiStrength: z.number().int().min(0).max(100),
  reducedMotion: z.boolean(),
});

export const WindowBoundsSchema = z.object({
  x: z.number().int().finite(),
  y: z.number().int().finite(),
  width: z.number().int().min(800).max(10000),
  height: z.number().int().min(600).max(10000),
  displayId: z.string().max(256).optional(),
});

export const WindowVisibilitySchema = z.object({
  windowEpoch: z.number().int().nonnegative(),
  visible: z.boolean(),
}).strict();

export const AppConfigSchema = z.object({
  schemaVersion: z.literal(1),
  devices: z.array(DeviceSchema).max(8),
  services: z.array(ServiceSchema).max(128),
  slots: z.tuple([SlotSchema, SlotSchema, SlotSchema, SlotSchema]),
  display: DisplayPrefsSchema,
  window: WindowBoundsSchema.nullable(),
});

export const ProfileSummarySchema = z.object({
  id: Id,
  displayName: Name,
  kind: z.enum(['local', 'ssh']),
  status: z.enum(['available', 'missing', 'invalid', 'unknown']),
});

export const ProfileReferenceSchema = z.object({
  id: Id,
  displayName: Name,
  kind: z.enum(['local', 'ssh']),
  sourcePath: NonEmptyPath,
  importedAt: z.string().datetime(),
});

export const ProfilesReferenceFileSchema = z.object({
  schemaVersion: z.literal(1),
  profiles: z.array(ProfileReferenceSchema).max(8),
});

export const AppInfoSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  version: z.string(),
  isPackaged: z.boolean(),
  platform: z.string(),
  arch: z.string(),
});

export const ErrorCodeSchema = z.enum([
  'invalid_request',
  'forbidden_sender',
  'profile_missing',
  'profile_invalid',
  'config_invalid',
  'config_write_failed',
  'engine_unavailable',
  'cli_missing',
  'host_key_untrusted',
  'auth_failed',
  'sudo_denied',
  'timeout',
  'deadline_unavailable',
  'log_unavailable',
  'incomplete',
  'binding_unresolved',
  'internal',
]);

export const ConnectionProbeSchema = z.object({
  deviceId: Id,
  transport: z.enum(['local', 'ssh']),
  status: z.enum(['connected', 'unknown', 'stale']),
  dockerVersion: z.string().max(128).nullable(),
  containerCount: z.number().int().nonnegative().nullable(),
  observedAt: z.string().datetime(),
  truncated: z.boolean(),
  errorCode: ErrorCodeSchema.nullable(),
}).strict();

export const RequestEnvelopeSchema = z.object({
  epoch: z.number().int().positive(),
  payload: z.unknown().optional(),
}).strict();

export const DiagnosticsSchema = z.object({
  resourceCount: z.number().int().nonnegative(),
  activeEpoch: z.number().int().nonnegative(),
  transportPool: z.object({
    entries: z.number().int().nonnegative(),
    references: z.number().int().nonnegative(),
    connections: z.number().int().nonnegative(),
    channels: z.number().int().nonnegative(),
  }).strict(),
}).strict();

type AppConfigSchemaOutput = z.infer<typeof AppConfigSchema>;
type ServiceSchemaOutput = z.infer<typeof ServiceSchema>;
export type AppConfig = Omit<AppConfigSchemaOutput, 'services'> & { services: Service[] };
export type Device = z.infer<typeof DeviceSchema>;
export type Service = Omit<ServiceSchemaOutput, 'statusAdapter'> & { statusAdapter?: StatusAdapter };
export type BusinessAdapter = z.infer<typeof BusinessAdapterSchema>;
export type StatusAdapter = z.infer<typeof StatusAdapterSchema>;
export type Binding = z.infer<typeof BindingSchema>;
export type Slot = z.infer<typeof SlotSchema>;
export type DisplayPrefs = z.infer<typeof DisplayPrefsSchema>;
export type WindowBounds = z.infer<typeof WindowBoundsSchema>;
export type MenuCommand = 'open-settings' | 'refresh' | 'layout-columns4' | 'layout-grid2x2' | 'layout-focus';
export type WindowVisibility = z.infer<typeof WindowVisibilitySchema>;
export type ProfileSummary = z.infer<typeof ProfileSummarySchema>;
export type ProfileReference = z.infer<typeof ProfileReferenceSchema>;
export type AppInfo = z.infer<typeof AppInfoSchema>;
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type ConnectionProbe = z.infer<typeof ConnectionProbeSchema>;
export type RequestEnvelope = z.infer<typeof RequestEnvelopeSchema>;
export type Diagnostics = z.infer<typeof DiagnosticsSchema>;

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: ErrorCode; message: string } };

export type SnapshotPage = {
  config: AppConfig;
  profiles: ProfileSummary[];
  resourceCount: number;
  windowEpoch: number;
  observation: ObservationSnapshot;
  servicePage: {
    offset: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
};

export type ObservationSnapshot = {
  devices: DeviceObservation[];
  containers: ContainerEntity[];
  observations: ContainerObservation[];
  services: ServiceObservation[];
  logs: LogSourceState[];
  containerPage: {
    offset: number;
    limit: number;
    total: number;
    returned: number;
    nextOffset: number;
    hasMore: boolean;
    capacityExceeded: boolean;
  };
  truncated: boolean;
};

export function emptyObservationSnapshot(): ObservationSnapshot {
  return {
    devices: [],
    containers: [],
    observations: [],
    services: [],
    logs: [],
    containerPage: { offset: 0, limit: 96, total: 0, returned: 0, nextOffset: 0, hasMore: false, capacityExceeded: false },
    truncated: false,
  };
}

export type UpdateEnvelope = {
  epoch: number;
  seq: number;
  kind: 'snapshot' | 'observations' | 'logs' | 'diagnostic';
  payload: unknown;
};

export function createDefaultConfig(): AppConfig {
  return {
    schemaVersion: 1,
    devices: [],
    services: [],
    slots: [
      { serviceId: null, logBindingId: null },
      { serviceId: null, logBindingId: null },
      { serviceId: null, logBindingId: null },
      { serviceId: null, logBindingId: null },
    ],
    display: {
      layout: 'columns4',
      focusSlot: 0,
      asciiMode: 'dynamic',
      asciiBrightness: 50,
      asciiStrength: 50,
      reducedMotion: false,
    },
    window: null,
  };
}

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail(code: ErrorCode, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}
