import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const electronPath = require('electron') as string;
const nasSourcePath = process.env.SERVICE_OBSERVATORY_TEST_PROFILE;

test('dev app performs a redacted read-only NAS probe through the typed bridge', async () => {
  test.skip(!nasSourcePath, '需要通过项目外 SERVICE_OBSERVATORY_TEST_PROFILE 注入既有私有 profile。');
  if (!nasSourcePath) return;
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-transport-'));
  await writeFile(path.join(dataRoot, 'profiles.private.json'), `${JSON.stringify({
    schemaVersion: 1,
    profiles: [{ id: 'nas-access', displayName: 'NAS 只读设备', kind: 'ssh', sourcePath: nasSourcePath, importedAt: new Date().toISOString() }],
  })}\n`, { encoding: 'utf8', mode: 0o600 });
  const app = await electron.launch({
    executablePath: electronPath,
    args: [root],
    env: { ...process.env, SERVICE_OBSERVATORY_DATA_DIR: dataRoot },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.brand-lockup')).toHaveText('「观」Server Observer');
    const result = await page.evaluate(async () => {
      const boot = await window.observatory.bootstrap();
      if (!boot.ok) return boot;
      return window.observatory.testDevice(boot.value.snapshot.windowEpoch, {
        id: 'nas-readonly-test', name: 'NAS 只读设备', transport: 'ssh', profileId: 'nas-access', enabled: true,
      });
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.transport).toBe('ssh');
      expect(result.value.status).toBe('connected');
      expect(result.value.containerCount).toBeGreaterThan(0);
      expect(result.value.dockerVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(result.value.errorCode).toBeNull();
    }
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
