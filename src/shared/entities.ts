import { z } from 'zod';
import type { BusinessObservation } from './business.js';

const ContainerId = z.string().regex(/^[a-f0-9]{12,64}$/);
const DeviceId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);

export const FreshnessSchema = z.enum(['fresh', 'stale', 'unknown', 'partial']);
export type Freshness = z.infer<typeof FreshnessSchema>;

export const ContainerStateSchema = z.enum(['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead', 'unknown']);
export type ContainerState = z.infer<typeof ContainerStateSchema>;

export const HealthStatusSchema = z.enum(['healthy', 'unhealthy', 'starting', 'none', 'unknown']);
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const ComposeIdentitySchema = z.object({
  project: z.string().trim().max(160).nullable(),
  service: z.string().trim().max(160).nullable(),
  ordinal: z.number().int().nonnegative().nullable(),
}).strict();
export type ComposeIdentity = z.infer<typeof ComposeIdentitySchema>;

export const ContainerEntitySchema = z.object({
  key: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}:[a-f0-9]{12,64}$/),
  deviceId: DeviceId,
  id: ContainerId,
  name: z.string().trim().min(1).max(256),
  image: z.string().trim().max(512),
  compose: ComposeIdentitySchema,
  state: ContainerStateSchema,
  health: HealthStatusSchema,
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  exitCode: z.number().int().nullable(),
  restartCount: z.number().int().nonnegative().nullable(),
  tty: z.boolean().nullable(),
  networkMode: z.string().trim().max(256).nullable(),
  logsAvailable: z.boolean(),
  sourceAt: z.string().datetime(),
  generation: z.string().min(1).max(160),
}).strict();
export type ContainerEntity = z.infer<typeof ContainerEntitySchema>;

export type ContainerKey = string;

export const MetricSampleSchema = z.object({
  cpuPercent: z.number().finite().nonnegative().nullable(),
  memoryBytes: z.number().finite().nonnegative().nullable(),
  memoryLimitBytes: z.number().finite().nonnegative().nullable(),
  networkRxBytes: z.number().finite().nonnegative().nullable(),
  networkTxBytes: z.number().finite().nonnegative().nullable(),
  pids: z.number().finite().nonnegative().nullable(),
}).strict();
export type MetricSample = z.infer<typeof MetricSampleSchema>;

export type ObservationPoint = MetricSample & {
  observedAt: string;
  sourceAt: string;
  freshness: Freshness;
};

export type ContainerObservation = {
  key: ContainerKey;
  deviceId: string;
  containerId: string;
  startedAt: string | null;
  current: ObservationPoint | null;
  history: ObservationPoint[];
  coverage: { requested: number; returned: number; complete: boolean };
  errorCode: string | null;
  generation: string;
};

export type DiscoveryResult = {
  deviceId: string;
  containers: ContainerEntity[];
  observedAt: string;
  complete: boolean;
  errorCode: string | null;
  sourceAt: string | null;
};

export type DeviceObservation = {
  deviceId: string;
  containerCount: number;
  complete: boolean;
  errorCode: string | null;
  sourceAt: string | null;
  observedAt: string;
};

export type ServiceMember = {
  bindingId: string;
  deviceId: string;
  containerKey: ContainerKey | null;
  status: 'bound' | 'unresolved' | 'ambiguous' | 'missing-device';
  reason: string | null;
};

export type ServiceObservation = {
  serviceId: string;
  status: 'unconfigured' | 'ok' | 'attention' | 'neutral' | 'unknown';
  freshness: Freshness;
  coverage: { required: number; observed: number; missing: number };
  members: ServiceMember[];
  metrics: MetricSample;
  uptimeSeconds: number | null;
  sourceAt: string | null;
  observedAt: string;
  errorCode: string | null;
  business: BusinessObservation;
};

export function containerKey(deviceId: string, id: string): ContainerKey {
  return `${deviceId}:${id}` as ContainerKey;
}

export function generationFor(container: Pick<ContainerEntity, 'id' | 'startedAt' | 'deviceId'>): string {
  return `${container.deviceId}:${container.id}:${container.startedAt ?? 'never'}`;
}
