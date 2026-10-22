import type { AppConfig, Device, ObservationSnapshot, Service } from '../shared/contracts.js';
import { createDockerTransport } from './transport/factory.js';
import { readPrivateProfile, resolveSecret } from './credentials/profile-reader.js';
import type { ProfileRegistry } from './credentials/registry.js';
import { ObservationScheduler } from './scheduler.js';
import { LogManager } from './logs/manager.js';
import { TransportError } from './transport/types.js';
import { DeviceTransportPool } from './transport/pool.js';
import type { LogSourceState } from '../shared/logs.js';
import type { ContainerEntity } from '../shared/entities.js';
import { HttpJsonBusinessAdapter } from './business/http-json.js';
import { emptyBusinessObservation, type BusinessObservation } from '../shared/business.js';
import { StatusManager } from './status/manager.js';
import { ArticleReceiptJsonReader, type ArticleTransportLease } from './status/article-receipt-json.js';
import { RagflowDocumentsStatusAdapter, type RagflowTransportLease } from './status/ragflow-documents.js';
import { QuantPgStatusAdapter, type QuantPgTransportLease } from './status/quant-pg.js';
import { InfrastructureStatusAdapter } from './status/infrastructure.js';
import { StatusSourceRegistry } from './status/source-registry.js';
import type { StatusSourceSummary } from '../shared/status.js';

const DEFAULT_CONTAINER_PAGE_LIMIT = 96;
const MAX_CONTAINER_PAGE_LIMIT = 512;

export type SnapshotOptions = {
  containerOffset?: number;
  containerLimit?: number;
};

export class ObservationRuntime {
  readonly scheduler: ObservationScheduler;
  readonly statuses: StatusManager;
  readonly logs = new LogManager();
  readonly transports: DeviceTransportPool;
  private readonly statusSources: StatusSourceRegistry;
  private readonly businessAdapters = new Map<string, HttpJsonBusinessAdapter>();
  private config: AppConfig | null = null;
  private readonly listeners = new Set<() => void>();
  private statusVisibleTimer: NodeJS.Timeout | null = null;
  private statusHiddenTimer: NodeJS.Timeout | null = null;
  private lifecycleGeneration = 0;

  constructor(private readonly profiles: ProfileRegistry) {
    this.transports = new DeviceTransportPool((device) => this.createTransport(device));
    const dataRoot = typeof profiles.dataRoot === 'string' ? profiles.dataRoot : process.cwd();
    this.statusSources = new StatusSourceRegistry(dataRoot, (profileId) => this.profiles.getReference(profileId) !== null);
    this.statuses = new StatusManager({
      resolveEndpoint: (profileId, endpointRef) => this.resolveStatusEndpoint(profileId, endpointRef),
      createArticleReader: () => new ArticleReceiptJsonReader(
        (profileId, sourceRef) => this.statusSources.resolveArticle(profileId, sourceRef),
        (profileId) => this.acquireArticleTransport(profileId),
      ),
      createRagflowReader: () => new RagflowDocumentsStatusAdapter(
        (profileId, sourceRef) => this.statusSources.resolveRagflow(profileId, sourceRef),
        (profileId) => this.acquireRagflowTransport(profileId),
      ),
      createQuantReader: () => new QuantPgStatusAdapter(
        (profileId, sourceRef) => this.statusSources.resolveQuant(profileId, sourceRef),
        (profileId) => this.acquireQuantTransport(profileId),
      ),
      createInfrastructureReader: () => new InfrastructureStatusAdapter(
        (profileId, sourceRef, kind) => this.statusSources.resolveInfrastructure(profileId, sourceRef, kind),
        (profileId) => this.acquireStatusTransport(profileId),
      ),
    });
    this.scheduler = new ObservationScheduler({
      createTransport: (device) => this.transports.acquire(device),
      releaseTransport: (_device, transport) => this.transports.release(transport),
      readBusiness: (service) => this.readBusiness(service),
    });
  }

