import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { QueryResult } from 'pg';
import type { DockerTransport } from '../../src/main/transport/types.js';
import {
  QUANT_METADATA_SQL,
  QUANT_RECENT_DATA_BATCH_SQL,
  QUANT_SESSION_METADATA_SQL,
  QUANT_SCANS_COLUMNS,
  QUANT_SCANS_RECENT_SQL,
  QUANT_TASK_COLUMNS,
  QUANT_TASKS_FILTERED_SQL,
  QUANT_TASKS_RECENT_SQL,
  QuantPgStatusAdapter,
  type QuantPgClientLike,
} from '../../src/main/status/quant-pg.js';
import type { RegisteredQuantPgSource } from '../../src/main/status/source-registry.js';

const source: RegisteredQuantPgSource = {
  sourceRef: 'quant-pg-receipts',
  profileId: 'nas-access',
  displayName: 'Quant后台任务',
  target: {
    containerId: 'a'.repeat(64),
    ip: '10.0.0.3',
    port: 5432,
    network: 'quant-workspace_default',
    composeProject: 'quant-workspace',
    composeService: 'postgres',
  },
  credential: { schemaVersion: 1, database: 'quant', username: 'readonly', password: 'private' },
  scanIds: [],
  taskNames: ['daily-market-pipeline-us', 'weekly-full-refresh', 'weekly-orphaned-scan-cleanup', 'weekly-fundamental-refresh', 'monthly-price-data-cleanup'],
  allowRecent: true,
  scopeVerified: true,
};

function result(rows: Record<string, unknown>[]): QueryResult<Record<string, unknown>> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows };
}

class FakeClient implements QuantPgClientLike {
  readonly queries: string[] = [];
  ended = false;
  readOnly = true;
  scansRelkind: 'r' | 'v' = 'r';
  scanStatus: 'running' | 'completed' = 'running';
  taskStatus: 'queued' | 'completed' = 'queued';
  failure: Error | null = null;
  scanRows: Record<string, unknown>[] | null = null;
  taskRows: Record<string, unknown>[] | null = null;
  async connect(): Promise<void> { return undefined; }
  on() { return this; }
  async end() { this.ended = true; }
  async query(query: string | { text: string; values?: unknown[] }) {
    const text = typeof query === 'string' ? query : query.text;
    this.queries.push(text);
    if (this.failure) throw this.failure;
    if (text === QUANT_RECENT_DATA_BATCH_SQL) {
      return [
        result(this.scanRows ?? Array.from({ length: 41 }, (_, index) => ({ id: index + 1, scan_id: `scan-${index + 1}`, status: index === 0 ? this.scanStatus : 'completed', task_id: `task-${index + 1}`, total_stocks: 20, passed_stocks: 4, trigger_source: 'manual', started_at: '2026-10-21T00:00:00.000Z', completed_at: index === 0 && this.scanStatus === 'running' ? null : '2026-10-21T00:10:00.000Z', analytics_completed_at: null }))),
        result(this.taskRows ?? []),
      ] as unknown as QueryResult<Record<string, unknown>>;
    }
    if (text === QUANT_SESSION_METADATA_SQL || text === QUANT_METADATA_SQL) return result([{ database_name: 'quant', user_name: 'readonly', read_only: this.readOnly ? 'on' : 'off', scans_relkind: this.scansRelkind, task_history_relkind: 'r', scans_columns_ok: true, task_history_columns_ok: true }]);
    if (text.includes('FROM public.scans')) return result(this.scanRows ?? Array.from({ length: 41 }, (_, index) => ({ id: index + 1, scan_id: `scan-${index + 1}`, status: index === 0 ? this.scanStatus : 'completed', task_id: `task-${index + 1}`, total_stocks: 20, passed_stocks: 4, trigger_source: 'manual', started_at: '2026-10-21T00:00:00.000Z', completed_at: index === 0 && this.scanStatus === 'running' ? null : '2026-10-21T00:10:00.000Z', analytics_completed_at: null })));
    if (text.includes('FROM public.task_execution_history')) return result(this.taskRows ?? [
      { id: 1, task_name: 'daily-market-pipeline-us', task_id: 'history-task', status: this.taskStatus, triggered_by: 'schedule', started_at: '2026-10-21T01:00:00.000Z', completed_at: this.taskStatus === 'completed' ? '2026-10-21T01:05:00.000Z' : null, duration_seconds: this.taskStatus === 'completed' ? 300 : null },
      { id: 2, task_name: 'weekly-full-refresh', task_id: null, status: this.taskStatus, triggered_by: 'manual', started_at: '2026-10-21T02:00:00.000Z', completed_at: this.taskStatus === 'completed' ? '2026-10-21T02:01:00.000Z' : null, duration_seconds: this.taskStatus === 'completed' ? 60 : null },
      { id: 3, task_name: 'weekly-full-refresh', task_id: null, status: 'completed', triggered_by: 'manual', started_at: '2026-10-21T03:00:00.000Z', completed_at: '2026-10-21T03:01:00.000Z', duration_seconds: 60 },
      { id: 4, task_name: 'daily-market-pipeline-us', task_id: 'history-task', status: 'completed', triggered_by: 'schedule', started_at: '2026-10-20T01:00:00.000Z', completed_at: '2026-10-20T01:05:00.000Z', duration_seconds: 300 },
    ]);
    return result([]);
  }
}

