import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusAdapterSchema, ServiceSchema } from '../../src/shared/contracts.js';
import { emptyBusinessObservation } from '../../src/shared/business.js';
import type { ContainerEntity, DeviceObservation, ServiceObservation } from '../../src/shared/entities.js';
import { HttpJsonStatusAdapter } from '../../src/main/status/http-json.js';
import { StatusManager } from '../../src/main/status/manager.js';

const now = new Date('2026-10-21T10:00:00.000Z');
const containerId = 'a'.repeat(64);

afterEach(() => vi.useRealTimers());

function container(overrides: Partial<ContainerEntity> = {}): ContainerEntity {
  return {
    key: `local:${containerId}`,
    deviceId: 'local',
    id: containerId,
    name: '/worker',
    image: 'worker:latest',
    compose: { project: null, service: null, ordinal: null },
    state: 'running',
    health: 'healthy',
    startedAt: '2026-10-21T09:00:00.000Z',
    finishedAt: null,
    exitCode: null,
    restartCount: 0,
    tty: false,
    networkMode: 'bridge',
    logsAvailable: true,
    sourceAt: now.toISOString(),
    generation: `local:${containerId}:2026-10-21T09:00:00.000Z`,
    ...overrides,
  };
}

function serviceObservation(overrides: Partial<ServiceObservation> = {}): ServiceObservation {
  return {
    serviceId: 'worker',
    status: 'ok',
    freshness: 'fresh',
    coverage: { required: 1, observed: 1, missing: 0 },
    members: [{ bindingId: 'binding', deviceId: 'local', containerKey: `local:${containerId}`, status: 'bound', reason: null }],
    metrics: { cpuPercent: null, memoryBytes: null, memoryLimitBytes: null, networkRxBytes: null, networkTxBytes: null, pids: null },
    uptimeSeconds: 3600,
    sourceAt: now.toISOString(),
    observedAt: now.toISOString(),
    errorCode: null,
    business: emptyBusinessObservation(now.toISOString()),
    ...overrides,
  };
}

function device(overrides: Partial<DeviceObservation> = {}): DeviceObservation {
  return { deviceId: 'local', containerCount: 1, complete: true, errorCode: null, sourceAt: now.toISOString(), observedAt: now.toISOString(), ...overrides };
}