  start(config: AppConfig): void {
    this.lifecycleGeneration += 1;
    if (this.statusVisibleTimer) clearInterval(this.statusVisibleTimer);
    if (this.statusHiddenTimer) clearInterval(this.statusHiddenTimer);
    this.statusVisibleTimer = null;
    this.statusHiddenTimer = null;
    this.config = structuredClone(config);
    this.statuses.reset();
    const visible = new Set(config.slots.flatMap((slot) => slot.serviceId ? [slot.serviceId] : []));
    this.scheduler.start(config, visible, () => {
      this.observeDockerStatuses();
      this.emitUpdate();
    });
    this.observeDockerStatuses();
    void this.refreshStatusSources();
    this.statusVisibleTimer = setInterval(() => void this.refreshStatusSources(this.visibleStatusServiceIds()), 5_000);
    this.statusHiddenTimer = setInterval(() => void this.refreshStatusSources(this.hiddenStatusServiceIds()), 30_000);
  }

  stop(): void {
    this.lifecycleGeneration += 1;
    if (this.statusVisibleTimer) clearInterval(this.statusVisibleTimer);
    if (this.statusHiddenTimer) clearInterval(this.statusHiddenTimer);
    this.statusVisibleTimer = null;
    this.statusHiddenTimer = null;
    this.scheduler.stop();
    void this.logs.close();
    void this.transports.closeAll();
    this.businessAdapters.clear();
    this.config = null;
    this.statuses.reset();
  }

  private async readBusiness(service: Service): Promise<BusinessObservation> {
    if (service.businessAdapter.kind === 'none') return emptyBusinessObservation();
    let adapter = this.businessAdapters.get(service.id);
    if (!adapter) {
      adapter = new HttpJsonBusinessAdapter({
        resolveEndpoint: async (endpointRef) => this.resolveBusinessEndpoint(service.businessAdapter.kind === 'http_json' ? service.businessAdapter.profileId : '', endpointRef),
      });
      this.businessAdapters.set(service.id, adapter);
    }
    return adapter.read(service.businessAdapter);
  }

  private async resolveBusinessEndpoint(profileId: string, endpointRef: string): Promise<string | undefined> {
    const reference = this.profiles.getReference(profileId);
    if (!reference) return undefined;
    const profile = await readPrivateProfile(reference.sourcePath);
    return profile.businessEndpoints[endpointRef];
  }

  private async resolveStatusEndpoint(profileId: string, endpointRef: string): Promise<string | undefined> {
    const reference = this.profiles.getReference(profileId);
    if (!reference) return undefined;
    const profile = await readPrivateProfile(reference.sourcePath);
    return profile.statusEndpoints?.[endpointRef] ?? profile.businessEndpoints[endpointRef];
  }

  async refresh(): Promise<void> {
    await this.scheduler.refreshNow();
    await this.refreshStatusSources();
  }

  statusPage(serviceId: string, cursor?: string, limit = 40) {
    return this.statuses.page(serviceId, cursor, limit);
  }

  async statusSourceSummaries(): Promise<StatusSourceSummary[]> {
    const [privateSources, http] = await Promise.all([this.statusSources.summaries(), this.profiles.statusEndpointSummaries()]);
    return [...http, ...privateSources];
  }

