import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProfileRegistry } from '../../src/main/credentials/registry.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ProfileRegistry', () => {
  it('loads only non-secret profile summaries and recovers its backup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-profiles-'));
    roots.push(root);
    await writeFile(path.join(root, 'profiles.private.json.bak'), JSON.stringify({
      schemaVersion: 1,
      profiles: [{
        id: 'nas-readonly', displayName: 'NAS 只读设备', kind: 'ssh',
        sourcePath: '/private/profile.json', importedAt: new Date().toISOString(),
      }],
    }), 'utf8');
    await writeFile(path.join(root, 'profiles.private.json'), '{broken\n', 'utf8');
    const registry = new ProfileRegistry(root);
    await registry.load();
    expect(registry.summaries()).toEqual([{ id: 'nas-readonly', displayName: 'NAS 只读设备', kind: 'ssh', status: 'available' }]);
    expect(registry.getReference('nas-readonly')).toMatchObject({ id: 'nas-readonly', sourcePath: '/private/profile.json' });
    expect(JSON.stringify(registry.summaries())).not.toContain('profile.json');
  });
});
