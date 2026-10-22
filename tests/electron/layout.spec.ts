import { invokeMenu } from './helpers/menu.js';
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const electronPath = require('electron') as string;

function legacyConfig(asciiMode: 'static' | 'dynamic' = 'static', layout: 'columns4' | 'grid2x2' | 'focus' = 'grid2x2', focusSlot = 0) {
  const services = ['本机 API', '任务队列', '文件入口', 'NAS 数据库'].map((name, index) => ({
    id: `service-${index + 1}`,
    name,
    category: index % 2 ? '后台任务' : '应用服务',
    bindings: [],
    businessAdapter: { kind: 'none' as const },
  }));
  return {
    schemaVersion: 1,
    devices: [],
    services,
    slots: services.map((service) => ({ serviceId: service.id, logBindingId: null })) as [{ serviceId: string; logBindingId: null }, { serviceId: string; logBindingId: null }, { serviceId: string; logBindingId: null }, { serviceId: string; logBindingId: null }],
    display: { layout, focusSlot, asciiMode, asciiBrightness: 42, asciiStrength: 48, reducedMotion: false },
    window: null,
  };
}

async function launchWithConfig(dataRoot: string, asciiMode: 'static' | 'dynamic' = 'static', layout: 'columns4' | 'grid2x2' | 'focus' = 'grid2x2', focusSlot = 0) {
  await writeFile(path.join(dataRoot, 'config.json'), `${JSON.stringify(legacyConfig(asciiMode, layout, focusSlot))}\n`, { encoding: 'utf8', mode: 0o600 });
  return electron.launch({ executablePath: electronPath, args: [root], env: { ...process.env, SERVICE_OBSERVATORY_DATA_DIR: dataRoot } });
}