describe('M2 status contracts and bounded sources', () => {
  it('keeps old service configs compatible with an explicit unconfigured status source', () => {
    const parsed = ServiceSchema.parse({ id: 'worker', name: 'Worker', category: '基础设施', bindings: [], businessAdapter: { kind: 'none' } });
    expect(parsed.statusAdapter).toEqual({ kind: 'none' });
  });

  it('records the first real Docker observation once and only appends state changes', () => {
    const manager = new StatusManager({ resolveEndpoint: async () => undefined });
    const service = serviceObservation();
    manager.observeDocker([service], [device()], [container()], now);
    manager.observeDocker([service], [device()], [container()], new Date(now.getTime() + 5_000));
    let page = manager.page('worker', undefined, 40);
    expect(page.records).toHaveLength(1);
    expect(page.records[0]).toMatchObject({ evidenceKind: 'container_observation', outcome: 'active', stage: '容器观察' });
    expect(page.records[0]?.facts).toMatchObject({ states: 'running:1', health: 'healthy:1' });
    expect(page.feeds).toContainEqual(expect.objectContaining({ sourceRef: 'docker:local', health: 'fresh' }));

    manager.observeDocker(
      [serviceObservation({ status: 'attention', freshness: 'partial', coverage: { required: 1, observed: 0, missing: 1 } })],
      [device({ observedAt: new Date(now.getTime() + 10_000).toISOString() })],
      [container({ state: 'exited', health: 'none' })],
      new Date(now.getTime() + 10_000),
    );
    page = manager.page('worker', undefined, 40);
    expect(page.records).toHaveLength(2);
    expect(page.records[0]?.facts).toMatchObject({ states: 'exited:1', health: 'none:1' });
    expect(page.records[0]?.summary).toContain('观察到1个容器已停止');
    expect(page.records[0]?.summary).toContain('尚有1个必需成员未覆盖');
    expect(page.records[0]?.summary).toContain('采样尚不完整');

    manager.observeDocker([serviceObservation()], [device()], [container()], new Date(now.getTime() + 20_000));
    page = manager.page('worker', undefined, 40);
    expect(page.records).toHaveLength(3);
    expect(new Set(page.records.map((record) => record.id)).size).toBe(3);
    expect(page.records[0]?.summary).toContain('观察到');
    expect(page.records.at(-1)?.summary).toContain('首次观察到');
  });

  it('describes stale, unhealthy, and neutral Docker observations without inferring business state', () => {
    const manager = new StatusManager({ resolveEndpoint: async () => undefined });
    manager.observeDocker(
      [serviceObservation({ status: 'unknown', freshness: 'stale' })],
      [device()],
      [container()],
      now,
    );
    let record = manager.page('worker', undefined, 40).records[0];
    expect(record?.summary).toContain('首次观察到1个容器运行');
    expect(record?.summary).toContain('采样已过期');
    expect(record?.summary).not.toContain('服务状态尚未确认');

    manager.observeDocker(
      [serviceObservation({ status: 'attention', freshness: 'fresh' })],
      [device()],
      [container({ health: 'unhealthy' })],
      new Date(now.getTime() + 1_000),
    );
    record = manager.page('worker', undefined, 40).records[0];
    expect(record?.summary).toContain('观察到1个容器运行');
    expect(record?.summary).toContain('发现1个容器健康检查异常');

    manager.observeDocker(
      [serviceObservation({ status: 'neutral', freshness: 'fresh' })],
      [device()],
      [container({ state: 'running', health: 'healthy' })],
      new Date(now.getTime() + 2_000),
    );
    record = manager.page('worker', undefined, 40).records[0];
    expect(record?.summary).toContain('观察到1个容器运行');
    expect(record?.summary).not.toContain('未判定为服务持续运行');
  });

  it('keeps an incomplete first discovery as an unconfigured feed without inventing a record', () => {
    const manager = new StatusManager({ resolveEndpoint: async () => undefined });
    manager.observeDocker([serviceObservation()], [device({ complete: false, containerCount: 0, sourceAt: null })], [], now);
    const page = manager.page('worker', undefined);
    expect(page.records).toHaveLength(0);
    expect(page.feeds).toContainEqual(expect.objectContaining({ sourceRef: 'docker:local', health: 'unconfigured', lastSuccessAt: null }));
  });

  it('maps bounded HTTP events, filters sensitive facts, and pages at forty records', async () => {
    const events = Array.from({ length: 45 }, (_, index) => ({
      id: `event-${index + 1}`,
      task: `task-${index + 1}`,
      stage: '归档',
      outcome: 'succeeded',
      occurred_at: now.toISOString(),
      evidence_kind: 'stage_receipt',
      evidence_ref: `receipt-${index + 1}`,
      summary: `第 ${index + 1} 项已归档`,
      facts: { completed: index + 1, total: 45, token: 'private-value', endpoint: 'private-endpoint' },
    }));
    const statusAdapter = StatusAdapterSchema.parse({ kind: 'http_json', profileId: 'profile', endpointRef: 'receipts', mapping: {
      events: '/events', id: '/id', taskKey: '/task', stage: '/stage', outcome: '/outcome', occurredAt: '/occurred_at', evidenceKind: '/evidence_kind', evidenceRef: '/evidence_ref', summary: '/summary', facts: '/facts',
    }});
    let servedEvents = events;
    const source = new HttpJsonStatusAdapter({ resolveEndpoint: async () => 'https://status.invalid/receipts', fetcher: async () => new Response(JSON.stringify({ events: servedEvents }), { status: 200, headers: { 'content-type': 'application/json' } }) });
    const result = await source.read('paper', statusAdapter, now);
    expect(result.health).toBe('fresh');
    expect(result.records).toHaveLength(45);
    expect(result.records[0]?.facts).toEqual({ completed: 1, total: 45 });

    const manager = new StatusManager({
      resolveEndpoint: async () => 'https://status.invalid/receipts',
      createHttpAdapter: () => source,
    });
    await manager.readConfigured([{ id: 'paper', name: '论文', category: '论文下载', bindings: [], businessAdapter: { kind: 'none' }, statusAdapter }], now);
    const firstPage = manager.page('paper', undefined);
    expect(firstPage.records).toHaveLength(40);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).toBeTypeOf('string');
    expect(firstPage.feeds).toContainEqual(expect.objectContaining({ sourceRef: 'http_json:profile:receipts', health: 'fresh' }));
    servedEvents = [{ ...events[0]!, id: 'event-new', task: 'task-new' }, ...events];
    await manager.readConfigured([{ id: 'paper', name: '论文', category: '论文下载', bindings: [], businessAdapter: { kind: 'none' }, statusAdapter }], new Date(now.getTime() + 1_000));
    const secondPage = manager.page('paper', firstPage.nextCursor ?? undefined);
    expect(secondPage.records).toHaveLength(5);
    expect(secondPage.hasMore).toBe(false);
    expect(secondPage.records.some((record) => record.id === 'event-new')).toBe(false);
  });

  it('maps HTTP free text to deterministic safe fields before it crosses the status boundary', async () => {
    const adapter = StatusAdapterSchema.parse({ kind: 'http_json', profileId: 'profile', endpointRef: 'receipts', mapping: {} });
    const source = new HttpJsonStatusAdapter({
      resolveEndpoint: async () => 'https://status.invalid/receipts',
      fetcher: async () => new Response(JSON.stringify([
        {
          id: 'https://user:secret@10.0.0.7/private/event?token=abc',
          taskKey: 'https://user:secret@10.0.0.7/private/task?token=abc',
          stage: 'https://status.invalid/private-stage',
          outcome: 'succeeded',
          occurredAt: now.toISOString(),
          evidenceKind: 'business_event',
          evidenceRef: '/Users/fixture/private/receipt-token',
          summary: 'private summary should not be forwarded',
          facts: { completed: 3, total: 5, status: 'succeeded', note: '/Users/fixture/private', token: 'abc' },
        },
        { id: 'constructor', stage: 'constructor', outcome: 'succeeded', occurredAt: now.toISOString(), evidenceKind: 'business_event', facts: { completed: 1, total: 1 } },
        { id: 'toString', stage: 'toString', outcome: 'failed', occurredAt: now.toISOString(), evidenceKind: 'business_event', facts: { failed: 1, total: 1 } },
      ]), { status: 200 }),
    });

    const result = await source.read('paper', adapter, now);
    const record = result.records[0];
    expect(result.records).toHaveLength(3);
    expect(record).toMatchObject({ stage: '状态记录', summary: '状态记录：已完成（3/5）', facts: { completed: 3, total: 5, status: 'succeeded' } });
    expect(result.records.slice(1).every((item) => item.stage === '状态记录')).toBe(true);
    expect(record?.id).toMatch(/^event-[0-9a-f]{24}$/);
    expect(record?.taskKey).toMatch(/^task-[0-9a-f]{24}$/);
    expect(record?.evidenceRef).toBe('evidence');
    expect(JSON.stringify(result)).not.toContain('10.0.0.7');
    expect(JSON.stringify(result)).not.toContain('/Users/fixture');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('token');
  });

  it('rejects redirects and keeps prior records while the source feed turns unhealthy', async () => {
    const adapter = StatusAdapterSchema.parse({ kind: 'http_json', profileId: 'profile', endpointRef: 'receipts', mapping: {} });
    const source = new HttpJsonStatusAdapter({ resolveEndpoint: async () => 'https://status.invalid/receipts', fetcher: async () => new Response('', { status: 302, headers: { location: 'https://elsewhere.invalid' } }) });
    const result = await source.read('paper', adapter, now);
    expect(result.errorCode).toBe('status_redirect');
    expect(result.records).toHaveLength(0);
  });

  it('keeps the HTTP deadline active until the response body is fully read', async () => {
    vi.useFakeTimers();
    const adapter = StatusAdapterSchema.parse({ kind: 'http_json', profileId: 'profile', endpointRef: 'receipts', mapping: {} });
    const source = new HttpJsonStatusAdapter({
      resolveEndpoint: async () => 'https://status.invalid/receipts',
      fetcher: async (_url, init) => new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('timeout', 'AbortError')), { once: true });
        },
      }), { status: 200 }),
    });
    const pending = source.read('paper', adapter, now);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toMatchObject({ errorCode: 'status_timeout', health: 'error' });
  });

  it('shares one HTTP read for services that reference the same profile endpoint', async () => {
    let fetches = 0;
    const adapter = StatusAdapterSchema.parse({ kind: 'http_json', profileId: 'profile', endpointRef: 'shared', mapping: {} });
    const source = new HttpJsonStatusAdapter({
      resolveEndpoint: async () => 'https://status.invalid/shared',
      fetcher: async () => {
        fetches += 1;
        return new Response(JSON.stringify({ id: 'shared-event', stage: '队列', outcome: 'active', evidenceKind: 'business_event' }), { status: 200 });
      },
    });
    const manager = new StatusManager({ resolveEndpoint: async () => 'https://status.invalid/shared', createHttpAdapter: () => source });
    const services = [
      { id: 'paper', name: '论文', category: '论文下载', bindings: [], businessAdapter: { kind: 'none' as const }, statusAdapter: adapter },
      { id: 'queue', name: '队列', category: '后台任务', bindings: [], businessAdapter: { kind: 'none' as const }, statusAdapter: adapter },
    ];
    await manager.readConfigured(services, now);
    expect(fetches).toBe(1);
    expect(manager.page('paper', undefined).records).toHaveLength(1);
    expect(manager.page('queue', undefined).records).toHaveLength(1);
  });

  it('orders history by source event time before read completion time', async () => {
    const adapter = StatusAdapterSchema.parse({ kind: 'http_json', profileId: 'profile', endpointRef: 'ordered', mapping: {} });
    const source = new HttpJsonStatusAdapter({
      resolveEndpoint: async () => 'https://status.invalid/ordered',
      fetcher: async () => new Response(JSON.stringify([
        { id: 'read-later', stage: '归档', outcome: 'succeeded', occurredAt: '2026-10-21T10:00:00Z', evidenceKind: 'business_event' },
        { id: 'occurred-later', stage: '归档', outcome: 'succeeded', occurredAt: '2026-10-21T11:00:00Z', evidenceKind: 'business_event' },
      ]), { status: 200 }),
    });
    const manager = new StatusManager({ resolveEndpoint: async () => 'https://status.invalid/ordered', createHttpAdapter: () => source });
    const service = { id: 'ordered-service', name: '有序源', category: '后台任务', bindings: [], businessAdapter: { kind: 'none' as const }, statusAdapter: adapter };
    await manager.readConfigured([service], now);
    const records = manager.page(service.id, undefined).records;
    expect(records.map((record) => record.occurredAt)).toEqual(['2026-10-21T11:00:00.000Z', '2026-10-21T10:00:00.000Z']);
    expect(records.every((record) => /^ref-[0-9a-f]{24}$/.test(record.id))).toBe(true);
  });

  it('isolates same event ids by source, keeps exact-source cursors, and deduplicates repeats', async () => {
    const adapters = {
      first: StatusAdapterSchema.parse({ kind: 'http_json', profileId: 'profile', endpointRef: 'first', mapping: {} }),
      second: StatusAdapterSchema.parse({ kind: 'http_json', profileId: 'profile', endpointRef: 'second', mapping: {} }),
    };
    const payloads: Record<string, unknown[]> = {
      first: [
        { id: 'same-event', stage: '归档', outcome: 'succeeded', occurredAt: '2026-10-21T10:00:00Z', evidenceKind: 'business_event' },
        { id: 'after-event', stage: '归档', outcome: 'succeeded', occurredAt: '2026-10-21T09:00:00Z', evidenceKind: 'business_event' },
      ],
      second: [
        { id: 'same-event', stage: '归档', outcome: 'succeeded', occurredAt: '2026-10-21T12:00:00Z', evidenceKind: 'business_event' },
      ],
    };
    const source = new HttpJsonStatusAdapter({
      resolveEndpoint: async (_profileId, endpointRef) => `https://status.invalid/${endpointRef}`,
      fetcher: async (input) => {
        const endpointRef = new URL(String(input)).pathname.slice(1);
        return new Response(JSON.stringify(payloads[endpointRef] ?? []), { status: 200 });
      },
    });
    const manager = new StatusManager({
      resolveEndpoint: async (_profileId, endpointRef) => `https://status.invalid/${endpointRef}`,
      createHttpAdapter: () => source,
    });
    const service = (statusAdapter: typeof adapters.first) => ({ id: 'shared-source', name: '同源测试', category: '后台任务', bindings: [], businessAdapter: { kind: 'none' as const }, statusAdapter });

    await manager.readConfigured([service(adapters.second)], now);
    await manager.readConfigured([service(adapters.first)], new Date(now.getTime() + 1_000));
    await manager.readConfigured([service(adapters.first)], new Date(now.getTime() + 2_000));

    const firstPage = manager.page('shared-source', undefined, 2);
    expect(firstPage.records).toHaveLength(2);
    expect(new Set(firstPage.records.map((record) => record.id)).size).toBe(1);
    expect(firstPage.records[0]?.id).toMatch(/^ref-[0-9a-f]{24}$/);
    expect(new Set(firstPage.records.map((record) => record.sourceRef))).toEqual(new Set(['http_json:profile:second', 'http_json:profile:first']));
    expect(firstPage.nextCursor).toMatch(/^v1\./);

    const secondPage = manager.page('shared-source', firstPage.nextCursor ?? undefined, 2);
    expect(secondPage.records[0]?.sourceRef).toBe('http_json:profile:first');
    expect(secondPage.records[0]?.id).toMatch(/^ref-[0-9a-f]{24}$/);
    expect(secondPage.hasMore).toBe(false);
    expect(manager.page('shared-source', undefined, 40).records).toHaveLength(3);
  });

  it('does not append a late source result after reset starts a new runtime generation', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<ReturnType<typeof emptyBusinessObservation>>((resolve) => {
      release = () => resolve(emptyBusinessObservation(now.toISOString()));
    });
    const adapter = StatusAdapterSchema.parse({ kind: 'http_json', profileId: 'profile', endpointRef: 'late', mapping: {} });
    const source = new HttpJsonStatusAdapter({
      resolveEndpoint: async () => 'https://status.invalid/late',
      fetcher: async () => {
        await pending;
        return new Response(JSON.stringify({ id: 'late-event', stage: '队列', outcome: 'succeeded', evidenceKind: 'business_event' }), { status: 200 });
      },
    });
    const manager = new StatusManager({ resolveEndpoint: async () => 'https://status.invalid/late', createHttpAdapter: () => source });
    const service = { id: 'late-service', name: '延迟源', category: '后台任务', bindings: [], businessAdapter: { kind: 'none' as const }, statusAdapter: adapter };
    const read = manager.readConfigured([service], now);
    manager.reset();
    release?.();
    await read;
    expect(manager.page('late-service', undefined).records).toEqual([]);
  });

  it('marks an invalid or stale cursor as a gap instead of silently repeating page one', async () => {
    const adapter = StatusAdapterSchema.parse({ kind: 'http_json', profileId: 'profile', endpointRef: 'cursor', mapping: {} });
    const source = new HttpJsonStatusAdapter({
      resolveEndpoint: async () => 'https://status.invalid/cursor',
      fetcher: async () => new Response(JSON.stringify({ id: 'cursor-event', stage: '队列', outcome: 'active', evidenceKind: 'business_event' }), { status: 200 }),
    });
    const manager = new StatusManager({ resolveEndpoint: async () => 'https://status.invalid/cursor', createHttpAdapter: () => source });
    await manager.readConfigured([{ id: 'cursor-service', name: '游标源', category: '后台任务', bindings: [], businessAdapter: { kind: 'none' as const }, statusAdapter: adapter }], now);
    const page = manager.page('cursor-service', 'v1.invalid', 40);
    expect(page.records).toHaveLength(1);
    expect(page.feeds).toContainEqual(expect.objectContaining({ gap: true }));
  });
});

