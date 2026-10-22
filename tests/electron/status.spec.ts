import { _electron as electron, expect, test } from '@playwright/test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const electronPath = require('electron') as string;
const containerId = 'a'.repeat(64);

test('status IPC receives an isolated Docker observation without enlarging bootstrap', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-status-'));
  const fixturePath = path.join(dataRoot, 'docker-fixture.mjs');
  const wrapperPath = path.join(dataRoot, 'docker-fixture');
  const profilePath = path.join(dataRoot, 'profile.json');
  const sourceAt = '2026-10-21T09:00:00.000Z';
  const fixture = `
const id = ${JSON.stringify(containerId)};
const sourceAt = ${JSON.stringify(sourceAt)};
const args = process.argv.slice(2);
const command = args.find((value) => ['version', 'ps', 'inspect', 'stats', 'logs'].includes(value));
const idsAfterFormat = () => { const marker = args.indexOf('--format'); return marker >= 0 ? args.slice(marker + 2) : []; };
if (command === 'version') process.stdout.write('29.1.3\\n');
else if (command === 'ps') process.stdout.write([id, '/fixture-worker', 'fixture:latest', 'running', 'Up 1 hour', sourceAt, '1 hour', '', 'bridge', 'fixture', 'worker', '1'].map(JSON.stringify).join('\\t') + '\\n');
else if (command === 'inspect') process.stdout.write(idsAfterFormat().map((value) => [value, '/fixture-worker', 'fixture:latest', 'running', 'healthy', sourceAt, '0001-01-01T00:00:00Z', '0', '0', 'false', 'bridge'].map(JSON.stringify).join('\\t')).join('\\n') + '\\n');
else if (command === 'stats') process.stdout.write(idsAfterFormat().map((value) => JSON.stringify({ Container: value.slice(0, 12), CPUPerc: '1.0%', MemUsage: '1MiB / 1GiB', NetIO: '1kB / 2kB', PIDs: '1' })).join('\\n') + '\\n');
else if (command === 'logs') process.stdout.write(sourceAt + ' fixture log\\n');
else process.exitCode = 2;
`;
  await writeFile(fixturePath, fixture, { encoding: 'utf8', mode: 0o600 });
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(wrapperPath, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fixturePath)} "$@"\n`, { encoding: 'utf8', mode: 0o700 });
  await chmod(wrapperPath, 0o700);
  await writeFile(profilePath, `${JSON.stringify({ id: 'fixture-profile', kind: 'local', context: 'desktop-linux', dockerPath: wrapperPath })}\n`, { encoding: 'utf8', mode: 0o600 });
  const service = {
    id: 'fixture-service',
    name: '隔离容器服务',
    category: '基础设施',
    bindings: [{ id: 'fixture-binding', deviceId: 'fixture-device', selector: { kind: 'container_id' as const, value: containerId }, required: true, expectedPolicy: 'continuous' as const }],
    businessAdapter: { kind: 'none' as const },
    statusAdapter: { kind: 'none' as const },
  };
  const config = {
    schemaVersion: 1,
    devices: [{ id: 'fixture-device', name: '隔离设备', transport: 'local' as const, profileId: 'fixture-profile', enabled: true }],
    services: [service],
    slots: [{ serviceId: service.id, logBindingId: null }, { serviceId: null, logBindingId: null }, { serviceId: null, logBindingId: null }, { serviceId: null, logBindingId: null }],
    display: { layout: 'columns4' as const, focusSlot: 0, asciiMode: 'static' as const, asciiBrightness: 50, asciiStrength: 50, reducedMotion: true },
    window: null,
  };
  await writeFile(path.join(dataRoot, 'profiles.private.json'), `${JSON.stringify({ schemaVersion: 1, profiles: [{ id: 'fixture-profile', displayName: '隔离设备', kind: 'local', sourcePath: profilePath, importedAt: new Date().toISOString() }] })}\n`, { encoding: 'utf8', mode: 0o600 });
  await writeFile(path.join(dataRoot, 'config.json'), `${JSON.stringify(config)}\n`, { encoding: 'utf8', mode: 0o600 });
  const app = await electron.launch({ executablePath: electronPath, args: [root], env: { ...process.env, SERVICE_OBSERVATORY_DATA_DIR: dataRoot } });
  try {
    const page = await app.firstWindow();
    const readReceipt = () => page.evaluate(async () => {
      const boot = await window.observatory.bootstrap();
      if (!boot.ok) return { records: -1, evidence: null, feed: null };
      const result = await window.observatory.getStatusPage(boot.value.snapshot.windowEpoch, 'fixture-service', undefined, 40);
      if (!result.ok) return { records: -1, evidence: null, feed: null };
      return { records: result.value.records.length, evidence: result.value.records[0]?.evidenceKind ?? null, feed: result.value.feeds.find((item) => item.sourceRef === 'docker:fixture-device')?.health ?? null };
    });
    await expect.poll(async () => (await readReceipt()).records, { timeout: 30_000 }).toBeGreaterThan(0);
    const receipt = await readReceipt();
    expect(receipt.records).toBeGreaterThan(0);
    expect(receipt.evidence).toBe('container_observation');
    expect(receipt.feed).toBe('fresh');
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('status IPC keeps HTTP business evidence bounded at the preload boundary', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-status-http-'));
  const profilePath = path.join(dataRoot, 'http-profile.json');
  const server = createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify([
      {
        id: 'https://user:secret@10.0.0.7/private/event?token=fixture',
        taskKey: 'https://user:secret@10.0.0.7/private/task?token=fixture',
        stage: 'archive',
        outcome: 'succeeded',
        occurredAt: '2026-10-21T09:00:00.000Z',
        evidenceKind: 'business_event',
        evidenceRef: '/Users/fixture/private/receipt-token',
        summary: 'https://user:secret@10.0.0.7/private/summary?token=fixture',
        facts: {
          completed: 3,
          total: 5,
          status: 'succeeded',
          note: '/Users/fixture/private/notes',
          token: 'fixture-token',
          taskStatus: 'https://private.invalid/task',
        },
      },
      {
        id: 'fixture-failed-event',
        taskKey: 'fixture-task-2',
        stage: 'https://10.0.0.7/private/stage',
        outcome: 'failed',
        occurredAt: '2026-10-21T09:00:01.000Z',
        evidenceKind: 'stage_receipt',
        evidenceRef: 'fixture-evidence-2',
        summary: 'private stage summary',
        facts: { failed: 1, total: 1 },
      },
    ]));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture HTTP server did not expose a port');
  const endpoint = `http://127.0.0.1:${address.port}/fixture-status`;
  const service = {
    id: 'fixture-http-service',
    name: '隔离 HTTP 状态源',
    category: '论文下载',
    bindings: [],
    businessAdapter: { kind: 'none' as const },
    statusAdapter: { kind: 'http_json' as const, profileId: 'fixture-http-profile', endpointRef: 'fixture-status', mapping: {} },
  };
  const config = {
    schemaVersion: 1,
    devices: [],
    services: [service],
    slots: [{ serviceId: service.id, logBindingId: null }, { serviceId: null, logBindingId: null }, { serviceId: null, logBindingId: null }, { serviceId: null, logBindingId: null }],
    display: { layout: 'columns4' as const, focusSlot: 0, asciiMode: 'off' as const, asciiBrightness: 50, asciiStrength: 50, reducedMotion: true },
    window: null,
  };
  await writeFile(profilePath, `${JSON.stringify({ id: 'fixture-http-profile', kind: 'local', context: 'desktop-linux', statusEndpoints: { 'fixture-status': endpoint } })}\n`, { encoding: 'utf8', mode: 0o600 });
  await writeFile(path.join(dataRoot, 'profiles.private.json'), `${JSON.stringify({ schemaVersion: 1, profiles: [{ id: 'fixture-http-profile', displayName: '隔离 HTTP 源', kind: 'local', sourcePath: profilePath, importedAt: new Date().toISOString() }] })}\n`, { encoding: 'utf8', mode: 0o600 });
  await writeFile(path.join(dataRoot, 'config.json'), `${JSON.stringify(config)}\n`, { encoding: 'utf8', mode: 0o600 });
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ executablePath: electronPath, args: [root], env: { ...process.env, SERVICE_OBSERVATORY_DATA_DIR: dataRoot } });
    const page = await app.firstWindow();
    const readPage = () => page.evaluate(async () => {
      const boot = await window.observatory.bootstrap();
      if (!boot.ok) return null;
      const result = await window.observatory.getStatusPage(boot.value.snapshot.windowEpoch, 'fixture-http-service', undefined, 40);
      return result.ok ? result.value : null;
    });
    await expect.poll(async () => (await readPage())?.records.length ?? -1, { timeout: 30_000 }).toBe(2);
    const statusPage = await readPage();
    if (!statusPage) throw new Error('status:get-page did not return a page through preload');
    const succeeded = statusPage.records.find((record) => record.outcome === 'succeeded');
    const failed = statusPage.records.find((record) => record.outcome === 'failed');
    expect(succeeded).toMatchObject({ stage: '归档', summary: '归档：已完成（3/5）', facts: { completed: 3, total: 5, status: 'succeeded' } });
    expect(succeeded?.id).toMatch(/^event-[0-9a-f]{24}$/);
    expect(succeeded?.taskKey).toMatch(/^task-[0-9a-f]{24}$/);
    expect(succeeded?.evidenceRef).toBe('evidence');
    expect(failed).toMatchObject({ stage: '状态记录', summary: '状态记录：失败', facts: { failed: 1, total: 1 } });
    expect(JSON.stringify(statusPage)).not.toContain('10.0.0.7');
    expect(JSON.stringify(statusPage)).not.toContain('/Users/fixture');
    expect(JSON.stringify(statusPage)).not.toContain('secret');
    expect(JSON.stringify(statusPage)).not.toContain('token');
    expect(JSON.stringify(statusPage)).not.toContain('private stage summary');
  } finally {
    await app?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dataRoot, { recursive: true, force: true });
  }
});