test('settings switches all layouts and focus slot without remounting panels', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-layout-'));
  const app = await launchWithConfig(dataRoot);
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('navigation', { name: '整体视图' })).toHaveCount(0);
    await invokeMenu(app, 'open-settings');
    await page.getByRole('button', { name: '面板与布局' }).click();
    const layoutGroup = page.getByRole('group', { name: '视图布局' });
    await expect(layoutGroup).toBeVisible();
    const viewButtons = layoutGroup.getByRole('button');
    await expect(viewButtons).toHaveCount(3);
    await expect(layoutGroup.getByRole('button', { name: '四列' })).toHaveAttribute('aria-pressed', 'false');
    await expect(layoutGroup.getByRole('button', { name: '四宫格' })).toHaveAttribute('aria-pressed', 'true');
    await expect(layoutGroup.getByRole('button', { name: '一大三小' })).toHaveAttribute('aria-pressed', 'false');

    const panels = page.locator('.service-panel');
    const firstPanel = panels.nth(0);
    await page.evaluate(() => {
      const panel = document.querySelector('.service-panel');
      const log = panel?.querySelector('.log-viewer');
      if (!panel || !log) throw new Error('expected service panel and log viewer');
      Object.assign(window, { __layoutRefs: { panel, log } });
    });
    await layoutGroup.getByRole('button', { name: '四列' }).click();
    await expect(page.locator('.dashboard-grid')).toHaveClass(/layout-columns4/);
    await expect(firstPanel).toBeVisible();
    await layoutGroup.getByRole('button', { name: '一大三小' }).click();
    await expect(page.locator('.dashboard-grid')).toHaveClass(/layout-focus/);
    await expect(page.locator('.panel-focus-main h2')).toHaveText('本机 API');
    await expect(page.locator('.panel-focus-small')).toHaveCount(3);

    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('button', { name: '关闭设置' }).click();
    await page.locator('.panel-focus-small-2').getByRole('button', { name: '设为主视图' }).click();
    await expect(page.locator('.panel-focus-main h2')).toHaveText('文件入口');
    await expect(page.locator('.panel-focus-small').getByRole('button', { name: '设为主视图' })).toHaveCount(3);
    const sameNodes = await page.evaluate(() => {
      const refs = (window as unknown as { __layoutRefs?: { panel: Element; log: Element } }).__layoutRefs;
      return !!refs && refs.panel === document.querySelector('.service-panel') && refs.log === document.querySelector('.service-panel .log-viewer');
    });
    expect(sameNodes).toBe(true);
    const snapshot = await page.evaluate(async () => {
      const boot = await window.observatory.bootstrap();
      return boot.ok ? { layout: boot.value.snapshot.config.display.layout, focusSlot: boot.value.snapshot.config.display.focusSlot } : null;
    });
    expect(snapshot).toEqual({ layout: 'focus', focusSlot: 2 });
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('legacy display defaults focus slot and persists layout across restart', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-layout-restart-'));
  const app = await launchWithConfig(dataRoot);
  try {
    const page = await app.firstWindow();
    const first = await page.evaluate(async () => {
      const boot = await window.observatory.bootstrap();
      if (!boot.ok) return null;
      return { layout: boot.value.snapshot.config.display.layout, focusSlot: boot.value.snapshot.config.display.focusSlot, services: boot.value.snapshot.config.services.length };
    });
    expect(first).toEqual({ layout: 'grid2x2', focusSlot: 0, services: 4 });
    await invokeMenu(app, 'open-settings');
    await page.getByRole('button', { name: '面板与布局' }).click();
    await page.getByRole('group', { name: '视图布局' }).getByRole('button', { name: '一大三小' }).click();
    await expect(page.locator('.dashboard-grid')).toHaveClass(/layout-focus/);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('button', { name: '关闭设置' }).click();
    await page.locator('.panel-focus-small-3').getByRole('button', { name: '设为主视图' }).click();
    await expect(page.locator('.panel-focus-main h2')).toHaveText('NAS 数据库');
  } finally {
    await app.close();
  }

  const persisted = JSON.parse(await readFile(path.join(dataRoot, 'config.json'), 'utf8')) as { display: { layout: string; focusSlot: number } };
  expect(persisted.display).toMatchObject({ layout: 'focus', focusSlot: 3 });
  const restarted = await electron.launch({ executablePath: electronPath, args: [root], env: { ...process.env, SERVICE_OBSERVATORY_DATA_DIR: dataRoot } });
  try {
    const page = await restarted.firstWindow();
    await expect(page.locator('.dashboard-grid')).toHaveClass(/layout-focus/);
    await expect(page.locator('.panel-focus-main h2')).toHaveText('NAS 数据库');
    await invokeMenu(restarted, 'open-settings');
    await page.getByRole('button', { name: '面板与布局' }).click();
    await expect(page.getByRole('group', { name: '视图布局' }).getByRole('button', { name: '一大三小' })).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await restarted.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('dynamic layout transition animates stable panels and cleans up', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-layout-motion-'));
  const app = await launchWithConfig(dataRoot, 'dynamic');
  try {
    const page = await app.firstWindow();
    await invokeMenu(app, 'open-settings');
    await page.getByRole('button', { name: '面板与布局' }).click();
    await expect(page.getByRole('group', { name: '视图布局' }).getByRole('button', { name: '四宫格' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('group', { name: '视图布局' }).getByRole('button', { name: '四列' }).click();
    await expect(page.locator('.dashboard-grid')).toHaveClass(/layout-columns4/);
    await page.waitForTimeout(40);
    expect(await page.evaluate(() => document.getAnimations().length)).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => document.getAnimations().length), { timeout: 1_000 }).toBe(0);
    expect(await page.locator('.service-panel')).toHaveCount(4);
    expect(await page.locator('.log-viewer')).toHaveCount(4);
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('rapid layout requests settle on the last intent without leftover animations', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-layout-rapid-'));
  const app = await launchWithConfig(dataRoot, 'dynamic', 'focus', 0);
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('navigation', { name: '整体视图' })).toHaveCount(0);
    await invokeMenu(app, 'open-settings');
    await page.getByRole('button', { name: '面板与布局' }).click();
    await expect(page.getByRole('group', { name: '视图布局' })).toBeVisible();
    await page.evaluate(() => {
      const labels = ['四列', '一大三小', '四宫格', '四列', '一大三小', '四宫格', '四列', '一大三小', '四宫格', '四列'];
      const buttons = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="视图布局"] button')];
      for (const label of labels) buttons.find((button) => button.innerText.includes(label))?.click();
    });
    await expect.poll(() => page.locator('.dashboard-grid').getAttribute('class'), { timeout: 3_000 }).toMatch(/layout-columns4/);
    await expect.poll(() => page.evaluate(() => document.getAnimations().length), { timeout: 1_500 }).toBe(0);
    await page.locator('.choice-row').filter({ hasText: '主槽位' }).getByRole('button', { name: '03' }).click();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByText('已保存槽位服务配置。')).toBeVisible();
    const readPersistedDisplay = async () => {
      try {
        const persisted = JSON.parse(await readFile(path.join(dataRoot, 'config.json'), 'utf8')) as { display?: { layout?: string; focusSlot?: number } };
        return persisted.display ?? null;
      } catch {
        return null;
      }
    };
    await expect.poll(readPersistedDisplay, { timeout: 3_000 }).toMatchObject({ layout: 'columns4', focusSlot: 2 });
    await page.waitForTimeout(120);
    expect(await readPersistedDisplay()).toMatchObject({ layout: 'columns4', focusSlot: 2 });
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('native View menu switches and persists layouts directly and follows settings previews', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-native-layout-'));
  const app = await launchWithConfig(dataRoot);
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.service-panel')).toHaveCount(4);
    await page.evaluate(() => { (window as Window & { __nativePanels?: Element[] }).__nativePanels = [...document.querySelectorAll('.service-panel')]; });
    const checkedLayout = () => app.evaluate(({ Menu }) => ['columns4', 'grid2x2', 'focus'].filter((layout) => Menu.getApplicationMenu()?.getMenuItemById(`layout-${layout}`)?.checked));
    await expect.poll(checkedLayout).toEqual(['grid2x2']);
    for (const layout of ['columns4', 'grid2x2', 'focus'] as const) {
      await invokeMenu(app, `layout-${layout}`);
      await expect(page.locator('.dashboard-grid')).toHaveClass(new RegExp(`layout-${layout}`));
      await expect.poll(checkedLayout).toEqual([layout]);
      await expect.poll(async () => JSON.parse(await readFile(path.join(dataRoot, 'config.json'), 'utf8')).display.layout).toBe(layout);
      await expect(page.locator('.settings-drawer')).toHaveCount(0);
      expect(await page.evaluate(() => (window as Window & { __nativePanels?: Element[] }).__nativePanels?.every((node, index) => node === document.querySelectorAll('.service-panel')[index]))).toBe(true);
    }
    await invokeMenu(app, 'open-settings');
    await page.getByRole('button', { name: '面板与布局' }).click();
    await page.getByRole('group', { name: '视图布局' }).getByRole('button', { name: '四列', exact: true }).click();
    await expect(page.locator('.dashboard-grid')).toHaveClass(/layout-columns4/);
    await expect.poll(checkedLayout).toEqual(['columns4']);
    // Selecting the currently previewed layout from the native menu must still save it.
    await invokeMenu(app, 'layout-columns4');
    await expect.poll(async () => JSON.parse(await readFile(path.join(dataRoot, 'config.json'), 'utf8')).display.layout).toBe('columns4');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('button', { name: '关闭设置' }).click();
    await expect.poll(checkedLayout).toEqual(['columns4']);
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
