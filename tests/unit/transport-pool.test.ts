import { describe, expect, it } from 'vitest';
import { DeviceTransportPool } from '../../src/main/transport/pool.js';
import type { DockerTransport } from '../../src/main/transport/types.js';
import type { Device } from '../../src/shared/contracts.js';

const device: Device = { id: 'nas-device', name: 'NAS', transport: 'ssh', profileId: 'nas-profile', enabled: true };

function transport(close: () => void): DockerTransport {
  return {
    kind: 'ssh',
    version: async () => { throw new Error('unused'); },
    list: async () => { throw new Error('unused'); },
    inspect: async () => { throw new Error('unused'); },
    stats: async () => { throw new Error('unused'); },
    logs: async () => { throw new Error('unused'); },
    close: async () => close(),
    diagnostics: () => ({ connections: 1, channels: 2 }),
  };
}

describe('device transport pool', () => {
  it('shares one transport across concurrent operations and only closes at pool shutdown', async () => {
    let created = 0;
    let closed = 0;
    const shared = transport(() => { closed += 1; });
    const pool = new DeviceTransportPool(async () => { created += 1; return shared; });

    const [first, second] = await Promise.all([pool.acquire(device), pool.acquire(device)]);
    expect(first).toBe(shared);
    expect(second).toBe(shared);
    expect(created).toBe(1);
    expect(pool.stats()).toEqual({ entries: 1, references: 2, connections: 1, channels: 2 });

    pool.release(first);
    pool.release(second);
    expect(closed).toBe(0);
    expect(pool.stats().references).toBe(0);
    await pool.closeAll();
    expect(closed).toBe(1);
  });
});