  snapshot(options: SnapshotOptions = {}): ObservationSnapshot {
    const containerOffset = normalizePageNumber(options.containerOffset, 0, 4096);
    const containerLimit = normalizePageNumber(options.containerLimit, DEFAULT_CONTAINER_PAGE_LIMIT, MAX_CONTAINER_PAGE_LIMIT);
    const allContainers = this.scheduler.cache.getContainers();
    const pageContainers = allContainers.slice(containerOffset, containerOffset + containerLimit);
    const selectedKeys = this.selectedContainerKeys();
    const containers = dedupeContainers([...pageContainers, ...allContainers.filter((container) => selectedKeys.has(container.key))]);
    const containerKeys = new Set(containers.map((container) => container.key));
    const allObservations = this.scheduler.cache.getObservations();
    const observations = allObservations
      .filter((observation) => containerKeys.has(observation.key))
      .map((observation) => ({ ...observation, history: observation.history.slice(-24) }));
    const devices = this.scheduler.deviceObservations();
    const containerPage = {
      offset: containerOffset,
      limit: containerLimit,
      total: allContainers.length,
      returned: containers.length,
      nextOffset: Math.min(allContainers.length, containerOffset + pageContainers.length),
      hasMore: containerOffset + pageContainers.length < allContainers.length,
      capacityExceeded: false,
    };
    const snapshot: ObservationSnapshot = {
      devices,
      containers,
      observations,
      services: this.scheduler.serviceObservations(new Set()).slice(0, 128),
      logs: this.logs.list().map(trimLogState),
      containerPage,
      truncated: devices.some((device) => !device.complete) || containerPage.hasMore,
    };
    return boundSnapshot(snapshot, selectedKeys, pageContainers.map((container) => container.key));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async openLog(deviceId: string, containerId: string): Promise<boolean> {
    const config = this.config;
    if (!config) return false;
    const device = config.devices.find((item) => item.id === deviceId && item.enabled);
    const container = this.scheduler.cache.getContainers(deviceId).find((item) => item.id === containerId);
    if (!device || !container || !container.logsAvailable) return false;
    const sourceKey = container.key;
    const continuous = container.state === 'running';
    if (this.logs.retainIfCompatible(sourceKey, container.generation, continuous)) return true;
    const transport = await this.transports.acquire(device);
    const secrets = await this.privateSecrets(device);
    const opened = this.logs.open({
      sourceKey,
      deviceId,
      containerId,
      generation: container.generation,
      continuous,
      transport,
      releaseTransport: () => this.transports.release(transport),
      secrets,
    });
    if (!opened) this.transports.release(transport);
    return opened;
  }

  async pollLog(sourceKey: string) {
    return this.logs.poll(sourceKey);
  }

  closeLog(sourceKey: string, generation?: string, continuous?: boolean): void {
    this.logs.release(sourceKey, generation, continuous);
  }

  pauseLog(sourceKey: string, paused: boolean): void {
    this.logs.pause(sourceKey, paused);
  }

  searchLog(sourceKey: string, query: string) {
    return this.logs.search(sourceKey, query);
  }

  private async createTransport(device: Device) {
    const reference = this.profiles.getReference(device.profileId);
    if (!reference || reference.kind !== device.transport) {
      throw new TransportError('profile_missing', 'Device profile is unavailable.');
    }
    return createDockerTransport(reference, {
      trace: (event) => this.logs.recordTransportTrace(device.id, event),
    });
  }

  private async acquireArticleTransport(profileId: string): Promise<ArticleTransportLease | null> {
    return this.acquireStatusTransport(profileId);
  }

  private async acquireRagflowTransport(profileId: string): Promise<RagflowTransportLease | null> {
    return this.acquireStatusTransport(profileId);
  }

  private async acquireQuantTransport(profileId: string): Promise<QuantPgTransportLease | null> {
    return this.acquireStatusTransport(profileId);
  }

  private async acquireStatusTransport(profileId: string): Promise<{ transport: import('./transport/types.js').DockerTransport; release: () => void } | null> {
    const device = this.config?.devices.find((item) => item.enabled && item.transport === 'ssh' && item.profileId === profileId);
    if (!device) return null;
    try {
      const transport = await this.transports.acquire(device);
      return { transport, release: () => this.transports.release(transport) };
    } catch {
      return null;
    }
  }

  private async privateSecrets(device: Device): Promise<string[]> {
    const reference = this.profiles.getReference(device.profileId);
    if (!reference || reference.kind !== 'ssh') return [];
    try {
      const profile = await readPrivateProfile(reference.sourcePath);
      if (profile.kind !== 'ssh') return [];
      const values = await Promise.all([resolveSecret(profile, 'password'), resolveSecret(profile, 'sudoPassword')]);
      return values.filter((value): value is string => !!value);
    } catch {
      return [];
    }
  }

  private emitUpdate(): void {
    for (const listener of this.listeners) listener();
  }

  private observeDockerStatuses(): void {
    this.statuses.observeDocker(
      this.scheduler.serviceObservations(new Set()),
      this.scheduler.deviceObservations(),
      this.scheduler.cache.getContainers(),
    );
  }

  private async refreshStatusSources(selectedServiceIds?: ReadonlySet<string>): Promise<void> {
    const config = this.config;
    if (!config) return;
    const generation = this.lifecycleGeneration;
    try {
      await this.statuses.readConfigured(config.services, new Date(), selectedServiceIds);
      if (generation !== this.lifecycleGeneration || this.config !== config) return;
      this.observeDockerStatuses();
      this.emitUpdate();
    } catch {
      // Background status refreshes must not become unhandled rejections.
    }
  }

  private visibleStatusServiceIds(): Set<string> {
    if (!this.config) return new Set();
    return new Set(this.config.slots.flatMap((slot) => slot.serviceId ? [slot.serviceId] : []));
  }

  private hiddenStatusServiceIds(): Set<string> {
    if (!this.config) return new Set();
    const visible = this.visibleStatusServiceIds();
    return new Set(this.config.services.filter((service) => !visible.has(service.id)).map((service) => service.id));
  }

  private selectedContainerKeys(): Set<string> {
    if (!this.config) return new Set();
    const selectedServiceIds = new Set(this.config.slots.flatMap((slot) => slot.serviceId ? [slot.serviceId] : []));
    if (!selectedServiceIds.size) return new Set();
    return new Set(this.scheduler.serviceObservations(selectedServiceIds).flatMap((service) => service.members.flatMap((member) => member.containerKey ? [member.containerKey] : [])));
  }
}

function trimLogState(state: LogSourceState): LogSourceState {
  return { ...state, entries: state.entries.slice(-100) };
}

function boundSnapshot(snapshot: ObservationSnapshot, selectedKeys: ReadonlySet<string>, pageKeys: readonly string[]): ObservationSnapshot {
  let next = snapshot;
  while (Buffer.byteLength(JSON.stringify(next), 'utf8') > 48 * 1024) {
    if (next.logs.some((log) => log.entries.length > 1)) {
      next = { ...next, logs: next.logs.map((log) => ({ ...log, entries: log.entries.slice(-Math.max(1, Math.floor(log.entries.length / 2))) })), truncated: true };
      continue;
    }
    if (next.observations.some((observation) => observation.history.length > 1)) {
      next = { ...next, observations: next.observations.map((observation) => ({ ...observation, history: observation.history.slice(-Math.max(1, Math.floor(observation.history.length / 2))) })), truncated: true };
      continue;
    }
    const removableContainers = next.containers.filter((container) => !selectedKeys.has(container.key));
    if (removableContainers.length) {
      const keepCount = Math.floor(removableContainers.length / 2);
      const keepKeys = new Set(removableContainers.slice(0, keepCount).map((container) => container.key));
      const containers = next.containers.filter((container) => selectedKeys.has(container.key) || keepKeys.has(container.key));
      next = { ...next, containers, truncated: true };
      continue;
    }
    if (next.observations.length > 32) {
      next = { ...next, observations: next.observations.slice(0, Math.max(1, Math.floor(next.observations.length / 2))), truncated: true };
      continue;
    }
    if (next.services.length > 16) {
      next = { ...next, services: next.services.slice(0, Math.max(1, Math.floor(next.services.length / 2))), truncated: true };
      continue;
    }
    if (next.logs.length) {
      next = { ...next, logs: [], truncated: true };
      continue;
    }
    if (next.observations.length) {
      next = { ...next, observations: [], truncated: true };
      continue;
    }
    if (next.services.length) {
      next = { ...next, services: [], truncated: true };
      continue;
    }
    if (next.containers.length) {
      const keepCount = Math.floor(next.containers.length / 2);
      const containers = next.containers.slice(0, keepCount);
      next = {
        ...next,
        containers,
        containerPage: { ...next.containerPage, capacityExceeded: true },
        truncated: true,
      };
      continue;
    }
    break;
  }
  const returnedKeys = new Set(next.containers.map((container) => container.key));
  let pageCount = 0;
  for (const key of pageKeys) {
    if (!returnedKeys.has(key)) break;
    pageCount += 1;
  }
  const nextOffset = Math.min(next.containerPage.total, next.containerPage.offset + pageCount);
  return {
    ...next,
    containerPage: {
      ...next.containerPage,
      returned: next.containers.length,
      nextOffset,
      hasMore: nextOffset < next.containerPage.total,
    },
  };
}

function normalizePageNumber(value: number | undefined, fallback: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(0, Math.floor(value)));
}

function dedupeContainers(containers: readonly ContainerEntity[]): ContainerEntity[] {
  return [...new Map(containers.map((container) => [container.key, container])).values()];
}
