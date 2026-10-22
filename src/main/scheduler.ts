import type { AppConfig, Device, Service } from '../shared/contracts.js';
import { emptyBusinessObservation, type BusinessObservation } from '../shared/business.js';
import type { ContainerKey, DeviceObservation, ServiceObservation } from '../shared/entities.js';
import { ObservationCache } from './observations/cache.js';
import { discoverDevice } from './discovery/collector.js';
import { parseStatsOutput } from './observations/stats-parser.js';
import { aggregateServiceObservation } from './services/aggregate.js';
import { resolveServiceMembers } from './services/resolver.js';
import { TransportError, type DockerTransport } from './transport/types.js';

const DISCOVERY_INTERVAL_MS = 15_000;
const VISIBLE_STATS_INTERVAL_MS = 5_000;
const HIDDEN_STATS_INTERVAL_MS = 30_000;
const MAX_GLOBAL_REQUESTS = 8;
const MAX_DEVICE_REQUESTS = 4;
const MAX_STATS_BATCH = 32;
const DISCOVERY_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 30_000] as const;
const BUSINESS_INTERVAL_MS = 30_000;
const MAX_BUSINESS_REQUESTS = 2;

export type TransportFactory = (device: Device) => Promise<DockerTransport>;

export type SchedulerOptions = {
  cache?: ObservationCache;
  createTransport: TransportFactory;
  releaseTransport?: (device: Device, transport: DockerTransport) => Promise<void> | void;
  setTimer?: (callback: () => void, delay: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  sleep?: (delay: number) => Promise<void>;
  random?: () => number;
  readBusiness?: (service: Service) => Promise<BusinessObservation>;
};

export class ObservationScheduler {
  readonly cache: ObservationCache;
  private readonly createTransport: TransportFactory;
  private readonly releaseTransport: (device: Device, transport: DockerTransport) => Promise<void> | void;
  private readonly setTimer: (callback: () => void, delay: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;
  private readonly sleep: (delay: number) => Promise<void>;
  private readonly random: () => number;
  private readonly readBusiness: (service: Service) => Promise<BusinessObservation>;
  private readonly inFlight = new Set<string>();
  private readonly deviceRequests = new Map<string, number>();
  private timers: NodeJS.Timeout[] = [];
  private globalRequests = 0;
  private config: AppConfig | null = null;
  private visibleServiceIds = new Set<string>();
  private onUpdate: (() => void) | null = null;
  private readonly businessByService = new Map<string, BusinessObservation>();

  constructor(options: SchedulerOptions) {
    this.cache = options.cache ?? new ObservationCache();
    this.createTransport = options.createTransport;
    this.releaseTransport = options.releaseTransport ?? ((_device, transport) => transport.close());
    this.setTimer = options.setTimer ?? ((callback, delay) => setInterval(callback, delay));
    this.clearTimer = options.clearTimer ?? ((timer) => clearInterval(timer));
    this.sleep = options.sleep ?? ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
    this.random = options.random ?? Math.random;
    this.readBusiness = options.readBusiness ?? (async () => emptyBusinessObservation());
  }

  start(config: AppConfig, visibleServiceIds: ReadonlySet<string> = new Set(), onUpdate?: () => void): void {
    this.stop();
    this.config = structuredClone(config);
    this.visibleServiceIds = new Set(visibleServiceIds);
    this.onUpdate = onUpdate ?? null;
    void this.runDiscoveryCycle();
    void this.runStatsCycle();
    void this.runBusinessCycle();
    this.timers = [
      this.setTimer(() => void this.runDiscoveryCycle(), DISCOVERY_INTERVAL_MS),
      this.setTimer(() => void this.runStatsCycle(), VISIBLE_STATS_INTERVAL_MS),
      this.setTimer(() => void this.runHiddenStatsCycle(), HIDDEN_STATS_INTERVAL_MS),
      this.setTimer(() => void this.runBusinessCycle(), BUSINESS_INTERVAL_MS),
    ];
  }

  stop(): void {
    for (const timer of this.timers) this.clearTimer(timer);
    this.timers = [];
    this.config = null;
    this.visibleServiceIds.clear();
    this.businessByService.clear();
    this.onUpdate = null;
  }

  setVisibleServices(ids: ReadonlySet<string>): void {
    this.visibleServiceIds = new Set(ids);
  }

  async runDiscoveryCycle(): Promise<void> {
    const config = this.config;
    if (!config) return;
    await Promise.all(config.devices.filter((device) => device.enabled).map((device) => this.runDeviceDiscovery(device)));
    this.onUpdate?.();
  }

  async refreshNow(): Promise<void> {
    await this.runDiscoveryCycle();
    await this.runStatsCycle();
  }

  async runStatsCycle(): Promise<void> {
    await this.runStatsForServices(this.visibleServiceIds, true);
    this.onUpdate?.();
  }

  async runHiddenStatsCycle(): Promise<void> {
    const config = this.config;
    if (!config) return;
    const hidden = new Set(config.services.filter((service) => !this.visibleServiceIds.has(service.id)).map((service) => service.id));
    await this.runStatsForServices(hidden, false);
    this.onUpdate?.();
  }

  async runBusinessCycle(): Promise<void> {
    const config = this.config;
    if (!config) return;
    const services = [...config.services];
    for (let offset = 0; offset < services.length; offset += MAX_BUSINESS_REQUESTS) {
      const batch = services.slice(offset, offset + MAX_BUSINESS_REQUESTS);
      await Promise.all(batch.map(async (service) => {
        try {
          this.businessByService.set(service.id, await this.readBusiness(service));
        } catch {
          this.businessByService.set(service.id, { ...emptyBusinessObservation(), status: 'error', errorCode: 'business_http' });
        }
      }));
    }
    this.onUpdate?.();
  }

  serviceObservations(visibleServiceIds = this.visibleServiceIds): ServiceObservation[] {
    const config = this.config;
    if (!config) return [];
    const devices = new Set(config.devices.filter((device) => device.enabled).map((device) => device.id));
    const containers = new Map(this.cache.getContainers().map((container) => [container.key, container]));
    const observations = new Map(this.cache.getObservations().map((observation) => [observation.key, observation]));
    return config.services.map((service) => {
      const members = resolveServiceMembers(service, devices, [...containers.values()]);
      const discoveryComplete = [...new Set(service.bindings.map((binding) => binding.deviceId))]
        .every((deviceId) => this.cache.getDiscovery(deviceId)?.complete === true);
      return aggregateServiceObservation(service, members, containers, observations, this.businessByService.get(service.id), undefined, discoveryComplete);
    }).filter((observation) => visibleServiceIds.size === 0 || visibleServiceIds.has(observation.serviceId));
  }

  deviceObservations(): DeviceObservation[] {
    const config = this.config;
    if (!config) return [];
    return config.devices.filter((device) => device.enabled).map((device) => {
      const discovery = this.cache.getDiscovery(device.id);
      return {
        deviceId: device.id,
        containerCount: this.cache.getContainers(device.id).length,
        complete: discovery?.complete ?? false,
        errorCode: discovery?.errorCode ?? null,
        sourceAt: discovery?.sourceAt ?? null,
        observedAt: discovery?.observedAt ?? new Date().toISOString(),
      };
    });
  }

  private async runDiscovery(device: Device): Promise<void> {
    const lock = `discovery:${device.id}`;
    if (!this.tryAcquire(lock, device.id)) return;
    let result: Awaited<ReturnType<typeof discoverDevice>> | undefined;
    try {
      for (let attempt = 0; ; attempt += 1) {
        let transport: DockerTransport | undefined;
        try {
          transport = await this.createTransport(device);
          result = await discoverDevice(device, transport);
        } catch (error) {
          result = {
            deviceId: device.id,
            containers: [],
            observedAt: new Date().toISOString(),
            complete: false,
            errorCode: mapError(error),
            sourceAt: null,
          };
        } finally {
          if (transport) await Promise.resolve(this.releaseTransport(device, transport)).catch(() => undefined);
        }

        if (!shouldRetryDiscovery(result.errorCode) || attempt >= DISCOVERY_RETRY_DELAYS_MS.length) break;
        const baseDelay = DISCOVERY_RETRY_DELAYS_MS[attempt];
        if (baseDelay === undefined) break;
        const jitter = 0.9 + Math.min(1, Math.max(0, this.random())) * 0.2;
        await this.sleep(Math.round(baseDelay * jitter));
      }
      if (result) this.cache.applyDiscovery(result);
    } finally {
      this.release(lock, device.id);
    }
  }

  private async runDeviceDiscovery(device: Device): Promise<void> {
    await this.runDiscovery(device);
  }

  private async runStatsForServices(serviceIds: ReadonlySet<string>, visible: boolean): Promise<void> {
    const config = this.config;
    if (!config || !serviceIds.size) return;
    const enabledDevices = new Set(config.devices.filter((device) => device.enabled).map((device) => device.id));
    const containers = this.cache.getContainers();
    const targets = new Map<string, Set<string>>();
    for (const service of config.services.filter((item) => serviceIds.has(item.id))) {
      const members = resolveServiceMembers(service, enabledDevices, containers);
      for (const member of members) {
        if (member.status !== 'bound' || !member.containerKey) continue;
        const container = containers.find((item) => item.key === member.containerKey);
        if (!container || container.state !== 'running') continue;
        const ids = targets.get(container.deviceId) ?? new Set<string>();
        ids.add(container.id);
        targets.set(container.deviceId, ids);
      }
    }
    await Promise.all(config.devices.filter((device) => targets.has(device.id) && device.enabled).map((device) => this.runDeviceStats(device, [...(targets.get(device.id) ?? [])], visible)));
  }

  private async runDeviceStats(device: Device, ids: readonly string[], _visible: boolean): Promise<void> {
    if (!ids.length) return;
    const lock = `stats:${device.id}`;
    if (!this.tryAcquire(lock, device.id)) return;
    let transport: DockerTransport | undefined;
    try {
      transport = await this.createTransport(device);
      for (let offset = 0; offset < ids.length; offset += MAX_STATS_BATCH) {
        const batch = ids.slice(offset, offset + MAX_STATS_BATCH);
        try {
          const result = await transport.stats(batch);
          const parsed = parseStatsOutput(result, batch, 128);
          this.cache.applyStats(device.id, batch, parsed.values, result.observedAt, parsed.complete, parsed.complete ? null : 'incomplete');
        } catch (error) {
          this.cache.markStatsFailure(device.id, batch, mapError(error));
        }
      }
    } catch (error) {
      this.cache.markStatsFailure(device.id, ids, mapError(error));
    } finally {
      if (transport) await Promise.resolve(this.releaseTransport(device, transport)).catch(() => undefined);
      this.release(lock, device.id);
    }
  }

  private tryAcquire(lock: string, deviceId: string): boolean {
    if (this.inFlight.has(lock)) return false;
    if (this.globalRequests >= MAX_GLOBAL_REQUESTS) return false;
    if ((this.deviceRequests.get(deviceId) ?? 0) >= MAX_DEVICE_REQUESTS) return false;
    this.inFlight.add(lock);
    this.globalRequests += 1;
    this.deviceRequests.set(deviceId, (this.deviceRequests.get(deviceId) ?? 0) + 1);
    return true;
  }

  private release(lock: string, deviceId: string): void {
    if (!this.inFlight.delete(lock)) return;
    this.globalRequests = Math.max(0, this.globalRequests - 1);
    const count = (this.deviceRequests.get(deviceId) ?? 1) - 1;
    if (count <= 0) this.deviceRequests.delete(deviceId);
    else this.deviceRequests.set(deviceId, count);
  }
}

function mapError(error: unknown): string {
  return error instanceof TransportError ? error.code : 'internal';
}

function shouldRetryDiscovery(errorCode: string | null): boolean {
  return errorCode === 'timeout' || errorCode === 'engine_unavailable';
}

export const schedulerIntervals = {
  discoveryMs: DISCOVERY_INTERVAL_MS,
  visibleStatsMs: VISIBLE_STATS_INTERVAL_MS,
  hiddenStatsMs: HIDDEN_STATS_INTERVAL_MS,
  maxGlobalRequests: MAX_GLOBAL_REQUESTS,
  maxDeviceRequests: MAX_DEVICE_REQUESTS,
  businessMs: BUSINESS_INTERVAL_MS,
  maxBusinessRequests: MAX_BUSINESS_REQUESTS,
} as const;
