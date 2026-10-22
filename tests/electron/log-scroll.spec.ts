import { invokeMenu } from './helpers/menu.js';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { StatusPage } from '../../src/shared/status.js';

const root = process.cwd();
const electronPath = require('electron') as string;
const fixtureIds = ['a', 'b', 'c', 'd', 'e'].map((letter) => letter.repeat(64));
const sourceAt = '2026-10-21T09:00:00.000Z';
const ragScopeSummary = '已读60篇：处理完成60；范围未读完';
const ragSourceRef = 'ragflow_documents:fixture-profile:fixture-status';
const layoutLabels = {
  columns4: '四列',
  grid2x2: '四宫格',
  focus: '一大三小',
} as const;

type Layout = keyof typeof layoutLabels;
type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;
type Fixture = {
  dataRoot: string;
  phasePath: string;
  statusServer: Server;
  app: Awaited<ReturnType<typeof electron.launch>>;
  page: Page;
};

const fixedStatusPage: StatusPage = {
  serviceId: 'fixture-service-1',
  records: [
    {
      id: 'fixture-rag-scope',
      serviceId: 'fixture-service-1',
      sourceRef: ragSourceRef,
      taskKey: 'fixture-rag-scope',
      stage: '源范围快照',
      outcome: 'partial',
      summary: ragScopeSummary,
      occurredAt: null,
      sourceAt: null,
      observedAt: sourceAt,
      evidenceKind: 'snapshot_diff',
      facts: {
        reportedDocuments: 60,
        coveredDocuments: 60,
        coverageMissing: 0,
        coveragePercent: 100,
        processingPercent: 100,
        pendingCount: 0,
        processingCount: 0,
        completedCount: 60,
        failedCount: 0,
        cancelledCount: 0,
        unknownCount: 0,
        scanRound: 1,
        scanStartedAt: sourceAt,
        scanEndedAt: null,
        consistency: 'bounded_partial',
        failureCounts: '暂无已核实失败',
        aggregateAuthoritative: false,
        aggregateError: null,
        detailsComplete: false,
      },
      evidenceRef: 'fixture-rag-scope',
    },
    {
      id: 'fixture-rag-dataset-personal',
      serviceId: 'fixture-service-1',
      sourceRef: ragSourceRef,
      taskKey: 'fixture-rag-dataset-personal',
      stage: '数据集范围',
      outcome: 'partial',
      summary: '个人剪藏：总量30；已覆盖30/30；处理完成30，失败0，待处理0，处理中0，取消0，未知0；有界部分读取',
      occurredAt: null,
      sourceAt: sourceAt,
      observedAt: sourceAt,
      evidenceKind: 'snapshot_diff',
      facts: { datasetAlias: '个人剪藏', reportedDocuments: 30, coveredDocuments: 30, coveragePercent: 100, pendingCount: 0, processingCount: 0, completedCount: 30, failedCount: 0, cancelledCount: 0, unknownCount: 0, consistency: 'bounded_partial', failureCounts: '暂无已核实失败' },
      evidenceRef: 'fixture-rag-dataset-personal',
    },
    {
      id: 'fixture-rag-dataset-work',
      serviceId: 'fixture-service-1',
      sourceRef: ragSourceRef,
      taskKey: 'fixture-rag-dataset-work',
      stage: '数据集范围',
      outcome: 'partial',
      summary: '工作知识库：总量30；已覆盖30/30；处理完成30，失败0，待处理0，处理中0，取消0，未知0；有界部分读取',
      occurredAt: null,
      sourceAt: sourceAt,
      observedAt: sourceAt,
      evidenceKind: 'snapshot_diff',
      facts: { datasetAlias: '工作知识库', reportedDocuments: 30, coveredDocuments: 30, coveragePercent: 100, pendingCount: 0, processingCount: 0, completedCount: 30, failedCount: 0, cancelledCount: 0, unknownCount: 0, consistency: 'bounded_partial', failureCounts: '暂无已核实失败' },
      evidenceRef: 'fixture-rag-dataset-work',
    },
    {
      id: 'fixture-rag-document',
      serviceId: 'fixture-service-1',
      sourceRef: ragSourceRef,
      taskKey: 'fixture-rag-scope',
      stage: '报告完成',
      outcome: 'succeeded',
      summary: 'RAGFlow文档 01234567 · 工作知识库：报告完成（100%）',
      occurredAt: null,
      sourceAt: '2026-10-20T23:59:59.000Z',
      observedAt: sourceAt,
      evidenceKind: 'stage_receipt',
      facts: { completed: 60, total: 60, status: 'succeeded' },
      evidenceRef: 'fixture-rag-document',
    },
  ],
  nextCursor: null,
  hasMore: false,
  feeds: [{
    sourceRef: ragSourceRef,
    health: 'fresh',
    lastSuccessAt: sourceAt,
    observedAt: sourceAt,
    cursor: null,
    hasMore: false,
    gap: false,
    errorCode: null,
  }],
};

