import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const electronPath = require('electron') as string;
const evidenceDir = path.join(root, '.ai-bridge', 'evidence', 'ui-refinement');

type Layout = 'columns4' | 'grid2x2' | 'focus';

type Viewport = {
  width: number;
  height: number;
  label: string;
};

type Rect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
};

type PanelMeasurement = {
  service: string;
  panel: Rect;
  panelClientWidth: number;
  panelScrollWidth: number;
  head: Rect;
  metrics: Rect;
  status: Rect;
  logModule: Rect;
  statusLogHeightDelta: number;
  log: {
    box: Rect;
    clientWidth: number;
    clientHeight: number;
    scrollWidth: number;
    lineHeight: number;
    visualLineCount: number;
    completeVisibleVisualLines: number;
    partiallyVisibleVisualLines: number;
  };
  metricOverflowWithoutFullValue: string[];
  statusItemCount: number;
  newestStatusFullyVisible: boolean;
  statusClip: {
    top: number;
    bottom: number;
    newestTop: number;
    newestBottom: number;
  } | null;
  local: {
    headTop: number;
    metricsTop: number;
    statusTop: number;
    logTop: number;
  };
};

type GeometryMeasurement = {
  viewport: { width: number; height: number };
  layout: Layout;
  panels: PanelMeasurement[];
  documentScrollWidth: number;
  documentClientWidth: number;
  localTemplate: {
    maxHeadTopDelta: number;
    maxMetricsTopDelta: number;
    maxStatusTopDelta: number;
    maxLogTopDelta: number;
  };
};

