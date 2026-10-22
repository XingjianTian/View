import type { Service } from '../../shared/contracts.js';
import type { ContainerEntity, DeviceObservation, ServiceObservation } from '../../shared/entities.js';
import {
  sanitizeId,
  statusLimits,
  statusSourceRef,
  type StatusFeed,
  type StatusPage,
  type StatusRecord,
} from '../../shared/status.js';
import { HttpJsonStatusAdapter, type EndpointResolver } from './http-json.js';
import { ArticleReceiptJsonReader } from './article-receipt-json.js';
import { RagflowDocumentsStatusAdapter } from './ragflow-documents.js';
import { InfrastructureStatusAdapter } from './infrastructure.js';
import type { InfrastructureKind } from '../transport/infrastructure.js';
import { QuantPgStatusAdapter } from './quant-pg.js';

type Clock = () => Date;

export type StatusManagerOptions = {
  resolveEndpoint: EndpointResolver;
  now?: Clock;
  createHttpAdapter?: (serviceId: string, resolveEndpoint: EndpointResolver) => HttpJsonStatusAdapter;
  createArticleReader?: () => ArticleReceiptJsonReader;
  createRagflowReader?: () => RagflowDocumentsStatusAdapter;
  createQuantReader?: () => QuantPgStatusAdapter;
  createInfrastructureReader?: () => InfrastructureStatusAdapter;
};

export class StatusManager {
  private readonly now: Clock;
  private readonly resolveEndpoint: EndpointResolver;
  private readonly createHttpAdapter: (serviceId: string, resolveEndpoint: EndpointResolver) => HttpJsonStatusAdapter;
  private readonly createArticleReader: (() => ArticleReceiptJsonReader) | undefined;
  private readonly createRagflowReader: (() => RagflowDocumentsStatusAdapter) | undefined;
  private readonly createQuantReader: (() => QuantPgStatusAdapter) | undefined;
  private readonly createInfrastructureReader: (() => InfrastructureStatusAdapter) | undefined;
  private readonly records = new Map<string, StatusRecord[]>();
  private readonly fingerprints = new Map<string, string>();
  private readonly transitionSequences = new Map<string, number>();
  private readonly feeds = new Map<string, StatusFeed>();
  private readonly serviceSources = new Map<string, Set<string>>();
  private readonly httpAdapters = new Map<string, HttpJsonStatusAdapter>();
  private articleReader: ArticleReceiptJsonReader | null = null;
  private ragflowReader: RagflowDocumentsStatusAdapter | null = null;
  private quantReader: QuantPgStatusAdapter | null = null;
  private infrastructureReader: InfrastructureStatusAdapter | null = null;
  private generation = 0;
  private configuredReadToken = 0;
  private configuredRead: { token: number; controller: AbortController } | null = null;

  constructor(options: StatusManagerOptions) {
    this.now = options.now ?? (() => new Date());
    this.resolveEndpoint = options.resolveEndpoint;
    this.createHttpAdapter = options.createHttpAdapter ?? ((_serviceId, resolveEndpoint) => new HttpJsonStatusAdapter({ resolveEndpoint }));
    this.createArticleReader = options.createArticleReader;
    this.createRagflowReader = options.createRagflowReader;
    this.createQuantReader = options.createQuantReader;
    this.createInfrastructureReader = options.createInfrastructureReader;
  }

  reset(): void {
    this.generation += 1;
    this.configuredRead?.controller.abort();
    this.configuredRead = null;
    this.records.clear();
    this.fingerprints.clear();
    this.transitionSequences.clear();
    this.feeds.clear();
    this.serviceSources.clear();
    this.httpAdapters.clear();
    this.articleReader = null;
    this.ragflowReader = null;
    this.quantReader = null;
    this.infrastructureReader = null;
  }

