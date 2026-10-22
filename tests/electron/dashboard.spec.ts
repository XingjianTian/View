import { invokeMenu } from './helpers/menu.js';
import { _electron as electron, expect, test } from '@playwright/test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const electronPath = require('electron') as string;

function seededConfig() {
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
    display: { layout: 'grid2x2' as const, asciiMode: 'static' as const, asciiBrightness: 42, asciiStrength: 48, reducedMotion: true },
    window: null,
  };
}

test('dashboard renders four replaceable slots and utility settings', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-dashboard-'));
  await writeFile(path.join(dataRoot, 'config.json'), `${JSON.stringify(seededConfig())}\n`, { encoding: 'utf8', mode: 0o600 });
  const app = await electron.launch({ executablePath: electronPath, args: [root], env: { ...process.env, SERVICE_OBSERVATORY_DATA_DIR: dataRoot } });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.brand-lockup')).toHaveText('「观」Server Observer');
    await expect(page.locator('.app-topbar button')).toHaveCount(0);
    await invokeMenu(app, 'refresh-status');
    await expect(page.locator('.dashboard-grid')).toHaveClass(/layout-grid2x2/);
    await expect(page.locator('.service-panel')).toHaveCount(4);
    await expect(page.locator('.service-panel h2').first()).toHaveText('本机 API');
    await expect(page.locator('.metric')).toHaveCount(12);
    await expect(page.locator('.panel-content-grid')).toHaveCount(4);
    await expect(page.locator('.status-timeline-panel')).toHaveCount(4);
    await expect(page.locator('.detail-button')).toHaveCount(4);
    await expect(page.locator('.detail-button').first()).toHaveAttribute('aria-label', /打开本机 API详情/);
    await expect(page.locator('.cpu-trend')).toHaveCount(0);
    await expect(page.locator('.metric').first()).toContainText('CPU');
    const streamReceipt = await page.evaluate(async () => {
      const received = new Promise<{ batchBytes: number; kind: string }>((resolve) => {
        const remove = window.observatory.onUpdates((update) => {
          const payload = update.payload as { items?: Array<{ kind?: string }> };
          remove();
          resolve({ batchBytes: JSON.stringify(update).length, kind: payload.items?.[0]?.kind ?? 'unknown' });
        });
      });
      const boot = await window.observatory.bootstrap();
      if (!boot.ok) return { batchBytes: -1, kind: 'bootstrap-failed' };
      await window.observatory.subscribeUpdates(boot.value.snapshot.windowEpoch);
      return received;
    });
    expect(streamReceipt.kind).toBe('observations');
    expect(streamReceipt.batchBytes).toBeLessThan(64 * 1024);
    await invokeMenu(app, 'open-settings');
    await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
    await expect(page.locator('.settings-feedback')).toContainText('已刷新本地与远端只读采样');
    await expect(page.getByRole('tab', { name: '容器成员' })).toBeVisible();
    await page.getByRole('button', { name: '面板与布局' }).click();
    await expect(page.getByText('槽位 01')).toBeVisible();
    await expect(page.getByRole('navigation', { name: '整体视图' })).toHaveCount(0);
    await expect(page.getByRole('group', { name: '视图布局' })).toBeVisible();
    await page.getByRole('button', { name: '外观与动效' }).click();
    await expect(page.locator('input[type="range"]')).toHaveCount(2);
    await expect(page.getByRole('checkbox', { name: '减少动态效果' })).toBeVisible();
    await page.getByRole('button', { name: '诊断与关于' }).click();
    await expect(page.getByRole('button', { name: '登记私有 profile' })).toBeVisible();
    await expect(page.getByRole('button', { name: '按当前容器建立六项目录' })).toHaveCount(0);
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('snapshot pages stay bounded for a full service catalog', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-snapshot-page-'));
  const services = Array.from({ length: 128 }, (_, serviceIndex) => ({
    id: `service-${serviceIndex + 1}`,
    name: `服务 ${serviceIndex + 1}`,
    category: '自定义',
    bindings: Array.from({ length: 32 }, (_, bindingIndex) => ({
      id: `binding-${serviceIndex + 1}-${bindingIndex + 1}`,
      deviceId: 'device-1',
      selector: { kind: 'container_id' as const, value: 'a'.repeat(64) },
      required: true,
      expectedPolicy: 'continuous' as const,
    })),
    businessAdapter: { kind: 'none' as const },
  }));
  const config = {
    schemaVersion: 1,
    devices: [{ id: 'device-1', name: '测试设备', transport: 'local' as const, profileId: 'local-profile', enabled: false }],
    services,
    slots: services.slice(0, 4).map((service) => ({ serviceId: service.id, logBindingId: null })) as [{ serviceId: string; logBindingId: null }, { serviceId: string; logBindingId: null }, { serviceId: string; logBindingId: null }, { serviceId: string; logBindingId: null }],
    display: { layout: 'grid2x2' as const, asciiMode: 'static' as const, asciiBrightness: 42, asciiStrength: 48, reducedMotion: true },
    window: null,
  };
  await writeFile(path.join(dataRoot, 'config.json'), `${JSON.stringify(config)}\n`, { encoding: 'utf8', mode: 0o600 });
  const app = await electron.launch({ executablePath: electronPath, args: [root], env: { ...process.env, SERVICE_OBSERVATORY_DATA_DIR: dataRoot } });
  try {
    const page = await app.firstWindow();
    const receipt = await page.evaluate(async () => {
      const boot = await window.observatory.bootstrap();
      if (!boot.ok) return { bootstrapBytes: -1, bootstrapHasMore: false, pageBytes: -1, pageHasMore: false };
      const next = await window.observatory.getSnapshotPage(boot.value.snapshot.windowEpoch, 64, 32);
      return {
        bootstrapBytes: JSON.stringify(boot.value).length,
        bootstrapHasMore: boot.value.snapshot.servicePage.hasMore,
        pageBytes: next.ok ? JSON.stringify(next.value).length : -1,
        pageHasMore: next.ok ? next.value.servicePage.hasMore : false,
      };
    });
    expect(receipt.bootstrapBytes).toBeGreaterThan(0);
    expect(receipt.bootstrapBytes).toBeLessThan(64 * 1024);
    expect(receipt.pageBytes).toBeGreaterThan(0);
    expect(receipt.pageBytes).toBeLessThan(64 * 1024);
    expect(receipt.bootstrapHasMore).toBe(true);
    expect(receipt.pageHasMore).toBe(true);
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('renderer settings loads every long-name multi-member container across bounded pages', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-renderer-pages-'));
  const ids = Array.from({ length: 97 }, (_, index) => (index + 1).toString(16).padStart(64, '0'));
  const fixturePath = path.join(dataRoot, 'docker-fixture.mjs');
  const wrapperPath = path.join(dataRoot, 'docker-fixture');
  const fixture = `
const ids = ${JSON.stringify(ids)};
const sourceAt = '2026-10-20T09:00:00.000Z';
const names = ids.map((_, index) => '/fixture-' + index + '-' + 'x'.repeat(180));
const image = 'image-' + 'y'.repeat(500);
const args = process.argv.slice(2);
const command = args.find((value) => ['version', 'ps', 'inspect', 'stats', 'logs'].includes(value));
const idsAfterFormat = () => {
  const marker = args.indexOf('--format');
  return marker >= 0 ? args.slice(marker + 2) : [];
};
if (command === 'version') {
  process.stdout.write('29.1.3\\n');
} else if (command === 'ps') {
  process.stdout.write(ids.map((id, index) => [id, names[index], image, 'running', 'Up 1 hour', sourceAt, '1 hour', '', 'bridge', 'fixture-project', 'fixture-service', String((index % 3) + 1)].map(JSON.stringify).join('\\t')).join('\\n') + '\\n');
} else if (command === 'inspect') {
  process.stdout.write(idsAfterFormat().map((id) => [id, names[ids.indexOf(id)], image, 'running', 'none', sourceAt, '0001-01-01T00:00:00Z', '0', '0', 'false', 'bridge'].map(JSON.stringify).join('\\t')).join('\\n') + '\\n');
} else if (command === 'stats') {
  process.stdout.write(idsAfterFormat().map((id) => JSON.stringify({ Container: id.slice(0, 12), CPUPerc: '1.0%', MemUsage: '1MiB / 1GiB', NetIO: '1kB / 2kB', PIDs: '1' })).join('\\n') + '\\n');
} else if (command === 'logs') {
  process.stdout.write(sourceAt + ' fixture log\\n');
} else {
  process.exitCode = 2;
}
`;
  await writeFile(fixturePath, fixture, { encoding: 'utf8', mode: 0o600 });
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(wrapperPath, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fixturePath)} "$@"\n`, { encoding: 'utf8', mode: 0o700 });
  await chmod(wrapperPath, 0o700);
  const profilePath = path.join(dataRoot, 'fixture-profile.json');
  await writeFile(profilePath, `${JSON.stringify({ id: 'fixture-profile', kind: 'local', context: 'desktop-linux', dockerPath: wrapperPath })}\n`, { encoding: 'utf8', mode: 0o600 });
  const longServiceName = `长名多成员服务-${'x'.repeat(80)}`;
  const service = {
    id: 'fixture-service',
    name: longServiceName,
    category: '基础设施',
    bindings: [ids[0], ids.at(-1)].map((value, index) => ({
      id: `fixture-binding-${index + 1}`,
      deviceId: 'fixture-device',
      selector: { kind: 'container_id' as const, value },
      required: true,
      expectedPolicy: 'continuous' as const,
    })),
    businessAdapter: { kind: 'none' as const },
  };
  const config = {
    schemaVersion: 1,
    devices: [{ id: 'fixture-device', name: '隔离只读设备', transport: 'local' as const, profileId: 'fixture-profile', enabled: true }],
    services: [service],
    slots: [{ serviceId: service.id, logBindingId: null }, { serviceId: null, logBindingId: null }, { serviceId: null, logBindingId: null }, { serviceId: null, logBindingId: null }],
    display: { layout: 'grid2x2' as const, focusSlot: 1, asciiMode: 'static' as const, asciiBrightness: 30, asciiStrength: 30, reducedMotion: true },
    window: null,
  };
  await writeFile(path.join(dataRoot, 'profiles.private.json'), `${JSON.stringify({ schemaVersion: 1, profiles: [{ id: 'fixture-profile', displayName: '隔离只读设备', kind: 'local', sourcePath: profilePath, importedAt: new Date().toISOString() }] })}\n`, { encoding: 'utf8', mode: 0o600 });
  await writeFile(path.join(dataRoot, 'config.json'), `${JSON.stringify(config)}\n`, { encoding: 'utf8', mode: 0o600 });
  const app = await electron.launch({ executablePath: electronPath, args: [root], env: { ...process.env, SERVICE_OBSERVATORY_DATA_DIR: dataRoot } });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.brand-lockup')).toHaveText('「观」Server Observer');
    await expect(page.locator('.app-topbar button')).toHaveCount(0);
    await invokeMenu(app, 'refresh-status');
    await expect(page.locator('.device-summary')).toContainText('隔离只读设备', { timeout: 30_000 });
    await page.locator('.service-title-button').click();
    const details = page.getByRole('dialog', { name: /长名多成员服务/ });
    await expect(details).toBeVisible();
    await expect(details).toContainText(longServiceName);
    await expect(details).toContainText('/fixture-0-');
    await expect(details.getByRole('button', { name: '关闭详情' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(details).toHaveCount(0);
    await expect(page.locator('.service-title-button')).toBeFocused();
    await invokeMenu(app, 'open-settings');
    await expect(page.locator('.settings-summary')).toContainText('97 个容器', { timeout: 30_000 });
    await page.getByRole('tab', { name: '容器成员' }).click();
    const directory = page.locator('.member-checklist .member-check');
    await expect(directory).toHaveCount(97, { timeout: 30_000 });
    const names = await directory.evaluateAll((labels) => labels.map((label) => label.textContent ?? ''));
    expect(names.some((name) => name.includes('/fixture-0-'))).toBe(true);
    expect(names.some((name) => name.includes('/fixture-96-'))).toBe(true);
    await expect(directory.locator('input:checked')).toHaveCount(2);
    await page.getByRole('button', { name: '面板与布局' }).click();
    await page.getByRole('group', { name: '视图布局' }).getByRole('button', { name: '一大三小' }).click();
    await expect(page.locator('.dashboard-grid')).toHaveClass(/layout-focus/);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('button', { name: '关闭设置' }).click();
    await expect(page.locator('.panel-focus-small-1 h2')).toContainText('长名多成员服务-');
    await expect(page.locator('.panel-focus-small-1 .full-name-button')).toBeVisible();
    await expect(page.locator('.panel-focus-small-1 .metric')).toHaveCount(3);
    await expect(page.locator('.panel-focus-small-1 .panel-content-grid')).toHaveCount(1);
    await expect(page.locator('.panel-focus-small-1 .cpu-trend')).toHaveCount(0);
    await expect(page.locator('.panel-focus-small-1 .metric').first()).toContainText('CPU');
    const smallLog = page.locator('.panel-focus-small-1 .log-viewer');
    await expect(smallLog.locator('.log-controls')).toBeHidden();
    const beforeTools = await smallLog.boundingBox();
    await smallLog.getByRole('button', { name: '打开详细日志', exact: true }).click();
    await expect(smallLog).toHaveClass(/log-expanded/);
    await expect(smallLog).toHaveAttribute('role', 'dialog');
    await expect(smallLog.getByRole('button', { name: '关闭日志' })).toBeVisible();
    await expect(smallLog.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
    await expect(smallLog.getByRole('combobox', { name: '选择日志来源' })).toBeVisible();
    const expandedBox = await smallLog.boundingBox();
    expect(expandedBox!.width).toBeGreaterThan(beforeTools!.width);
    expect(expandedBox!.height).toBeGreaterThan(beforeTools!.height);
    await smallLog.getByRole('button', { name: '关闭日志' }).click();
    await expect(smallLog).not.toHaveClass(/log-expanded/);
    await expect(smallLog.locator('.log-tools-button')).toBeFocused();
    await smallLog.getByRole('button', { name: '打开详细日志', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(smallLog).not.toHaveClass(/log-expanded/);
    await expect(smallLog.locator('.log-tools-button')).toBeFocused();
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