async function installStatusPageGate(app: ElectronApp): Promise<void> {
  await app.evaluate(({ ipcMain }, page) => {
    const target = ipcMain as unknown as { _invokeHandlers?: Map<string, (event: unknown, args: unknown) => Promise<unknown>> };
    const original = target._invokeHandlers?.get('status:get-page');
    if (!target._invokeHandlers || !original) throw new Error('status:get-page handler missing');
    const gate = { original, requests: 0 };
    (globalThis as unknown as { __logStatusPageGate: typeof gate }).__logStatusPageGate = gate;
    target._invokeHandlers.set('status:get-page', async (_event, args) => {
      gate.requests += 1;
      const payload = (args as { payload?: { serviceId?: string } } | undefined)?.payload;
      const serviceId = payload?.serviceId;
      if (!serviceId) return { ok: false, error: { code: 'invalid_request', message: '测试状态请求缺少服务 ID。' } };
      return {
        ok: true,
        value: {
          ...page,
          serviceId,
          records: page.records.map((record) => ({ ...record, serviceId })),
        },
      };
    });
  }, fixedStatusPage);
}

async function statusPageGateRequests(app: ElectronApp): Promise<number> {
  return app.evaluate(() => (globalThis as unknown as { __logStatusPageGate: { requests: number } }).__logStatusPageGate.requests);
}

async function restoreStatusPageGate(app: ElectronApp): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const target = ipcMain as unknown as { _invokeHandlers?: Map<string, (event: unknown, args: unknown) => Promise<unknown>> };
    const gate = (globalThis as unknown as { __logStatusPageGate?: { original: (event: unknown, args: unknown) => Promise<unknown> } }).__logStatusPageGate;
    if (target._invokeHandlers && gate) target._invokeHandlers.set('status:get-page', gate.original);
    delete (globalThis as unknown as { __logStatusPageGate?: unknown }).__logStatusPageGate;
  });
}

type ScrollMeasurement = {
  layout: Layout;
  viewport: { width: number; height: number };
  logs: Array<{
    box: { top: number; bottom: number; height: number };
    clip: { top: number; bottom: number; height: number };
    panel: { top: number; bottom: number; height: number; children: Array<{ className: string; top: number; bottom: number; height: number; text: string }> };
    clientWidth: number;
    clientHeight: number;
    paddingTop: number;
    paddingBottom: number;
    contentHeight: number;
    lineHeight: number;
    failurePromptVisible: boolean;
    scrollWidth: number;
    scrollHeight: number;
    scrollTop: number;
    status: {
      headlineVisible: boolean;
      recentGroupVisible: boolean;
      headlineText: string;
      recentSummary: string;
      headlineFontSize: number;
      recentSummaryFontSize: number;
      clientHeight: number;
      scrollHeight: number;
      rect: { top: number; bottom: number; height: number };
      headlineRect: { top: number; bottom: number; height: number } | null;
      recentGroupRect: { top: number; bottom: number; height: number } | null;
    };
    visualLineCount: number;
    visibleCompleteVisualLines: number;
    rowCount: number;
    partiallyVisibleVisualLines: number;
  }>;
};

function seededConfig() {
  const services = ['论文下载', '知识库任务', '后台任务', '基础设施'].map((name, index) => ({
    id: `fixture-service-${index + 1}`,
    name,
    category: index === 0 ? '论文下载' : index === 1 ? '知识库' : index === 2 ? '后台任务' : '基础设施',
    bindings: [
      {
        id: `fixture-binding-${index + 1}`,
        deviceId: 'fixture-device',
        selector: { kind: 'container_id' as const, value: fixtureIds[index] as string },
        required: true,
        expectedPolicy: 'continuous' as const,
      },
      ...(index === 0 ? [{
        id: 'fixture-binding-1-alt',
        deviceId: 'fixture-device',
        selector: { kind: 'container_id' as const, value: fixtureIds[4] as string },
        required: true,
        expectedPolicy: 'continuous' as const,
      }] : []),
    ],
    businessAdapter: { kind: 'none' as const },
    statusAdapter: { kind: 'http_json' as const, profileId: 'fixture-profile', endpointRef: 'fixture-status', mapping: {} },
  }));
  return {
    schemaVersion: 1,
    devices: [{ id: 'fixture-device', name: '隔离日志设备', transport: 'local' as const, profileId: 'fixture-profile', enabled: true }],
    services,
    slots: services.map((service) => ({ serviceId: service.id, logBindingId: null })) as [{ serviceId: string; logBindingId: null }, { serviceId: string; logBindingId: null }, { serviceId: string; logBindingId: null }, { serviceId: string; logBindingId: null }],
    display: { layout: 'grid2x2' as const, focusSlot: 0, asciiMode: 'off' as const, asciiBrightness: 50, asciiStrength: 50, reducedMotion: true },
    window: null,
  };
}