  observeDocker(
    services: readonly ServiceObservation[],
    devices: readonly DeviceObservation[],
    containers: readonly ContainerEntity[],
    now = this.now(),
  ): void {
    const observedAt = now.toISOString();
    const containerByKey = new Map(containers.map((container) => [container.key, container]));
    const deviceById = new Map(devices.map((device) => [device.deviceId, device]));
    for (const device of devices) {
      const sourceRef = statusSourceRef('docker', device.deviceId);
      const previous = this.feeds.get(sourceRef);
      const sourceAt = validDate(device.sourceAt ?? device.observedAt);
      const sourceAge = sourceAt ? Math.max(0, now.getTime() - Date.parse(sourceAt)) : Number.POSITIVE_INFINITY;
      const health = device.errorCode ? 'error' : device.complete && sourceAge <= statusLimits.staleAfterMs ? 'fresh' : previous?.lastSuccessAt ? 'stale' : 'unconfigured';
      this.setFeed(sourceRef, {
        sourceRef,
        health,
        lastSuccessAt: device.complete && sourceAt ? sourceAt : previous?.lastSuccessAt ?? null,
        observedAt,
        cursor: null,
        hasMore: false,
        gap: false,
        errorCode: device.errorCode ? 'status_source' : health === 'stale' ? 'status_expired' : null,
      });
    }
    for (const service of services) {
      const deviceRefs = new Set(service.members.map((member) => statusSourceRef('docker', member.deviceId)));
      for (const sourceRef of deviceRefs) this.addServiceSource(service.serviceId, sourceRef);
      const relevant = service.members.map((member) => ({ member, container: member.containerKey ? containerByKey.get(member.containerKey) : undefined }));
      const observedContainers = relevant.filter((item) => item.container !== undefined);
      const discoveryComplete = service.members.length > 0 && service.members.every((member) => deviceById.get(member.deviceId)?.complete === true);
      if (!observedContainers.length && !discoveryComplete) continue;
      const fingerprint = JSON.stringify({
        status: service.status,
        freshness: service.freshness,
        coverage: service.coverage,
        members: relevant.map(({ member, container }) => ({ bindingId: member.bindingId, status: member.status, key: container?.key ?? null, state: container?.state ?? null, health: container?.health ?? null, generation: container?.generation ?? null })),
      });
      const previousFingerprint = this.fingerprints.get(service.serviceId);
      if (previousFingerprint === fingerprint) continue;
      this.fingerprints.set(service.serviceId, fingerprint);
      const sequence = (this.transitionSequences.get(service.serviceId) ?? 0) + 1;
      this.transitionSequences.set(service.serviceId, sequence);
      const sourceRef = statusSourceRef('docker', relevant[0]?.member.deviceId ?? service.serviceId);
      const sourceAt = [...observedContainers.map(({ container }) => container?.sourceAt), ...service.members.map((member) => deviceById.get(member.deviceId)?.sourceAt ?? null)]
        .filter((value): value is string => !!value).sort().at(-1) ?? null;
      const stateCounts = countValues(observedContainers.map(({ container }) => container?.state ?? 'unknown'));
      const healthCounts = countValues(observedContainers.map(({ container }) => container?.health ?? 'unknown'));
      const facts = {
        serviceStatus: service.status,
        freshness: service.freshness,
        required: service.coverage.required,
        observed: service.coverage.observed,
        missing: service.coverage.missing,
        members: relevant.length,
        containers: observedContainers.length,
        states: formatCounts(stateCounts),
        health: formatCounts(healthCounts),
      } satisfies Record<string, string | number | boolean | null>;
      const outcome = service.status === 'ok' || service.status === 'neutral' ? 'active' : 'unknown';
      const record: StatusRecord = {
        id: sanitizeId(`docker-${service.serviceId}-${sequence}-${hashFingerprint(fingerprint)}`, `docker-${service.serviceId}-${sequence}`),
        serviceId: sanitizeId(service.serviceId, 'service'),
        sourceRef,
        taskKey: null,
        stage: '容器观察',
        outcome,
        summary: formatDockerSummary(service, stateCounts, healthCounts, previousFingerprint === undefined),
        occurredAt: validDate(sourceAt),
        sourceAt: validDate(sourceAt),
        observedAt,
        evidenceKind: 'container_observation',
        facts,
        evidenceRef: sanitizeId(`docker-${service.serviceId}`, 'docker-observation'),
      };
      this.addRecord(record);
    }
  }

