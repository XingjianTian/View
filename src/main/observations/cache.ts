import type { ContainerEntity, ContainerKey, ContainerObservation, DiscoveryResult, MetricSample, ObservationPoint } from '../../shared/entities.js';
import { FreshnessSchema } from '../../shared/entities.js';

const DISCOVERY_TTL_MS = 45_000;
const VISIBLE_STATS_TTL_MS = 15_000;
const HIDDEN_STATS_TTL_MS = 90_000;
const HISTORY_WINDOW_MS = 15 * 60_000;
const HISTORY_LIMIT = 180;

type Clock = () => number;

export class ObservationCache {
  private readonly monotonic: Clock;
  private readonly containers = new Map<ContainerKey, ContainerEntity>();
  private readonly deviceDiscovery = new Map<string, { result: DiscoveryResult; at: number }>();
  private readonly observations = new Map<ContainerKey, ContainerObservation>();

  constructor(monotonic: Clock = () => performance.now()) {
    this.monotonic = monotonic;
  }

  applyDiscovery(result: DiscoveryResult): void {
    const at = this.monotonic();
    const previous = this.deviceDiscovery.get(result.deviceId)?.result;
    if (result.complete || !previous) {
      for (const key of [...this.containers.keys()]) {
        if (key.startsWith(`${result.deviceId}:`)) this.containers.delete(key);
      }
    }
    for (const container of result.containers) this.containers.set(container.key, container);
    this.deviceDiscovery.set(result.deviceId, { result, at });
    for (const [key, observation] of this.observations) {
      const container = this.containers.get(key);
      if (container) {
        if (observation.generation !== container.generation) {
          observation.current = null;
          observation.history = [];
          observation.coverage = { requested: 0, returned: 0, complete: false };
          observation.errorCode = null;
        }
        observation.startedAt = container.startedAt;
        observation.generation = container.generation;
      }
    }
  }

  applyStats(
    deviceId: string,
    ids: readonly string[],
    samples: ReadonlyMap<string, MetricSample>,
    sourceAt: string,
    complete: boolean,
    errorCode: string | null = null,
  ): void {
    const nowIso = new Date().toISOString();
    const now = this.monotonic();
    const requested = ids.length;
    for (const id of ids) {
      const container = this.findContainer(deviceId, id);
      if (!container) continue;
      const key = container.key;
      const sample = samples.get(container.id);
      let observation = this.observations.get(key);
      if (!observation || observation.generation !== container.generation) {
        const replacement: ContainerObservation = {
          key,
          deviceId,
          containerId: container.id,
          startedAt: container.startedAt,
          current: null,
          history: [],
          coverage: { requested, returned: 0, complete: false },
          errorCode: null,
          generation: container.generation,
        };
        this.observations.set(key, replacement);
        observation = replacement;
      }
      const activeObservation = observation;
      if (sample) {
        const point: ObservationPoint = { ...sample, observedAt: nowIso, sourceAt, freshness: complete ? 'fresh' : 'partial' };
        activeObservation.current = point;
        activeObservation.history.push(point);
        activeObservation.history = activeObservation.history.filter((entry) => Date.parse(entry.observedAt) >= Date.now() - HISTORY_WINDOW_MS).slice(-HISTORY_LIMIT);
      } else if (activeObservation.current) {
        activeObservation.current = { ...activeObservation.current, freshness: 'partial' };
      }
      activeObservation.coverage = { requested, returned: samples.size, complete: complete && samples.size === requested };
      activeObservation.errorCode = errorCode;
    }
  }

  markStatsFailure(deviceId: string, ids: readonly string[], errorCode: string): void {
    for (const id of ids) {
      const container = this.findContainer(deviceId, id);
      if (!container) continue;
      const observation = this.observations.get(container.key);
      if (!observation) {
        this.observations.set(container.key, {
          key: container.key,
          deviceId,
          containerId: container.id,
          startedAt: container.startedAt,
          current: null,
          history: [],
          coverage: { requested: ids.length, returned: 0, complete: false },
          errorCode,
          generation: container.generation,
        });
        continue;
      }
      observation.errorCode = errorCode;
      observation.coverage = { ...observation.coverage, complete: false };
      if (observation.current) observation.current = { ...observation.current, freshness: 'stale' };
    }
  }

  getContainer(key: ContainerKey): ContainerEntity | undefined {
    const container = this.containers.get(key);
    return container ? structuredClone(container) : undefined;
  }

  getContainers(deviceId?: string): ContainerEntity[] {
    return [...this.containers.values()]
      .filter((container) => deviceId === undefined || container.deviceId === deviceId)
      .map((container) => structuredClone(container));
  }

  getObservation(key: ContainerKey, visible = true): ContainerObservation | undefined {
    const observation = this.observations.get(key);
    if (!observation) return undefined;
    const ttl = visible ? VISIBLE_STATS_TTL_MS : HIDDEN_STATS_TTL_MS;
    const copy = structuredClone(observation);
    if (copy.current && this.monotonic() - this.monotonicAt(copy.current.observedAt) > ttl) {
      copy.current.freshness = copy.current.freshness === 'unknown' ? 'unknown' : 'stale';
    }
    return copy;
  }

  getObservations(visibleKeys?: ReadonlySet<ContainerKey>): ContainerObservation[] {
    return [...this.observations.keys()]
      .map((key) => this.getObservation(key, visibleKeys?.has(key) ?? false))
      .filter((item): item is ContainerObservation => item !== undefined);
  }

  getDiscovery(deviceId: string): DiscoveryResult | undefined {
    const entry = this.deviceDiscovery.get(deviceId);
    return entry ? structuredClone(entry.result) : undefined;
  }

  isDiscoveryFresh(deviceId: string): boolean {
    const entry = this.deviceDiscovery.get(deviceId);
    return !!entry && this.monotonic() - entry.at <= DISCOVERY_TTL_MS;
  }

  clear(): void {
    this.containers.clear();
    this.deviceDiscovery.clear();
    this.observations.clear();
  }

  private findContainer(deviceId: string, id: string): ContainerEntity | undefined {
    return [...this.containers.values()].find((container) => container.deviceId === deviceId && (container.id === id || container.id.startsWith(id) || id.startsWith(container.id)));
  }

  private monotonicAt(iso: string): number {
    const age = Date.now() - Date.parse(iso);
    return this.monotonic() - Math.max(0, age);
  }
}

export const observationTtls = {
  discoveryMs: DISCOVERY_TTL_MS,
  visibleStatsMs: VISIBLE_STATS_TTL_MS,
  hiddenStatsMs: HIDDEN_STATS_TTL_MS,
  historyWindowMs: HISTORY_WINDOW_MS,
  historyLimit: HISTORY_LIMIT,
} as const;

export function freshnessIsKnown(value: string): boolean {
  return FreshnessSchema.safeParse(value).success && value !== 'unknown';
}
