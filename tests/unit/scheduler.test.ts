import { describe, expect, it } from 'vitest';
import { ObservationScheduler } from '../../src/main/scheduler.js';
import type { AppConfig } from '../../src/shared/contracts.js';
import type { DockerTransport } from '../../src/main/transport/types.js';

const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const config: AppConfig = {
  schemaVersion: 1,
  devices: [{ id: 'local', name: '本机', transport: 'local', profileId: 'local-profile', enabled: true }],
  services: [{ id: 'worker', name: 'Worker', category: '基础设施', bindings: [{ id: 'binding', deviceId: 'local', selector: { kind: 'container_id', value: id }, required: true, expectedPolicy: 'continuous' }], businessAdapter: { kind: 'none' } }],
  slots: [{ serviceId: 'worker', logBindingId: 'binding' }, { serviceId: null, logBindingId: null }, { serviceId: null, logBindingId: null }, { serviceId: null, logBindingId: null }],
    display: { layout: 'columns4', focusSlot: 0, asciiMode: 'dynamic', asciiBrightness: 50, asciiStrength: 50, reducedMotion: false },
  window: null,
};

function fakeTransport(counters: { list: number; inspect: number; stats: number }): DockerTransport {
  const row = [id, 'worker', 'image', 'running', 'Up', '2026', '1 minute', '', '', '', '', ''].map((value) => JSON.stringify(value)).join('\t');
  const inspect = [id, '/worker', 'image', 'running', 'none', '2026-10-20T09:00:00.000Z', '0001-01-01T00:00:00Z', 0, 0, false, 'default'].map((value) => JSON.stringify(value)).join('\t');
  return {
    kind: 'local',
    version: async () => ({ operation: 'version', stdout: '29.1.3\n', stderr: '', code: 0, truncated: false, observedAt: new Date().toISOString() }),
    list: async () => { counters.list += 1; return { operation: 'list', stdout: `${row}\n`, stderr: '', code: 0, truncated: false, observedAt: new Date().toISOString() }; },
    inspect: async () => { counters.inspect += 1; return { operation: 'inspect', stdout: `${inspect}\n`, stderr: '', code: 0, truncated: false, observedAt: new Date().toISOString() }; },
    stats: async () => { counters.stats += 1; return { operation: 'stats', stdout: `${JSON.stringify({ Container: id.slice(0, 12), CPUPerc: '101%', MemUsage: '1MiB / 2MiB', NetIO: '2KiB / 3KiB', PIDs: '2' })}\n`, stderr: '', code: 0, truncated: false, observedAt: new Date().toISOString() }; },
    logs: async () => ({ operation: 'logs', stdout: '', stderr: '', code: 0, truncated: false, observedAt: new Date().toISOString() }),
    close: async () => undefined,
  };
}

describe('bounded observation scheduler', () => {
  it('does not overlap a device cycle and samples visible members once', async () => {
    const counters = { list: 0, inspect: 0, stats: 0 };
    const callbacks: (() => void)[] = [];
    const scheduler = new ObservationScheduler({
      createTransport: async () => fakeTransport(counters),
      setTimer: (callback) => { callbacks.push(callback); return callbacks.length as unknown as NodeJS.Timeout; },
      clearTimer: () => undefined,
    });
    scheduler.start(config, new Set(['worker']));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await scheduler.refreshNow();
    expect(counters.list).toBeGreaterThan(0);
    expect(counters.inspect).toBeGreaterThan(0);
    expect(counters.stats).toBe(1);
    expect(scheduler.serviceObservations(new Set(['worker']))[0]?.metrics.cpuPercent).toBe(101);
    expect(callbacks).toHaveLength(4);
    scheduler.stop();
  });

  it('carries a business adapter DTO into the service observation', async () => {
    let reads = 0;
    const scheduler = new ObservationScheduler({
      createTransport: async () => fakeTransport({ list: 0, inspect: 0, stats: 0 }),
      readBusiness: async () => {
        reads += 1;
        return {
          status: 'fresh',
          metrics: { total: 10, succeeded: 7, failed: 1, active: 1, waiting: 1, cancelled: 0 },
          scopeType: 'batch',
          scopeId: 'isolated-batch',
          sourceAt: new Date().toISOString(),
          observedAt: new Date().toISOString(),
          progress: { completedPercent: 80, successPercent: 70 },
          errorCode: null,
        };
      },
      setTimer: () => 1 as unknown as NodeJS.Timeout,
      clearTimer: () => undefined,
    });
    scheduler.start(config, new Set(['worker']));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const observation = scheduler.serviceObservations(new Set(['worker']))[0];
    expect(reads).toBe(1);
    expect(observation?.business.progress?.completedPercent).toBe(80);
    scheduler.stop();
  });
});