  async readConfigured(services: readonly Service[], now = this.now(), selectedServiceIds?: ReadonlySet<string>): Promise<void> {
    if (this.configuredRead) return;
    const token = ++this.configuredReadToken;
    const controller = new AbortController();
    this.configuredRead = { token, controller };
    try {
      await this.readConfiguredInternal(services, now, selectedServiceIds, controller.signal);
    } finally {
      if (this.configuredRead?.token === token) this.configuredRead = null;
    }
  }

  private async readConfiguredInternal(services: readonly Service[], now: Date, selectedServiceIds?: ReadonlySet<string>, signal?: AbortSignal): Promise<void> {
    const generation = this.generation;
    const httpGroups = new Map<string, { sourceRef: string; adapter: Extract<NonNullable<Service['statusAdapter']>, { kind: 'http_json' }>; services: Service[] }>();
    const articleGroups = new Map<string, { sourceRef: string; adapter: Extract<NonNullable<Service['statusAdapter']>, { kind: 'article_receipt_json' }>; services: Service[] }>();
    const ragflowGroups = new Map<string, { sourceRef: string; adapter: Extract<NonNullable<Service['statusAdapter']>, { kind: 'ragflow_documents' }>; services: Service[] }>();
    const quantGroups = new Map<string, { sourceRef: string; adapter: Extract<NonNullable<Service['statusAdapter']>, { kind: 'quant_pg_receipts' }>; services: Service[] }>();
    const infrastructureGroups = new Map<string, { sourceRef: string; adapter: Extract<NonNullable<Service['statusAdapter']>, { kind: InfrastructureKind }>; services: Service[] }>();
    for (const service of services) {
      if (selectedServiceIds && !selectedServiceIds.has(service.id)) continue;
      const adapter = service.statusAdapter ?? { kind: 'none' as const };
      if (adapter.kind === 'none') {
        this.setUnconfiguredFeed(service.id, now);
        continue;
      }
      if (adapter.kind === 'http_json') {
        const key = `${adapter.profileId}\u001f${adapter.endpointRef}`;
        const existing = httpGroups.get(key);
        if (existing) existing.services.push(service);
        else httpGroups.set(key, { sourceRef: statusSourceRef('http_json', `${adapter.profileId}:${adapter.endpointRef}`), adapter, services: [service] });
      } else if (adapter.kind === 'article_receipt_json') {
        const key = `${adapter.profileId}\u001f${adapter.sourceRef}`;
        const existing = articleGroups.get(key);
        if (existing) existing.services.push(service);
        else articleGroups.set(key, { sourceRef: statusSourceRef('article_receipt_json', `${adapter.profileId}:${adapter.sourceRef}`), adapter, services: [service] });
      } else if (adapter.kind === 'ragflow_documents') {
        const key = `${adapter.profileId}\u001f${adapter.sourceRef}`;
        const existing = ragflowGroups.get(key);
        if (existing) existing.services.push(service);
        else ragflowGroups.set(key, { sourceRef: statusSourceRef('ragflow_documents', `${adapter.profileId}:${adapter.sourceRef}`), adapter, services: [service] });
      } else if (adapter.kind === 'quant_pg_receipts') {
        const key = `${adapter.profileId}\u001f${adapter.sourceRef}`;
        const existing = quantGroups.get(key);
        if (existing) existing.services.push(service);
        else quantGroups.set(key, { sourceRef: statusSourceRef('quant_pg_receipts', `${adapter.profileId}:${adapter.sourceRef}`), adapter, services: [service] });
      } else {
        const key = `${adapter.kind}\u001f${adapter.profileId}\u001f${adapter.sourceRef}`;
        const existing = infrastructureGroups.get(key);
        if (existing) existing.services.push(service);
        else infrastructureGroups.set(key, { sourceRef: statusSourceRef(adapter.kind, `${adapter.profileId}:${adapter.sourceRef}`), adapter, services: [service] });
      }
    }
    const tasks: Array<() => Promise<void>> = [
      ...[...httpGroups.values()].map((group) => () => this.readHttpGroup(group, now, generation, signal)),
      ...[...articleGroups.values()].map((group) => () => this.readArticleGroup(group, now, generation, signal)),
      ...[...ragflowGroups.values()].map((group) => () => this.readRagflowGroup(group, now, generation, signal)),
      ...[...quantGroups.values()].map((group) => () => this.readQuantGroup(group, now, generation, signal)),
      ...[...infrastructureGroups.values()].map((group) => () => this.readInfrastructureGroup(group, now, generation, signal)),
    ];
    const batches = chunk(tasks, 2);
    for (const batch of batches) {
      if (signal?.aborted) return;
      await Promise.all(batch.map(async (task) => {
        try {
          await task();
        } catch {
          // Group readers convert source failures to bounded feed errors. Keep one
          // unexpected source from rejecting the configured refresh as a whole.
        }
      }));
    }
  }

