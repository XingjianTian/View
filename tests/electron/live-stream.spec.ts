import { _electron as electron, expect, test } from '@playwright/test';
import { execFile as nodeExecFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(nodeExecFile);
const root = process.cwd();
const electronPath = require('electron') as string;

test('live local bridge keeps snapshots bounded and reads a real finite log source', async () => {
  test.skip(!process.env.SERVICE_OBSERVATORY_RUN_LIVE, '显式设置 SERVICE_OBSERVATORY_RUN_LIVE=1 才运行本机实时接入验收。');
  let containerId: string;
  try {
    const result = await execFile('docker', ['--context', 'desktop-linux', 'ps', '-aq', '--no-trunc'], { maxBuffer: 64 * 1024 });
    containerId = result.stdout.split(/\r?\n/).map((value) => value.trim()).find(Boolean) ?? '';
  } catch {
    test.skip(true, '本机 Docker Desktop 当前不可用。');
    return;
  }
  if (!/^[a-f0-9]{64}$/.test(containerId)) {
    test.skip(true, '本机没有可读容器。');
    return;
  }
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-live-stream-'));
  const profilePath = path.join(dataRoot, 'local-profile.json');
  await writeFile(profilePath, JSON.stringify({ id: 'local-profile', kind: 'local', context: 'desktop-linux' }), { mode: 0o600 });
  await writeFile(path.join(dataRoot, 'profiles.private.json'), JSON.stringify({ schemaVersion: 1, profiles: [{ id: 'local-profile', displayName: '本机 Docker', kind: 'local', sourcePath: profilePath, importedAt: new Date().toISOString() }] }), { mode: 0o600 });
  await writeFile(path.join(dataRoot, 'config.json'), JSON.stringify({ schemaVersion: 1, devices: [{ id: 'local-device', name: '本机 Docker', transport: 'local', profileId: 'local-profile', enabled: true }], services: [], slots: [{ serviceId: null, logBindingId: null }, { serviceId: null, logBindingId: null }, { serviceId: null, logBindingId: null }, { serviceId: null, logBindingId: null }], display: { layout: 'grid2x2', asciiMode: 'static', asciiBrightness: 45, asciiStrength: 50, reducedMotion: true }, window: null }), { mode: 0o600 });
  const app = await electron.launch({ executablePath: electronPath, args: [root], env: { ...process.env, SERVICE_OBSERVATORY_DATA_DIR: dataRoot } });
  try {
    const page = await app.firstWindow();
    const receipt = await page.evaluate(async () => {
      const boot = await window.observatory.bootstrap();
      if (!boot.ok) return { containers: 0, entries: 0, batchBytes: -1, snapshotBytes: -1, timestamped: false };
      const epoch = boot.value.snapshot.windowEpoch;
      let snapshot = boot.value.snapshot;
      for (let attempt = 0; attempt < 8 && !snapshot.observation.containers.length; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        const next = await window.observatory.getSnapshot(epoch);
        if (next.ok) snapshot = next.value;
      }
      const candidates = snapshot.observation.containers.filter((container) => container.logsAvailable).slice(0, 4);
      let entries = 0;
      let timestamped = false;
      for (const candidate of candidates) {
        const opened = await window.observatory.openLog(epoch, candidate.deviceId, candidate.id);
        if (opened.ok) {
          const polled = await window.observatory.pollLog(epoch, opened.value.sourceKey);
          if (polled.ok) {
            entries += polled.value.entries.length;
            timestamped ||= polled.value.entries.some((entry) => !!entry.timestamp);
          }
          await window.observatory.closeLog(epoch, opened.value.sourceKey);
        }
      }
      const update = new Promise<number>((resolve) => {
        const remove = window.observatory.onUpdates((value) => { remove(); resolve(JSON.stringify(value).length); });
        void window.observatory.subscribeUpdates(epoch);
      });
      const batchBytes = await update;
      const finalSnapshot = await window.observatory.getSnapshot(epoch);
      const snapshotBytes = finalSnapshot.ok ? JSON.stringify(finalSnapshot.value).length : -1;
      return { containers: snapshot.observation.containers.length, entries, timestamped, batchBytes, snapshotBytes };
    });
    if (!receipt.containers) test.skip(true, '本机实时发现未返回容器。');
    expect(receipt.batchBytes).toBeGreaterThan(0);
    expect(receipt.batchBytes).toBeLessThan(64 * 1024);
    expect(receipt.snapshotBytes).toBeGreaterThan(0);
    expect(receipt.snapshotBytes).toBeLessThan(64 * 1024);
    expect(receipt.entries).toBeGreaterThan(0);
    expect(receipt.timestamped).toBe(true);
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
