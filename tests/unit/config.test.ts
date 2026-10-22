import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../../src/main/config/store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ConfigStore', () => {
  it('persists validated settings and recovers the last valid backup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-config-'));
    roots.push(root);
    const store = new ConfigStore(root);
    await store.load();
    await store.saveDevice({ id: 'local', name: '本机', transport: 'local', profileId: 'local-profile', enabled: true });
    await store.saveDisplay({ layout: 'grid2x2', asciiMode: 'static', asciiBrightness: 20, asciiStrength: 30, reducedMotion: true });
    const persisted = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8')) as { display: { layout: string; focusSlot: number } };
    expect(persisted.display.layout).toBe('grid2x2');
    expect(persisted.display.focusSlot).toBe(0);
    await writeFile(path.join(root, 'config.json'), '{"broken":true}\n', 'utf8');
    const recovered = new ConfigStore(root);
    await recovered.load();
    expect(recovered.snapshot().display.layout).toBe('columns4');
    expect(recovered.snapshot().devices).toHaveLength(1);
  });

  it('rejects invalid configuration data before it reaches disk', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-config-'));
    roots.push(root);
    const store = new ConfigStore(root);
    await store.load();
    await expect(store.saveDevice({ id: '../secret', name: 'bad', transport: 'local', profileId: 'profile', enabled: true })).rejects.toThrow();
  });

  it('adds the default focus slot while loading a legacy display config', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-config-'));
    roots.push(root);
    await writeFile(path.join(root, 'config.json'), `${JSON.stringify({
      schemaVersion: 1,
      devices: [{ id: 'local', name: '本机', transport: 'local', profileId: 'local-profile', enabled: true }],
      services: [],
      slots: [
        { serviceId: null, logBindingId: null },
        { serviceId: null, logBindingId: null },
        { serviceId: null, logBindingId: null },
        { serviceId: null, logBindingId: null },
      ],
      display: { layout: 'grid2x2', asciiMode: 'static', asciiBrightness: 20, asciiStrength: 30, reducedMotion: true },
      window: null,
    })}\n`, 'utf8');
    const store = new ConfigStore(root);
    await store.load();
    expect(store.snapshot().display).toMatchObject({ layout: 'grid2x2', focusSlot: 0 });
    expect(store.snapshot().devices).toHaveLength(1);
  });
});