  page(serviceId: string, cursor: string | undefined, limit: number = statusLimits.maxPageItems): StatusPage {
    const safeServiceId = sanitizeId(serviceId, 'service');
    const boundedLimit = Math.min(statusLimits.maxPageItems, Math.max(1, Math.floor(limit)));
    const all = this.records.get(safeServiceId) ?? [];
    const hasCursor = typeof cursor === 'string' && cursor.length > 0;
    const after = decodeCursor(cursor);
    const cursorIndex = after ? all.findIndex((record) => recordCursorKey(record) === after) : -1;
    const offset = after ? Math.max(0, cursorIndex + 1) : 0;
    let records = all.slice(offset, offset + boundedLimit);
    const cursorMissing = hasCursor && (!after || cursorIndex < 0);
    const feeds = [...(this.serviceSources.get(safeServiceId) ?? [])].map((sourceRef) => this.feeds.get(sourceRef)).filter((value): value is StatusFeed => value !== undefined).map((feed) => cursorMissing ? { ...feed, gap: true } : feed);
    let nextOffset = offset + records.length;
    while (records.length > 0 && Buffer.byteLength(JSON.stringify({ serviceId: safeServiceId, records, nextCursor: 'x', hasMore: true, feeds }), 'utf8') > statusLimits.maxPageBytes) {
      records = records.slice(0, -1);
      nextOffset = offset + records.length;
    }
    const hasMore = nextOffset < all.length;
    const last = records.at(-1);
    const page: StatusPage = {
      serviceId: safeServiceId,
      records,
      nextCursor: hasMore && last ? encodeCursor(last) : null,
      hasMore,
      feeds,
    };
    return page;
  }

  private setUnconfiguredFeed(serviceId: string, now: Date): void {
    const sourceRef = statusSourceRef('http_json', serviceId);
    this.addServiceSource(serviceId, sourceRef);
    this.setFeed(sourceRef, {
      sourceRef,
      health: 'unconfigured',
      lastSuccessAt: this.feeds.get(sourceRef)?.lastSuccessAt ?? null,
      observedAt: now.toISOString(),
      cursor: null,
      hasMore: false,
      gap: false,
      errorCode: 'status_unconfigured',
    });
  }

  private async readHttpGroup(group: { sourceRef: string; adapter: Extract<NonNullable<Service['statusAdapter']>, { kind: 'http_json' }>; services: Service[] }, now: Date, generation: number, signal?: AbortSignal): Promise<void> {
    try {
      const adapterKey = `${group.adapter.profileId}\u001f${group.adapter.endpointRef}`;
      let http = this.httpAdapters.get(adapterKey);
      if (!http) {
        http = this.createHttpAdapter(group.services[0]?.id ?? adapterKey, this.resolveEndpoint);
        this.httpAdapters.set(adapterKey, http);
      }
      const firstService = group.services[0];
      if (!firstService) return;
      const result = await http.read(firstService.id, group.adapter, now, group.sourceRef, signal);
      if (generation !== this.generation) return;
      for (const service of group.services) {
        this.addServiceSource(service.id, group.sourceRef);
        const previous = this.feeds.get(group.sourceRef);
        this.setFeed(group.sourceRef, {
          sourceRef: group.sourceRef,
          health: result.health,
          lastSuccessAt: result.lastSuccessAt ?? previous?.lastSuccessAt ?? null,
          observedAt: result.observedAt,
          cursor: null,
          hasMore: false,
          gap: false,
          errorCode: result.errorCode,
        });
        for (const record of result.records) this.addRecord({ ...record, serviceId: sanitizeId(service.id, 'service') });
      }
    } catch {
      if (generation !== this.generation) return;
      for (const service of group.services) this.setSourceError(service.id, group.sourceRef, now, signal?.aborted ? 'status_timeout' : 'status_source');
    }
  }