function fixtureEntrySource(servicePanelPath: string, detailsDrawerPath: string): string {
  return String.raw`
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ServicePanel } from ${JSON.stringify(servicePanelPath)};
import { ServiceDetailsDrawer } from ${JSON.stringify(detailsDrawerPath)};

const epoch = 42;
const observedAt = '2026-10-21T10:00:00.000Z';
const sourceAt = '2026-10-21T09:59:00.000Z';
const deviceIds = ['nas-readonly', 'nas-spaced', 'archive-node', 'quant-host', 'local-worker'];
const deviceNames = ['NAS只读设备', 'NAS 只读设备', '归档节点名称非常长-用于全文入口验证-只读', 'Quant共享执行节点', '本机工作节点'];
const containerIds = ['a', 'b', 'c', 'd', 'e'].map((letter) => letter.repeat(64));
const containerKeys = deviceIds.map((deviceId, index) => deviceId + ':' + containerIds[index]);

const devices = deviceIds.map((id, index) => ({ id, name: deviceNames[index], transport: 'local', profileId: 'fixture-profile', enabled: true }));
const services = [
  {
    id: 'paper-service',
    name: '论文下载',
    category: '论文下载',
    bindings: [
      { id: 'paper-binding-nas', deviceId: 'nas-readonly', selector: { kind: 'container_id', value: containerIds[0] }, required: true, expectedPolicy: 'continuous' },
      { id: 'paper-binding-nas-spaced', deviceId: 'nas-spaced', selector: { kind: 'container_id', value: containerIds[1] }, required: true, expectedPolicy: 'job' },
      { id: 'paper-binding-archive', deviceId: 'archive-node', selector: { kind: 'container_id', value: containerIds[2] }, required: true, expectedPolicy: 'job' },
    ],
    businessAdapter: { kind: 'http_json', profileId: 'fixture-profile', endpointRef: 'paper-business', mapping: {} },
    statusAdapter: { kind: 'article_receipt_json', profileId: 'fixture-profile', sourceRef: 'fixture-paper' },
  },
  {
    id: 'rag-service',
    name: 'RAGFlow工作知识库-长名称验证',
    category: '知识库',
    bindings: [{ id: 'rag-binding', deviceId: 'nas-spaced', selector: { kind: 'container_id', value: containerIds[1] }, required: true, expectedPolicy: 'continuous' }],
    businessAdapter: { kind: 'http_json', profileId: 'fixture-profile', endpointRef: 'rag-business', mapping: {} },
    statusAdapter: { kind: 'ragflow_documents', profileId: 'fixture-profile', sourceRef: 'fixture-rag' },
  },
  {
    id: 'quant-service',
    name: 'Quant扫描与任务历史',
    category: '量化任务',
    bindings: [{ id: 'quant-binding', deviceId: 'quant-host', selector: { kind: 'container_id', value: containerIds[3] }, required: true, expectedPolicy: 'job' }],
    businessAdapter: { kind: 'none' },
    statusAdapter: { kind: 'quant_pg_receipts', profileId: 'fixture-profile', sourceRef: 'fixture-quant' },
  },
  {
    id: 'infra-service',
    name: '基础设施服务-无业务Adapter-长名称与当前故障验证',
    category: '基础设施',
    bindings: [{ id: 'infra-binding', deviceId: 'local-worker', selector: { kind: 'container_id', value: containerIds[4] }, required: true, expectedPolicy: 'continuous' }],
    businessAdapter: { kind: 'none' },
    statusAdapter: { kind: 'none' },
  },
];

const config = {
  schemaVersion: 1,
  devices,
  services,
  slots: services.map((service) => ({ serviceId: service.id, logBindingId: null })),
  display: { layout: 'columns4', focusSlot: 0, asciiMode: 'off', asciiBrightness: 50, asciiStrength: 50, reducedMotion: true },
  window: null,
};

const containerNames = ['论文下载器-主容器', 'NAS只读-第二成员', '归档节点-长成员名称', 'ragflow-worker', '基础设施-错误日志容器'];
const containers = containerIds.map((id, index) => ({
  key: containerKeys[index],
  deviceId: deviceIds[index],
  id,
  name: containerNames[index],
  image: 'fixture:latest',
  compose: { project: 'fixture', service: containerNames[index], ordinal: 1 },
  state: index === 3 ? 'exited' : 'running',
  health: index === 4 ? 'unhealthy' : index === 3 ? 'none' : 'healthy',
  startedAt: sourceAt,
  finishedAt: index === 3 ? observedAt : null,
  exitCode: index === 3 ? 1 : null,
  restartCount: index === 3 ? 9 : index,
  tty: false,
  networkMode: index === 2 ? 'host' : 'bridge',
  logsAvailable: true,
  sourceAt,
  generation: deviceIds[index] + ':' + id + ':' + sourceAt,
}));

const point = (at, cpu, freshness = 'fresh', rx = 4_000_000_000_000, tx = 9_000_000_000_000) => ({
  observedAt: at,
  sourceAt: at,
  freshness,
  cpuPercent: cpu,
  memoryBytes: cpu == null ? null : 4_194_304_000_000,
  memoryLimitBytes: 8_589_934_592_000,
  networkRxBytes: rx,
  networkTxBytes: tx,
  pids: cpu == null ? null : 17,
});
const observationFor = (serviceId, status, freshness, members, metrics, errorCode, history) => ({
  serviceId,
  status,
  freshness,
  coverage: { required: members.length, observed: members.filter((member) => member.status === 'bound').length, missing: members.filter((member) => member.status !== 'bound').length },
  members,
  metrics,
  uptimeSeconds: serviceId === 'quant-service' ? null : serviceId === 'infra-service' ? 91 : 86_400,
  sourceAt,
  observedAt,
  errorCode,
  business: {
    status: serviceId === 'infra-service' ? 'not_configured' : serviceId === 'quant-service' ? 'uncomputable' : 'fresh',
    metrics: serviceId === 'paper-service' ? { total: 120, succeeded: 94, failed: 3, active: 2, waiting: 21, cancelled: 0 } : serviceId === 'rag-service' ? { total: 60, succeeded: 51, failed: 2, active: 1, waiting: 6, cancelled: 0 } : { total: null, succeeded: null, failed: null, active: null, waiting: null, cancelled: null },
    scopeType: serviceId === 'paper-service' ? 'batch' : serviceId === 'rag-service' ? 'queue' : null,
    scopeId: serviceId === 'paper-service' ? 'doi-batch-2026-10-21' : serviceId === 'rag-service' ? 'work-knowledge-base' : null,
    sourceAt: serviceId === 'infra-service' ? null : sourceAt,
    observedAt,
    progress: null,
    errorCode: serviceId === 'infra-service' ? 'business_unconfigured' : null,
  },
});

const observations = [
  observationFor('paper-service', 'attention', 'fresh', [
    { bindingId: 'paper-binding-nas', deviceId: 'nas-readonly', containerKey: containerKeys[0], status: 'bound', reason: null },
    { bindingId: 'paper-binding-nas-spaced', deviceId: 'nas-spaced', containerKey: containerKeys[1], status: 'bound', reason: null },
    { bindingId: 'paper-binding-archive', deviceId: 'archive-node', containerKey: containerKeys[2], status: 'bound', reason: null },
  ], point(observedAt, 97.6), null, [point('2026-10-21T09:58:00.000Z', 71.2), point('2026-10-21T09:59:00.000Z', 83.4)]),
  observationFor('rag-service', 'ok', 'partial', [
    { bindingId: 'rag-binding', deviceId: 'nas-spaced', containerKey: containerKeys[1], status: 'bound', reason: null },
  ], point(observedAt, 0), null, [point('2026-10-21T09:59:00.000Z', 0.1)]),
  observationFor('quant-service', 'neutral', 'stale', [
    { bindingId: 'quant-binding', deviceId: 'quant-host', containerKey: containerKeys[3], status: 'bound', reason: null },
  ], point(observedAt, null, 'stale', null, null), null, []),
  observationFor('infra-service', 'attention', 'unknown', [
    { bindingId: 'infra-binding', deviceId: 'local-worker', containerKey: containerKeys[4], status: 'bound', reason: null },
  ], point(observedAt, null, 'unknown', null, null), 'timeout', [point('2026-10-21T09:55:00.000Z', 4.4, 'stale')]),
];

const record = (id, serviceId, sourceRef, stage, outcome, summary, occurredAt, evidenceKind = 'business_event', facts = {}, taskKey = id) => ({
  id,
  serviceId,
  sourceRef,
  taskKey,
  stage,
  outcome,
  summary,
  occurredAt,
  sourceAt: occurredAt,
  observedAt: occurredAt,
  evidenceKind,
  facts,
  evidenceRef: id,
});

const paperRecords = [
  record('paper-current-failure', 'paper-service', 'article_receipt_json:fixture-paper', '单篇回执', 'failed', 'DOI 10.1234/fixture 当前下载失败；最近失败已恢复', '2026-10-21T09:59:30.000Z', 'stage_receipt', { failed: 1, total: 1, status: 'failed' }, 'paper-task-current'),
  record('paper-batch-complete', 'paper-service', 'article_receipt_json:fixture-paper', '分组结果', 'partial', '论文分组结果：已下载 94/120 篇，失败 3，部分 2', '2026-10-21T09:50:00.000Z', 'business_event', { papers: 120, succeeded: 94, failed: 3, partial: 2 }, 'paper-batch'),
  record('paper-old-success', 'paper-service', 'article_receipt_json:fixture-paper', '同步回执', 'succeeded', 'Zotero同步回执已完成 91 篇', '2026-10-21T09:40:00.000Z', 'stage_receipt', { completed: 91, total: 94, status: 'succeeded' }, 'paper-sync'),
  record('paper-container-observation', 'paper-service', 'docker:nas-readonly', '容器观察', 'active', '容器正在运行，读取诊断未完成', '2026-10-21T09:59:40.000Z', 'container_observation', {}, 'docker-observation'),
];

const ragRecords = [
  record('rag-latest', 'rag-service', 'ragflow_documents:fixture-rag', '数据集范围', 'partial', '工作知识库：完成 51 · 失败 2 · 部分读取', '2026-10-21T09:58:00.000Z', 'snapshot_diff', { datasetAlias: '工作知识库', reportedDocuments: 60, coveredDocuments: 60, completedCount: 51, failedCount: 2, pendingCount: 6, processingCount: 1, cancelledCount: 0, unknownCount: 0, consistency: 'bounded_partial' }, 'rag-work'),
  record('rag-complete', 'rag-service', 'ragflow_documents:fixture-rag', '报告完成', 'succeeded', 'RAGFlow报告完成（51/60）', '2026-10-21T09:55:00.000Z', 'stage_receipt', { completed: 51, total: 60, status: 'succeeded' }, 'rag-report'),
  record('rag-failure', 'rag-service', 'ragflow_documents:fixture-rag', '失败', 'failed', '工作知识库：嵌入阶段失败；已有来源描述，尚未归类', '2026-10-21T09:53:00.000Z', 'stage_receipt', { datasetAlias: '工作知识库', errorStage: '嵌入', errorCode: 'unclassified', errorReason: '未归类' }, 'rag-failure'),
  record('rag-failure-2', 'rag-service', 'ragflow_documents:fixture-rag', '失败', 'failed', '工作知识库：嵌入阶段失败；已有来源描述，尚未归类', '2026-10-21T09:52:00.000Z', 'stage_receipt', { datasetAlias: '工作知识库', errorStage: '嵌入', errorCode: 'unclassified', errorReason: '未归类' }, 'rag-failure-2'),
  record('rag-old', 'rag-service', 'ragflow_documents:fixture-rag', '历史范围', 'partial', '个人剪藏：完成 28 · 失败 1', '2026-10-21T09:45:00.000Z', 'snapshot_diff', { datasetAlias: '个人剪藏', reportedDocuments: 30, coveredDocuments: 30, completedCount: 28, failedCount: 1, pendingCount: 1, processingCount: 0, cancelledCount: 0, unknownCount: 0, consistency: 'bounded_partial' }, 'rag-personal'),
];

const quantRecords = [
  record('quant-scope', 'quant-service', 'quant_pg_receipts:fixture-quant', '已读范围', 'partial', 'Quant扫描与任务历史仍有更多记录', '2026-10-21T09:56:00.000Z', 'snapshot_diff', { businessKind: 'scope', scansRead: 12, tasksRead: 8, recorded: 20, activeRecorded: 0, completedScans: 9, completedTasks: 5, failedRecorded: 2, activityState: 'historical', incomplete: true, hasMore: true }, 'quant-scope'),
  record('quant-scan', 'quant-service', 'quant_pg_receipts:fixture-quant', '扫描记录', 'succeeded', 'Quant扫描完成 9 次', '2026-10-21T09:52:00.000Z', 'business_event', { businessKind: 'scan', completed: 9 }, 'quant-scan'),
  record('quant-task-failure', 'quant-service', 'quant_pg_receipts:fixture-quant', '任务记录', 'failed', 'Quant任务历史失败 2 条', '2026-10-21T09:48:00.000Z', 'business_event', { businessKind: 'task_history', failed: 2 }, 'quant-task'),
];

const statusPages = {
  'paper-service': { serviceId: 'paper-service', records: paperRecords, nextCursor: null, hasMore: false, feeds: [{ sourceRef: 'article_receipt_json:fixture-paper', health: 'fresh', lastSuccessAt: sourceAt, observedAt, cursor: null, hasMore: false, gap: false, errorCode: null }] },
  'rag-service': { serviceId: 'rag-service', records: ragRecords, nextCursor: null, hasMore: false, feeds: [{ sourceRef: 'ragflow_documents:fixture-rag', health: 'fresh', lastSuccessAt: sourceAt, observedAt, cursor: null, hasMore: false, gap: false, errorCode: null }] },
  'quant-service': { serviceId: 'quant-service', records: quantRecords, nextCursor: null, hasMore: false, feeds: [{ sourceRef: 'quant_pg_receipts:fixture-quant', health: 'stale', lastSuccessAt: '2026-10-21T08:00:00.000Z', observedAt, cursor: null, hasMore: true, gap: true, errorCode: 'status_expired' }] },
  'infra-service': { serviceId: 'infra-service', records: [], nextCursor: null, hasMore: false, feeds: [{ sourceRef: 'http_json:fixture-unconfigured', health: 'unconfigured', lastSuccessAt: null, observedAt, cursor: null, hasMore: false, gap: false, errorCode: 'status_unconfigured' }] },
};

const makeEntries = (sourceKey) => Array.from({ length: sourceKey.startsWith('local-worker:') ? 64 : 18 }, (_, index) => ({
  id: sourceKey + '-entry-' + index,
  sourceKey,
  deviceId: sourceKey.split(':')[0],
  containerId: sourceKey.split(':')[1],
  timestamp: new Date(Date.parse(sourceAt) + index * 1000).toISOString(),
  message: index === 3 ? '多行日志：\n  保留缩进与换行，当前读取路径可完整查看' : index === 7 ? '中文无空格长日志：论文下载进度' + '已读取'.repeat(24) : '日志第' + (index + 1) + ' · 原始输出行',
  observedAt,
}));

const logStates = Object.fromEntries(containerKeys.map((key, index) => {
  const [deviceId, containerId] = key.split(':');
  const diagnostic = {
    readAttemptId: index + 1,
    source: 'container_logs',
    connectionGeneration: 1,
    phase: index === 4 ? 'remote' : 'read',
    elapsedMs: index === 4 ? 5000 : 18,
    budgetMs: index === 4 ? 5000 : 1000,
    channels: 1,
    bytes: 4096 + index,
    outcome: index === 4 ? 'remote_timeout' : index === 3 ? 'success_idle' : 'success_new',
    observedAt,
  };
  return [key, {
    sourceKey: key,
    deviceId,
    containerId,
    generation: deviceId + ':' + containerId + ':' + sourceAt,
    cursor: null,
    entries: makeEntries(key),
    bytes: 4096 + index,
    gap: index === 4 ? 2 : 0,
    paused: false,
    complete: true,
    lastSuccessAt: index === 4 ? '2026-10-21T09:55:00.000Z' : observedAt,
    errorCode: index === 4 ? 'timeout' : null,
    lastErrorCode: index === 4 ? 'remote_error' : null,
    lastErrorAt: index === 4 ? '2026-10-21T09:55:00.000Z' : null,
    lastErrorDiagnostic: index === 4 ? { ...diagnostic, outcome: 'remote_error', phase: 'remote' } : null,
    diagnostic,
  }];
}));

const logs = Object.values(logStates);
const observationHistories = [
  [point('2026-10-21T09:58:00.000Z', 71.2), point('2026-10-21T09:59:00.000Z', 83.4)],
  [point('2026-10-21T09:59:00.000Z', 0.1)],
  [],
  [point('2026-10-21T09:55:00.000Z', 4.4, 'stale')],
  [],
];
const observationsSnapshot = { devices: devices.map((device) => ({ deviceId: device.id, containerCount: 1, complete: true, errorCode: null, sourceAt, observedAt })), containers, observations: containerKeys.map((key, index) => ({ key, deviceId: deviceIds[index], containerId: containerIds[index], startedAt: sourceAt, current: point(observedAt, observations[index]?.metrics.cpuPercent ?? null), history: observationHistories[index] ?? [], coverage: { requested: 12, returned: (observationHistories[index]?.length ?? 0) + 1, complete: true }, errorCode: null, generation: containers[index].generation })), services: observations, logs, containerPage: { offset: 0, limit: 96, total: containers.length, returned: containers.length, nextOffset: containers.length, hasMore: false, capacityExceeded: false }, truncated: false };

const ipcCounts = { openLog: 0, closeLog: 0, pollLog: 0, pauseLog: 0, searchLog: 0 };
window.__fixtureIpc = ipcCounts;
window.observatory = {
  openLog: async (_epoch, deviceId, containerId) => { ipcCounts.openLog += 1; return { ok: true, value: { sourceKey: deviceId + ':' + containerId } }; },
  closeLog: async () => { ipcCounts.closeLog += 1; return { ok: true, value: null }; },
  pauseLog: async () => { ipcCounts.pauseLog += 1; return { ok: true, value: null }; },
  pollLog: async (_epoch, sourceKey) => { ipcCounts.pollLog += 1; return { ok: true, value: logStates[sourceKey] }; },
  searchLog: async (_epoch, sourceKey, query) => { ipcCounts.searchLog += 1; return { ok: true, value: (logStates[sourceKey]?.entries ?? []).filter((entry) => entry.message.includes(query)) }; },
};

function Fixture() {
  const [layout, setLayout] = useState('columns4');
  const [focusSlot, setFocusSlot] = useState(0);
  const [details, setDetails] = useState(null);
  useEffect(() => {
    const listener = (event) => {
      const value = event.detail;
      if (value?.layout) setLayout(value.layout);
      if (typeof value?.focusSlot === 'number') setFocusSlot(value.focusSlot);
    };
    window.addEventListener('fixture-layout', listener);
    window.__setFixtureLayout = (nextLayout, nextFocusSlot = focusSlot) => window.dispatchEvent(new CustomEvent('fixture-layout', { detail: { layout: nextLayout, focusSlot: nextFocusSlot } }));
    return () => window.removeEventListener('fixture-layout', listener);
  }, [focusSlot]);
  const renderConfig = { ...config, display: { ...config.display, layout, focusSlot } };
  return <main className="shell"><div className="app-content">
    <header className="masthead app-topbar"><div className="topbar-brand"><h1 className="brand-lockup"><span className="brand-mark">「观」</span><span className="brand-label">Server Observer</span></h1></div><div className="header-actions"><span className="section-label">隔离 UI 几何夹具</span></div></header>
    <section className={'dashboard-grid layout-' + layout} aria-label="服务面板">
      {renderConfig.slots.map((slot, index) => {
        const service = services.find((item) => item.id === slot.serviceId);
        const observation = observations.find((item) => item.serviceId === slot.serviceId);
        return <ServicePanel key={slot.serviceId} slotIndex={index} service={service} observation={observation} config={renderConfig} containers={containers} observations={observationsSnapshot.observations} logs={logs} epoch={epoch} statusPage={statusPages[slot.serviceId]} statusLoading={false} onFocusSlot={setFocusSlot} onOpenDetails={(slotIndex, trigger) => setDetails({ slotIndex, trigger })} />;
      })}
    </section>
  </div>
    {details && (() => {
      const service = services[details.slotIndex];
      const observation = observations.find((item) => item.serviceId === service.id);
      return <ServiceDetailsDrawer service={service} observation={observation} config={renderConfig} containers={containers} observations={observationsSnapshot.observations} statusPage={statusPages[service.id]} statusLoading={false} trigger={details.trigger} onClose={() => setDetails(null)} />;
    })()}
  </main>;
}

createRoot(document.getElementById('root')).render(<Fixture />);
`;
}

