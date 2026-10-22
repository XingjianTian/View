import type { Device } from '../../shared/contracts.js';
import type { DockerTransport } from './types.js';

type PoolEntry = {
  key: string;
  refs: number;
  transport: DockerTransport | null;
  opening: Promise<DockerTransport> | null;
};

export type TransportPoolStats = {
  entries: number;
  references: number;
  connections: number;
  channels: number;
};

export class DeviceTransportPool {
  private readonly entries = new Map<string, PoolEntry>();

  constructor(private readonly createTransport: (device: Device) => Promise<DockerTransport>) {}

  async acquire(device: Device): Promise<DockerTransport> {
    const key = poolKey(device);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { key, refs: 0, transport: null, opening: null };
      entry.opening = this.createTransport(device).then((transport) => {
        entry!.transport = transport;
        return transport;
      }).catch((error: unknown) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      });
      this.entries.set(key, entry);
    }
    entry.refs += 1;
    try {
      if (entry.transport) return entry.transport;
      if (!entry.opening) throw new Error('transport opening missing');
      return await entry.opening;
    } catch (error) {
      entry.refs = Math.max(0, entry.refs - 1);
      throw error;
    }
  }

  release(transport: DockerTransport): void {
    const entry = [...this.entries.values()].find((candidate) => candidate.transport === transport);
    if (entry) entry.refs = Math.max(0, entry.refs - 1);
  }

  async closeAll(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(entries.map(async (entry) => {
      const transport = entry.transport ?? await entry.opening;
      await transport?.close();
    }));
  }

  stats(): TransportPoolStats {
    let connections = 0;
    let channels = 0;
    for (const entry of this.entries.values()) {
      const current = entry.transport?.diagnostics?.();
      connections += current?.connections ?? 0;
      channels += current?.channels ?? 0;
    }
    return {
      entries: this.entries.size,
      references: [...this.entries.values()].reduce((total, entry) => total + entry.refs, 0),
      connections,
      channels,
    };
  }
}

function poolKey(device: Device): string {
  return `${device.id}:${device.transport}:${device.profileId}`;
}