function fixtureSource(phasePath: string): string {
  return `
const fs = require('node:fs');
const ids = ${JSON.stringify(fixtureIds)};
const sourceAt = ${JSON.stringify(sourceAt)};
const phasePath = ${JSON.stringify(phasePath)};
const args = process.argv.slice(2);
const command = args.find((value) => ['version', 'ps', 'inspect', 'stats', 'logs'].includes(value));
const idsAfterFormat = () => {
  const marker = args.indexOf('--format');
  return marker >= 0 ? args.slice(marker + 2) : [];
};
const stamp = (index) => new Date(Date.parse(sourceAt) + index * 1000).toISOString();
const line = (index, message) => stamp(index) + ' ' + (message ?? 'fixture-log-' + index);
const baseLines = () => {
  const ansi = String.fromCharCode(27);
  const json = JSON.stringify({ kind: '中文无空格JSON', message: '论文下载进度'.repeat(240), payload: { stage: '已读取', count: 17 } });
  return Array.from({ length: 48 }, (_, index) => {
    if (index === 42) return line(index, json);
    if (index === 43) return line(index, '多行首行：服务正在处理');
    if (index === 44) return '多行续行：没有时间戳的续行内容';
    if (index === 45) return line(index, ansi + '[32m回车ANSI颜色' + ansi + '[0m');
    return line(index);
  });
};
const phase = Number.parseInt(fs.readFileSync(phasePath, 'utf8').trim() || '0', 10);
const lines = baseLines();
if (phase >= 1) lines.push(...Array.from({ length: 10 }, (_, index) => line(100 + index, 'phase1-append-' + index)));
if (phase >= 2) lines.push(...Array.from({ length: 10 }, (_, index) => line(200 + index, 'phase2-append-' + index)));
if (phase >= 3) {
  lines.push(...Array.from({ length: 640 }, (_, index) => {
    if (index === 5) return line(1000 + index, '淘汰缺口前的超长行：' + 'x'.repeat(17 * 1024));
    return line(1000 + index, 'phase3-append-' + index);
  }));
}
if (phase >= 4) lines.push(...Array.from({ length: 10 }, (_, index) => line(2000 + index, 'phase4-append-' + index)));
if (command === 'version') {
  process.stdout.write('29.1.3\\n');
} else if (command === 'ps') {
  process.stdout.write(ids.map((id, index) => [id, '/wp017-fixture-' + (index + 1), 'fixture:latest', 'running', 'Up 1 hour', sourceAt, '1 hour', '', 'bridge', 'wp017-fixture', 'service-' + (index + 1), '1'].map(JSON.stringify).join('\\t')).join('\\n') + '\\n');
} else if (command === 'inspect') {
  process.stdout.write(idsAfterFormat().map((id) => {
    const index = ids.indexOf(id);
    return [id, '/wp017-fixture-' + (index + 1), 'fixture:latest', 'running', 'healthy', sourceAt, '0001-01-01T00:00:00Z', '0', '0', 'false', 'bridge'].map(JSON.stringify).join('\\t');
  }).join('\\n') + '\\n');
} else if (command === 'stats') {
  process.stdout.write(idsAfterFormat().map((id) => JSON.stringify({ Container: id.slice(0, 12), CPUPerc: '1.0%', MemUsage: '1MiB / 1GiB', NetIO: '1kB / 2kB', PIDs: '1' })).join('\\n') + '\\n');
} else if (command === 'logs') {
  process.stdout.write(lines.join('\\r\\n') + '\\r\\n');
} else {
  process.exitCode = 2;
}
`;
}

async function launchFixture(): Promise<Fixture> {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-log-scroll-'));
  const fixturePath = path.join(dataRoot, 'docker-fixture.cjs');
  const wrapperPath = path.join(dataRoot, 'docker-fixture');
  const profilePath = path.join(dataRoot, 'fixture-profile.json');
  const phasePath = path.join(dataRoot, 'log-phase.txt');
  await writeFile(phasePath, '0\n', { encoding: 'utf8', mode: 0o600 });
  await writeFile(fixturePath, fixtureSource(phasePath), { encoding: 'utf8', mode: 0o600 });
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(wrapperPath, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fixturePath)} "$@"\n`, { encoding: 'utf8', mode: 0o700 });
  await chmod(wrapperPath, 0o700);
  const statusServer = createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify([
      { id: 'fixture-rag-scope', taskKey: 'fixture-rag-scope', stage: '源范围快照', outcome: 'partial', occurredAt: null, sourceAt: null, evidenceKind: 'snapshot_diff', evidenceRef: 'fixture-rag-scope', summary: ragScopeSummary, facts: { datasetScope: '个人剪藏、工作知识库', datasetCount: 2, reportedDocuments: 60, recentDocuments: 60, pendingCount: 0, processingCount: 0, completedCount: 60, failedCount: 0, cancelledCount: 0, unknownCount: 0, hasMore: true, incomplete: true, completed: 60, total: 60, observed: 60, required: 60, partial: true, status: 'partial', sourceStatus: 'partial' } },
      { id: 'fixture-rag-document', taskKey: 'fixture-rag-scope', stage: '报告完成', outcome: 'succeeded', occurredAt: '2026-10-20T23:59:59.000Z', sourceAt: '2026-10-20T23:59:59.000Z', evidenceKind: 'stage_receipt', evidenceRef: 'fixture-rag-document', summary: 'RAGFlow文档 01234567 · 工作知识库：报告完成（100%）', facts: { completed: 60, total: 60, status: 'succeeded' } },
    ]));
  });
  await new Promise<void>((resolve, reject) => {
    statusServer.once('error', reject);
    statusServer.listen(0, '127.0.0.1', () => resolve());
  });
  const statusAddress = statusServer.address();
  if (!statusAddress || typeof statusAddress === 'string') throw new Error('fixture status endpoint did not expose a port');
  const statusEndpoint = `http://127.0.0.1:${statusAddress.port}/fixture-status`;
  await writeFile(profilePath, `${JSON.stringify({ id: 'fixture-profile', kind: 'local', context: 'desktop-linux', dockerPath: wrapperPath, statusEndpoints: { 'fixture-status': statusEndpoint } })}\n`, { encoding: 'utf8', mode: 0o600 });
  await writeFile(path.join(dataRoot, 'profiles.private.json'), `${JSON.stringify({ schemaVersion: 1, profiles: [{ id: 'fixture-profile', displayName: '隔离日志设备', kind: 'local', sourcePath: profilePath, importedAt: new Date().toISOString() }] })}\n`, { encoding: 'utf8', mode: 0o600 });
  await writeFile(path.join(dataRoot, 'config.json'), `${JSON.stringify(seededConfig())}\n`, { encoding: 'utf8', mode: 0o600 });
  const app = await electron.launch({ executablePath: electronPath, args: [root], env: { ...process.env, SERVICE_OBSERVATORY_DATA_DIR: dataRoot } });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await installStatusPageGate(app);
  return { dataRoot, phasePath, statusServer, app, page };
}

