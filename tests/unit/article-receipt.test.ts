import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { StatusAdapterSchema } from '../../src/shared/contracts.js';
import { ARTICLE_RECEIPT_PYTHON, parseRemoteArticleReceiptRead, type RemoteArticleReceiptRead } from '../../src/main/transport/article-receipts.js';
import { ArticleReceiptJsonReader } from '../../src/main/status/article-receipt-json.js';
import { StatusManager } from '../../src/main/status/manager.js';

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const fileName = (value: number) => value.toString(16).padStart(64, '0');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runFixedReader(root: string, canonicalize = true): Promise<Record<string, unknown>> {
  const script = path.join(root, 'fixed-reader.py');
  await writeFile(script, ARTICLE_RECEIPT_PYTHON, { mode: 0o700 });
  const readerRoot = canonicalize ? await realpath(root) : root;
  const result = await execFile('/usr/bin/python3', [script, readerRoot], { maxBuffer: 1024 * 1024 });
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-article-receipts-'));
  roots.push(root);
  await Promise.all(['jobs', 'research-requests', 'research-queue'].map((directory) => mkdir(path.join(root, directory))));
  return root;
}

describe('ArticleDownloader receipt source', () => {
  it('accepts only the fixed adapter contract and maps independent business evidence', async () => {
    const adapter = StatusAdapterSchema.parse({ kind: 'article_receipt_json', profileId: 'nas', sourceRef: 'article-receipts' });
    if (adapter.kind !== 'article_receipt_json') throw new Error('adapter fixture invalid');
    const remote: RemoteArticleReceiptRead = {
      strictReader: true,
      complete: true,
      truncated: false,
      totalBytes: 3,
      directoryCounts: { jobs: 1, 'research-requests': 1, 'research-queue': 1 },
      errorCode: null,
      files: [
        {
          directory: 'research-requests',
          fileName: `${fileName(1)}.json`,
          bytes: 1,
          sourceAt: '2026-10-18T00:00:00.000Z',
          payload: {
            request_id: fileName(1),
            dois: ['10.1000/alpha', '10.1000/beta'],
            result: {
              request_id: fileName(1),
              status: 'completed',
              completed_at: '2026-10-18T01:02:03Z',
              papers: [
                { doi: '10.1000/alpha', status: 'completed', archived: true, zotero_status: 'synced', steps: { github: 'succeeded' }, github_commit: 'a'.repeat(40) },
                { doi: '10.1000/beta', status: 'failed', archived: false, zotero_status: 'retry_pending', steps: { github: 'succeeded' } },
              ],
            },
          },
        },
        {
          directory: 'jobs',
          fileName: `${fileName(3)}.json`,
          bytes: 1,
          sourceAt: '2026-10-18T00:00:01.000Z',
          payload: { id: fileName(3), status: 'failed', last_result: { status: 'downloaded', archived: true, zotero_status: 'retry_pending' } },
        },
        {
          directory: 'research-queue',
          fileName: `${fileName(5)}.json`,
          bytes: 1,
          sourceAt: '2026-10-18T00:00:02.000Z',
          payload: { id: fileName(5), steps: { github: 'succeeded', reading: 'running' }, paper_id: 'P-abcdef123456' },
        },
      ],
    };
    let receivedProfile = '';
    let receivedSource = '';
    const reader = new ArticleReceiptJsonReader(
      async (profileId, sourceRef) => { receivedProfile = profileId; receivedSource = sourceRef; return { profileId, sourceRef, rootPath: '/private/receipt-root' }; },
      async () => ({ transport: { kind: 'ssh', readArticleReceipts: async () => remote, close: async () => undefined } as never, release: () => undefined }),
    );
    const result = await reader.readSnapshots(adapter.profileId, adapter.sourceRef, undefined, new Date('2026-10-21T00:00:00Z'));
    expect(receivedProfile).toBe('nas');
    expect(receivedSource).toBe('article-receipts');
    expect(result.health).toBe('fresh');
    expect(result.records.some((record) => record.stage === '分组结果' && record.outcome === 'partial')).toBe(true);
    expect(result.records.some((record) => record.stage === 'GitHub同步' && record.outcome === 'partial')).toBe(true);
    expect(result.records.some((record) => record.stage === '下载任务' && record.outcome === 'succeeded')).toBe(true);
    expect(result.records.some((record) => record.stage === '任务结果' && record.outcome === 'failed')).toBe(true);
    expect(result.records.some((record) => record.stage === 'NAS归档' && record.outcome === 'succeeded')).toBe(true);
    expect(result.records.some((record) => record.stage === 'Zotero入库' && record.outcome === 'partial')).toBe(true);
    expect(result.records.every((record) => record.sourceAt !== null && Number.isFinite(Date.parse(record.observedAt)) && Date.parse(record.sourceAt) <= Date.parse(record.observedAt))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('abcdef');
  });

  it('maps explicit pending jobs and queue steps as waiting, without inventing pending', async () => {
    const jobId = fileName(30);
    const queueId = fileName(31);
    const remote: RemoteArticleReceiptRead = {
      strictReader: true,
      complete: true,
      truncated: false,
      totalBytes: 2,
      directoryCounts: { jobs: 1, 'research-requests': 0, 'research-queue': 1 },
      errorCode: null,
      files: [
        { directory: 'jobs', fileName: `${jobId}.json`, bytes: 1, sourceAt: '2026-10-18T00:00:00.000Z', payload: { id: jobId, status: 'pending' } },
        { directory: 'research-queue', fileName: `${queueId}.json`, bytes: 1, sourceAt: '2026-10-18T00:00:01.000Z', payload: { id: queueId, steps: { download: 'pending' } } },
      ],
    };
    const reader = new ArticleReceiptJsonReader(
      async () => ({ profileId: 'nas', sourceRef: 'article-receipts', rootPath: '/private/receipts' }),
      async () => ({ transport: { kind: 'ssh', readArticleReceipts: async () => remote, close: async () => undefined } as never, release: () => undefined }),
    );
    const result = await reader.readSnapshots('nas', 'article-receipts');
    const pendingRecords = result.records.filter((record) => record.facts.taskStatus === 'pending');
    expect(pendingRecords).toHaveLength(2);
    expect(pendingRecords.every((record) => record.outcome === 'active')).toBe(true);
    expect(pendingRecords.map((record) => record.summary)).toEqual(expect.arrayContaining(['下载任务：等待处理', '下载：等待处理']));

    const incompleteRemote: RemoteArticleReceiptRead = {
      ...remote,
      files: [
        { directory: 'jobs', fileName: `${jobId}.json`, bytes: 1, sourceAt: null, payload: { id: jobId } },
        { directory: 'research-queue', fileName: `${queueId}.json`, bytes: 1, sourceAt: null, payload: { id: queueId, steps: {} } },
      ],
    };
    const incompleteReader = new ArticleReceiptJsonReader(
      async () => ({ profileId: 'nas', sourceRef: 'article-receipts', rootPath: '/private/receipts' }),
      async () => ({ transport: { kind: 'ssh', readArticleReceipts: async () => incompleteRemote, close: async () => undefined } as never, release: () => undefined }),
    );
    const incomplete = await incompleteReader.readSnapshots('nas', 'article-receipts');
    expect(incomplete.errorCode).toBe('status_incomplete');
    expect(incomplete.records.some((record) => record.facts.taskStatus === 'pending')).toBe(false);
    expect(incomplete.records).toContainEqual(expect.objectContaining({ stage: '处理队列', outcome: 'unknown', summary: '处理队列：状态未知', facts: { taskStatus: null, activityState: 'unknown' } }));
  });

  it('keeps Zotero status outcomes and does not invent a completion time', async () => {
    const expected = [
      { status: 'failed', outcome: 'failed', summary: 'Zotero入库：失败' },
      { status: 'pending', outcome: 'active', summary: 'Zotero入库：等待处理' },
      { status: 'unknown', outcome: 'unknown', summary: 'Zotero入库：状态未知' },
    ] as const;
    const remote: RemoteArticleReceiptRead = {
      strictReader: true,
      complete: true,
      truncated: false,
      totalBytes: expected.length,
      directoryCounts: { jobs: expected.length, 'research-requests': 0, 'research-queue': 0 },
      errorCode: null,
      files: expected.map((item, index) => {
        const id = fileName(32 + index);
        return {
          directory: 'jobs' as const,
          fileName: `${id}.json`,
          bytes: 1,
          sourceAt: '2026-10-18T00:00:00.000Z',
          payload: { id, status: 'downloaded', last_result: { status: 'downloaded', zotero_status: item.status } },
        };
      }),
    };
    const reader = new ArticleReceiptJsonReader(
      async () => ({ profileId: 'nas', sourceRef: 'article-receipts', rootPath: '/private/receipts' }),
      async () => ({ transport: { kind: 'ssh', readArticleReceipts: async () => remote, close: async () => undefined } as never, release: () => undefined }),
    );

    const result = await reader.readSnapshots('nas', 'article-receipts', undefined, new Date('2026-10-21T00:00:00Z'));
    const zoteroRecords = result.records.filter((record) => record.stage === 'Zotero入库');
    expect(zoteroRecords).toHaveLength(expected.length);
    for (const item of expected) {
      const record = zoteroRecords.find((candidate) => candidate.facts.status === item.status);
      expect(record).toMatchObject({
        outcome: item.outcome,
        summary: item.summary,
        occurredAt: null,
        sourceAt: '2026-10-18T00:00:00.000Z',
        facts: { status: item.status, confirmed: false },
      });
      expect(record?.observedAt).toEqual(expect.any(String));
      expect(Number.isFinite(Date.parse(record?.observedAt ?? ''))).toBe(true);
    }
  });

  it('keeps valid receipt records when files have invalid extreme or textual dates', async () => {
    const validId = fileName(34);
    const invalidPositiveId = fileName(35);
    const invalidNegativeId = fileName(36);
    const invalidStringId = fileName(37);
    const remote: RemoteArticleReceiptRead = {
      strictReader: true,
      complete: true,
      truncated: false,
      totalBytes: 4,
      directoryCounts: { jobs: 4, 'research-requests': 0, 'research-queue': 0 },
      errorCode: null,
      files: [
        { directory: 'jobs', fileName: `${validId}.json`, bytes: 1, sourceAt: '2026-10-18T00:00:00.000Z', payload: { id: validId, status: 'pending' } },
        { directory: 'jobs', fileName: `${invalidPositiveId}.json`, bytes: 1, sourceAt: '2026-10-18T00:00:01.000Z', payload: { id: invalidPositiveId, status: 'completed', last_result: { status: 'completed', completed_at: Number.MAX_VALUE } } },
        { directory: 'jobs', fileName: `${invalidNegativeId}.json`, bytes: 1, sourceAt: '2026-10-18T00:00:02.000Z', payload: { id: invalidNegativeId, status: 'failed', failed_at: -Number.MAX_VALUE } },
        { directory: 'jobs', fileName: `${invalidStringId}.json`, bytes: 1, sourceAt: '2026-10-18T00:00:03.000Z', payload: { id: invalidStringId, status: 'completed', finished_at: 'not-a-date' } },
      ],
    };
    const reader = new ArticleReceiptJsonReader(
      async () => ({ profileId: 'nas', sourceRef: 'article-receipts', rootPath: '/private/receipts' }),
      async () => ({ transport: { kind: 'ssh', readArticleReceipts: async () => remote, close: async () => undefined } as never, release: () => undefined }),
    );

    const result = await reader.readSnapshots('nas', 'article-receipts', undefined, new Date('2026-10-21T00:00:00Z'));
    expect(result.health).toBe('error');
    expect(result.errorCode).toBe('status_incomplete');
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ taskKey: validId, outcome: 'active', summary: '下载任务：等待处理' });
  });

  it('converts source resolver failures and cleanup failures to bounded source errors', async () => {
    const failingResolver = new ArticleReceiptJsonReader(
      async () => { throw new Error('fixture resolver failure'); },
      async () => ({ transport: { kind: 'ssh', readArticleReceipts: async () => { throw new Error('unreachable'); }, close: async () => undefined } as never, release: () => undefined }),
    );
    await expect(failingResolver.readSnapshots('nas', 'article-receipts')).resolves.toMatchObject({ health: 'error', errorCode: 'status_source', records: [] });

    const remote: RemoteArticleReceiptRead = {
      strictReader: true,
      complete: true,
      truncated: false,
      totalBytes: 0,
      directoryCounts: { jobs: 0, 'research-requests': 0, 'research-queue': 0 },
      errorCode: null,
      files: [],
    };
    const cleanupFailure = new ArticleReceiptJsonReader(
      async () => ({ profileId: 'nas', sourceRef: 'article-receipts', rootPath: '/private/receipts' }),
      async () => ({ transport: { kind: 'ssh', readArticleReceipts: async () => remote, close: async () => undefined } as never, release: async () => { throw new Error('fixture cleanup failure'); } }),
    );
    await expect(cleanupFailure.readSnapshots('nas', 'article-receipts')).resolves.toMatchObject({ health: 'fresh', errorCode: null, records: [] });

    const managerAdapter = StatusAdapterSchema.parse({ kind: 'article_receipt_json', profileId: 'nas', sourceRef: 'article-receipts' });
    const manager = new StatusManager({ resolveEndpoint: async () => undefined, createArticleReader: () => { throw new Error('fixture reader factory failure'); } });
    await manager.readConfigured([{ id: 'reader-factory-failure', name: '回执源', category: '论文下载', bindings: [], businessAdapter: { kind: 'none' }, statusAdapter: managerAdapter }], new Date('2026-10-21T00:00:00Z'));
    expect(manager.page('reader-factory-failure', undefined).feeds).toContainEqual(expect.objectContaining({ health: 'error', errorCode: 'status_source' }));
  });

  it('shares concurrent reads by profile and source reference', async () => {
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    let calls = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const remote: RemoteArticleReceiptRead = {
      strictReader: true,
      complete: true,
      truncated: false,
      totalBytes: 0,
      directoryCounts: { jobs: 0, 'research-requests': 0, 'research-queue': 0 },
      errorCode: null,
      files: [],
    };
    const reader = new ArticleReceiptJsonReader(
      async () => ({ profileId: 'nas', sourceRef: 'article-receipts', rootPath: '/private/receipts' }),
      async () => ({ transport: { kind: 'ssh', readArticleReceipts: async () => { calls += 1; started?.(); await gate; return remote; }, close: async () => undefined } as never, release: () => undefined }),
    );
    const first = reader.readSnapshots('nas', 'article-receipts');
    await startedPromise;
    const second = reader.readSnapshots('nas', 'article-receipts');
    expect(calls).toBe(1);
    release?.();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it('deduplicates snapshot-only changes, versions changed stages, and keeps A-B-A history', async () => {
    const jobId = fileName(40);
    const queueId = fileName(41);
    const sourceAt = (minute: number) => `2026-10-21T00:${minute.toString().padStart(2, '0')}:00.000Z`;
    const job = (fileSourceAt: string): RemoteArticleReceiptRead['files'][number] => ({
      directory: 'jobs',
      fileName: `${jobId}.json`,
      bytes: 1,
      sourceAt: fileSourceAt,
      payload: { id: jobId, status: 'downloaded', last_result: { status: 'downloaded', archived: true, zotero_status: 'synced' } },
    });
    const queue = (fileSourceAt: string, updatedAt: string, steps: Record<string, string>, extra: Record<string, unknown> = {}): RemoteArticleReceiptRead['files'][number] => ({
      directory: 'research-queue',
      fileName: `${queueId}.json`,
      bytes: 1,
      sourceAt: fileSourceAt,
      payload: { id: queueId, steps, updated_at: updatedAt, ...extra },
    });
    let remote: RemoteArticleReceiptRead = {
      strictReader: true,
      complete: true,
      truncated: false,
      totalBytes: 2,
      directoryCounts: { jobs: 1, 'research-requests': 0, 'research-queue': 1 },
      errorCode: null,
      files: [job(sourceAt(0)), queue(sourceAt(0), sourceAt(0), { download: 'pending', zotero: 'pending' })],
    };
    const reader = new ArticleReceiptJsonReader(
      async () => ({ profileId: 'nas', sourceRef: 'article-receipts', rootPath: '/private/receipts' }),
      async () => ({ transport: { kind: 'ssh', readArticleReceipts: async () => remote, close: async () => undefined } as never, release: () => undefined }),
    );
    const adapter = StatusAdapterSchema.parse({ kind: 'article_receipt_json', profileId: 'nas', sourceRef: 'article-receipts' });
    const service = { id: 'article-history', name: '论文历史', category: '论文下载', bindings: [], businessAdapter: { kind: 'none' as const }, statusAdapter: adapter };
    const manager = new StatusManager({ resolveEndpoint: async () => undefined, createArticleReader: () => reader });

    await manager.readConfigured([service], new Date(sourceAt(0)));
    expect(manager.page(service.id, undefined, 40).records).toHaveLength(5);
    const first = manager.page(service.id, undefined, 40).records;
    expect(first.filter((record) => record.stage === 'NAS归档' || record.stage === 'Zotero入库').every((record) => record.occurredAt === null)).toBe(true);
    expect(first.filter((record) => record.sourceRef.startsWith('article_receipt_json:') && record.taskKey?.startsWith(`${queueId}:`)).every((record) => record.occurredAt === null)).toBe(true);

    remote = { ...remote, files: [job(sourceAt(1)), queue(sourceAt(1), sourceAt(1), { download: 'pending', zotero: 'pending' })] };
    await manager.readConfigured([service], new Date(sourceAt(1)));
    expect(manager.page(service.id, undefined, 40).records).toHaveLength(5);

    remote = { ...remote, files: [job(sourceAt(2)), queue(sourceAt(2), sourceAt(2), { download: 'completed', zotero: 'pending' })] };
    await manager.readConfigured([service], new Date(sourceAt(2)));
    remote = { ...remote, files: [job(sourceAt(3)), queue(sourceAt(3), sourceAt(3), { download: 'pending', zotero: 'pending' })] };
    await manager.readConfigured([service], new Date(sourceAt(3)));
    const afterReturn = manager.page(service.id, undefined, 40).records;
    const downloads = afterReturn.filter((record) => record.stage === '下载');
    expect(downloads).toHaveLength(3);
    expect(new Set(downloads.map((record) => record.id)).size).toBe(3);
    expect(downloads[0]).toMatchObject({ outcome: 'active', occurredAt: null });
    expect(afterReturn.filter((record) => record.stage === 'Zotero入库' && record.taskKey?.startsWith(`${queueId}:`))).toHaveLength(1);

    remote = { ...remote, files: [job(sourceAt(4)), queue(sourceAt(4), sourceAt(4), { download: 'pending', zotero: 'pending', github: 'pending' }, { paper_id: 'P-abcdef123456' })] };
    await manager.readConfigured([service], new Date(sourceAt(4)));
    const beforeGithubChange = manager.page(service.id, undefined, 40).records;
    expect(beforeGithubChange.filter((record) => record.stage === '下载')).toHaveLength(3);
    expect(beforeGithubChange.filter((record) => record.stage === 'Zotero入库' && record.taskKey?.startsWith(`${queueId}:`))).toHaveLength(1);

    remote = { ...remote, files: [job(sourceAt(5)), queue(sourceAt(5), sourceAt(5), { download: 'pending', zotero: 'pending', github: 'succeeded' }, { paper_id: 'P-abcdef123456', github_commit: 'a'.repeat(40) })] };
    await manager.readConfigured([service], new Date(sourceAt(5)));
    const afterGithubChange = manager.page(service.id, undefined, 40).records;
    expect(afterGithubChange.filter((record) => record.stage === '下载')).toHaveLength(3);
    expect(afterGithubChange.filter((record) => record.stage === 'Zotero入库' && record.taskKey?.startsWith(`${queueId}:`))).toHaveLength(1);
    expect(afterGithubChange.filter((record) => record.stage === 'GitHub同步')).toHaveLength(2);
  });

  it('keeps same-id job and queue evidence independent across repeated snapshots', async () => {
    const sharedId = fileName(42);
    const remoteFor = (minute: number): RemoteArticleReceiptRead => ({
      strictReader: true,
      complete: true,
      truncated: false,
      totalBytes: 2,
      directoryCounts: { jobs: 1, 'research-requests': 0, 'research-queue': 1 },
      errorCode: null,
      files: [
        {
          directory: 'jobs',
          fileName: `${sharedId}.json`,
          bytes: 1,
          sourceAt: `2026-10-21T00:${minute.toString().padStart(2, '0')}:00.000Z`,
          payload: { id: sharedId, status: 'downloaded', last_result: { status: 'downloaded', archived: true, zotero_status: 'synced' } },
        },
        {
          directory: 'research-queue',
          fileName: `${sharedId}.json`,
          bytes: 1,
          sourceAt: `2026-10-21T00:${minute.toString().padStart(2, '0')}:00.000Z`,
          payload: { id: sharedId, steps: { zotero: 'succeeded' } },
        },
      ],
    });
    let remote = remoteFor(0);
    const reader = new ArticleReceiptJsonReader(
      async () => ({ profileId: 'nas', sourceRef: 'article-receipts', rootPath: '/private/receipts' }),
      async () => ({ transport: { kind: 'ssh', readArticleReceipts: async () => remote, close: async () => undefined } as never, release: () => undefined }),
    );
    const adapter = StatusAdapterSchema.parse({ kind: 'article_receipt_json', profileId: 'nas', sourceRef: 'article-receipts' });
    const service = { id: 'same-receipt-id', name: '同 ID 回执', category: '论文下载', bindings: [], businessAdapter: { kind: 'none' as const }, statusAdapter: adapter };
    const manager = new StatusManager({ resolveEndpoint: async () => undefined, createArticleReader: () => reader });

    await manager.readConfigured([service], new Date('2026-10-21T00:00:00.000Z'));
    remote = remoteFor(1);
    await manager.readConfigured([service], new Date('2026-10-21T00:01:00.000Z'));

    const zoteroRecords = manager.page(service.id, undefined, 40).records.filter((record) => record.stage === 'Zotero入库');
    expect(zoteroRecords).toHaveLength(2);
    expect(new Set(zoteroRecords.map((record) => record.id)).size).toBe(2);
    expect(zoteroRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({ facts: expect.objectContaining({ confirmed: true, status: 'synced' }) }),
      expect.objectContaining({ facts: { taskStatus: 'succeeded', activityState: 'historical' } }),
    ]));
  });

  it('shares same-source services, bounds different sources, isolates one fault, and drops late generations', async () => {
    const adapter = (sourceRef: string) => StatusAdapterSchema.parse({ kind: 'article_receipt_json', profileId: 'nas', sourceRef });
    const service = (id: string, statusAdapter: ReturnType<typeof adapter>) => ({
      id,
      name: id,
      category: '论文下载',
      bindings: [],
      businessAdapter: { kind: 'none' as const },
      statusAdapter,
    });
    const calls: Record<string, number> = {};
    let active = 0;
    let maxActive = 0;
    let releaseLate: (() => void) | undefined;
    let startedLate: (() => void) | undefined;
    const lateStarted = new Promise<void>((resolve) => { startedLate = resolve; });
    const lateGate = new Promise<void>((resolve) => { releaseLate = resolve; });
    const remoteFor = (sourceRef: string): RemoteArticleReceiptRead => {
      const id = fileName(sourceRef === 'source-a' ? 60 : 61);
      return {
        strictReader: true,
        complete: true,
        truncated: false,
        totalBytes: sourceRef === 'source-b' ? 0 : 1,
        directoryCounts: { jobs: sourceRef === 'source-b' ? 0 : 1, 'research-requests': 0, 'research-queue': 0 },
        errorCode: null,
        files: sourceRef === 'source-b' ? [] : [{ directory: 'jobs', fileName: `${id}.json`, bytes: 1, sourceAt: '2026-10-21T00:00:00.000Z', payload: { id, status: 'pending' } }],
      };
    };
    const reader = new ArticleReceiptJsonReader(
      async (_profileId, sourceRef) => ({ profileId: 'nas', sourceRef, rootPath: sourceRef }),
      async () => ({
        transport: {
          kind: 'ssh',
          readArticleReceipts: async (rootPath: string) => {
            calls[rootPath] = (calls[rootPath] ?? 0) + 1;
            active += 1;
            maxActive = Math.max(maxActive, active);
            try {
              if (rootPath === 'source-c') {
                startedLate?.();
                await lateGate;
              }
              if (rootPath === 'source-b') throw new Error('fixture source failure');
              return remoteFor(rootPath);
            } finally {
              active -= 1;
            }
          },
          close: async () => undefined,
        } as never,
        release: () => undefined,
      }),
    );
    const manager = new StatusManager({ resolveEndpoint: async () => undefined, createArticleReader: () => reader });

    await manager.readConfigured([
      service('article-a-one', adapter('source-a')),
      service('article-a-two', adapter('source-a')),
      service('article-b', adapter('source-b')),
    ], new Date('2026-10-21T00:00:00.000Z'));
    expect(calls['source-a']).toBe(1);
    expect(calls['source-b']).toBe(1);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(manager.page('article-a-one', undefined).records).toHaveLength(1);
    expect(manager.page('article-a-two', undefined).records).toHaveLength(1);
    expect(manager.page('article-b', undefined).feeds).toContainEqual(expect.objectContaining({ health: 'error', errorCode: 'status_source' }));

    const lateRead = manager.readConfigured([service('article-late', adapter('source-c'))], new Date('2026-10-21T00:01:00.000Z'));
    await lateStarted;
    manager.reset();
    releaseLate?.();
    await lateRead;
    expect(manager.page('article-late', undefined).records).toEqual([]);
  });

  it('uses directory descriptors and NOFOLLOW to reject symlinks, FIFOs and hardlinks', async () => {
    const root = await makeRoot();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-receipt-outside-'));
    roots.push(outside);
    const valid = fileName(10);
    await writeFile(path.join(outside, valid), JSON.stringify({ secret: 'outside' }));
    await symlink(path.join(outside, valid), path.join(root, 'jobs', `${valid}.json`));
    await link(path.join(outside, valid), path.join(root, 'research-requests', `${fileName(11)}.json`));
    const fifo = path.join(root, 'research-queue', `${fileName(12)}.json`);
    await execFile('/usr/bin/mkfifo', [fifo]);
    const result = await runFixedReader(root);
    expect(result.strictReader).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.files).toEqual([]);
    expect(ARTICLE_RECEIPT_PYTHON).toContain('O_NOFOLLOW');
    expect(ARTICLE_RECEIPT_PYTHON).toContain('O_DIRECTORY');
  });

  it('opens every absolute root component with NOFOLLOW and rejects an ancestor symlink', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-receipt-ancestor-'));
    roots.push(parent);
    const realRoot = path.join(parent, 'real', 'state');
    await Promise.all(['jobs', 'research-requests', 'research-queue'].map((directory) => mkdir(path.join(realRoot, directory), { recursive: true })));
    const aliasRoot = path.join(parent, 'alias');
    await symlink(realRoot, aliasRoot);
    const result = await runFixedReader(aliasRoot, false);
    expect(result.strictReader).toBe(true);
    expect(result.errorCode).toBe('source_unavailable');
    expect(result.files).toEqual([]);
    expect(ARTICLE_RECEIPT_PYTHON).toContain('open_root_components');
  });

  it('marks directory overflow as bounded and never emits more than 64 files per directory', async () => {
    const root = await makeRoot();
    await Promise.all(Array.from({ length: 65 }, (_, index) => writeFile(path.join(root, 'jobs', `${fileName(index)}.json`), JSON.stringify({ status: 'running' }))));
    const result = await runFixedReader(root);
    expect(result.complete).toBe(false);
    expect(result.truncated).toBe(true);
    expect((result.directoryCounts as Record<string, number>).jobs).toBe(64);
    expect((result.files as unknown[]).length).toBe(64);
  });

  it('rejects malformed remote DTOs before business mapping', () => {
    expect(parseRemoteArticleReceiptRead({ schemaVersion: 1, strictReader: true, complete: true, truncated: false, totalBytes: 1, directoryCounts: { jobs: 0, 'research-requests': 0, 'research-queue': 0 }, files: [{ directory: 'jobs', fileName: '../escape.json', bytes: 1, sourceAt: null, payload: {} }], errorCode: null })).toBeNull();
  });

  it('rejects inconsistent group result payloads instead of claiming success', async () => {
    const requestId = fileName(20);
    const remote: RemoteArticleReceiptRead = {
      strictReader: true,
      complete: true,
      truncated: false,
      totalBytes: 1,
      directoryCounts: { jobs: 1, 'research-requests': 0, 'research-queue': 0 },
      errorCode: null,
      files: [{ directory: 'jobs', fileName: fileName(21) + '.json', bytes: 1, sourceAt: '2026-10-18T00:00:00.000Z', payload: { id: fileName(21), status: 'downloaded' } }],
    };
    const transport = {
      kind: 'ssh',
      readArticleReceipts: async () => ({
        ...remote,
        files: [{ directory: 'research-requests' as const, fileName: requestId + '.json', bytes: 1, sourceAt: '2026-10-18T00:00:00.000Z', payload: { request_id: requestId, dois: ['10.1000/only'], result: { request_id: fileName(22), status: 'completed', completed_at: '2026-10-18T01:00:00Z', papers: [] } } }],
      }),
      close: async () => undefined,
    } as never;
    const reader = new ArticleReceiptJsonReader(
      async () => ({ profileId: 'nas', sourceRef: 'article-receipts', rootPath: '/private/receipts' }),
      async () => ({ transport, release: () => undefined }),
    );
    const result = await reader.readSnapshots('nas', 'article-receipts');
    expect(result.health).toBe('error');
    expect(result.errorCode).toBe('status_incomplete');
    expect(result.records).toEqual([]);
  });
});
