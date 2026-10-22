import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const electronPath = require('electron') as string;
const nasSourcePath = process.env.SERVICE_OBSERVATORY_TEST_PROFILE;

test('live NAS bridge discovers containers and reads one finite log source', async () => {
  test.setTimeout(120_000);
  test.skip(!process.env.SERVICE_OBSERVATORY_RUN_NAS_LIVE || !nasSourcePath, '显式设置 SERVICE_OBSERVATORY_RUN_NAS_LIVE=1 并注入项目外私有 profile 才运行 NAS 实时验收。');
  if (!nasSourcePath) return;
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-nas-live-'));
  await writeFile(path.join(dataRoot, 'profiles.private.json'), `${JSON.stringify({
    schemaVersion: 1,
    profiles: [{ id: 'nas-access', displayName: 'NAS 只读设备', kind: 'ssh', sourcePath: nasSourcePath, importedAt: new Date().toISOString() }],
  })}\n`, { encoding: 'utf8', mode: 0o600 });
  await writeFile(path.join(dataRoot, 'config.json'), `${JSON.stringify({
    schemaVersion: 1,
    devices: [{ id: 'nas-device', name: 'NAS 只读设备', transport: 'ssh', profileId: 'nas-access', enabled: true }],
    services: [],
    slots: [{ serviceId: null, logBindingId: null }, { serviceId: null, logBindingId: null }, { serviceId: null, logBindingId: null }, { serviceId: null, logBindingId: null }],
    display: { layout: 'grid2x2', asciiMode: 'static', asciiBrightness: 45, asciiStrength: 50, reducedMotion: true },
    window: null,
  })}\n`, { encoding: 'utf8', mode: 0o600 });
  const app = await electron.launch({ executablePath: electronPath, args: [root], env: { ...process.env, SERVICE_OBSERVATORY_DATA_DIR: dataRoot } });
  try {
    const page = await app.firstWindow();
    const receipt = await page.evaluate(async () => {
      const boot = await window.observatory.bootstrap();
      if (!boot.ok) return { discovered: 0, complete: false, entries: 0, timestamped: false };
      let snapshot = boot.value.snapshot;
      for (let attempt = 0; attempt < 24 && !snapshot.observation.devices[0]?.complete; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        const next = await window.observatory.getSnapshot(snapshot.windowEpoch);
        if (next.ok) snapshot = next.value;
      }
      const candidates = snapshot.observation.containers.filter((container) => container.logsAvailable).slice(0, 12);
      for (const candidate of candidates) {
        const opened = await window.observatory.openLog(snapshot.windowEpoch, candidate.deviceId, candidate.id);
        if (!opened.ok) continue;
        try {
          const polled = await window.observatory.pollLog(snapshot.windowEpoch, opened.value.sourceKey);
          if (polled.ok && polled.value.entries.length) {
            return {
              discovered: snapshot.observation.containers.length,
              complete: snapshot.observation.devices[0]?.complete ?? false,
              entries: polled.value.entries.length,
              timestamped: polled.value.entries.some((entry) => !!entry.timestamp),
            };
          }
        } finally {
          await window.observatory.closeLog(snapshot.windowEpoch, opened.value.sourceKey);
        }
      }
      return { discovered: snapshot.observation.containers.length, complete: snapshot.observation.devices[0]?.complete ?? false, entries: 0, timestamped: false };
    });
    expect(receipt.complete).toBe(true);
    expect(receipt.discovered).toBeGreaterThan(0);
    expect(receipt.entries).toBeGreaterThan(0);
    expect(receipt.timestamped).toBe(true);
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
