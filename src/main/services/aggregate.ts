import type { Service } from '../../shared/contracts.js';
import { emptyBusinessObservation, type BusinessObservation } from '../../shared/business.js';
import type { ContainerEntity, ContainerObservation, Freshness, MetricSample, ServiceMember, ServiceObservation } from '../../shared/entities.js';
import { dedupeMemberKeys } from './resolver.js';

export function aggregateServiceObservation(
  service: Service,
  members: readonly ServiceMember[],
  containers: ReadonlyMap<string, ContainerEntity>,
  observations: ReadonlyMap<string, ContainerObservation>,
  business: BusinessObservation = emptyBusinessObservation(),
  observedAt = new Date().toISOString(),
  discoveryComplete = true,
): ServiceObservation {
  if (!service.bindings.length) {
    return {
      serviceId: service.id,
      status: 'unconfigured',
      freshness: 'unknown',
      coverage: { required: 0, observed: 0, missing: 0 },
      members: [...members],
      metrics: emptyMetrics(),
      uptimeSeconds: null,
      sourceAt: null,
      observedAt,
      errorCode: 'binding_unresolved',
      business,
    };
  }
  const requiredBindings = service.bindings.filter((binding) => binding.required);
  const memberByBinding = new Map(members.map((member) => [member.bindingId, member]));
  const uniqueKeys = dedupeMemberKeys(members);
  const uniqueObservations = uniqueKeys
    .map((key) => ({ container: containers.get(key), observation: observations.get(key) }))
    .filter((item): item is { container: ContainerEntity; observation: ContainerObservation } => !!item.container && !!item.observation);
  const observedKeys = new Set(uniqueObservations.filter(({ observation }) => observation.current !== null).map(({ container }) => container.key));
  const missingRequired = requiredBindings.filter((binding) => {
    const member = memberByBinding.get(binding.id);
    if (!member || member.status !== 'bound' || !member.containerKey) return true;
    const container = containers.get(member.containerKey);
    if (!container) return true;
    if (binding.expectedPolicy === 'manual' && container.state !== 'running') return false;
    return !observedKeys.has(member.containerKey);
  });
  const freshness = combineFreshness(members, uniqueObservations.map(({ observation }) => observation.current?.freshness ?? 'unknown'));
  const metrics = sumMetrics(uniqueObservations.filter(({ container }) => observedKeys.has(container.key)).map(({ observation }) => observation.current ?? emptyMetrics()));
  const sourceAt = uniqueObservations.map(({ observation }) => observation.current?.sourceAt).filter((value): value is string => !!value).sort().at(-1) ?? null;
  const status = deriveStatus(service, members, memberByBinding, containers, observedKeys, missingRequired.length, freshness, discoveryComplete);
  const continuous = requiredBindings
    .map((binding) => memberByBinding.get(binding.id))
    .filter((member): member is ServiceMember => !!member && member.status === 'bound' && !!member.containerKey)
    .map((member) => containers.get(member.containerKey as string))
    .filter((container): container is ContainerEntity => !!container && container.startedAt !== null && container.state === 'running')
    .map((container) => Math.max(0, (Date.parse(observedAt) - Date.parse(container.startedAt as string)) / 1000))
    .filter(Number.isFinite);
  return {
    serviceId: service.id,
    status,
    freshness,
    coverage: { required: requiredBindings.length, observed: requiredBindings.length - missingRequired.length, missing: missingRequired.length },
    members: [...members],
    metrics,
    uptimeSeconds: continuous.length ? Math.min(...continuous) : null,
    sourceAt,
    observedAt,
    errorCode: discoveryComplete && missingRequired.length ? 'binding_unresolved' : null,
    business,
  };
}

function deriveStatus(
  service: Service,
  members: readonly ServiceMember[],
  memberByBinding: ReadonlyMap<string, ServiceMember>,
  containers: ReadonlyMap<string, ContainerEntity>,
  observedKeys: ReadonlySet<string>,
  missingRequired: number,
  freshness: Freshness,
  discoveryComplete: boolean,
): ServiceObservation['status'] {
  if (!discoveryComplete) return 'unknown';
  if (missingRequired > 0) return 'attention';
  if (service.bindings.some((binding) => binding.expectedPolicy === 'manual' && memberByBinding.get(binding.id)?.containerKey && containers.get(memberByBinding.get(binding.id)?.containerKey as string)?.state !== 'running')) return 'neutral';
  if (freshness === 'unknown') return 'unknown';
  for (const binding of service.bindings) {
    const member = memberByBinding.get(binding.id);
    if (!member || member.status !== 'bound' || !member.containerKey) continue;
    const container = containers.get(member.containerKey);
    if (!container || !observedKeys.has(container.key)) continue;
    if (binding.expectedPolicy === 'continuous' && (container.state !== 'running' || container.health === 'unhealthy')) return 'attention';
    if (binding.expectedPolicy === 'manual' && container.state !== 'running') return 'neutral';
  }
  if (members.length && members.every((member) => member.status !== 'bound')) return 'unknown';
  return freshness === 'fresh' ? 'ok' : freshness === 'partial' ? 'attention' : 'unknown';
}

function combineFreshness(members: readonly ServiceMember[], values: readonly Freshness[]): Freshness {
  if (!members.some((member) => member.status === 'bound')) return 'unknown';
  if (values.includes('unknown')) return 'unknown';
  if (values.includes('stale')) return 'stale';
  if (values.includes('partial')) return 'partial';
  return 'fresh';
}

function emptyMetrics(): MetricSample {
  return { cpuPercent: null, memoryBytes: null, memoryLimitBytes: null, networkRxBytes: null, networkTxBytes: null, pids: null };
}

function sumMetrics(metrics: readonly MetricSample[]): MetricSample {
  const sum = (field: keyof MetricSample): number | null => {
    const values = metrics.map((metric) => metric[field]).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  return {
    cpuPercent: sum('cpuPercent'),
    memoryBytes: sum('memoryBytes'),
    memoryLimitBytes: sum('memoryLimitBytes'),
    networkRxBytes: sum('networkRxBytes'),
    networkTxBytes: sum('networkTxBytes'),
    pids: sum('pids'),
  };
}
