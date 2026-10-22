import { describe, expect, it } from 'vitest';
import { ObservationCache } from '../../src/main/observations/cache.js';
import { parseDockerUnitForTest, parseStatsOutput } from '../../src/main/observations/stats-parser.js';
import type { CommandResult } from '../../src/main/transport/types.js';
import type { ContainerEntity } from '../../src/shared/entities.js';
import { createDefaultConfig } from '../../src/shared/contracts.js';
import { ObservationRuntime } from '../../src/main/runtime.js';

const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const container: ContainerEntity = {
  key: `local:${id}`,
  deviceId: 'local',
  id,
  name: 'worker',
  image: 'image@sha256:abc',
  compose: { project: null, service: null, ordinal: null },
  state: 'running',
  health: 'none',
  startedAt: '2026-10-20T09:00:00.000Z',
  finishedAt: null,
  exitCode: null,
  restartCount: 0,
  tty: false,
  networkMode: 'default',
  logsAvailable: true,
  sourceAt: '2026-10-20T10:00:00.000Z',
  generation: `local:${id}:2026-10-20T09:00:00.000Z`,
};

function result(stdout: string): CommandResult {
  return { operation: 'stats', stdout, stderr: '', code: 0, truncated: false, observedAt: '2026-10-20T10:00:01.000Z' };
}

