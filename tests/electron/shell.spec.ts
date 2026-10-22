import { invokeMenu } from './helpers/menu.js';
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const electronPath = require('electron') as string;

test('packaged shell exposes only the typed bridge and blocks navigation', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-electron-'));
  const app = await electron.launch({
    executablePath: electronPath,
    args: [root],
    env: { ...process.env, SERVICE_OBSERVATORY_DATA_DIR: dataRoot },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.brand-lockup')).toHaveText('「观」Server Observer');
    await expect(page.locator('.runtime')).toHaveCount(0);
    await expect(page.locator('.context-strip')).toHaveCount(0);
    await expect(page.locator('.footer')).toHaveCount(0);
    await invokeMenu(app, 'open-settings');
    await page.getByRole('button', { name: '诊断与关于' }).click();
    await expect(page.locator('.app-info')).toContainText('开发版');
    const surface = await page.evaluate(() => ({
      hasRequire: typeof (globalThis as { require?: unknown }).require,
      hasProcess: typeof (globalThis as { process?: unknown }).process,
      hasFs: typeof (globalThis as { fs?: unknown }).fs,
      bridgeKeys: Object.keys(window.observatory).sort(),
    }));
    expect(surface.hasRequire).toBe('undefined');
    expect(surface.hasProcess).toBe('undefined');
    expect(surface.hasFs).toBe('undefined');
    expect(surface.bridgeKeys).toEqual([
      'bootstrap', 'chooseAndRegisterProfile', 'closeLog', 'getAppInfo', 'getDiagnostics', 'getSnapshot', 'getSnapshotPage', 'getStatusPage', 'getWindowVisibility',
      'listProfiles', 'listStatusSources', 'onMenuCommand', 'onUpdates', 'onWindowVisibility', 'openLog', 'pauseLog', 'pollLog', 'refresh', 'removeDevice', 'removeService',
      'saveDevice', 'saveDisplay', 'saveService', 'saveWindowBounds', 'searchLog', 'setMenuLayout', 'setSlots', 'subscribeUpdates',
      'testDevice', 'unsubscribeUpdates',
    ]);
    const popup = await page.evaluate(() => window.open('https://example.com/'));
    expect(popup).toBeNull();
    await expect(page.locator('.brand-lockup')).toHaveText('「观」Server Observer');
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('native visibility bridge reports hide/minimize and restore without a blur transition', async () => {
  const visibilityStageTimeoutMs = 3_000;
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-electron-visibility-'));
  const app = await electron.launch({
    executablePath: electronPath,
    args: [root],
    env: { ...process.env, SERVICE_OBSERVATORY_DATA_DIR: dataRoot },
  });
  try {
    const page = await app.firstWindow();
    await expect.poll(
      () => app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        return !!window && !window.isDestroyed() && window.isVisible() && !window.isMinimized();
      }),
      { timeout: visibilityStageTimeoutMs, message: '[visibility:initial] native window did not become visible' },
    ).toBe(true);
    const initial = await page.evaluate(async () => {
      const boot = await window.observatory.bootstrap();
      if (!boot.ok) throw new Error(boot.error.message);
      const current = await window.observatory.getWindowVisibility(boot.value.snapshot.windowEpoch);
      if (!current.ok) throw new Error(current.error.message);
      return current.value;
    });
    expect(initial.visible).toBe(true);
    const epoch = initial.windowEpoch;
    const armVisibilityWait = async (stage: string, visible: boolean) => {
      await page.evaluate(({ expected, stage: stageName, timeoutMs }) => {
        const target = window as unknown as {
          __visibilityWait?: Promise<unknown>;
          __visibilityWaitCleanup?: (() => void) | undefined;
        };
        target.__visibilityWaitCleanup?.();
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let remove: () => void = () => undefined;
        target.__visibilityWait = new Promise((resolve) => {
          const finish = (result: unknown) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            remove();
            target.__visibilityWaitCleanup = undefined;
            resolve(result);
          };
          remove = window.observatory.onWindowVisibility((value) => {
            if (value.visible === expected) finish({ kind: 'event', stage: stageName, value });
          });
          timer = setTimeout(() => finish({ kind: 'timeout', stage: stageName, expected }), timeoutMs);
          target.__visibilityWaitCleanup = remove;
        });
      }, { expected: visible, stage, timeoutMs: visibilityStageTimeoutMs });
    };
    const readVisibilityWait = async (stage: string, visible: boolean) => {
      const result = await page.evaluate(async ({ currentEpoch }) => {
        const target = window as unknown as { __visibilityWait?: Promise<unknown> };
        const event = await target.__visibilityWait;
        delete target.__visibilityWait;
        const queried = await window.observatory.getWindowVisibility(currentEpoch);
        return { event, queried };
      }, { currentEpoch: epoch });
      const event = result.event as { kind?: string; stage?: string; value?: { windowEpoch: number; visible: boolean } } | undefined;
      expect(event?.kind, `[visibility:${stage}] expected a native visibility event`).toBe('event');
      expect(event?.stage).toBe(stage);
      expect(event?.value?.windowEpoch).toBe(epoch);
      expect(event?.value?.visible).toBe(visible);
      expect(result.queried, `[visibility:${stage}] queried visibility`).toEqual({ ok: true, value: { windowEpoch: epoch, visible } });
      return event?.value ?? null;
    };

    await armVisibilityWait('hide', false);
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.hide(); });
    await readVisibilityWait('hide', false);
    await armVisibilityWait('show', true);
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.show(); });
    await readVisibilityWait('show', true);
    await armVisibilityWait('minimize', false);
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.minimize(); });
    await readVisibilityWait('minimize', false);
    await armVisibilityWait('restore', true);
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) return;
      window.restore();
      if (!window.isVisible()) window.show();
    });
    await readVisibilityWait('restore', true);
    const queried = await page.evaluate(async (currentEpoch) => window.observatory.getWindowVisibility(currentEpoch), epoch);
    expect(queried).toEqual({ ok: true, value: { windowEpoch: epoch, visible: true } });
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('native menus open settings after a closed window and refresh without reloading the page', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-native-menu-'));
  const app = await electron.launch({ executablePath: electronPath, args: [root], env: { ...process.env, SERVICE_OBSERVATORY_DATA_DIR: dataRoot } });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.brand-lockup')).toHaveText('「观」Server Observer');
    const items = await app.evaluate(({ Menu }) => ['open-settings', 'refresh-status'].map((id) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(id);
      return { id: item?.id, accelerator: item?.accelerator };
    }));
    expect(items).toEqual([{ id: 'open-settings', accelerator: 'CmdOrCtrl+,' }, { id: 'refresh-status', accelerator: 'CmdOrCtrl+R' }]);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.send('observatory:menu-command', 'unsupported-command'));
    await expect(page.locator('.settings-drawer')).toHaveCount(0);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
    await invokeMenu(app, 'open-settings');
    const reopened = await app.firstWindow();
    await expect(reopened.locator('.settings-drawer')).toBeVisible();
    const epochBefore = await reopened.evaluate(async () => {
      const boot = await window.observatory.bootstrap();
      return boot.ok ? boot.value.snapshot.windowEpoch : -1;
    });
    await reopened.evaluate(() => { (window as Window & { __menuRefreshMarker?: string }).__menuRefreshMarker = 'still-mounted'; });
    await invokeMenu(app, 'refresh-status');
    await expect(reopened.locator('.settings-feedback')).toContainText('已刷新本地与远端只读采样');
    const epochAfter = await reopened.evaluate(async () => {
      const boot = await window.observatory.bootstrap();
      return boot.ok ? boot.value.snapshot.windowEpoch : -2;
    });
    expect(epochAfter).toBe(epochBefore);
    expect(await reopened.evaluate(() => (window as Window & { __menuRefreshMarker?: string }).__menuRefreshMarker)).toBe('still-mounted');
    await reopened.getByRole('button', { name: '关闭设置' }).click();
    await expect(reopened.locator('.app-topbar button')).toHaveCount(0);
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
