import { invokeMenu } from './helpers/menu.js';
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const electronPath = require('electron') as string;
const containerId = 'a'.repeat(64);
type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;

function service(id: string, name: string, index: number) {
  return {
    id,
    name,
    category: index === 1 ? '论文下载' : '后台任务',
    bindings: index === 1 ? [{
      id: 'binding-paper',
      deviceId: 'device-1',
      selector: { kind: 'container_id' as const, value: containerId },
      required: true,
      expectedPolicy: 'continuous' as const,
    }] : [],
    businessAdapter: index === 1 ? { kind: 'http_json' as const, profileId: 'missing-business-profile', endpointRef: 'legacy-business', mapping: { events: '/events' } } : { kind: 'none' as const },
    statusAdapter: index === 1 ? { kind: 'http_json' as const, profileId: 'missing-status-profile', endpointRef: 'legacy-status', mapping: { events: '/events' } } : { kind: 'none' as const },
  };
}

function seededConfig() {
  const services = [
    service('service-1', '论文服务', 1),
    service('service-2', '后台服务', 2),
    service('service-3', '知识库服务', 3),
    service('service-4', '基础设施服务', 4),
  ];
  return {
    schemaVersion: 1,
    devices: [
      { id: 'device-1', name: '设备一', transport: 'local' as const, profileId: 'missing-device-profile', enabled: false },
      { id: 'device-2', name: '设备二', transport: 'local' as const, profileId: 'missing-device-profile-2', enabled: false },
    ],
    services,
    slots: services.map((item) => ({ serviceId: item.id, logBindingId: null })) as [{ serviceId: string; logBindingId: null }, { serviceId: string; logBindingId: null }, { serviceId: string; logBindingId: null }, { serviceId: string; logBindingId: null }],
    display: { layout: 'grid2x2' as const, focusSlot: 0, asciiMode: 'off' as const, asciiBrightness: 42, asciiStrength: 48, reducedMotion: true },
    window: null,
  };
}

async function launchFixture(dataRoot: string) {
  await writeFile(path.join(dataRoot, 'config.json'), `${JSON.stringify(seededConfig())}\n`, { encoding: 'utf8', mode: 0o600 });
  return electron.launch({ executablePath: electronPath, args: [root], env: { ...process.env, SERVICE_OBSERVATORY_DATA_DIR: dataRoot } });
}

async function epochFor(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const result = await window.observatory.bootstrap();
    if (!result.ok) throw new Error(result.error.message);
    return result.value.snapshot.windowEpoch;
  });
}

async function installDisplaySaveGate(app: ElectronApp) {
  await app.evaluate(({ ipcMain }) => {
    const target = ipcMain as unknown as { _invokeHandlers?: Map<string, (event: unknown, args: unknown) => Promise<unknown>> };
    const original = target._invokeHandlers?.get('config:save-display');
    if (!target._invokeHandlers || !original) throw new Error('config:save-display handler missing');
    const gate = {
      original,
      pending: [] as Array<{ event: unknown; args: unknown; resolve: (result: unknown) => void }>,
      failBrightness: null as number | null,
    };
    (globalThis as unknown as { __settingsDisplayGate: typeof gate }).__settingsDisplayGate = gate;
    target._invokeHandlers.set('config:save-display', (event, args) => new Promise((resolve) => {
      gate.pending.push({ event, args, resolve: resolve as (result: unknown) => void });
    }));
  });
}

async function installSlotsSaveCounter(app: ElectronApp) {
  await app.evaluate(({ ipcMain }) => {
    const target = ipcMain as unknown as { _invokeHandlers?: Map<string, (event: unknown, args: unknown) => Promise<unknown>> };
    const original = target._invokeHandlers?.get('config:set-slots');
    if (!target._invokeHandlers || !original) throw new Error('config:set-slots handler missing');
    const counter = { count: 0 };
    (globalThis as unknown as { __settingsSlotsSaveCounter: typeof counter }).__settingsSlotsSaveCounter = counter;
    target._invokeHandlers.set('config:set-slots', async (event, args) => {
      counter.count += 1;
      return original(event, args);
    });
  });
}

async function slotsSaveCount(app: ElectronApp) {
  return app.evaluate(() => (globalThis as unknown as { __settingsSlotsSaveCounter: { count: number } }).__settingsSlotsSaveCounter.count);
}

async function pendingDisplaySaves(app: ElectronApp) {
  return app.evaluate(() => (globalThis as unknown as { __settingsDisplayGate: { pending: unknown[] } }).__settingsDisplayGate.pending.length);
}