async function setLayout(app: ElectronApp, page: Page, layout: Layout): Promise<void> {
  await invokeMenu(app, 'open-settings');
  await page.getByRole('button', { name: '面板与布局' }).click();
  await page.getByRole('group', { name: '视图布局' }).getByRole('button', { name: layoutLabels[layout] }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: '关闭设置' }).click();
  await expect(page.locator('.dashboard-grid')).toHaveClass(new RegExp(`layout-${layout}`));
}

async function measureLogs(page: Page, layout: Layout): Promise<ScrollMeasurement> {
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const logs = await page.locator('.log-lines').evaluateAll((nodes) => nodes.map((node) => {
    const element = node as HTMLElement;
    const rect = element.getBoundingClientRect();
    let clip = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    let ancestor = element.parentElement;
    while (ancestor) {
      const ancestorRect = ancestor.getBoundingClientRect();
      const style = getComputedStyle(ancestor);
      const clipsX = ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX);
      const clipsY = ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY);
      if (clipsX) {
        clip.left = Math.max(clip.left, ancestorRect.left);
        clip.right = Math.min(clip.right, ancestorRect.right);
      }
      if (clipsY) {
        clip.top = Math.max(clip.top, ancestorRect.top);
        clip.bottom = Math.min(clip.bottom, ancestorRect.bottom);
      }
      ancestor = ancestor.parentElement;
    }
    const rows = [...element.querySelectorAll<HTMLElement>('.log-line')];
    const computedStyle = getComputedStyle(element);
    const paddingTop = Number.parseFloat(computedStyle.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(computedStyle.paddingBottom) || 0;
    const lineHeight = Number.parseFloat(computedStyle.lineHeight) || 0;
    const logViewer = element.closest<HTMLElement>('.log-viewer');
    const failurePromptVisible = !!logViewer?.classList.contains('log-error')
      || !!logViewer?.querySelector('.log-state[role="status"]');
    const panel = element.closest<HTMLElement>('.service-panel');
    const statusTimeline = panel?.querySelector<HTMLElement>('.status-timeline');
    const statusRect = statusTimeline?.getBoundingClientRect();
    const panelItems = statusTimeline ? [...statusTimeline.querySelectorAll<HTMLElement>('.status-panel-item')] : [];
    const statusHeadline = panelItems[0] ?? null;
    const recentGroup = panelItems[0] ?? null;
    const statusHeadlineText = statusHeadline?.querySelector<HTMLElement>('.status-panel-copy strong');
    const recentSummaryText = recentGroup?.querySelector<HTMLElement>('.status-panel-copy strong');
    const visibleInStatus = (target: HTMLElement | null, rect: DOMRect | undefined) => {
      if (!target || !rect) return false;
      const targetRect = target.getBoundingClientRect();
      return targetRect.height > 0
        && targetRect.top >= rect.top - 0.5
        && targetRect.bottom <= rect.bottom + 0.5;
    };
    const visualRects = rows.flatMap((row) => {
      const message = row.querySelector<HTMLElement>('span:last-child') ?? row;
      const range = document.createRange();
      range.selectNodeContents(message);
      const unique = new Map<string, DOMRect>();
      for (const rect of [...range.getClientRects()]) {
        const key = `${Math.round(rect.top * 10) / 10}:${Math.round(rect.bottom * 10) / 10}:${Math.round(rect.left * 10) / 10}`;
        unique.set(key, rect);
      }
      return [...unique.values()];
    });
    const completeVisualLines = visualRects.filter((lineRect) => {
      const visibleWidth = Math.min(lineRect.right, clip.right) - Math.max(lineRect.left, clip.left);
      const visibleHeight = Math.min(lineRect.bottom, clip.bottom) - Math.max(lineRect.top, clip.top);
      return visibleWidth > 1 && visibleHeight >= lineRect.height - 0.5;
    });
    const partiallyVisibleVisualLines = visualRects.filter((lineRect) => {
      const visibleWidth = Math.min(lineRect.right, clip.right) - Math.max(lineRect.left, clip.left);
      const visibleHeight = Math.min(lineRect.bottom, clip.bottom) - Math.max(lineRect.top, clip.top);
      return visibleWidth > 1 && visibleHeight > 0 && visibleHeight < lineRect.height - 0.5;
    });
    return {
      box: { top: rect.top, bottom: rect.bottom, height: rect.height },
      clip: { top: clip.top, bottom: clip.bottom, height: Math.max(0, clip.bottom - clip.top) },
      panel: panel ? {
        top: panel.getBoundingClientRect().top,
        bottom: panel.getBoundingClientRect().bottom,
        height: panel.getBoundingClientRect().height,
        children: [...panel.children].map((child) => {
          const childRect = (child as HTMLElement).getBoundingClientRect();
          return { className: (child as HTMLElement).className.toString(), top: childRect.top, bottom: childRect.bottom, height: childRect.height, text: (child.textContent ?? '').trim().slice(0, 160) };
        }),
      } : { top: 0, bottom: 0, height: 0, children: [] },
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
      paddingTop,
      paddingBottom,
      contentHeight: Math.max(0, element.clientHeight - paddingTop - paddingBottom),
      lineHeight,
      failurePromptVisible,
      scrollWidth: element.scrollWidth,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
      status: {
        headlineVisible: visibleInStatus(statusHeadline ?? null, statusRect),
        recentGroupVisible: visibleInStatus(recentGroup ?? null, statusRect),
        headlineText: statusHeadline?.textContent?.trim() ?? '',
        recentSummary: recentSummaryText?.textContent?.trim() ?? '',
        headlineFontSize: statusHeadlineText ? Number.parseFloat(getComputedStyle(statusHeadlineText).fontSize) : 0,
        recentSummaryFontSize: recentSummaryText ? Number.parseFloat(getComputedStyle(recentSummaryText).fontSize) : 0,
        clientHeight: statusTimeline?.clientHeight ?? 0,
        scrollHeight: statusTimeline?.scrollHeight ?? 0,
        rect: statusRect ? { top: statusRect.top, bottom: statusRect.bottom, height: statusRect.height } : { top: 0, bottom: 0, height: 0 },
        headlineRect: statusHeadline ? (() => { const value = statusHeadline.getBoundingClientRect(); return { top: value.top, bottom: value.bottom, height: value.height }; })() : null,
        recentGroupRect: recentGroup ? (() => { const value = recentGroup.getBoundingClientRect(); return { top: value.top, bottom: value.bottom, height: value.height }; })() : null,
      },
      visualLineCount: visualRects.length,
      visibleCompleteVisualLines: completeVisualLines.length,
      rowCount: rows.length,
      partiallyVisibleVisualLines: partiallyVisibleVisualLines.length,
    };
  }));
  return { layout, viewport, logs };
}