  private async readArticleGroup(group: { sourceRef: string; adapter: Extract<NonNullable<Service['statusAdapter']>, { kind: 'article_receipt_json' }>; services: Service[] }, now: Date, generation: number, signal?: AbortSignal): Promise<void> {
    try {
      if (!this.createArticleReader) {
        for (const service of group.services) this.setSourceError(service.id, group.sourceRef, now, 'status_source');
        return;
      }
      this.articleReader ??= this.createArticleReader();
      const result = await this.articleReader.readSnapshots(group.adapter.profileId, group.adapter.sourceRef, signal, now);
      if (generation !== this.generation) return;
      for (const service of group.services) {
        this.addServiceSource(service.id, group.sourceRef);
        const previous = this.feeds.get(group.sourceRef);
        this.setFeed(group.sourceRef, {
          sourceRef: group.sourceRef,
          health: result.health,
          lastSuccessAt: result.lastSuccessAt ?? previous?.lastSuccessAt ?? null,
          observedAt: result.observedAt,
          cursor: null,
          hasMore: false,
          gap: false,
          errorCode: result.errorCode,
        });
        for (const record of result.records) this.addRecord({ ...record, serviceId: sanitizeId(service.id, 'service') });
      }
    } catch {
      if (generation !== this.generation) return;
      for (const service of group.services) this.setSourceError(service.id, group.sourceRef, now, signal?.aborted ? 'status_timeout' : 'status_source');
    }
  }

  private async readRagflowGroup(group: { sourceRef: string; adapter: Extract<NonNullable<Service['statusAdapter']>, { kind: 'ragflow_documents' }>; services: Service[] }, now: Date, generation: number, signal?: AbortSignal): Promise<void> {
    try {
      if (!this.createRagflowReader) {
        for (const service of group.services) this.setSourceError(service.id, group.sourceRef, now, 'status_source');
        return;
      }
      this.ragflowReader ??= this.createRagflowReader();
      const result = await this.ragflowReader.readSnapshots(group.adapter.profileId, group.adapter.sourceRef, signal, now);
      if (generation !== this.generation) return;
      for (const service of group.services) {
        this.addServiceSource(service.id, group.sourceRef);
        const previous = this.feeds.get(group.sourceRef);
        this.setFeed(group.sourceRef, {
          sourceRef: group.sourceRef,
          health: result.health,
          lastSuccessAt: result.lastSuccessAt ?? previous?.lastSuccessAt ?? null,
          observedAt: result.observedAt,
          cursor: null,
          hasMore: result.hasMore,
          gap: result.gap,
          errorCode: result.errorCode,
        });
        for (const record of result.records) this.addRecord({ ...record, serviceId: sanitizeId(service.id, 'service') });
      }
    } catch {
      if (generation !== this.generation) return;
      for (const service of group.services) this.setSourceError(service.id, group.sourceRef, now, signal?.aborted ? 'status_timeout' : 'status_source');
    }
  }

  private async readQuantGroup(group: { sourceRef: string; adapter: Extract<NonNullable<Service['statusAdapter']>, { kind: 'quant_pg_receipts' }>; services: Service[] }, now: Date, generation: number, signal?: AbortSignal): Promise<void> {
    try {
      if (!this.createQuantReader) {
        for (const service of group.services) this.setSourceError(service.id, group.sourceRef, now, 'status_source');
        return;
      }
      this.quantReader ??= this.createQuantReader();
      const result = await this.quantReader.readSnapshots(group.adapter.profileId, group.adapter.sourceRef, signal, now);
      if (generation !== this.generation) return;
      for (const service of group.services) {
        this.addServiceSource(service.id, group.sourceRef);
        const previous = this.feeds.get(group.sourceRef);
        this.setFeed(group.sourceRef, {
          sourceRef: group.sourceRef,
          health: result.health,
          lastSuccessAt: result.lastSuccessAt ?? previous?.lastSuccessAt ?? null,
          observedAt: result.observedAt,
          cursor: null,
          hasMore: result.hasMore,
          gap: result.gap,
          errorCode: result.errorCode,
        });
        for (const record of result.records) this.addRecord({ ...record, serviceId: sanitizeId(service.id, 'service') });
      }
    } catch {
      if (generation !== this.generation) return;
      for (const service of group.services) this.setSourceError(service.id, group.sourceRef, now, signal?.aborted ? 'status_timeout' : 'status_source');
    }
  }