async function resolveNextDisplaySave(app: ElectronApp) {
  await app.evaluate(async () => {
    const gate = (globalThis as unknown as { __settingsDisplayGate: { original: (event: unknown, args: unknown) => Promise<unknown>; pending: Array<{ event: unknown; args: { payload?: { display?: { asciiBrightness?: number } } }; resolve: (result: unknown) => void }>; failBrightness: number | null } }).__settingsDisplayGate;
    const next = gate.pending.shift();
    if (!next) throw new Error('no display save is pending');
    if (gate.failBrightness !== null && next.args.payload?.display?.asciiBrightness === gate.failBrightness) {
      next.resolve({ ok: false, error: { code: 'config_write_failed', message: '测试显示写入失败' } });
      return;
    }
    next.resolve(await gate.original(next.event, next.args));
  });
}

function serviceNameInput(page: import('@playwright/test').Page) {
  return page.locator('.editor-form label').filter({ hasText: '服务名称' }).locator('input');
}

function slotSelect(page: import('@playwright/test').Page, index: number) {
  return page.locator('.slot-setting').nth(index).locator('select');
}

test('settings keeps drafts, preserves service fields, and merges concurrent slot changes', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-settings-'));
  const app = await launchFixture(dataRoot);
  try {
    const page = await app.firstWindow();
    await invokeMenu(app, 'open-settings');

    const nav = page.getByRole('navigation', { name: '设置类别' });
    await expect(nav.getByRole('button')).toHaveCount(5);
    await expect(page.getByRole('tablist', { name: '服务编辑页签' }).getByRole('tab')).toHaveCount(3);
    await expect(page.locator('.settings-breadcrumb[aria-label="当前位置"]')).toContainText('服务 / 论文服务');

    const nameInput = serviceNameInput(page);
    await nameInput.fill('草稿论文服务');
    await nav.getByRole('button', { name: '设备' }).click();
    const leaveDialog = page.getByRole('dialog', { name: '草稿尚未保存' });
    await expect(leaveDialog).toBeVisible();
    await leaveDialog.getByRole('button', { name: '留在此处' }).click();
    await expect(nameInput).toHaveValue('草稿论文服务');
    await nav.getByRole('button', { name: '设备' }).click();
    await page.getByRole('dialog', { name: '草稿尚未保存' }).getByRole('button', { name: '放弃修改' }).click();
    await expect(nav.getByRole('button', { name: '设备' })).toHaveAttribute('aria-current', 'page');

    await nav.getByRole('button', { name: '服务' }).click();
    await serviceNameInput(page).fill('已保存论文服务');
    await nav.getByRole('button', { name: '设备' }).click();
    await page.getByRole('dialog', { name: '草稿尚未保存' }).getByRole('button', { name: '保存并离开' }).click();
    await expect(nav.getByRole('button', { name: '设备' })).toHaveAttribute('aria-current', 'page');

    await nav.getByRole('button', { name: '服务' }).click();
    const savedInput = serviceNameInput(page);
    await savedInput.fill('');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(/请求参数无效|设置未能保存/);
    await expect(savedInput).toHaveValue('');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(serviceNameInput(page)).toHaveValue('已保存论文服务');

    const epoch = await epochFor(page);
    await serviceNameInput(page).fill('并发后论文服务');
    await page.evaluate(async (currentEpoch) => {
      const snapshot = await window.observatory.getSnapshot(currentEpoch);
      if (!snapshot.ok) throw new Error(snapshot.error.message);
      const device = snapshot.value.config.devices.find((item) => item.id === 'device-2');
      const otherService = snapshot.value.config.services.find((item) => item.id === 'service-2');
      if (!device || !otherService) throw new Error('fixture object missing');
      const deviceResult = await window.observatory.saveDevice(currentEpoch, { ...device, name: '设备二外部更新' });
      if (!deviceResult.ok) throw new Error(deviceResult.error.message);
      const serviceResult = await window.observatory.saveService(currentEpoch, { ...otherService, name: '后台服务外部更新' });
      if (!serviceResult.ok) throw new Error(serviceResult.error.message);
    }, epoch);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByText('已保存服务：并发后论文服务')).toBeVisible();

    const preserved = await page.evaluate(async (currentEpoch) => {
      const result = await window.observatory.getSnapshot(currentEpoch);
      if (!result.ok) throw new Error(result.error.message);
      const config = result.value.config;
      return {
        deviceName: config.devices.find((item) => item.id === 'device-2')?.name,
        otherServiceName: config.services.find((item) => item.id === 'service-2')?.name,
        service: config.services.find((item) => item.id === 'service-1'),
      };
    }, epoch);
    expect(preserved.deviceName).toBe('设备二外部更新');
    expect(preserved.otherServiceName).toBe('后台服务外部更新');
    expect(preserved.service).toMatchObject({
      id: 'service-1',
      name: '并发后论文服务',
      businessAdapter: { kind: 'http_json', profileId: 'missing-business-profile', endpointRef: 'legacy-business', mapping: { events: '/events' } },
      statusAdapter: { kind: 'http_json', profileId: 'missing-status-profile', endpointRef: 'legacy-status', mapping: { events: '/events' } },
      bindings: [{ id: 'binding-paper', deviceId: 'device-1', required: true, expectedPolicy: 'continuous', selector: { kind: 'container_id', value: containerId } }],
    });

    await nav.getByRole('button', { name: '面板与布局' }).click();
    await slotSelect(page, 0).selectOption('service-2');
    await page.evaluate(async (currentEpoch) => {
      const snapshot = await window.observatory.getSnapshot(currentEpoch);
      if (!snapshot.ok) throw new Error(snapshot.error.message);
      const slots = snapshot.value.config.slots.map((slot, index) => index === 1 ? { ...slot, serviceId: 'service-3' } : slot) as [{ serviceId: string | null; logBindingId: string | null }, { serviceId: string | null; logBindingId: string | null }, { serviceId: string | null; logBindingId: string | null }, { serviceId: string | null; logBindingId: string | null }];
      const result = await window.observatory.setSlots(currentEpoch, slots);
      if (!result.ok) throw new Error(result.error.message);
    }, epoch);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByText('已保存槽位服务配置。')).toBeVisible();
    let slots = await page.evaluate(async (currentEpoch) => {
      const result = await window.observatory.getSnapshot(currentEpoch);
      if (!result.ok) throw new Error(result.error.message);
      return result.value.config.slots;
    }, epoch);
    expect(slots[0]?.serviceId).toBe('service-2');
    expect(slots[1]?.serviceId).toBe('service-3');

    await slotSelect(page, 0).selectOption('service-3');
    await page.evaluate(async (currentEpoch) => {
      const snapshot = await window.observatory.getSnapshot(currentEpoch);
      if (!snapshot.ok) throw new Error(snapshot.error.message);
      const slots = snapshot.value.config.slots.map((slot, index) => index === 0 ? { ...slot, serviceId: 'service-4' } : slot) as [{ serviceId: string | null; logBindingId: string | null }, { serviceId: string | null; logBindingId: string | null }, { serviceId: string | null; logBindingId: string | null }, { serviceId: string | null; logBindingId: string | null }];
      const result = await window.observatory.setSlots(currentEpoch, slots);
      if (!result.ok) throw new Error(result.error.message);
    }, epoch);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('槽位 01 已被其他更新修改');
    await expect(slotSelect(page, 0)).toHaveValue('service-3');
    slots = await page.evaluate(async (currentEpoch) => {
      const result = await window.observatory.getSnapshot(currentEpoch);
      if (!result.ok) throw new Error(result.error.message);
      return result.value.config.slots;
    }, epoch);
    expect(slots[0]?.serviceId).toBe('service-4');
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('layout-only save keeps slots and skips the collection-reset IPC', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-settings-layout-only-'));
  const app = await launchFixture(dataRoot);
  try {
    const page = await app.firstWindow();
    await installSlotsSaveCounter(app);
    await invokeMenu(app, 'open-settings');
    await page.getByRole('button', { name: '面板与布局' }).click();
    await page.getByRole('group', { name: '视图布局' }).getByRole('button', { name: '四列' }).click();
    await expect(page.locator('.dashboard-grid')).toHaveClass(/layout-columns4/);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByText('已保存槽位服务配置。')).toBeVisible();
    expect(await slotsSaveCount(app)).toBe(0);

    const persisted = JSON.parse(await readFile(path.join(dataRoot, 'config.json'), 'utf8')) as { display: { layout: string }; slots: Array<{ serviceId: string | null; logBindingId: string | null }> };
    expect(persisted.display.layout).toBe('columns4');
    expect(persisted.slots.map((slot) => slot.serviceId)).toEqual(['service-1', 'service-2', 'service-3', 'service-4']);
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('settings serializes a delayed layout preview before cancel', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-settings-layout-race-'));
  const app = await launchFixture(dataRoot);
  try {
    const page = await app.firstWindow();
    await installDisplaySaveGate(app);
    await invokeMenu(app, 'open-settings');
    const nav = page.getByRole('navigation', { name: '设置类别' });
    await nav.getByRole('button', { name: '面板与布局' }).click();
    await page.getByRole('group', { name: '视图布局' }).getByRole('button', { name: '四列' }).click();
    await expect.poll(() => pendingDisplaySaves(app)).toBe(1);

    await nav.getByRole('button', { name: '服务' }).click();
    const leaveDialog = page.getByRole('dialog', { name: '草稿尚未保存' });
    await expect(leaveDialog).toBeVisible();
    await leaveDialog.getByRole('button', { name: '放弃修改' }).click();
    await expect.poll(() => pendingDisplaySaves(app)).toBe(1);
    await resolveNextDisplaySave(app);
    await expect.poll(() => pendingDisplaySaves(app)).toBe(1);
    await resolveNextDisplaySave(app);
    await expect(nav.getByRole('button', { name: '服务' })).toHaveAttribute('aria-current', 'page');

    const epoch = await epochFor(page);
    const snapshot = await page.evaluate(async (currentEpoch) => {
      const result = await window.observatory.getSnapshot(currentEpoch);
      if (!result.ok) throw new Error(result.error.message);
      return result.value.config.display;
    }, epoch);
    expect(snapshot.layout).toBe('grid2x2');
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('settings commits the latest delayed display choice and rolls back a failed save', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-settings-display-race-'));
  const app = await launchFixture(dataRoot);
  try {
    const page = await app.firstWindow();
    await installDisplaySaveGate(app);
    await invokeMenu(app, 'open-settings');
    const nav = page.getByRole('navigation', { name: '设置类别' });
    await nav.getByRole('button', { name: '外观与动效' }).click();
    const brightness = page.locator('input[type="range"]').first();

    await brightness.fill('67');
    await brightness.fill('68');
    await expect.poll(() => pendingDisplaySaves(app)).toBe(1);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await resolveNextDisplaySave(app);
    await expect.poll(() => pendingDisplaySaves(app)).toBe(1);
    await resolveNextDisplaySave(app);
    await expect.poll(() => pendingDisplaySaves(app)).toBe(1);
    await resolveNextDisplaySave(app);
    await expect(page.getByRole('button', { name: '取消', exact: true })).toBeDisabled();

    await brightness.fill('73');
    await expect.poll(() => pendingDisplaySaves(app)).toBe(1);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await resolveNextDisplaySave(app);
    await expect.poll(() => pendingDisplaySaves(app)).toBe(1);
    await resolveNextDisplaySave(app);
    await expect(page.getByText('预览设置已保留。')).toBeVisible();

    const epoch = await epochFor(page);
    const saved = await page.evaluate(async (currentEpoch) => {
      const result = await window.observatory.getSnapshot(currentEpoch);
      if (!result.ok) throw new Error(result.error.message);
      return result.value.config.display.asciiBrightness;
    }, epoch);
    expect(saved).toBe(73);

    await app.evaluate(() => {
      (globalThis as unknown as { __settingsDisplayGate: { failBrightness: number | null } }).__settingsDisplayGate.failBrightness = 81;
    });
    await brightness.fill('81');
    await expect.poll(() => pendingDisplaySaves(app)).toBe(1);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await resolveNextDisplaySave(app);
    await expect.poll(() => pendingDisplaySaves(app)).toBe(1);
    await resolveNextDisplaySave(app);
    await expect(page.getByRole('alert')).toContainText('测试显示写入失败');

    const afterFailure = await page.evaluate(async (currentEpoch) => {
      const result = await window.observatory.getSnapshot(currentEpoch);
      if (!result.ok) throw new Error(result.error.message);
      return result.value.config.display.asciiBrightness;
    }, epoch);
    expect(afterFailure).toBe(73);
    const reloadedConfig = JSON.parse(await readFile(path.join(dataRoot, 'config.json'), 'utf8')) as { display: { asciiBrightness: number } };
    expect(reloadedConfig.display.asciiBrightness).toBe(73);

    await app.evaluate(() => {
      (globalThis as unknown as { __settingsDisplayGate: { failBrightness: number | null } }).__settingsDisplayGate.failBrightness = null;
    });
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect.poll(() => pendingDisplaySaves(app)).toBe(1);
    await resolveNextDisplaySave(app);
    await expect(page.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