async function launchIsolatedFixture(): Promise<{ app: Awaited<ReturnType<typeof electron.launch>>; page: Page; dataRoot: string }> {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-panel-refinement-'));
  const entryPath = path.join(dataRoot, 'fixture.tsx');
  const bundlePath = path.join(dataRoot, 'fixture.js');
  const htmlPath = path.join(dataRoot, 'fixture.html');
  const mainPath = path.join(dataRoot, 'main.cjs');
  const css = await readFile(path.join(root, 'src/renderer/styles.css'), 'utf8');
  await writeFile(entryPath, fixtureEntrySource(
    path.join(root, 'src/renderer/components/ServicePanel.tsx'),
    path.join(root, 'src/renderer/components/ServiceDetailsDrawer.tsx'),
  ), { encoding: 'utf8', mode: 0o600 });
  await build({ entryPoints: [entryPath], bundle: true, format: 'iife', platform: 'browser', target: 'es2022', jsx: 'automatic', nodePaths: [path.join(root, 'node_modules')], outfile: bundlePath, logLevel: 'silent' });
  await writeFile(htmlPath, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="./fixture.js"></script></body></html>\n`, { encoding: 'utf8', mode: 0o600 });
  await writeFile(mainPath, `const { app, BrowserWindow } = require('electron');\napp.whenReady().then(async () => { const window = new BrowserWindow({ show: true, webPreferences: { contextIsolation: true, sandbox: false } }); await window.loadFile(${JSON.stringify(htmlPath)}); });\napp.on('window-all-closed', () => app.quit());\n`, { encoding: 'utf8', mode: 0o600 });
  const app = await electron.launch({ executablePath: electronPath, args: [mainPath] });
  const page = await app.firstWindow();
  page.on('console', (message) => console.log(`[panel-refinement console:${message.type()}] ${message.text()}`));
  page.on('pageerror', (error) => console.log(`[panel-refinement pageerror] ${error.message}\n${error.stack ?? ''}`));
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('.service-panel')).toHaveCount(4);
  await expect.poll(() => page.locator('.log-line').count(), { timeout: 10_000 }).toBeGreaterThan(30);
  return { app, page, dataRoot };
}

async function setFixtureLayout(page: Page, layout: Layout, focusSlot = 0): Promise<void> {
  await page.evaluate(({ nextLayout, nextFocusSlot }) => {
    const setter = (window as unknown as { __setFixtureLayout?: (value: string, focusSlot: number) => void }).__setFixtureLayout;
    if (!setter) throw new Error('fixture layout setter unavailable');
    setter(nextLayout, nextFocusSlot);
  }, { nextLayout: layout, nextFocusSlot: focusSlot });
  await expect(page.locator('.dashboard-grid')).toHaveClass(new RegExp(`layout-${layout}`));
  await page.evaluate(async () => { await document.fonts.ready; await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
}

async function measureGeometry(page: Page, layout: Layout): Promise<GeometryMeasurement> {
  return page.evaluate((currentLayout) => {
    const rect = (node: Element | null): Rect => {
      const value = node?.getBoundingClientRect();
      if (!value) return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
      return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
    };
    const maxDelta = (values: number[]) => values.length ? Math.max(...values) - Math.min(...values) : 0;
    const visibleIntersection = (line: DOMRect, clip: DOMRect) => {
      const width = Math.min(line.right, clip.right) - Math.max(line.left, clip.left);
      const height = Math.min(line.bottom, clip.bottom) - Math.max(line.top, clip.top);
      return { width, height };
    };
    const panelMeasurements = [...document.querySelectorAll<HTMLElement>('.service-panel')].map((panel) => {
      const headElement = panel.querySelector('.panel-head');
      const metricsElement = panel.querySelector('.metric-row');
      const statusElement = panel.querySelector('.status-timeline');
      const logElement = panel.querySelector('.log-viewer');
      const logLines = panel.querySelector<HTMLElement>('.log-lines');
      const panelRect = panel.getBoundingClientRect();
      const head = rect(headElement);
      const metrics = rect(metricsElement);
      const status = rect(statusElement);
      const log = rect(logElement);
      const lineElement = logLines;
      let visualRects: DOMRect[] = [];
      let clip = lineElement?.getBoundingClientRect() ?? new DOMRect();
      if (lineElement) {
        let ancestor: HTMLElement | null = lineElement;
        while (ancestor) {
          const ancestorRect = ancestor.getBoundingClientRect();
          const style = getComputedStyle(ancestor);
          if (['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX)) {
            clip = new DOMRect(Math.max(clip.left, ancestorRect.left), clip.top, Math.min(clip.right, ancestorRect.right) - Math.max(clip.left, ancestorRect.left), clip.height);
          }
          if (['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY)) {
            clip = new DOMRect(clip.left, Math.max(clip.top, ancestorRect.top), clip.width, Math.min(clip.bottom, ancestorRect.bottom) - Math.max(clip.top, ancestorRect.top));
          }
          ancestor = ancestor.parentElement;
        }
        visualRects = [...lineElement.querySelectorAll<HTMLElement>('.log-line')].flatMap((row) => {
          const message = row.querySelector<HTMLElement>('span:last-child') ?? row;
          const range = document.createRange();
          range.selectNodeContents(message);
          const unique = new Map<string, DOMRect>();
          for (const value of [...range.getClientRects()]) unique.set(`${Math.round(value.top * 10) / 10}:${Math.round(value.bottom * 10) / 10}:${Math.round(value.left * 10) / 10}`, value);
          return [...unique.values()];
        });
      }
      const completeVisibleVisualLines = visualRects.filter((line) => {
        const intersection = visibleIntersection(line, clip);
        return intersection.width > 1 && intersection.height >= line.height - 0.5;
      }).length;
      const partiallyVisibleVisualLines = visualRects.filter((line) => {
        const intersection = visibleIntersection(line, clip);
        return intersection.width > 1 && intersection.height > 0 && intersection.height < line.height - 0.5;
      }).length;
      const lineStyle = lineElement ? getComputedStyle(lineElement) : null;
      const lineHeight = lineStyle ? Number.parseFloat(lineStyle.lineHeight) : 0;
      const metricOverflowWithoutFullValue = [...panel.querySelectorAll<HTMLElement>('.metric strong')]
        .filter((metric) => metric.scrollWidth > metric.clientWidth + 1 && !metric.getAttribute('title') && !metric.getAttribute('aria-label'))
        .map((metric) => metric.textContent?.trim() ?? '');
      const items = [...panel.querySelectorAll<HTMLElement>('.status-panel-item')];
      const statusRect = statusElement?.getBoundingClientRect();
      const newest = items[0]?.getBoundingClientRect();
      const newestStatusFullyVisible = !!newest && !!statusRect && newest.height > 0 && newest.top >= statusRect.top - 0.5 && newest.bottom <= statusRect.bottom + 0.5;
      const service = panel.querySelector('.service-title-button h2')?.textContent?.trim() ?? '';
      return {
        service,
        panel: { left: panelRect.left, right: panelRect.right, top: panelRect.top, bottom: panelRect.bottom, width: panelRect.width, height: panelRect.height },
        panelClientWidth: panel.clientWidth,
        panelScrollWidth: panel.scrollWidth,
        head,
        metrics,
        status,
        logModule: log,
        statusLogHeightDelta: Math.abs(status.height - log.height),
        log: {
          box: rect(lineElement),
          clientWidth: lineElement?.clientWidth ?? 0,
          clientHeight: lineElement?.clientHeight ?? 0,
          scrollWidth: lineElement?.scrollWidth ?? 0,
          lineHeight,
          visualLineCount: visualRects.length,
          completeVisibleVisualLines,
          partiallyVisibleVisualLines,
        },
        metricOverflowWithoutFullValue,
        statusItemCount: items.length,
        newestStatusFullyVisible,
        statusClip: statusRect && newest ? { top: statusRect.top, bottom: statusRect.bottom, newestTop: newest.top, newestBottom: newest.bottom } : null,
        local: {
          headTop: head.top - panelRect.top,
          metricsTop: metrics.top - panelRect.top,
          statusTop: status.top - panelRect.top,
          logTop: log.top - panelRect.top,
        },
      } satisfies PanelMeasurement;
    });
    const localTemplate = {
      maxHeadTopDelta: maxDelta(panelMeasurements.map((item) => item.local.headTop)),
      maxMetricsTopDelta: maxDelta(panelMeasurements.map((item) => item.local.metricsTop)),
      maxStatusTopDelta: maxDelta(panelMeasurements.map((item) => item.local.statusTop)),
      maxLogTopDelta: maxDelta(panelMeasurements.map((item) => item.local.logTop)),
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      layout: currentLayout,
      panels: panelMeasurements,
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      localTemplate,
    } satisfies GeometryMeasurement;
  }, layout);
}

function rowGroups(panels: PanelMeasurement[]): PanelMeasurement[][] {
  const groups: PanelMeasurement[][] = [];
  for (const panel of [...panels].sort((left, right) => left.panel.top - right.panel.top || left.panel.left - right.panel.left)) {
    const group = groups.find((candidate) => Math.abs(candidate[0]!.panel.top - panel.panel.top) <= 3);
    if (group) group.push(panel);
    else groups.push([panel]);
  }
  return groups;
}

async function assertGeometry(measurement: GeometryMeasurement): Promise<void> {
  expect(measurement.panels, `${measurement.layout} should render four fixture panels`).toHaveLength(4);
  expect(measurement.documentScrollWidth, `${measurement.layout} must not create document x overflow`).toBeLessThanOrEqual(measurement.documentClientWidth + 1);
  for (const panel of measurement.panels) {
    if (panel.status.height > 0 && panel.logModule.height > 0) expect(panel.statusLogHeightDelta, `${measurement.layout} ${panel.service} status/log heights`).toBeLessThanOrEqual(2);
    expect(panel.panelScrollWidth, `${measurement.layout} ${panel.service} panel x overflow`).toBeLessThanOrEqual(panel.panelClientWidth + 1);
    if (panel.logModule.height > 0) {
      expect(panel.log.clientWidth, `${measurement.layout} ${panel.service} log client width`).toBeGreaterThan(0);
      expect(panel.log.scrollWidth, `${measurement.layout} ${panel.service} log x overflow`).toBeLessThanOrEqual(panel.log.clientWidth + 1);
      expect(panel.log.lineHeight, `${measurement.layout} ${panel.service} log baseline`).toBeGreaterThanOrEqual(14);
      expect(panel.log.completeVisibleVisualLines, `${measurement.layout} ${panel.service} three complete log baselines`).toBeGreaterThanOrEqual(3);
    }
    expect(panel.metricOverflowWithoutFullValue, `${measurement.layout} ${panel.service} metrics must expose a full value when visually clipped`).toEqual([]);
    if (panel.status.height > 0 && panel.statusItemCount > 0) expect(panel.newestStatusFullyVisible, `${measurement.layout} ${panel.service} newest status`).toBe(true);
  }
  if (measurement.layout === 'focus') {
    const main = measurement.panels.find((panel) => panel.service === '论文下载')!;
    const small = measurement.panels.filter((panel) => panel.service !== '论文下载');
    expect(Math.max(...small.map((panel) => panel.panel.top)) - Math.min(...small.map((panel) => panel.panel.top)), 'focus small panels share one bottom row').toBeLessThanOrEqual(2);
    expect(main.panel.bottom, 'focus main stays above the small panels at every desktop height').toBeLessThanOrEqual(Math.min(...small.map((panel) => panel.panel.top)));
    for (const panel of small.filter((panel) => panel.status.height > 0 && panel.logModule.height > 0)) expect(panel.statusLogHeightDelta).toBeLessThanOrEqual(2);
    for (const key of ['headTop', 'metricsTop', 'statusTop', 'logTop'] as const) {
      expect(Math.max(...small.map((panel) => panel.local[key])) - Math.min(...small.map((panel) => panel.local[key])), `focus small ${key} local template`).toBeLessThanOrEqual(2);
    }
  } else {
    for (const group of rowGroups(measurement.panels)) {
      for (const key of ['head', 'metrics', 'status', 'logModule'] as const) {
        const tops = group.map((panel) => panel[key].top);
        const bottoms = group.map((panel) => panel[key].bottom);
        expect(Math.max(...tops) - Math.min(...tops), `${measurement.layout} ${key} row top alignment`).toBeLessThanOrEqual(2);
        expect(Math.max(...bottoms) - Math.min(...bottoms), `${measurement.layout} ${key} row bottom alignment`).toBeLessThanOrEqual(2);
      }
    }
  }
}

async function waitForStableLayout(page: Page): Promise<void> {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
}

type LogSurfaceMeasurement = {
  viewer: Rect;
  lines: Rect;
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  scrollTop: number;
  lineHeight: number;
  text: string;
  completeVisibleVisualLines: number;
  anchor: { id: string; offset: number } | null;
};

async function measureLogSurface(page: Page, selector: string): Promise<LogSurfaceMeasurement> {
  return page.evaluate((currentSelector) => {
    const rect = (node: Element | null): Rect => {
      const value = node?.getBoundingClientRect();
      if (!value) return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
      return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
    };
    const viewer = document.querySelector<HTMLElement>(currentSelector);
    const lines = viewer?.querySelector<HTMLElement>('.log-lines');
    if (!viewer || !lines) throw new Error(`log surface not found: ${currentSelector}`);
    let clip = lines.getBoundingClientRect();
    let ancestor: HTMLElement | null = lines;
    while (ancestor) {
      const ancestorRect = ancestor.getBoundingClientRect();
      const style = getComputedStyle(ancestor);
      if (['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX)) {
        clip = new DOMRect(Math.max(clip.left, ancestorRect.left), clip.top, Math.min(clip.right, ancestorRect.right) - Math.max(clip.left, ancestorRect.left), clip.height);
      }
      if (['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY)) {
        clip = new DOMRect(clip.left, Math.max(clip.top, ancestorRect.top), clip.width, Math.min(clip.bottom, ancestorRect.bottom) - Math.max(clip.top, ancestorRect.top));
      }
      ancestor = ancestor.parentElement;
    }
    const visibleIntersection = (line: DOMRect) => ({
      width: Math.min(line.right, clip.right) - Math.max(line.left, clip.left),
      height: Math.min(line.bottom, clip.bottom) - Math.max(line.top, clip.top),
    });
    const visualRects = [...lines.querySelectorAll<HTMLElement>('.log-line')].flatMap((row) => {
      const message = row.querySelector<HTMLElement>('span:last-child') ?? row;
      const range = document.createRange();
      range.selectNodeContents(message);
      const unique = new Map<string, DOMRect>();
      for (const value of [...range.getClientRects()]) unique.set(`${Math.round(value.top * 10) / 10}:${Math.round(value.bottom * 10) / 10}:${Math.round(value.left * 10) / 10}`, value);
      return [...unique.values()];
    });
    const completeVisibleVisualLines = visualRects.filter((line) => {
      const intersection = visibleIntersection(line);
      return intersection.width > 1 && intersection.height >= line.height - 0.5;
    }).length;
    const linesRect = lines.getBoundingClientRect();
    const anchor = [...lines.querySelectorAll<HTMLElement>('[data-entry-id]')].find((row) => {
      const rowRect = row.getBoundingClientRect();
      return rowRect.bottom > linesRect.top + 1 && rowRect.top < linesRect.bottom - 1;
    });
    return {
      viewer: rect(viewer),
      lines: rect(lines),
      clientWidth: lines.clientWidth,
      clientHeight: lines.clientHeight,
      scrollWidth: lines.scrollWidth,
      scrollHeight: lines.scrollHeight,
      scrollTop: lines.scrollTop,
      lineHeight: Number.parseFloat(getComputedStyle(lines).lineHeight),
      text: lines.innerText,
      completeVisibleVisualLines,
      anchor: anchor ? { id: anchor.dataset.entryId ?? '', offset: anchor.getBoundingClientRect().top - linesRect.top } : null,
    } satisfies LogSurfaceMeasurement;
  }, selector);
}

test('isolated production panel fixture verifies mixed geometry, visual evidence, and interactions', async () => {
  test.setTimeout(120_000);
  const fixture = await launchIsolatedFixture();
  const screenshots: string[] = [];
  const measurements: GeometryMeasurement[] = [];
  const interactions: Record<string, unknown> = {};
  const viewports: Viewport[] = [
    { width: 1280, height: 740, label: '1280x740' },
    { width: 1280, height: 800, label: '1280x800' },
    { width: 1280, height: 801, label: '1280x801' },
    { width: 1280, height: 824, label: '1280x824' },
    { width: 1920, height: 1080, label: '1920x1080' },
  ];
  await mkdir(evidenceDir, { recursive: true });
  try {
    const { page } = fixture;
    await page.setViewportSize({ width: 1280, height: 740 });
    await waitForStableLayout(page);
    await expect(page.locator('.service-panel').nth(0).locator('.device-summary span:last-child')).toHaveText('NAS · 3 台设备');
    await expect(page.locator('.service-panel').nth(1).locator('.device-summary span:last-child')).toHaveText('NAS');
    await expect(page.locator('.service-panel').nth(0).locator('.device-summary')).toHaveAttribute('title', /NAS 只读设备/);
    await expect(page.locator('.service-panel').nth(0).locator('.device-summary')).toHaveAttribute('title', /归档节点名称非常长/);
    await expect(page.locator('.service-panel').nth(3).locator('.full-name-button')).toBeVisible();
    await expect(page.locator('.service-panel').nth(3).locator('.status-chip')).toHaveAttribute('title', /需关注/);
    await expect(page.locator('.service-panel').nth(3).locator('.log-state')).toContainText('异常');
    await expect(page.locator('.service-panel').nth(0).locator('.metric strong').nth(0)).toHaveText('97.6%');
    await expect(page.locator('.service-panel').nth(1).locator('.metric strong').nth(0)).toHaveText('0.0%');
    await expect(page.locator('.service-panel').nth(2).locator('.metric strong').nth(0)).toHaveText('未知');
    await expect(page.locator('.service-panel').nth(3).locator('.metric strong').nth(0)).toHaveText('未知');
    await expect(page.locator('.service-panel').nth(0).locator('.status-panel-items')).toContainText('论文下载');
    await expect(page.locator('.service-panel').nth(0).locator('.status-panel-items')).toContainText('最近失败已恢复');
    await expect(page.locator('.service-panel').nth(1).locator('.status-panel-items')).toContainText('工作知识库');
    await expect(page.locator('.service-panel').nth(1).locator('.status-chip')).toHaveAttribute('title', /容器正常/);
    await expect(page.locator('.service-panel').nth(1).locator('.status-panel-items')).toContainText('嵌入阶段失败');
    await expect(page.locator('.service-panel').nth(2).locator('.status-panel-items')).toContainText('Quant');
    await expect(page.locator('.service-panel').nth(2).locator('.log-state')).toHaveCount(0);
    await expect(page.locator('.service-panel').nth(2).locator('.status-chip')).toHaveClass(/status-neutral/);
    await expect(page.locator('.service-panel').nth(1).locator('.status-chip')).toHaveClass(/status-attention/);
    await expect(page.locator('.service-panel').nth(3).locator('.status-panel-empty')).toContainText('未接入');
    await expect(page.locator('.service-panel').nth(0).locator('.status-panel-item')).toHaveCount(3);
    await expect(page.locator('.service-panel').nth(1).locator('.status-panel-item')).toHaveCount(3);
    await expect(page.locator('.service-panel').nth(2).locator('.status-panel-item')).toHaveCount(3);
    await expect(page.locator('.service-panel').nth(3).locator('.status-panel-item')).toHaveCount(0);

    await page.evaluate(() => {
      const panel = document.querySelector('.service-panel');
      const log = panel?.querySelector('.log-viewer');
      if (!panel || !log) throw new Error('fixture panel/log missing');
      (window as unknown as { __fixtureRefs?: { panel: Element; log: Element } }).__fixtureRefs = { panel, log };
    });
    await setFixtureLayout(page, 'grid2x2');
    const stableIdentity = await page.evaluate(() => {
      const refs = (window as unknown as { __fixtureRefs?: { panel: Element; log: Element } }).__fixtureRefs;
      return !!refs && refs.panel === document.querySelector('.service-panel') && refs.log === document.querySelector('.service-panel .log-viewer');
    });
    expect(stableIdentity, 'layout changes should preserve panel and LogViewer node identity').toBe(true);

    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const layout of ['columns4', 'grid2x2', 'focus'] as Layout[]) {
        await setFixtureLayout(page, layout);
        await waitForStableLayout(page);
        const measurement = await measureGeometry(page, layout);
        measurements.push({ ...measurement, viewport: { width: viewport.width, height: viewport.height } });
        await assertGeometry(measurement);
        if (!(await page.locator('.service-panel').nth(1).locator('.panel-content-switch').count())) await expect(page.locator('.service-panel').nth(1).locator('.status-panel-items')).toContainText('（2 条记录）');
        for (const panel of await page.locator('.service-panel').all()) {
          const actions = await panel.locator('.panel-head-actions').evaluate((node) => [...node.querySelectorAll<HTMLElement>('button')].map((button) => ({ height: button.getBoundingClientRect().height, center: button.getBoundingClientRect().top + button.getBoundingClientRect().height / 2, align: getComputedStyle(button).alignItems, textAlign: getComputedStyle(button).textAlign })));
          expect(Math.max(...actions.map((x) => x.height)) - Math.min(...actions.map((x) => x.height))).toBeLessThanOrEqual(1);
          expect(Math.max(...actions.map((x) => x.center)) - Math.min(...actions.map((x) => x.center))).toBeLessThanOrEqual(1);
          const chip = await panel.locator('.status-chip').evaluate((node) => ({ align: getComputedStyle(node).alignItems, textAlign: getComputedStyle(node).textAlign }));
          expect(chip).toEqual({ align: 'center', textAlign: 'center' });
          await expect(panel.locator('.status-chip')).toHaveText('');
          await expect(panel.locator('.status-chip svg')).toHaveCount(1);
          expect((await panel.locator('.status-chip').boundingBox())!.width).toBe(30);
          const headerFit = await panel.evaluate((node) => {
            const meta = node.querySelector('.panel-meta')!.getBoundingClientRect();
            const member = node.querySelector('.member-summary')!.getBoundingClientRect();
            const actions = node.querySelector('.panel-head-actions')!.getBoundingClientRect();
            return { metaRight: meta.right, memberRight: member.right, actionsLeft: actions.left };
          });
          expect(headerFit.memberRight).toBeLessThanOrEqual(headerFit.metaRight + 1);
          expect(headerFit.metaRight).toBeLessThanOrEqual(headerFit.actionsLeft);
          await expect(panel.locator('.log-toolbar')).not.toContainText('无新增');
          if (await panel.locator('.focus-button').count()) {
            const focusBox = await panel.locator('.focus-button').boundingBox();
            const chipBox = await panel.locator('.status-chip').boundingBox();
            expect(focusBox!.width).toBe(chipBox!.width);
          }
          const log = panel.locator('.log-viewer');
          const contentSwitch = panel.locator('.panel-content-switch');
          if (await contentSwitch.count()) await contentSwitch.getByRole('button', { name: '日志', exact: true }).click();
          const trigger = panel.locator('.log-tools-button');
          const edge = await trigger.evaluate((node) => ({ right: node.getBoundingClientRect().right, toolbarRight: node.parentElement!.getBoundingClientRect().right }));
          expect(Math.abs(edge.right - edge.toolbarRight)).toBeLessThanOrEqual(1);
          await trigger.click();
          await expect(log).toHaveAttribute('role', 'dialog');
          await expect(log.locator('.log-close-button')).toBeVisible();
          await expect(log.locator('.log-close-button')).toBeFocused();
          const box = await log.boundingBox();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.y).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
          expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
          await log.locator('.log-close-button').click();
          await expect(log).not.toHaveAttribute('role', 'dialog');
          await expect(trigger).toBeFocused();
        }
        const screenshotPath = path.join(evidenceDir, `mixed-${viewport.label}-${layout}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: false });
        screenshots.push(screenshotPath);
      }
    }

    await page.setViewportSize({ width: 1280, height: 740 });
    await setFixtureLayout(page, 'focus', 0);
    const focusSmall = page.locator('.panel-focus-small-3');
    await focusSmall.locator('.panel-content-switch').getByRole('button', { name: '日志', exact: true }).click();
    const focusLog = focusSmall.locator('.log-viewer');
    const logBoxBeforeTools = await focusLog.boundingBox();
    const focusToolsTrigger = focusSmall.locator('.log-tools-button');
    await focusToolsTrigger.click();
    await expect(focusLog.locator('.log-controls')).toBeVisible();
    await expect(focusLog.locator('.log-diagnostics')).toContainText('最近失败');
    await expect(focusLog.locator('.log-diagnostics')).toContainText('日志读取异常');
    const timestampButton = focusLog.locator('.log-controls').getByRole('button', { name: '显示时间', exact: true });
    await timestampButton.click();
    await expect(focusLog.locator('.log-line.with-time')).toHaveCount(64);
    const logBoxAfterTools = await focusLog.boundingBox();
    expect(logBoxAfterTools!.width).toBeGreaterThan(logBoxBeforeTools!.width);
    expect(logBoxAfterTools!.height).toBeGreaterThan(logBoxBeforeTools!.height);
    const toolsRect = await focusLog.locator('.log-controls').boundingBox();
    const viewportSize = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    expect(toolsRect).not.toBeNull();
    if (toolsRect) {
      expect(toolsRect.x).toBeGreaterThanOrEqual(0);
      expect(toolsRect.y).toBeGreaterThanOrEqual(0);
      expect(toolsRect.x + toolsRect.width).toBeLessThanOrEqual(viewportSize.width + 1);
      expect(toolsRect.y + toolsRect.height).toBeLessThanOrEqual(viewportSize.height + 1);
    }
    const toolsScreenshot = path.join(evidenceDir, 'mixed-1280x740-focus-tools.png');
    await page.screenshot({ path: toolsScreenshot, fullPage: false });
    screenshots.push(toolsScreenshot);
    await page.keyboard.press('Escape');
    await expect(focusLog.locator('.log-controls')).toBeHidden();
    await expect(focusToolsTrigger).toBeFocused();

    const detailTrigger = focusSmall.locator('.detail-button');
    await detailTrigger.click();
    await expect(page.locator('.details-drawer')).toBeVisible();
    await expect(page.locator('.details-drawer')).toContainText('基础设施服务-无业务Adapter-长名称与当前故障验证');
    await expect(page.locator('.details-drawer')).toContainText('timeout');
    await expect(page.locator('.details-drawer')).toContainText('累计接收');
    await expect(page.locator('.details-drawer')).toContainText('网络口径');
    const detailsScreenshot = path.join(evidenceDir, 'mixed-1280x740-focus-details.png');
    await page.screenshot({ path: detailsScreenshot, fullPage: false });
    screenshots.push(detailsScreenshot);
    await page.keyboard.press('Escape');
    await expect(page.locator('.details-drawer')).toHaveCount(0);
    await expect(detailTrigger).toBeFocused();

    const paperDetailTrigger = page.locator('.service-panel').nth(0).locator('.service-title-button');
    await paperDetailTrigger.click();
    await expect(page.locator('.details-drawer')).toBeVisible();
    await expect(page.locator('.details-drawer')).toContainText('3.6 TB');
    await expect(page.locator('.details-drawer')).toContainText('8.2 TB');
    await expect(page.locator('.details-drawer')).toContainText('不可汇总（共享网络）');
    const paperDetailsScreenshot = path.join(evidenceDir, 'mixed-1280x740-focus-paper-details.png');
    await page.screenshot({ path: paperDetailsScreenshot, fullPage: false });
    screenshots.push(paperDetailsScreenshot);
    await page.keyboard.press('Escape');
    await expect(page.locator('.details-drawer')).toHaveCount(0);
    await expect(paperDetailTrigger).toBeFocused();

    const paperLog = page.locator('.service-panel').nth(0).locator('.log-viewer');
    await expect(paperLog.locator('.log-line.without-time')).toHaveCount(18);
    await page.locator('.service-panel').nth(0).getByRole('button', { name: '打开详细日志', exact: true }).click();
    await expect(paperLog.getByRole('combobox', { name: '选择日志来源' })).toBeVisible();
    const sourceOptions = await paperLog.getByRole('combobox', { name: '选择日志来源' }).locator('option').count();
    expect(sourceOptions).toBe(3);
    await paperLog.getByRole('combobox', { name: '选择日志来源' }).selectOption('paper-binding-archive');
    await page.keyboard.press('Escape');
    await expect(paperLog.locator('.log-controls')).toBeHidden();
    await expect(paperLog.locator('.log-line')).toHaveCount(18);

    const bottomLog = page.locator('.panel-focus-small-3 .log-viewer');
    const bottomLines = bottomLog.locator('.log-lines');
    const collapsedBeforeExpand = await measureLogSurface(page, '.panel-focus-small-3 .log-viewer');
    await bottomLines.evaluate((node) => { node.scrollTop = Math.min(5, Math.max(0, node.scrollHeight - node.clientHeight - 5)); });
    await expect.poll(async () => bottomLines.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    const anchoredBeforeExpand = await measureLogSurface(page, '.panel-focus-small-3 .log-viewer');
    await page.evaluate(() => {
      const node = document.querySelector('.panel-focus-small-3 .log-viewer');
      if (!node) throw new Error('bottom focus LogViewer missing');
      (window as unknown as { __expandLogViewer?: Element }).__expandLogViewer = node;
    });
    const ipcBeforeExpand = await page.evaluate(() => ({ ...((window as unknown as { __fixtureIpc: Record<string, number> }).__fixtureIpc) }));
    await focusToolsTrigger.click();
    await expect(bottomLog).toHaveClass(/log-expanded/);
    await waitForStableLayout(page);
    const expanded = await measureLogSurface(page, '.panel-focus-small-3 .log-viewer');
    const expandedViewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    expect(expanded.viewer.width).toBeGreaterThan(collapsedBeforeExpand.viewer.width * 1.5);
    expect(expanded.viewer.height).toBeGreaterThan(collapsedBeforeExpand.viewer.height * 1.5);
    expect(expanded.viewer.left).toBeGreaterThanOrEqual(0);
    expect(expanded.viewer.top).toBeGreaterThanOrEqual(0);
    expect(expanded.viewer.right).toBeLessThanOrEqual(expandedViewport.width + 1);
    expect(expanded.viewer.bottom).toBeLessThanOrEqual(expandedViewport.height + 1);
    expect(expanded.lines.height).toBeGreaterThan(expanded.lineHeight * 3);
    expect(expanded.lineHeight).toBeGreaterThanOrEqual(14);
    expect(expanded.completeVisibleVisualLines).toBeGreaterThanOrEqual(3);
    expect(expanded.scrollWidth).toBeLessThanOrEqual(expanded.clientWidth + 1);
    expect(expanded.text.length).toBeGreaterThan(80);
    expect(expanded.text).toContain('原始输出行');
    const ipcAfterExpand = await page.evaluate(() => ({ ...((window as unknown as { __fixtureIpc: Record<string, number> }).__fixtureIpc) }));
    const expandedScreenshot = path.join(evidenceDir, 'mixed-1280x740-focus-expanded.png');
    await page.screenshot({ path: expandedScreenshot, fullPage: false });
    screenshots.push(expandedScreenshot);
    interactions.expandCollapse = { collapsedBeforeExpand, anchoredBeforeExpand, expanded, ipcBeforeExpand, ipcAfterExpand };
    expect(expanded.anchor?.id).toBe(anchoredBeforeExpand.anchor?.id);
    expect(Math.abs((expanded.anchor?.offset ?? 0) - (anchoredBeforeExpand.anchor?.offset ?? 0))).toBeLessThanOrEqual(2);
    expect(ipcAfterExpand.openLog).toBe(ipcBeforeExpand.openLog);
    expect(ipcAfterExpand.closeLog).toBe(ipcBeforeExpand.closeLog);
    await bottomLog.getByRole('button', { name: '关闭日志', exact: true }).click();
    await expect(bottomLog).not.toHaveClass(/log-expanded/);
    await waitForStableLayout(page);
    const collapsedAfterExpand = await measureLogSurface(page, '.panel-focus-small-3 .log-viewer');
    const sameLogViewerNode = await page.evaluate(() => {
      const remembered = (window as unknown as { __expandLogViewer?: Element }).__expandLogViewer;
      return !!remembered && remembered === document.querySelector('.panel-focus-small-3 .log-viewer');
    });
    const ipcAfterCollapse = await page.evaluate(() => ({ ...((window as unknown as { __fixtureIpc: Record<string, number> }).__fixtureIpc) }));
    expect(sameLogViewerNode, 'expand/collapse must preserve LogViewer node identity').toBe(true);
    expect(collapsedAfterExpand.viewer.width).toBeCloseTo(collapsedBeforeExpand.viewer.width, 0);
    expect(collapsedAfterExpand.viewer.height).toBeCloseTo(collapsedBeforeExpand.viewer.height, 0);
    expect(collapsedAfterExpand.anchor?.id).toBe(anchoredBeforeExpand.anchor?.id);
    expect(Math.abs((collapsedAfterExpand.anchor?.offset ?? 0) - (anchoredBeforeExpand.anchor?.offset ?? 0))).toBeLessThanOrEqual(2);
    expect(ipcAfterCollapse.openLog).toBe(ipcBeforeExpand.openLog);
    expect(ipcAfterCollapse.closeLog).toBe(ipcBeforeExpand.closeLog);
    interactions.expandCollapse = { collapsedBeforeExpand, anchoredBeforeExpand, expanded, collapsedAfterExpand, ipcBeforeExpand, ipcAfterExpand, ipcAfterCollapse, sameLogViewerNode };
    await page.keyboard.press('Escape');
    await expect(bottomLog.locator('.log-controls')).toBeHidden();
    await expect(focusToolsTrigger).toBeFocused();
  } finally {
    const receipt = { fixture: 'isolated-esbuild-production-components', screenshots, measurements, interactions, generatedAt: new Date().toISOString() };
    await writeFile(path.join(evidenceDir, 'panel-refinement-measurements.json'), `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fixture.app.close();
    await rm(fixture.dataRoot, { recursive: true, force: true });
  }
});

test('native fullscreen and windowed mode retain readable panel composition in all layouts', async () => {
  test.setTimeout(90_000);
  const fixture = await launchIsolatedFixture();
  const results: { fullscreen: boolean; measurement: GeometryMeasurement }[] = [];
  const output = path.join(root, '.ai-bridge/evidence/fullscreen-layout');
  await mkdir(output, { recursive: true });
  try {
    const { app, page } = fixture;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 740));
    for (const fullscreen of [false, true, false]) {
      await app.evaluate(async ({ BrowserWindow }, next) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        if (window.isFullScreen() === next) return;
        await new Promise<void>((resolve) => {
          if (next) window.once('enter-full-screen', () => resolve());
          else window.once('leave-full-screen', () => resolve());
          window.setFullScreen(next);
        });
      }, fullscreen);
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFullScreen())).toBe(fullscreen);
      for (const layout of ['columns4', 'grid2x2', 'focus'] as Layout[]) {
        await setFixtureLayout(page, layout);
        await waitForStableLayout(page);
        const measurement = await measureGeometry(page, layout);
        results.push({ fullscreen, measurement });
        await assertGeometry(measurement);
        for (const panel of measurement.panels) {
          expect(panel.panel.bottom).toBeLessThanOrEqual(measurement.viewport.height + 1);
          expect(panel.metrics.bottom).toBeLessThanOrEqual(Math.min(...[panel.status, panel.logModule].filter((box) => box.height > 0).map((box) => box.top)));
          expect(panel.head.bottom).toBeLessThanOrEqual(panel.metrics.top);
        }
        if (fullscreen) await page.screenshot({ path: path.join(output, `native-${layout}.png`) });
      }
    }
  } finally {
    await writeFile(path.join(output, 'native-measurements.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
    await fixture.app.close();
    await rm(fixture.dataRoot, { recursive: true, force: true });
  }
});

test('narrow cards switch full-width summaries and logs without losing log state', async () => {
  const fixture = await launchIsolatedFixture();
  try {
    const { page } = fixture;
    await page.setViewportSize({ width: 1280, height: 740 });
    await setFixtureLayout(page, 'focus');
    const panel = page.locator('.panel-focus-small-2');
    const controls = panel.getByRole('group', { name: /卡片内容/ });
    await expect(controls.getByRole('button', { name: '业务', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.locator('.log-viewer')).toBeHidden();
    await expect(panel.locator('.status-panel-item')).toHaveCount(1);
    await expect(panel.locator('.status-collected-at')).toContainText('最近采集：');
    await expect(panel.locator('.status-result-warning')).toContainText('以下为上次结果');
    const statusBox = await panel.locator('.status-timeline').boundingBox();
    const panelBox = await panel.boundingBox();
    const titleBox = await panel.locator('.service-title-button').boundingBox();
    const metaBox = await panel.locator('.panel-meta').boundingBox();
    const actionsBox = await panel.locator('.panel-head-actions').boundingBox();
    expect(Math.abs((titleBox!.y + titleBox!.height / 2) - (metaBox!.y + metaBox!.height / 2))).toBeLessThanOrEqual(2);
    expect(metaBox!.x + metaBox!.width).toBeLessThanOrEqual(actionsBox!.x);
    expect(titleBox!.x + titleBox!.width).toBeLessThanOrEqual(metaBox!.x);
    expect((await panel.locator('.panel-head').boundingBox())!.height).toBeLessThanOrEqual(34);
    expect(statusBox!.width).toBeGreaterThan(panelBox!.width * 0.9);
    await controls.getByRole('button', { name: '日志', exact: true }).click();
    const log = panel.locator('.log-viewer');
    await expect(log).toBeVisible();
    await expect(panel.locator('.status-timeline')).toBeHidden();
    await expect(log.locator('.log-toolbar')).toHaveCount(0);
    const toolbar = controls.locator('.log-toolbar');
    await expect(toolbar).toBeVisible();
    const tabBox = await controls.getByRole('button', { name: '日志', exact: true }).boundingBox();
    const toolBox = await controls.getByRole('button', { name: '打开详细日志', exact: true }).boundingBox();
    expect(Math.abs((tabBox!.y + tabBox!.height / 2) - (toolBox!.y + toolBox!.height / 2))).toBeLessThanOrEqual(3);
    await controls.getByRole('button', { name: '打开详细日志', exact: true }).click();
    await expect(log).toHaveClass(/log-expanded/);
    await log.getByRole('button', { name: '关闭日志', exact: true }).click();
    await expect(controls.getByRole('button', { name: '打开详细日志', exact: true })).toBeFocused();
    const logBox = await log.boundingBox();
    expect(logBox!.width).toBeGreaterThan(panelBox!.width * 0.9);
    await log.locator('.log-lines').evaluate((node) => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
    await page.evaluate(() => { Object.assign(window, { __tabLog: document.querySelector('.panel-focus-small-2 .log-viewer') }); });
    const before = await page.evaluate(() => ({ ...((window as unknown as { __fixtureIpc: Record<string, number> }).__fixtureIpc) }));
    await controls.getByRole('button', { name: '业务', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __fixtureIpc: Record<string, number> }).__fixtureIpc.pollLog)).toBeGreaterThanOrEqual(before.pollLog! + 4);
    await controls.getByRole('button', { name: '日志', exact: true }).click();
    await expect(log.locator('.log-lines')).toHaveJSProperty('scrollTop', 0);
    expect(await page.evaluate(() => (window as unknown as { __tabLog: Element }).__tabLog === document.querySelector('.panel-focus-small-2 .log-viewer'))).toBe(true);
    const after = await page.evaluate(() => ({ ...((window as unknown as { __fixtureIpc: Record<string, number> }).__fixtureIpc) }));
    expect(after.openLog).toBe(before.openLog);
    expect(after.closeLog).toBe(before.closeLog);
    await controls.getByRole('button', { name: '业务', exact: true }).click();
    await expect(page.getByRole('button', { name: '展开业务详情' })).toHaveCount(0);
    const cardDetails = panel.locator('.panel-head-actions .detail-button');
    await cardDetails.click();
    await expect(page.locator('.details-drawer')).toBeVisible();
    await expect(page.locator('.details-drawer')).toContainText('Quant任务历史失败');
    await page.keyboard.press('Escape');
    await expect(page.locator('.details-drawer')).toHaveCount(0);
    await expect(cardDetails).toBeFocused();
  } finally {
    await fixture.app.close();
    await rm(fixture.dataRoot, { recursive: true, force: true });
  }
});