  private async readInfrastructureGroup(group: { sourceRef: string; adapter: Extract<NonNullable<Service['statusAdapter']>, { kind: InfrastructureKind }>; services: Service[] }, now: Date, generation: number, signal?: AbortSignal): Promise<void> {
    try {
      if (!this.createInfrastructureReader) {
        for (const service of group.services) this.setSourceError(service.id, group.sourceRef, now, 'status_source');
        return;
      }
      this.infrastructureReader ??= this.createInfrastructureReader();
      const result = await this.infrastructureReader.readSnapshots(group.adapter.profileId, group.adapter.sourceRef, group.adapter.kind, signal, now);
      if (generation !== this.generation) return;
      for (const service of group.services) {
        this.addServiceSource(service.id, group.sourceRef);
        const previous = this.feeds.get(group.sourceRef);
        this.setFeed(group.sourceRef, {
          sourceRef: group.sourceRef,
          health: result.health,
          lastSuccessAt: result.lastSuccessAt ?? previous?.lastSuccessAt ?? null,
          observedAt: result.observedAt,
          cursor: null,
          hasMore: result.hasMore,
          gap: result.gap,
          errorCode: result.errorCode,
        });
        for (const record of result.records) this.addRecord({ ...record, serviceId: sanitizeId(service.id, 'service') });
      }
    } catch {
      if (generation !== this.generation) return;
      for (const service of group.services) this.setSourceError(service.id, group.sourceRef, now, signal?.aborted ? 'status_timeout' : 'status_source');
    }
  }

  private setSourceError(serviceId: string, sourceRef: string, now: Date, errorCode: StatusFeed['errorCode']): void {
    this.addServiceSource(serviceId, sourceRef);
    const previous = this.feeds.get(sourceRef);
    this.setFeed(sourceRef, {
      sourceRef,
      health: 'error',
      lastSuccessAt: previous?.lastSuccessAt ?? null,
      observedAt: now.toISOString(),
      cursor: null,
      hasMore: false,
      gap: false,
      errorCode,
    });
  }

  private setFeed(sourceRef: string, feed: StatusFeed): void {
    this.feeds.set(sourceRef, feed);
  }

  private addServiceSource(serviceId: string, sourceRef: string): void {
    const safeServiceId = sanitizeId(serviceId, 'service');
    const sources = this.serviceSources.get(safeServiceId) ?? new Set<string>();
    sources.add(sourceRef);
    this.serviceSources.set(safeServiceId, sources);
  }

  private addRecord(record: StatusRecord): void {
    const serviceId = sanitizeId(record.serviceId, 'service');
    const existing = this.records.get(serviceId) ?? [];
    const identity = `${record.sourceRef}\u001f${record.id}`;
    const duplicateIndex = existing.findIndex((item) => `${item.sourceRef}\u001f${item.id}` === identity);
    if (duplicateIndex >= 0 && record.facts.infrastructureSnapshot !== true) return;
    const retained = duplicateIndex < 0 ? existing : existing.filter((_, index) => index !== duplicateIndex);
    const next = [...retained, record].sort(compareRecordRecency).slice(0, statusLimits.maxRecordsPerService);
    while (next.length > 1 && Buffer.byteLength(JSON.stringify(next), 'utf8') > statusLimits.maxServiceBytes) next.pop();
    this.records.set(serviceId, next);
    this.trimGlobalHistory();
  }

  private trimGlobalHistory(): void {
    const totalBytes = () => [...this.records.values()].reduce((sum, records) => sum + Buffer.byteLength(JSON.stringify(records), 'utf8'), 0);
    while (totalBytes() > statusLimits.maxHistoryBytes) {
      const candidate = [...this.records.entries()]
        .filter(([, records]) => records.length > 1)
        .sort(([, left], [, right]) => compareRecordRecency(right.at(-1)!, left.at(-1)!))[0];
      if (!candidate) break;
      candidate[1].pop();
    }
  }
}