describe('Docker stats observations', () => {
  it('parses Docker CLI units and preserves CPU over 100 percent', () => {
    const parsed = parseStatsOutput(result(JSON.stringify({ Container: id.slice(0, 12), CPUPerc: '154.20%', MemUsage: '1.5GiB / 4GiB', NetIO: '2.5MB / 1KiB', PIDs: '9' })), [id]);
    expect(parsed.complete).toBe(true);
    expect(parsed.values.get(id)).toEqual({
      cpuPercent: 154.2,
      memoryBytes: 1.5 * 1024 ** 3,
      memoryLimitBytes: 4 * 1024 ** 3,
      networkRxBytes: 2.5 * 1024 ** 2,
      networkTxBytes: 1024,
      pids: 9,
    });
    expect(parseDockerUnitForTest('12.5MiB')).toBe(12.5 * 1024 ** 2);
  });

  it('keeps an incomplete batch explicit when a requested member is missing', () => {
    const parsed = parseStatsOutput(result(JSON.stringify({ Container: id.slice(0, 12), CPUPerc: '1%', MemUsage: '-- / --', NetIO: '-- / --', PIDs: '0' })), [id, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']);
    expect(parsed.complete).toBe(false);
    expect(parsed.values.size).toBe(1);
  });
});

describe('bounded observation cache', () => {
  it('retains old containers across a partial discovery and cuts history on generation change', () => {
    const cache = new ObservationCache(() => 10_000);
    cache.applyDiscovery({ deviceId: 'local', containers: [container], observedAt: '2026-10-20T10:00:00.000Z', complete: true, errorCode: null, sourceAt: container.sourceAt });
    cache.applyStats('local', [id], new Map([[id, { cpuPercent: 5, memoryBytes: 10, memoryLimitBytes: 100, networkRxBytes: 1, networkTxBytes: 2, pids: 1 }]]), container.sourceAt, true);
    expect(cache.getObservation(container.key)?.history).toHaveLength(1);

    cache.applyDiscovery({ deviceId: 'local', containers: [], observedAt: '2026-10-20T10:00:15.000Z', complete: false, errorCode: 'timeout', sourceAt: null });
    expect(cache.getContainer(container.key)?.id).toBe(id);

    const rebuilt = { ...container, startedAt: '2026-10-20T10:05:00.000Z', generation: `local:${id}:2026-10-20T10:05:00.000Z` };
    cache.applyDiscovery({ deviceId: 'local', containers: [rebuilt], observedAt: '2026-10-20T10:05:00.000Z', complete: true, errorCode: null, sourceAt: rebuilt.sourceAt });
    expect(cache.getObservation(container.key)?.history).toEqual([]);
  });
});

describe('paged observation snapshots', () => {
  it('marks the default page incomplete and exposes all containers through bounded pages', () => {
    const runtime = new ObservationRuntime({ getReference: () => null } as never);
    runtime.start(createDefaultConfig());
    const containers = Array.from({ length: 128 }, (_, index) => {
      const containerId = index.toString(16).padStart(64, '0');
      return {
        ...container,
        id: containerId,
        key: `local:${containerId}`,
        name: `fixture-${index}`,
        generation: `local:${containerId}:2026-10-20T09:00:00.000Z`,
      };
    });
    runtime.scheduler.cache.applyDiscovery({
      deviceId: 'local',
      containers,
      observedAt: '2026-10-20T10:00:00.000Z',
      complete: true,
      errorCode: null,
      sourceAt: '2026-10-20T10:00:00.000Z',
    });
    try {
      const initial = runtime.snapshot();
      expect(initial.containerPage.total).toBe(128);
      expect(initial.containerPage.hasMore).toBe(true);
      expect(initial.containerPage.returned).toBeLessThan(initial.containerPage.total);
      expect(initial.truncated).toBe(true);

      const pages = [0, 32, 64, 96].map((containerOffset) => runtime.snapshot({ containerOffset, containerLimit: 32 }));
      expect(pages.map((page) => page.containerPage.returned)).toEqual([32, 32, 32, 32]);
      expect(pages.at(-1)?.containerPage.hasMore).toBe(false);
      expect(new Set(pages.flatMap((page) => page.containers.map((item) => item.id))).size).toBe(128);
    } finally {
      runtime.stop();
    }
  });

  it('keeps a long 63-container page explicitly pageable after the byte bound', () => {
    const runtime = new ObservationRuntime({ getReference: () => null } as never);
    runtime.start(createDefaultConfig());
    const containers = Array.from({ length: 63 }, (_, index) => {
      const containerId = (index + 1).toString(16).padStart(64, '0');
      return {
        ...container,
        id: containerId,
        key: `local:${containerId}`,
        name: `fixture-${index}-${'x'.repeat(180)}`,
        image: `image-${'y'.repeat(500)}`,
        generation: `local:${containerId}:2026-10-20T09:00:00.000Z`,
      };
    });
    runtime.scheduler.cache.applyDiscovery({ deviceId: 'local', containers, observedAt: '2026-10-20T10:00:00.000Z', complete: true, errorCode: null, sourceAt: '2026-10-20T10:00:00.000Z' });
    try {
      const page = runtime.snapshot();
      expect(page.containerPage.total).toBe(63);
      expect(page.containerPage.returned).toBeLessThan(63);
      expect(page.containerPage.hasMore).toBe(true);
      const next = runtime.snapshot({ containerOffset: 32, containerLimit: 32 });
      expect(next.containerPage.offset).toBe(32);
      expect(next.containerPage.hasMore).toBe(false);
    } finally {
      runtime.stop();
    }
  });

  it('keeps selected multi-member containers and exposes the actual next offset', () => {
    const runtime = new ObservationRuntime({ getReference: () => null } as never);
    const config = createDefaultConfig();
    const selectedIds = [
      '3e'.padStart(64, '0'),
      '3f'.padStart(64, '0'),
    ];
    config.devices = [{ id: 'local', name: '本机', transport: 'local', profileId: 'local-profile', enabled: true }];
    config.services = [{
      id: 'selected-service',
      name: '多成员服务',
      category: '基础设施',
      bindings: selectedIds.map((value, index) => ({
        id: `binding-${index + 1}`,
        deviceId: 'local',
        selector: { kind: 'container_id' as const, value },
        required: true,
        expectedPolicy: 'continuous' as const,
      })),
      businessAdapter: { kind: 'none' },
    }];
    config.slots = [
      { serviceId: 'selected-service', logBindingId: null },
      { serviceId: null, logBindingId: null },
      { serviceId: null, logBindingId: null },
      { serviceId: null, logBindingId: null },
    ];
    runtime.start(config);
    const containers = Array.from({ length: 63 }, (_, index) => {
      const containerId = (index + 1).toString(16).padStart(64, '0');
      return {
        ...container,
        id: containerId,
        key: `local:${containerId}`,
        name: `fixture-${index}-${'x'.repeat(180)}`,
        image: `image-${'y'.repeat(500)}`,
        generation: `local:${containerId}:2026-10-20T09:00:00.000Z`,
      };
    });
    runtime.scheduler.cache.applyDiscovery({ deviceId: 'local', containers, observedAt: '2026-10-20T10:00:00.000Z', complete: true, errorCode: null, sourceAt: '2026-10-20T10:00:00.000Z' });
    try {
      const first = runtime.snapshot();
      expect(first.containers.map((item) => item.id)).toEqual(expect.arrayContaining(selectedIds));
      expect(first.containerPage.nextOffset).toBeGreaterThan(0);
      expect(first.containerPage.nextOffset).toBeLessThan(first.containerPage.total);

      const second = runtime.snapshot({ containerOffset: first.containerPage.nextOffset, containerLimit: 32 });
      expect(second.containerPage.offset).toBe(first.containerPage.nextOffset);
      expect(second.containerPage.nextOffset).toBeGreaterThan(second.containerPage.offset);
      expect(second.containerPage.hasMore).toBe(second.containerPage.nextOffset < second.containerPage.total);

      const all = new Set([...first.containers, ...second.containers].map((item) => item.id));
      let offset = second.containerPage.nextOffset;
      while (second.containerPage.hasMore && offset < second.containerPage.total) {
        const page = runtime.snapshot({ containerOffset: offset, containerLimit: 32 });
        for (const item of page.containers) all.add(item.id);
        if (page.containerPage.nextOffset <= offset) break;
        offset = page.containerPage.nextOffset;
        if (!page.containerPage.hasMore) break;
      }
      expect(all.size).toBe(63);
    } finally {
      runtime.stop();
    }
  });

  it('caps an oversized selected directory and marks the capacity condition', () => {
    const runtime = new ObservationRuntime({ getReference: () => null } as never);
    const config = createDefaultConfig();
    const containers = Array.from({ length: 128 }, (_, index) => {
      const containerId = (index + 1).toString(16).padStart(64, '0');
      return {
        ...container,
        id: containerId,
        key: `local:${containerId}`,
        name: `selected-${index}-${'x'.repeat(240)}`,
        image: `image-${'y'.repeat(500)}`,
        generation: `local:${containerId}:2026-10-20T09:00:00.000Z`,
      };
    });
    config.devices = [{ id: 'local', name: '本机', transport: 'local', profileId: 'local-profile', enabled: true }];
    config.services = Array.from({ length: 4 }, (_, serviceIndex) => ({
      id: `selected-service-${serviceIndex + 1}`,
      name: `已选服务 ${serviceIndex + 1}`,
      category: '基础设施',
      bindings: containers.slice(serviceIndex * 32, serviceIndex * 32 + 32).map((item, bindingIndex) => ({
        id: `selected-binding-${serviceIndex + 1}-${bindingIndex + 1}`,
        deviceId: 'local',
        selector: { kind: 'container_id' as const, value: item.id },
        required: true,
        expectedPolicy: 'continuous' as const,
      })),
      businessAdapter: { kind: 'none' as const },
    }));
    config.slots = config.services.map((service) => ({ serviceId: service.id, logBindingId: null })) as typeof config.slots;
    runtime.start(config);
    runtime.scheduler.cache.applyDiscovery({ deviceId: 'local', containers, observedAt: '2026-10-20T10:00:00.000Z', complete: true, errorCode: null, sourceAt: '2026-10-20T10:00:00.000Z' });
    try {
      const page = runtime.snapshot();
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(48 * 1024);
      expect(page.containerPage.capacityExceeded).toBe(true);
      expect(page.containerPage.returned).toBeLessThan(page.containerPage.total);
    } finally {
      runtime.stop();
    }
  });
});