async function writeReceiptScreenshot(page: Page, label: string): Promise<string | null> {
  const outputDir = '/tmp/service-observatory-log-scroll-receipts';
  await mkdir(outputDir, { recursive: true });
  const screenshotPath = path.join(outputDir, `${Date.now()}-${label}.png`);
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return screenshotPath;
  } catch {
    return null;
  }
}

async function writeUiEvidenceScreenshots(app: ElectronApp, page: Page): Promise<string[]> {
  const outputDir = path.join(root, '.ai-bridge', 'evidence', 'ui-refinement');
  await mkdir(outputDir, { recursive: true });
  const viewports = [
    { width: 1280, height: 740, label: '1280x740' },
    { width: 1280, height: 800, label: '1280x800' },
    { width: 1920, height: 1080, label: '1920x1080' },
  ];
  const screenshots: string[] = [];
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const layout of ['columns4', 'grid2x2', 'focus'] as const) {
      await setLayout(app, page, layout);
      const screenshotPath = path.join(outputDir, `${viewport.label}-${layout}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });
      screenshots.push(screenshotPath);
      if (viewport.width === 1280 && viewport.height === 740 && layout === 'focus') {
        const logViewer = page.locator('.service-panel').first().locator('.log-viewer');
        if (!(await logViewer.evaluate((node) => node.classList.contains('log-expanded')))) await logViewer.locator('.log-tools-button').click();
        const toolsScreenshotPath = path.join(outputDir, `${viewport.label}-${layout}-tools-open.png`);
        await page.screenshot({ path: toolsScreenshotPath, fullPage: false });
        screenshots.push(toolsScreenshotPath);
        await logViewer.locator('.log-close-button').click();
      }
    }
  }
  return screenshots;
}

test('isolated log stream exposes wrap, scroll anchor, eviction gap, and layout resize behavior', async () => {
  test.setTimeout(90_000);
  const fixture = await launchFixture();
  const failures: string[] = [];
  const receipt: {
    fixtureMode: 'isolated_fixture';
    timeoutMs: number;
    startedAt: string;
    layouts: ScrollMeasurement[];
    interactions: Record<string, unknown>;
    failures: string[];
    finishedAt?: string;
    screenshot?: string | null;
  } = {
    fixtureMode: 'isolated_fixture',
    timeoutMs: 90_000,
    startedAt: new Date().toISOString(),
    layouts: [],
    interactions: {},
    failures,
  };
  const check = async (label: string, callback: () => Promise<void> | void) => {
    try {
      await callback();
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  try {
    const { page, phasePath } = fixture;
    await expect(page.locator('.device-summary').first()).toContainText('隔离日志设备', { timeout: 20_000 });
    const logLines = page.locator('.service-panel').first().locator('.log-lines');
    await expect.poll(async () => await logLines.locator('.log-line').count(), { timeout: 15_000 }).toBeGreaterThan(10);
    const statusTimeline = page.locator('.service-panel').first().locator('.status-timeline');
    await expect.poll(async () => await statusTimeline.locator('.status-panel-item').count(), { timeout: 15_000 }).toBeGreaterThan(0);
    await expect(statusTimeline.locator('.status-headline-details')).toHaveCount(0);
    await expect(statusTimeline.locator('.status-panel-items')).toContainText('个人剪藏');
    await expect(statusTimeline.locator('.status-panel-items')).toContainText('工作知识库');
    await expect(statusTimeline.locator('.status-panel-items')).toContainText('30');
    await expect.poll(async () => await page.evaluate(async () => {
      const boot = await window.observatory.bootstrap();
      if (!boot.ok) return false;
      const snapshot = await window.observatory.getSnapshot(boot.value.snapshot.windowEpoch);
      if (!snapshot.ok) return false;
      const device = snapshot.value.observation.devices[0];
      const service = snapshot.value.observation.services[0];
      return device?.complete === true && service?.coverage.observed === service?.coverage.required;
    }), { timeout: 20_000 }).toBe(true);

    const initialPanelText = await page.locator('.service-panel').first().innerText();
    expect(initialPanelText).toContain('个人剪藏：完成 30');
    expect(initialPanelText).toContain('工作知识库：完成 30');
    expect(initialPanelText).not.toContain(ragScopeSummary);
    const initialLogText = await logLines.innerText();
    expect(initialLogText).toContain('中文无空格JSON');
    expect(initialLogText).toContain('多行首行');
    expect(initialLogText).toContain('多行续行');
    expect(initialLogText).toContain('回车ANSI颜色');
    expect(initialLogText).not.toContain('\u001b');
    expect(await statusPageGateRequests(fixture.app)).toBeGreaterThan(0);
    receipt.interactions.initialMessages = { containsChineseJson: true, containsMultilineContinuation: true, ansiStripped: true };
    receipt.interactions.statusIpcMock = { requests: await statusPageGateRequests(fixture.app), rawSummaryLength: ragScopeSummary.length, rawSummaryVisible: true };

    const firstLogViewer = page.locator('.service-panel').first().locator('.log-viewer');
    await firstLogViewer.getByRole('button', { name: '打开详细日志', exact: true }).click();
    await expect(firstLogViewer.getByRole('combobox', { name: '选择日志来源' })).toBeVisible();
    await firstLogViewer.getByRole('combobox', { name: '选择日志来源' }).selectOption('fixture-binding-1-alt');
    await expect(firstLogViewer.getByRole('button', { name: '关闭日志' })).toBeVisible();
    await expect(firstLogViewer.getByRole('combobox', { name: '选择日志来源' })).toHaveValue('fixture-binding-1-alt');
    await expect.poll(async () => await firstLogViewer.locator('.log-lines').innerText(), { timeout: 12_000 }).toContain('中文无空格JSON');
    await firstLogViewer.getByRole('combobox', { name: '选择日志来源' }).selectOption('fixture-binding-1');
    await expect(firstLogViewer.getByRole('button', { name: '关闭日志' })).toBeVisible();
    await expect(firstLogViewer.getByRole('combobox', { name: '选择日志来源' })).toHaveValue('fixture-binding-1');
    await expect(firstLogViewer).toHaveClass(/log-expanded/);
    await firstLogViewer.locator('.log-close-button').click();
    receipt.interactions.sourceSwitch = { switchedTo: 'fixture-binding-1-alt', restoredTo: 'fixture-binding-1' };

    for (const layout of ['columns4', 'grid2x2', 'focus'] as const) {
      await check(`${layout} layout transition`, async () => {
        await setLayout(fixture.app, page, layout);
        const measurement = await measureLogs(page, layout);
        receipt.layouts.push(measurement);
        expect(measurement.logs).toHaveLength(4);
        for (const log of measurement.logs) {
          expect(log.visibleCompleteVisualLines, `${layout} must retain three complete visual log baselines`).toBeGreaterThanOrEqual(3);
          if (log.failurePromptVisible) {
            expect(log.contentHeight, `${layout} failure prompt must reserve three complete baselines after padding`).toBeGreaterThanOrEqual(log.lineHeight * 3 - 0.5);
          }
          expect(log.scrollWidth, `${layout} must not horizontally overflow the log viewport`).toBeLessThanOrEqual(log.clientWidth + 1);
          expect(log.status.headlineVisible, `${layout} must keep the status headline visible`).toBe(true);
          expect(log.status.recentGroupVisible, `${layout} must keep the latest business record visible`).toBe(true);
          expect(log.status.headlineText, `${layout} must expose an independent RAG dataset summary in the panel`).toMatch(/个人剪藏|工作知识库/);
          expect(log.status.headlineText, `${layout} must not promote an untrusted aggregate scope`).not.toContain(ragScopeSummary);
          expect(log.status.recentSummary, `${layout} must keep a business record in the list`).toMatch(/个人剪藏|工作知识库|论文下载|Quant/);
          expect(log.status.recentSummary, `${layout} must remove the duplicated scope overview from the list`).not.toBe(ragScopeSummary);
          expect(log.status.headlineFontSize, `${layout} status headline text must remain at least 14px`).toBeGreaterThanOrEqual(14);
          expect(log.status.recentSummaryFontSize, `${layout} status record text must remain at least 14px`).toBeGreaterThanOrEqual(14);
          receipt.interactions.statusFixture = {
            source: 'isolated_ipc_status_page_mock',
            rawSummaryLength: ragScopeSummary.length,
            rawSummary: ragScopeSummary,
            renderedHeadline: log.status.headlineText,
            renderedHeadlineLength: log.status.headlineText.length,
            renderedRecentGroup: log.status.recentSummary,
          };
        }

        try {
          await page.evaluate(() => {
            document.querySelectorAll<HTMLElement>('.log-viewer').forEach((viewer) => {
              viewer.dataset.logGeometryError = viewer.classList.contains('log-error') ? 'existing' : 'added';
              viewer.classList.add('log-error');
              viewer.querySelector<HTMLElement>('.log-toolbar')?.insertAdjacentHTML('beforeend', '<span class="log-state" data-log-geometry-prompt="current">当前失败：UI几何夹具</span><span class="log-state" data-log-geometry-prompt="recent" role="status">最近失败：UI几何夹具</span>');
            });
          });
          const failureMeasurement = await measureLogs(page, layout);
          expect(failureMeasurement.logs).toHaveLength(4);
          for (const log of failureMeasurement.logs) {
            expect(log.failurePromptVisible, `${layout} geometry fixture must expose a failure prompt`).toBe(true);
            expect(log.contentHeight, `${layout} failure fixture must reserve three complete baselines after padding`).toBeGreaterThanOrEqual(log.lineHeight * 3 - 0.5);
            expect(log.visibleCompleteVisualLines, `${layout} failure fixture must keep three complete visual log baselines`).toBeGreaterThanOrEqual(3);
            expect(log.scrollWidth, `${layout} failure fixture must not horizontally overflow`).toBeLessThanOrEqual(log.clientWidth + 1);
            expect(log.status.headlineVisible && log.status.recentGroupVisible, `${layout} failure fixture must keep status evidence visible`).toBe(true);
          }
        } finally {
          await page.evaluate(() => {
            document.querySelectorAll<HTMLElement>('[data-log-geometry-prompt]').forEach((node) => node.remove());
            document.querySelectorAll<HTMLElement>('[data-log-geometry-error]').forEach((viewer) => {
              if (viewer.dataset.logGeometryError === 'added') viewer.classList.remove('log-error');
              delete viewer.dataset.logGeometryError;
            });
          });
        }
      });
    }

    await setLayout(fixture.app, page, 'grid2x2');
    await logLines.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    const beforeBottom = await logLines.evaluate((node) => ({ scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }));
    await writeFile(phasePath, '1\n', { encoding: 'utf8', mode: 0o600 });
    await expect.poll(async () => await logLines.innerText(), { timeout: 12_000 }).toContain('phase1-append-9');
    const afterBottom = await logLines.evaluate((node) => ({ scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, distance: node.scrollHeight - node.clientHeight - node.scrollTop }));
    receipt.interactions.nearBottom = { before: beforeBottom, after: afterBottom };
    await check('near-bottom follows appended entries', () => expect(afterBottom.distance).toBeLessThanOrEqual(8));

    await logLines.evaluate((node) => { node.scrollTop = 0; });
    const anchorBefore = await logLines.evaluate((node) => {
      const rootRect = node.getBoundingClientRect();
      const row = [...node.querySelectorAll<HTMLElement>('.log-line')].find((candidate) => candidate.getBoundingClientRect().top >= rootRect.top + 1);
      if (!row) return null;
      return { text: row.textContent ?? '', top: row.getBoundingClientRect().top - rootRect.top };
    });
    await writeFile(phasePath, '2\n', { encoding: 'utf8', mode: 0o600 });
    await expect.poll(async () => await logLines.innerText(), { timeout: 12_000 }).toContain('phase2-append-9');
    const anchorAfter = await logLines.evaluate((node, before) => {
      const rootRect = node.getBoundingClientRect();
      const row = [...node.querySelectorAll<HTMLElement>('.log-line')].find((candidate) => (candidate.textContent ?? '') === before?.text);
      return row ? { text: row.textContent ?? '', top: row.getBoundingClientRect().top - rootRect.top } : null;
    }, anchorBefore);
    receipt.interactions.anchor = { before: anchorBefore, after: anchorAfter };
    await check('scrolled-up view preserves stable entry anchor', () => {
      expect(anchorBefore).not.toBeNull();
      expect(anchorAfter?.text).toBe(anchorBefore?.text);
      expect(Math.abs((anchorAfter?.top ?? 0) - (anchorBefore?.top ?? 0))).toBeLessThanOrEqual(8);
    });

    const logViewer = page.locator('.service-panel').first().locator('.log-viewer');
    await logViewer.getByRole('button', { name: '打开详细日志', exact: true }).click();
    await expect(logViewer.locator('.log-controls')).toBeVisible();
    await logViewer.getByRole('button', { name: '暂停' }).click();
    await expect(logViewer).toHaveClass(/log-paused/);
    const pausedRows = await logLines.locator('.log-line').count();
    await writeFile(phasePath, '3\n', { encoding: 'utf8', mode: 0o600 });
    await expect.poll(async () => await page.evaluate(async (containerId) => {
      const boot = await window.observatory.bootstrap();
      if (!boot.ok) return false;
      const snapshot = await window.observatory.getSnapshot(boot.value.snapshot.windowEpoch);
      if (!snapshot.ok) return false;
      return snapshot.value.observation.logs
        .find((log) => log.containerId === containerId)
        ?.entries.some((entry) => entry.message.includes('phase3-append-636')) ?? false;
    }, fixtureIds[0]), { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => await logViewer.locator('.new-count').count(), { timeout: 12_000 }).toBe(1);
    const pausedUnread = await logViewer.locator('.new-count').innerText();
    await page.waitForTimeout(5_000);
    const pausedUnreadAfter = await logViewer.locator('.new-count').innerText();
    expect(pausedUnreadAfter).toBe(pausedUnread);
    const pausedRowsAfter = await logLines.locator('.log-line').count();
    expect(pausedRowsAfter).toBe(pausedRows);
    await logViewer.getByRole('textbox', { name: '搜索日志' }).fill('phase3-append-');
    await logViewer.getByRole('button', { name: '查找' }).click();
    await expect(logViewer).toHaveClass(/log-filtered/);
    expect(await logLines.innerText()).toContain('phase3-append-');
    await logViewer.getByRole('button', { name: '清除筛选' }).click();
    await expect(logViewer).not.toHaveClass(/log-filtered/);
    await logViewer.getByRole('button', { name: '继续' }).click();
    await expect(logViewer).not.toHaveClass(/log-paused/);
    receipt.interactions.pauseSearchClear = { pausedRows, pausedRowsAfter, pausedUnread, pausedUnreadAfter, searchCleared: true };

    const epochResult = await page.evaluate(async (containerId) => {
      const boot = await window.observatory.bootstrap();
      if (!boot.ok) throw new Error(boot.error.message);
      const snapshot = await window.observatory.getSnapshot(boot.value.snapshot.windowEpoch);
      if (!snapshot.ok) throw new Error(snapshot.error.message);
      return {
        gap: snapshot.value.observation.logs.find((log) => log.containerId === containerId)?.gap ?? null,
        entries: snapshot.value.observation.logs.find((log) => log.containerId === containerId)?.entries.length ?? null,
      };
    }, fixtureIds[0]);
    receipt.interactions.evictionGap = epochResult;
    await check('oversized and bounded fixture output reports an eviction gap', () => {
      expect(epochResult.gap).toBeGreaterThan(0);
      expect(epochResult.entries).toBeLessThanOrEqual(100);
    });

    await expect(logViewer).toHaveClass(/log-expanded/);
    await expect(logViewer).toHaveClass(/log-expanded/);
    const expandedHeight = await logLines.evaluate((node) => node.getBoundingClientRect().height);
    await logViewer.getByRole('button', { name: '关闭日志' }).click();
    await expect(logViewer).not.toHaveClass(/log-expanded/);
    const collapsedHeight = await logLines.evaluate((node) => node.getBoundingClientRect().height);
    receipt.interactions.expandCollapse = { expandedHeight, collapsedHeight };
    await check('expand/collapse keeps a measurable log area', () => expect(expandedHeight).toBeGreaterThan(collapsedHeight));

    await logLines.evaluate((node) => { node.scrollTop = 0; });
    await writeFile(phasePath, '4\n', { encoding: 'utf8', mode: 0o600 });
    await expect.poll(async () => await logLines.innerText(), { timeout: 12_000 }).toContain('phase4-append-9');
    await expect(logViewer.locator('.new-count')).toHaveCount(1);
    await expect(logViewer).not.toHaveClass(/log-expanded/);
    await page.setViewportSize({ width: 980, height: 740 });
    const resized = await measureLogs(page, 'grid2x2');
    receipt.interactions.resize = resized;
    await check('resized layout keeps four panels and three log baselines', () => {
      expect(resized.logs).toHaveLength(4);
      expect(resized.logs.every((log) => log.visibleCompleteVisualLines >= 3)).toBe(true);
      expect(resized.logs.every((log) => !log.failurePromptVisible || log.contentHeight >= log.lineHeight * 3 - 0.5)).toBe(true);
    });

    await check('renderer exposes an explicit return-to-latest action', async () => {
      await expect(logViewer.getByRole('button', { name: '回到最新' })).toBeVisible();
      await logViewer.getByRole('button', { name: '回到最新' }).click();
      await expect.poll(async () => logLines.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThanOrEqual(8);
    });

    await page.setViewportSize({ width: 1920, height: 1080 });
    const emulated1920Layouts: ScrollMeasurement[] = [];
    for (const layout of ['columns4', 'grid2x2', 'focus'] as const) {
      await setLayout(fixture.app, page, layout);
      emulated1920Layouts.push(await measureLogs(page, layout));
    }
    receipt.interactions.emulatedRenderer1920 = { mode: 'emulated_renderer', measurements: emulated1920Layouts };
    await check('emulated 1920 renderer keeps all layouts and three log baselines', () => {
      expect(emulated1920Layouts).toHaveLength(3);
      for (const measurement of emulated1920Layouts) {
        expect(measurement.logs).toHaveLength(4);
        expect(measurement.logs.every((log) => log.visibleCompleteVisualLines >= 3)).toBe(true);
        expect(measurement.logs.every((log) => !log.failurePromptVisible || log.contentHeight >= log.lineHeight * 3 - 0.5)).toBe(true);
        expect(measurement.logs.every((log) => log.scrollWidth <= log.clientWidth + 1)).toBe(true);
        expect(measurement.logs.every((log) => log.status.headlineVisible && log.status.recentGroupVisible)).toBe(true);
      }
    });
    receipt.interactions.uiEvidenceScreenshots = await writeUiEvidenceScreenshots(fixture.app, page);
  } catch (error) {
    failures.push(`harness: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    receipt.failures = failures;
    receipt.finishedAt = new Date().toISOString();
    receipt.screenshot = await writeReceiptScreenshot(fixture.page, failures.length ? 'failure' : 'success');
    const outputDir = '/tmp/service-observatory-log-scroll-receipts';
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, `${Date.now()}-receipt.json`), `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await restoreStatusPageGate(fixture.app).catch(() => undefined);
    await fixture.app.close();
    await new Promise<void>((resolve) => fixture.statusServer.close(() => resolve()));
    await rm(fixture.dataRoot, { recursive: true, force: true });
  }
  expect(failures, `WP017 log-scroll expected failures:\n${failures.join('\n')}`).toEqual([]);
});