function countValues(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function formatCounts(counts: ReadonlyMap<string, number>): string {
  return [...counts.entries()].map(([key, count]) => `${key}:${count}`).join(',');
}

function formatDockerSummary(service: ServiceObservation, states: ReadonlyMap<string, number>, health: ReadonlyMap<string, number>, first: boolean): string {
  const running = states.get('running') ?? 0;
  const stopped = (states.get('exited') ?? 0) + (states.get('dead') ?? 0);
  const paused = states.get('paused') ?? 0;
  const restarting = states.get('restarting') ?? 0;
  const created = states.get('created') ?? 0;
  const removing = states.get('removing') ?? 0;
  const unknown = states.get('unknown') ?? 0;
  const stateParts = [
    running > 0 ? `${running}个容器运行` : null,
    stopped > 0 ? `${stopped}个容器已停止` : null,
    paused > 0 ? `${paused}个容器已暂停` : null,
    restarting > 0 ? `${restarting}个容器正在重启` : null,
    created > 0 ? `${created}个容器已创建但未运行` : null,
    removing > 0 ? `${removing}个容器正在移除` : null,
    unknown > 0 ? `${unknown}个容器状态未知` : null,
  ].filter((value): value is string => value !== null);
  const stateText = stateParts.length > 0 ? stateParts.join('，') : '未取得可用容器状态';
  const prefix = service.freshness === 'stale'
    ? (first ? '首次观察到' : '最近一次观察到')
    : (first ? '首次观察到' : '观察到');
  const sentence = stateParts.length > 0 ? `${prefix}${stateText}` : `${first ? '首次观察' : '本次观察'}${stateText}`;
  const details: string[] = [];
  const unhealthy = health.get('unhealthy') ?? 0;
  const starting = health.get('starting') ?? 0;
  const unknownHealth = health.get('unknown') ?? 0;
  const healthIssues = [
    unhealthy > 0 ? `发现${unhealthy}个容器健康检查异常` : null,
    starting > 0 ? `${starting}个容器仍在启动检查` : null,
    unknownHealth > 0 ? `${unknownHealth}个容器健康状态未知` : null,
  ].filter((value): value is string => value !== null);
  if (healthIssues.length > 0) details.push(healthIssues.join('，'));

  const samplingDetails: string[] = [];
  if (service.coverage.missing > 0) samplingDetails.push(`尚有${service.coverage.missing}个必需成员未覆盖`);
  if (service.freshness === 'stale') samplingDetails.push('采样已过期');
  else if (service.freshness === 'partial') samplingDetails.push('采样尚不完整');
  else if (service.freshness === 'unknown') samplingDetails.push('采样新鲜度未知');
  if (samplingDetails.length > 0) details.push(samplingDetails.join('，'));

  if (details.length === 0 && (service.status === 'unknown' || service.status === 'unconfigured')) details.push('服务状态尚未确认');
  else if (details.length === 0 && service.status === 'attention') details.push('服务状态需要关注');
  return `${sentence}。${details.length > 0 ? `${details.slice(0, 2).join('，')}。` : ''}`;
}

function validDate(value: string | null): string | null {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function compareRecordRecency(left: StatusRecord, right: StatusRecord): number {
  for (const key of ['occurredAt', 'sourceAt', 'observedAt'] as const) {
    const leftTime = timestamp(left[key]);
    const rightTime = timestamp(right[key]);
    if (leftTime === rightTime) continue;
    return rightTime > leftTime ? 1 : -1;
  }
  return right.id.localeCompare(left.id);
}

function timestamp(value: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function hashFingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16);
}

function encodeCursor(record: StatusRecord): string {
  return `v1.${Buffer.from(JSON.stringify({ after: recordCursorKey(record) })).toString('base64url')}`;
}

function decodeCursor(cursor: string | undefined): string | null {
  if (!cursor || !cursor.startsWith('v1.')) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor.slice(3), 'base64url').toString('utf8')) as { after?: unknown };
    return typeof parsed.after === 'string' && parsed.after.length <= 512 ? parsed.after : null;
  } catch {
    return null;
  }
}

function recordCursorKey(record: StatusRecord): string {
  return `${record.sourceRef}\u001f${record.id}`;
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) result.push(values.slice(offset, offset + size));
  return result;
}