function makeAdapter(client: FakeClient, openCount: { value: number }, closeCount: { value: number }, registered: RegisteredQuantPgSource = source, createClient: () => QuantPgClientLike = () => client, releaseCount: { value: number } = { value: 0 }) {
  const transport = {
    kind: 'ssh' as const,
    verifyQuantPostgresTarget: async () => ({ ...source.target, state: 'running' as const, observedAt: '2026-10-21T00:00:00.000Z' }),
    openQuantPostgresChannel: async () => {
      openCount.value += 1;
      const stream = new PassThrough();
      return { stream, close: () => { closeCount.value += 1; stream.destroy(); } };
    },
  } as unknown as DockerTransport;
  return new QuantPgStatusAdapter(
    async () => registered,
    async () => ({ transport, release: () => { releaseCount.value += 1; } }),
    createClient,
  );
}

class HangingClient extends FakeClient {
  async connect() { return await new Promise<void>(() => undefined); }
}

describe('Quant PostgreSQL status reader', () => {
  it('uses only fixed projections, keeps the 41st row as hasMore, and maps unsafe fields safely', async () => {
    const client = new FakeClient(); const opens = { value: 0 }; const closes = { value: 0 };
    const adapter = makeAdapter(client, opens, closes);
    const read = await adapter.readSnapshots(source.profileId, source.sourceRef);
    expect(read.errorCode).toBe('status_incomplete');
    expect(read.hasMore).toBe(true);
    expect(read.records.some((record) => record.stage === '已读范围' && record.evidenceKind === 'snapshot_diff')).toBe(true);
    const running = read.records.find((record) => record.facts.status === 'running');
    expect(running).toMatchObject({ outcome: 'unknown', occurredAt: null, sourceAt: '2026-10-21T00:00:00.000Z' });
    expect(running?.facts.attempt).toBeNull();
    expect(read.records.filter((record) => record.facts.businessKind === 'task_history')).toHaveLength(4);
    const taskReceipts = read.records.filter((record) => record.facts.businessKind === 'task_history' && record.facts.taskType === '全量缓存刷新');
    expect(taskReceipts).toHaveLength(2);
    expect(taskReceipts[0]?.taskKey).not.toBe(taskReceipts[1]?.taskKey);
    const sameExternalTask = read.records.filter((record) => record.facts.businessKind === 'task_history' && record.facts.taskType === '市场流水线');
    expect(sameExternalTask).toHaveLength(2);
    expect(sameExternalTask[0]?.taskKey).not.toBe(sameExternalTask[1]?.taskKey);
    expect(sameExternalTask[0]?.facts.externalTaskHash).toBe(sameExternalTask[1]?.facts.externalTaskHash);
    expect(client.queries).toContain(QUANT_SESSION_METADATA_SQL);
    expect(client.queries.some((query) => query.includes('SELECT *') || query.includes('result_summary') || query.includes('error_message'))).toBe(false);
    expect(QUANT_SCANS_RECENT_SQL).toContain(QUANT_SCANS_COLUMNS);
    expect(QUANT_TASKS_RECENT_SQL).toContain(QUANT_TASK_COLUMNS);
    expect(client.queries).toContain(QUANT_TASKS_FILTERED_SQL);
    expect(opens.value).toBe(1);
    expect(closes.value).toBe(1);
    expect(client.ended).toBe(true);
  });

  it('shares one in-flight source read and fails closed when the read-only contract is false', async () => {
    const client = new FakeClient(); const opens = { value: 0 }; const closes = { value: 0 };
    const adapter = makeAdapter(client, opens, closes);
    const [first, second] = await Promise.all([
      adapter.readSnapshots(source.profileId, source.sourceRef),
      adapter.readSnapshots(source.profileId, source.sourceRef),
    ]);
    expect(first).toBe(second);
    expect(opens.value).toBe(1);

    const invalidClient = new FakeClient(); invalidClient.readOnly = false;
    const invalid = await makeAdapter(invalidClient, { value: 0 }, { value: 0 }).readSnapshots(source.profileId, source.sourceRef);
    expect(invalid).toMatchObject({ health: 'error', errorCode: 'status_schema', records: [] });

    const viewClient = new FakeClient(); viewClient.scansRelkind = 'v';
    const view = await makeAdapter(viewClient, { value: 0 }, { value: 0 }).readSnapshots(source.profileId, source.sourceRef);
    expect(view).toMatchObject({ health: 'error', errorCode: 'status_schema', records: [] });
  });

  it('maps database and transport failures to fixed safe source categories', async () => {
    const failures: Array<[string, string]> = [
      ['28P01', 'status_auth'],
      ['42501', 'status_permission'],
      ['42P01', 'status_schema'],
      ['ECONNREFUSED', 'status_connection'],
    ];
    for (const [code, expected] of failures) {
      const client = new FakeClient();
      client.failure = Object.assign(new Error(`private raw failure ${code} / token=never-forward`), { code });
      const read = await makeAdapter(client, { value: 0 }, { value: 0 }).readSnapshots(source.profileId, source.sourceRef);
      expect(read).toMatchObject({ health: 'error', errorCode: expected, records: [] });
      expect(JSON.stringify(read)).not.toContain('token=never-forward');
    }
  });

  it('validates metadata before using the bounded recent data batch', async () => {
    const client = new FakeClient();
    const scoped = { ...source, taskNames: [], scopeVerified: true };
    const read = await makeAdapter(client, { value: 0 }, { value: 0 }, scoped).readSnapshots(scoped.profileId, scoped.sourceRef);
    expect(read.errorCode).toBe('status_incomplete');
    expect(client.queries).toContain(QUANT_SESSION_METADATA_SQL);
    expect(client.queries).toContain(QUANT_RECENT_DATA_BATCH_SQL);
    expect(client.queries.indexOf(QUANT_SESSION_METADATA_SQL)).toBeLessThan(client.queries.indexOf(QUANT_RECENT_DATA_BATCH_SQL));

    const invalidClient = new FakeClient();
    invalidClient.scansRelkind = 'v';
    const invalid = await makeAdapter(invalidClient, { value: 0 }, { value: 0 }, scoped).readSnapshots(scoped.profileId, scoped.sourceRef);
    expect(invalid.errorCode).toBe('status_schema');
    expect(invalidClient.queries).toContain(QUANT_SESSION_METADATA_SQL);
    expect(invalidClient.queries.some((query) => query.includes('FROM public.scans') || query.includes('FROM public.task_execution_history'))).toBe(false);
  });

  it('marks mixed and empty scope snapshots without fabricating success', async () => {
    const scoped = { ...source, taskNames: [], scopeVerified: true };
    const mixedClient = new FakeClient();
    mixedClient.scanRows = [
      { id: 1, scan_id: 'scan-complete', status: 'completed', task_id: null, total_stocks: 2, passed_stocks: 2, trigger_source: 'manual', started_at: '2026-10-21T00:00:00.000Z', completed_at: '2026-10-21T00:01:00.000Z', analytics_completed_at: null },
      { id: 2, scan_id: 'scan-failed', status: 'failed', task_id: null, total_stocks: 2, passed_stocks: 0, trigger_source: 'manual', started_at: '2026-10-21T00:02:00.000Z', completed_at: '2026-10-21T00:03:00.000Z', analytics_completed_at: null },
    ];
    mixedClient.taskRows = [];
    const mixed = await makeAdapter(mixedClient, { value: 0 }, { value: 0 }, scoped).readSnapshots(scoped.profileId, scoped.sourceRef);
    const mixedScope = mixed.records.find((record) => record.stage === '已读范围');
    expect(mixedScope).toMatchObject({ outcome: 'partial', facts: { completedScans: 1, failedScans: 1, cancelledScans: 0, unknownScans: 0 } });
    expect(mixedScope?.summary).toBe('扫描完成1，失败1，任务历史0条；范围完整；当前活动未由历史记录确认');

    const emptyClient = new FakeClient();
    emptyClient.scanRows = [];
    emptyClient.taskRows = [];
    const empty = await makeAdapter(emptyClient, { value: 0 }, { value: 0 }, scoped).readSnapshots(scoped.profileId, scoped.sourceRef);
    const emptyScope = empty.records.find((record) => record.stage === '已读范围');
    expect(emptyScope).toMatchObject({ outcome: 'unknown', facts: { recorded: 0, completedScans: 0, completedTasks: 0 } });
    expect(emptyScope?.summary).toContain('暂无可用记录');
    expect(emptyScope?.facts.activityState).toBe('historical');
    expect(empty).toMatchObject({ health: 'fresh', errorCode: null, gap: false });
    expect(empty.lastSuccessAt).toBeTruthy();
    expect(emptyScope?.summary).not.toContain('扫描完成0');
  });

  it('keeps failed receipts explicit without forwarding a source error detail', async () => {
    const failedClient = new FakeClient();
    failedClient.scanRows = [{
      id: 1,
      scan_id: 'scan-failed',
      status: 'failed',
      task_id: null,
      total_stocks: 2,
      passed_stocks: 0,
      trigger_source: 'manual',
      started_at: '2026-10-21T00:00:00.000Z',
      completed_at: '2026-10-21T00:01:00.000Z',
      analytics_completed_at: null,
    }];
    failedClient.taskRows = [];
    const read = await makeAdapter(failedClient, { value: 0 }, { value: 0 }, { ...source, taskNames: [], scopeVerified: true }).readSnapshots(source.profileId, source.sourceRef);
    const failed = read.records.find((record) => record.facts.status === 'failed');
    expect(failed?.summary).toContain('来源未提供详细原因');
    expect(JSON.stringify(failed)).not.toContain('error_message');
  });

  it('closes the reader channel when an external abort interrupts a pending connection', async () => {
    const client = new HangingClient(); const opens = { value: 0 }; const closes = { value: 0 };
    const releases = { value: 0 };
    const adapter = makeAdapter(client, opens, closes, source, () => client, releases);
    const controller = new AbortController();
    const read = adapter.readSnapshots(source.profileId, source.sourceRef, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(read).resolves.toMatchObject({ health: 'error', errorCode: 'status_timeout', records: [] });
    expect(opens.value).toBe(1);
    expect(closes.value).toBe(1);
    expect(releases.value).toBe(1);
    expect(client.ended).toBe(true);
  });

  it('starts lease release even when the total deadline is exhausted', async () => {
    vi.useFakeTimers();
    try {
      const client = new HangingClient(); const opens = { value: 0 }; const closes = { value: 0 }; const releases = { value: 0 };
      const adapter = makeAdapter(client, opens, closes, source, () => client, releases);
      const read = adapter.readSnapshots(source.profileId, source.sourceRef);
      await vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(5_100);
      await expect(read).resolves.toMatchObject({ health: 'error', errorCode: 'status_timeout', records: [] });
      expect(releases.value).toBe(1);
      expect(closes.value).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a queued or running receipt when the same scan later reaches a terminal state', async () => {
    const client = new FakeClient(); const adapter = makeAdapter(client, { value: 0 }, { value: 0 });
    const first = await adapter.readSnapshots(source.profileId, source.sourceRef);
    client.scanStatus = 'completed';
    const second = await adapter.readSnapshots(source.profileId, source.sourceRef);
    const running = first.records.find((record) => record.facts.status === 'running');
    const completed = second.records.find((record) => record.facts.status === 'completed' && record.facts.scanHash === running?.facts.scanHash);
    expect(running).toBeDefined();
    expect(completed).toBeDefined();
    expect(running?.id).not.toBe(completed?.id);
    expect(running?.taskKey).toBe(completed?.taskKey);
  });

  it('keeps a queued task receipt when the same history row later reaches a terminal state', async () => {
    const client = new FakeClient(); const adapter = makeAdapter(client, { value: 0 }, { value: 0 });
    const first = await adapter.readSnapshots(source.profileId, source.sourceRef);
    client.taskStatus = 'completed';
    const second = await adapter.readSnapshots(source.profileId, source.sourceRef);
    const queued = first.records.find((record) => record.facts.businessKind === 'task_history' && record.facts.status === 'queued');
    const completed = second.records.find((record) => record.facts.businessKind === 'task_history' && record.facts.status === 'completed');
    expect(queued).toBeDefined();
    expect(completed).toBeDefined();
    expect(queued?.id).not.toBe(completed?.id);
    expect(queued?.taskKey).toBe(completed?.taskKey);
  });
});