describe('infrastructure source manager integration', () => {
  it('stores only registered-source references for each infrastructure adapter', () => {
    for (const kind of ['tailscale_status', 'acme_certificates', 'openresty_status']) {
      expect(StatusAdapterSchema.parse({ kind, profileId: 'nas', sourceRef: 'scope' })).toEqual({ kind, profileId: 'nas', sourceRef: 'scope' });
      expect(StatusAdapterSchema.safeParse({ kind, profileId: 'nas', command: 'arbitrary' }).success).toBe(false);
    }
  });

  const kinds = ['tailscale_status', 'acme_certificates', 'openresty_status'] as const;
  const services = kinds.flatMap((kind) => [0, 1].map((index) => ServiceSchema.parse({ id: `${kind}-${index}`, name: kind, category: '基础设施', bindings: [], businessAdapter: { kind: 'none' }, statusAdapter: { kind, profileId: 'nas', sourceRef: 'scope' } })));

  it('shares matching sources without merging different kinds and keeps the existing two-source concurrency budget', async () => {
    let active = 0;
    let peak = 0;
    const readSnapshots = vi.fn(async (profileId: string, sourceRef: string, kind: typeof kinds[number]) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return { sourceRef: `${kind}:${profileId}:${sourceRef}`, health: 'fresh', observedAt: now.toISOString(), lastSuccessAt: now.toISOString(), records: [], hasMore: false, gap: false, errorCode: null };
    });
    const manager = new StatusManager({ resolveEndpoint: async () => undefined, createInfrastructureReader: () => ({ readSnapshots }) as unknown as import('../../src/main/status/infrastructure.js').InfrastructureStatusAdapter });
    await manager.readConfigured(services, now);
    expect(readSnapshots).toHaveBeenCalledTimes(3);
    expect(peak).toBe(2);
    for (const service of services) expect(manager.page(service.id, undefined).feeds).toEqual([expect.objectContaining({ sourceRef: `${service.statusAdapter!.kind}:nas:scope`, health: 'fresh' })]);
  });

  it('rejects an infrastructure result after reset instead of populating the new generation', async () => {
    let complete!: (value: unknown) => void;
    const readSnapshots = vi.fn(() => new Promise((resolve) => { complete = resolve; }));
    const manager = new StatusManager({ resolveEndpoint: async () => undefined, createInfrastructureReader: () => ({ readSnapshots }) as unknown as import('../../src/main/status/infrastructure.js').InfrastructureStatusAdapter });
    const pending = manager.readConfigured(services.slice(0, 1), now);
    manager.reset();
    complete({ health: 'fresh', observedAt: now.toISOString(), lastSuccessAt: now.toISOString(), records: [], hasMore: false, gap: false, errorCode: null });
    await pending;
    expect(manager.page(services[0]!.id, undefined).feeds).toEqual([]);
  });
});
