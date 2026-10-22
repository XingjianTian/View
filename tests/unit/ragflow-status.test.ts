import { describe, expect, it } from 'vitest';
import type { RegisteredRagflowDocumentsSource } from '../../src/main/status/source-registry.js';
import { RagflowDocumentsStatusAdapter } from '../../src/main/status/ragflow-documents.js';
import type {
  RagflowAggregateRead,
  RagflowDocumentsSource,
  RagflowIngestionLogsRead,
  RagflowReadBudget,
} from '../../src/main/transport/ragflow-documents.js';

const observedAt = '2026-10-21T10:00:00.000Z';

function registered(datasetIds: readonly string[] = ['dataset-a', 'dataset-b']): RegisteredRagflowDocumentsSource {
  const source: RagflowDocumentsSource = {
    sourceRef: 'ragflow-main',
    target: { containerId: 'a'.repeat(64), ip: '10.0.0.24', port: 9380 },
    bearerToken: 'private-bearer',
    datasetIds,
  };
  return {
    sourceRef: source.sourceRef,
    profileId: 'profile-main',
    displayName: '知识库',
    source,
    datasetAliases: new Map(datasetIds.map((id, index) => [id, index === 0 ? '工作库' : '个人片段'])),
  };
}

function aggregate(sourceRef: string, datasetId: string, overrides: Partial<RagflowAggregateRead['datasets'][number]> = {}): RagflowAggregateRead {
  return {
    sourceRef,
    datasets: [{ datasetId, total: 10, pendingCount: 1, processingCount: 1, completedCount: 6, failedCount: 1, cancelledCount: 0, unknownCount: 1, countConflict: false, countersComplete: true, ...overrides }],
    failedDatasetIds: [],
    complete: true,
    observedAt,
  };
}

function logs(sourceRef: string, datasetId: string, failed = false, filter: 'all_file_logs' | 'failed_operations' = failed ? 'failed_operations' : 'all_file_logs'): RagflowIngestionLogsRead {
  return {
    sourceRef,
    datasets: [{
      datasetId,
      page: 1,
      total: failed ? 2 : 0,
      filter,
      hasMore: false,
      logs: failed ? [{
        logIdHash: 'a'.repeat(24),
        documentHash: 'b'.repeat(24),
        run: 'FAILED',
        progress: 0.5,
        failureCode: 'unclassified',
        failureStage: 'embedding',
        failureEvidenceLevel: 'unclassified_description',
        failureShape: { charLength: 685, byteLength: 685, hasLF: true, hasCR: false, hasTab: false, hasOtherControl: false, oldParserWouldDrop: true },
        sourceAt: '2026-10-21T09:00:00.000Z',
      }] : [],
    }],
    failedDatasetIds: [],
    complete: true,
    hasMore: false,
    gap: false,
    observedAt,
  };
}

function adapterFor(
  ids: readonly string[],
  onAggregate: (datasetId: string, call: number) => Promise<RagflowAggregateRead> | RagflowAggregateRead,
  onLogs: (datasetId: string, call: number, scoped: RagflowDocumentsSource) => Promise<RagflowIngestionLogsRead> | RagflowIngestionLogsRead,
  options: { clock?: () => number; source?: RegisteredRagflowDocumentsSource } = {},
) {
  const source = options.source ?? registered(ids);
  let aggregateCalls = 0;
  let logCalls = 0;
  const adapter = new RagflowDocumentsStatusAdapter(
    async () => source,
    async () => ({
      transport: {
        readRagflowAggregates: async (scoped: RagflowDocumentsSource) => onAggregate(scoped.datasetIds?.[0] ?? '', ++aggregateCalls),
        readRagflowIngestionLogs: async (scoped: RagflowDocumentsSource) => onLogs(scoped.datasetIds?.[0] ?? '', ++logCalls, scoped),
      } as never,
      release: () => undefined,
    }),
    options.clock,
  );
  return { adapter, source };
}

describe('RAGFlow status rounds', () => {
  it('alternates one summary per dataset, then reads logs separately without treating logs as inventory coverage', async () => {
    const calls: string[] = [];
    const filters: string[] = [];
    const { adapter } = adapterFor(['dataset-a', 'dataset-b'], (datasetId) => {
      calls.push(`summary:${datasetId}`);
      return aggregate('ragflow-main', datasetId);
    }, (datasetId, _call, scoped) => {
      calls.push(`logs:${datasetId}`);
      filters.push(scoped.ingestionFailureOnly === true ? 'failed_operations' : 'all_file_logs');
      return logs('ragflow-main', datasetId, datasetId === 'dataset-a', scoped.ingestionFailureOnly ? 'failed_operations' : 'all_file_logs');
    });
    const first = await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date(observedAt));
    expect(calls).toEqual(['summary:dataset-a']);
    expect(first.records[0]?.facts.reportedDocuments).toBeNull();

    const second = await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date('2026-10-21T10:00:01Z'));
    expect(calls).toEqual(['summary:dataset-a', 'summary:dataset-b']);
    const scope = second.records.find((record) => record.stage === '源范围快照');
    expect(scope?.facts).toMatchObject({ reportedDocuments: 20, coveredDocuments: 0, coverageMissing: 20, coveragePercent: 0, processingPercent: 60, failureDetailCoverageGap: true, detailsComplete: false, consistency: '源报告已取得，统计窗口非原子' });
    expect(scope?.summary).toContain('总量20');
    for (const record of second.records) expect(Object.keys(record.facts).length).toBeLessThanOrEqual(32);
    expect(Object.keys(scope?.facts ?? {})).toHaveLength(28);
    expect(scope?.facts.activityState).toBe('active');
    const diagnostic = second.records.find((record) => record.stage === '读取诊断');
    expect(diagnostic?.facts).toMatchObject({ operation: 'summary', scopeIndex: 2, page: null, filter: null, httpSent: false, httpCompleted: false, safeError: null });
    expect(diagnostic?.evidenceKind).toBe('snapshot_diff');
    expect(JSON.stringify(diagnostic)).not.toContain('private-bearer');

    const third = await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date('2026-10-21T10:00:02Z'));
    const fourth = await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date('2026-10-21T10:00:03Z'));
    expect(calls).toEqual(['summary:dataset-a', 'summary:dataset-b', 'logs:dataset-a', 'logs:dataset-b']);
    expect(third.records.some((record) => record.stage === '失败')).toBe(true);
    expect(fourth.records.some((record) => record.stage === '失败')).toBe(true);
    const dataset = fourth.records.find((record) => record.stage === '数据集范围');
    expect(filters).toEqual(['failed_operations', 'failed_operations']);
    expect(dataset?.facts).toMatchObject({ coveredDocuments: 0, fileLogFilter: '失败操作日志', fileLogTotal: 2, fileLogHasMore: false });
    expect(JSON.stringify(fourth.records)).not.toContain('document-secret');
  });

  it('uses the unfiltered log route when a trusted summary has no failed documents', async () => {
    const filters: string[] = [];
    const { adapter } = adapterFor(['dataset-a'], () => aggregate('ragflow-main', 'dataset-a', {
      pendingCount: 0,
      processingCount: 0,
      completedCount: 10,
      failedCount: 0,
      unknownCount: 0,
    }), (_datasetId, _call, scoped) => {
      filters.push(scoped.ingestionFailureOnly === true ? 'failed_operations' : 'all_file_logs');
      return logs('ragflow-main', 'dataset-a', false, scoped.ingestionFailureOnly ? 'failed_operations' : 'all_file_logs');
    });
    await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date(observedAt));
    const result = await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date('2026-10-21T10:00:01Z'));
    const dataset = result.records.find((record) => record.stage === '数据集范围');
    const scope = result.records.find((record) => record.stage === '源范围快照');
    expect(filters).toEqual(['all_file_logs']);
    expect(scope?.facts).toMatchObject({ processingPercent: 100, failedCount: 0, failureDetailCoverageGap: false });
    expect(scope?.summary).not.toContain('失败详情覆盖有缺口');
    expect(dataset?.facts).toMatchObject({ fileLogFilter: '文件操作日志', fileLogTotal: 0, failureDetailCoverageGap: false });
    expect(dataset?.summary).not.toContain('失败详情覆盖有缺口');
  });

  it('keeps authoritative idle activity when an optional history-log read fails', async () => {
    const source = registered(['dataset-a']);
    let logCalls = 0;
    const adapter = new RagflowDocumentsStatusAdapter(
      async () => source,
      async () => ({
        transport: {
          readRagflowAggregates: async (scoped: RagflowDocumentsSource) => aggregate('ragflow-main', scoped.datasetIds?.[0] ?? 'dataset-a', {
            pendingCount: 0,
            processingCount: 0,
            completedCount: 8,
            failedCount: 2,
            cancelledCount: 0,
            unknownCount: 0,
          }),
          readRagflowIngestionLogs: async () => {
            logCalls += 1;
            throw new Error('optional failure-log read unavailable');
          },
        } as never,
        release: () => undefined,
      }),
    );

    const first = await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date(observedAt));
    const firstScope = first.records.find((record) => record.stage === '源范围快照');
    expect(firstScope?.facts).toMatchObject({ aggregateAuthoritative: true, activityState: 'idle' });

    const failedLogs = await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date('2026-10-21T10:00:01Z'));
    const failedScope = failedLogs.records.find((record) => record.stage === '源范围快照');
    expect(logCalls).toBe(1);
    expect(failedLogs).toMatchObject({ health: 'fresh', errorCode: 'status_source' });
    expect(failedScope?.facts).toMatchObject({ aggregateAuthoritative: true, activityState: 'idle', summaryError: null, detailError: 'status_source' });
  });

  it('retains the last complete summary window when a later summary round is incomplete', async () => {
    let failed = false;
    const { adapter } = adapterFor(['dataset-a', 'dataset-b'], (datasetId, call) => {
      if (call === 3) {
        failed = true;
        throw new Error('bounded source failure');
      }
      return aggregate('ragflow-main', datasetId, { total: datasetId === 'dataset-a' ? 10 : 20 });
    }, (datasetId) => logs('ragflow-main', datasetId));
    await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date(observedAt));
    await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date('2026-10-21T10:00:01Z'));
    await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date('2026-10-21T10:00:02Z'));
    await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date('2026-10-21T10:00:03Z'));
    expect(failed).toBe(false);
    const stale = await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date('2026-10-21T10:00:04Z'));
    expect(failed).toBe(true);
    const scope = stale.records.find((record) => record.stage === '源范围快照');
    expect(scope?.facts).toMatchObject({ reportedDocuments: 30, processingPercent: 40, aggregateObservedAt: observedAt });
    expect(scope?.facts.consistency).toBe('保留上次成功统计，当前来源未齐');
    expect(stale.health).toBe('error');
  });

  it('retains each dataset latest summary across alternating partial rounds without claiming a shared authoritative window', async () => {
    const windows = [
      '2026-10-21T10:00:00.000Z',
      '2026-10-21T10:00:01.000Z',
      null,
      '2026-10-21T10:00:04.000Z',
      '2026-10-21T10:00:05.000Z',
      null,
    ];
    const { adapter } = adapterFor(['dataset-a', 'dataset-b'], (datasetId, call) => {
      if (call === 3 || call === 6) throw new Error('bounded summary timeout');
      const total = call === 4 ? 22 : call === 5 ? 11 : datasetId === 'dataset-a' ? 10 : 20;
      return { ...aggregate('ragflow-main', datasetId, { total }), observedAt: windows[call - 1] ?? observedAt };
    }, (datasetId) => logs('ragflow-main', datasetId));

    await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date(observedAt));
    await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date('2026-10-21T10:00:01Z'));
    await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date('2026-10-21T10:00:02Z'));
    await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date('2026-10-21T10:00:03Z'));

    const firstFailed = await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date('2026-10-21T10:00:04Z'));
    expect(firstFailed.gap).toBe(true);
    const firstPartial = await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date('2026-10-21T10:00:05Z'));
    const firstPartialScope = firstPartial.records.find((record) => record.stage === '源范围快照');
    const firstWork = firstPartial.records.find((record) => record.stage === '数据集范围' && record.facts.datasetAlias === '工作库');
    const firstPersonal = firstPartial.records.find((record) => record.stage === '数据集范围' && record.facts.datasetAlias === '个人片段');
    expect(firstPartialScope?.facts).toMatchObject({ reportedDocuments: 30, aggregateAuthoritative: false });
    expect(firstWork?.facts).toMatchObject({ reportedDocuments: 10, aggregateObservedAt: '2026-10-21T10:00:00.000Z' });
    expect(firstPersonal?.facts).toMatchObject({ reportedDocuments: 22, aggregateObservedAt: '2026-10-21T10:00:04.000Z' });
    expect(firstPartial.gap).toBe(true);

    await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date('2026-10-21T10:00:06Z'));
    await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date('2026-10-21T10:00:07Z'));
    await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date('2026-10-21T10:00:08Z'));
    const secondPartial = await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date('2026-10-21T10:00:09Z'));
    const secondPartialScope = secondPartial.records.find((record) => record.stage === '源范围快照');
    const secondWork = secondPartial.records.find((record) => record.stage === '数据集范围' && record.facts.datasetAlias === '工作库');
    const secondPersonal = secondPartial.records.find((record) => record.stage === '数据集范围' && record.facts.datasetAlias === '个人片段');
    expect(secondPartialScope?.facts).toMatchObject({ reportedDocuments: 33, aggregateAuthoritative: false });
    expect(secondWork?.facts).toMatchObject({ reportedDocuments: 11, aggregateObservedAt: '2026-10-21T10:00:05.000Z' });
    expect(secondPersonal?.facts).toMatchObject({ reportedDocuments: 22, aggregateObservedAt: '2026-10-21T10:00:04.000Z' });
    expect(secondPartial.gap).toBe(true);
  });

  it('returns cached status records with a gap when source resolution temporarily fails', async () => {
    const source = registered(['dataset-a']);
    let resolveCalls = 0;
    const adapter = new RagflowDocumentsStatusAdapter(
      async () => {
        resolveCalls += 1;
        if (resolveCalls > 1) throw new Error('temporary source resolution failure');
        return source;
      },
      async () => ({
        transport: {
          readRagflowAggregates: async (scoped: RagflowDocumentsSource) => aggregate('ragflow-main', scoped.datasetIds?.[0] ?? 'dataset-a'),
        } as never,
        release: () => undefined,
      }),
    );

    const first = await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date(observedAt));
    const second = await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date('2026-10-21T10:00:01Z'));
    expect(first.records.some((record) => record.stage === '源范围快照')).toBe(true);
    expect(second.health).toBe('error');
    expect(second.gap).toBe(true);
    expect(second.errorCode).toBe('status_source');
    expect(second.lastSuccessAt).toBe(observedAt);
    expect(second.records.some((record) => record.stage === '源范围快照')).toBe(true);
  });

  it('retains cached status records when the transport lease fails after a successful read', async () => {
    const source = registered(['dataset-a']);
    let acquireCalls = 0;
    const adapter = new RagflowDocumentsStatusAdapter(
      async () => source,
      async () => {
        acquireCalls += 1;
        if (acquireCalls > 1) throw new Error('temporary lease failure');
        return {
          transport: {
            readRagflowAggregates: async (scoped: RagflowDocumentsSource) => aggregate('ragflow-main', scoped.datasetIds?.[0] ?? 'dataset-a'),
          } as never,
          release: () => undefined,
        };
      },
    );

    const first = await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date(observedAt));
    const second = await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date('2026-10-21T10:00:01Z'));
    expect(first.records.some((record) => record.stage === '源范围快照')).toBe(true);
    expect(second.health).toBe('error');
    expect(second.gap).toBe(true);
    expect(second.errorCode).toBe('status_source');
    expect(second.records.some((record) => record.stage === '源范围快照')).toBe(true);
  });

  it('keeps a count conflict visible instead of faking unknown zero or complete status', async () => {
    const { adapter } = adapterFor(['dataset-a'], () => aggregate('ragflow-main', 'dataset-a', {
      total: 3,
      completedCount: 3,
      failedCount: 1,
      unknownCount: null,
      countConflict: true,
      countersComplete: false,
    }), () => logs('ragflow-main', 'dataset-a'));
    const result = await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date(observedAt));
    const scope = result.records.find((record) => record.stage === '源范围快照');
    expect(scope?.facts).toMatchObject({ reportedDocuments: null, unknownCount: null, countConflict: true, processingPercent: null, aggregateAuthoritative: false });
    expect(scope?.summary).toContain('计数冲突');
    expect(scope?.summary).not.toContain('未归类0');
  });

  it('keeps scope and dataset sourceAt null and changes record identity across A-B-A observations', async () => {
    const { adapter } = adapterFor(['dataset-a'], (_datasetId, call) => aggregate('ragflow-main', 'dataset-a', { total: call === 1 ? 10 : 20 }), () => logs('ragflow-main', 'dataset-a'));
    const first = await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date(observedAt));
    await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date('2026-10-21T10:00:01Z'));
    const third = await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date('2026-10-21T10:00:02Z'));
    const firstDataset = first.records.find((record) => record.stage === '数据集范围');
    const thirdDataset = third.records.find((record) => record.stage === '数据集范围');
    expect(firstDataset?.sourceAt).toBeNull();
    expect(thirdDataset?.sourceAt).toBeNull();
    expect(firstDataset?.taskKey).toBe(thirdDataset?.taskKey);
    expect(firstDataset?.id).not.toBe(thirdDataset?.id);
  });

  it('keeps the evidence level and shape booleans safe in the status DTO', async () => {
    const { adapter } = adapterFor(['dataset-a'], () => aggregate('ragflow-main', 'dataset-a'), () => logs('ragflow-main', 'dataset-a', true));
    await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date(observedAt));
    const result = await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date('2026-10-21T10:00:01Z'));
    const record = result.records.find((item) => item.stage === '失败');
    expect(record?.facts).toMatchObject({ errorEvidenceLevel: 'unclassified_description', errorStage: '嵌入阶段', errorReason: '嵌入阶段：已有来源描述，尚未归类/原因未能安全识别', failureByteLength: 685, failureHasLF: true, failureOldParserWouldDrop: true });
    expect(record?.summary).toContain('已有来源描述，尚未归类/原因未能安全识别');
    expect(JSON.stringify(record)).not.toContain('embedding stage');
  });

  it('labels message-classified failures as source text classification without exposing raw text', async () => {
    const rawDescription = 'provider-secret-raw-failure';
    const { adapter } = adapterFor(['dataset-a'], () => aggregate('ragflow-main', 'dataset-a'), () => {
      const read = logs('ragflow-main', 'dataset-a', true);
      const dataset = read.datasets[0]!;
      const log = dataset.logs[0]!;
      return {
        ...read,
        datasets: [{
          ...dataset,
          logs: [{ ...log, failureCode: 'http_4xx', failureEvidenceLevel: 'message_classified', rawDescription }],
        }],
      } as unknown as RagflowIngestionLogsRead;
    });
    await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date(observedAt));
    const result = await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date('2026-10-21T10:00:01Z'));
    const record = result.records.find((item) => item.stage === '失败');
    expect(record?.summary).toContain('来源文本分类：上游 HTTP 4xx');
    expect(record?.facts).toMatchObject({ errorEvidenceLevel: 'message_classified', errorReason: '来源文本分类：嵌入阶段：上游 HTTP 4xx' });
    expect(JSON.stringify(record)).not.toContain(rawDescription);
  });

  it('does not describe absent failure detail as an existing source description', async () => {
    const { adapter } = adapterFor(['dataset-a'], () => aggregate('ragflow-main', 'dataset-a'), () => ({
      ...logs('ragflow-main', 'dataset-a', true),
      datasets: [{ ...logs('ragflow-main', 'dataset-a', true).datasets[0]!, logs: [{
        ...logs('ragflow-main', 'dataset-a', true).datasets[0]!.logs[0]!,
        failureStage: 'unknown',
        failureEvidenceLevel: 'source_no_detail',
        failureShape: null,
      }] }],
    }));
    await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date(observedAt));
    const result = await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date('2026-10-21T10:00:01Z'));
    const record = result.records.find((item) => item.stage === '失败');
    expect(record?.facts).toMatchObject({ errorEvidenceLevel: 'source_no_detail', errorReason: '来源未返回可确认失败细节' });
  });

  it('promotes one bounded cohort across normal rounds before the 90 second expiry', async () => {
    let monotonic = 10_000;
    const calls: string[] = [];
    const { adapter } = adapterFor(['dataset-a', 'dataset-b'], (datasetId, call) => {
      calls.push(datasetId);
      if (call === 2) throw new Error('bounded source timeout');
      const window = datasetId === 'dataset-a'
        ? { requestStartedAt: '2026-10-21T10:00:00.100Z', requestCompletedAt: '2026-10-21T10:00:00.200Z', observedAt: '2026-10-21T10:00:00.200Z' }
        : { requestStartedAt: '2026-10-21T10:00:00.300Z', requestCompletedAt: '2026-10-21T10:00:00.400Z', observedAt: '2026-10-21T10:00:00.400Z' };
      return { ...aggregate('ragflow-main', datasetId), ...window };
    }, (datasetId) => logs('ragflow-main', datasetId), { clock: () => monotonic });

    const first = await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date(observedAt));
    const second = await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date('2026-10-21T10:00:01Z'));
    const third = await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date('2026-10-21T10:00:02Z'));
    expect(first.records.find((record) => record.stage === '源范围快照')?.facts.reportedDocuments).toBeNull();
    expect(second.records.find((record) => record.stage === '源范围快照')?.facts.reportedDocuments).toBeNull();
    const scope = third.records.find((record) => record.stage === '源范围快照');
    expect(calls).toEqual(['dataset-a', 'dataset-b', 'dataset-b']);
    expect(scope?.facts).toMatchObject({ reportedDocuments: 20, aggregateAuthoritative: true, aggregateReadStartedAt: '2026-10-21T10:00:00.100Z', aggregateReadCompletedAt: '2026-10-21T10:00:00.400Z', aggregateObservedAt: '2026-10-21T10:00:00.400Z' });
    expect(scope?.facts.processingPercent).toBe(60);
    expect(scope?.sourceAt).toBeNull();
  });

  it('expires an incomplete cohort without combining its old A with a new B', async () => {
    let monotonic = 20_000;
    const calls: string[] = [];
    const { adapter } = adapterFor(['dataset-a', 'dataset-b'], (datasetId, call) => {
      calls.push(datasetId);
      if (call === 3) throw new Error('new cohort B timeout');
      return aggregate('ragflow-main', datasetId, { total: datasetId === 'dataset-a' && call === 2 ? 11 : 10 });
    }, (datasetId) => logs('ragflow-main', datasetId), { clock: () => monotonic });

    await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date(observedAt));
    monotonic += 90_001;
    const second = await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date('2026-10-21T10:01:31Z'));
    const third = await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date('2026-10-21T10:01:32Z'));
    const scope = third.records.find((record) => record.stage === '源范围快照');
    const work = third.records.find((record) => record.stage === '数据集范围' && record.facts.datasetAlias === '工作库');
    expect(calls).toEqual(['dataset-a', 'dataset-a', 'dataset-b']);
    expect(second.records.find((record) => record.stage === '源范围快照')?.facts.reportedDocuments).toBeNull();
    expect(scope?.facts).toMatchObject({ reportedDocuments: null, aggregateAuthoritative: false, consistency: '同窗统计已过期，当前未收齐' });
    expect(work?.facts).toMatchObject({ reportedDocuments: 11 });
    expect(scope?.summary).not.toContain('总量21');
  });

  it('invalidates the pending cohort when the registered target identity changes', async () => {
    let current = registered(['dataset-a', 'dataset-b']);
    let aggregateCalls = 0;
    const calls: string[] = [];
    const adapter = new RagflowDocumentsStatusAdapter(
      async () => current,
      async () => ({
        transport: {
          readRagflowAggregates: async (scoped: RagflowDocumentsSource) => {
            const datasetId = scoped.datasetIds?.[0] ?? '';
            calls.push(datasetId);
            aggregateCalls += 1;
            return aggregate('ragflow-main', datasetId, { total: aggregateCalls === 2 ? 99 : 10 });
          },
        } as never,
        release: () => undefined,
      }),
    );

    await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date(observedAt));
    current = { ...registered(['dataset-a', 'dataset-b']), source: { ...registered(['dataset-a', 'dataset-b']).source, target: { containerId: 'b'.repeat(64), ip: '10.0.0.25', port: 9380 } } };
    const result = await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date('2026-10-21T10:00:01Z'));
    const scope = result.records.find((record) => record.stage === '源范围快照');
    const work = result.records.find((record) => record.stage === '数据集范围' && record.facts.datasetAlias === '工作库');
    expect(calls).toEqual(['dataset-a', 'dataset-a']);
    expect(scope?.facts).toMatchObject({ reportedDocuments: null, aggregateAuthoritative: false });
    expect(work?.facts.reportedDocuments).toBe(99);
  });

  it('gives a failed dataset two normal opportunities before a log turn', async () => {
    let aggregateCalls = 0;
    let logCalls = 0;
    const { adapter } = adapterFor(['dataset-a', 'dataset-b'], (datasetId, call) => {
      aggregateCalls = call;
      if (datasetId === 'dataset-b') throw new Error('bounded failure');
      return aggregate('ragflow-main', datasetId);
    }, (datasetId) => {
      logCalls += 1;
      return logs('ragflow-main', datasetId);
    });

    await adapter.readSnapshots('profile-main', 'ragflow-main');
    await adapter.readSnapshots('profile-main', 'ragflow-main');
    await adapter.readSnapshots('profile-main', 'ragflow-main');
    const fourth = await adapter.readSnapshots('profile-main', 'ragflow-main');
    expect(aggregateCalls).toBe(3);
    expect(logCalls).toBe(1);
    expect(fourth.records.some((record) => record.stage === '读取诊断')).toBe(true);
  });

  it('reports a completed deadline diagnostic as pending target verification', async () => {
    const source = registered(['dataset-a']);
    const adapter = new RagflowDocumentsStatusAdapter(
      async () => source,
      async () => ({
        transport: {
          readRagflowAggregates: async (_scoped: RagflowDocumentsSource, _signal: AbortSignal | undefined, budget: RagflowReadBudget | undefined) => {
            budget?.onDiagnostic?.({ phase: 'deadline', httpStatus: null, bytes: 0, observedAt });
            throw new Error('bounded target verification timeout');
          },
        } as never,
        release: () => undefined,
      }),
    );

    const result = await adapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date(observedAt));
    const diagnostic = result.records.find((record) => record.stage === '读取诊断');
    expect(diagnostic?.facts).toMatchObject({ phase: 'deadline', phaseCompleted: true, nextPhase: 'target' });
    expect(diagnostic?.summary).toContain('阶段期限确认已完成，下一阶段目标验证');

    const waitingAdapter = new RagflowDocumentsStatusAdapter(
      async () => source,
      async () => ({
        transport: {
          readRagflowAggregates: async (_scoped: RagflowDocumentsSource, _signal: AbortSignal | undefined, budget: RagflowReadBudget | undefined) => {
            budget?.onDiagnostic?.({ phase: 'channel_wait', httpStatus: null, bytes: 0, observedAt });
            throw new Error('bounded channel wait');
          },
        } as never,
        release: () => undefined,
      }),
    );
    const waiting = await waitingAdapter.readSnapshots('profile-main', 'ragflow-main', undefined, new Date(observedAt));
    const waitingDiagnostic = waiting.records.find((record) => record.stage === '读取诊断');
    expect(waitingDiagnostic?.facts).toMatchObject({ phase: 'channel_wait', phaseCompleted: false, nextPhase: 'channel' });
    expect(waitingDiagnostic?.summary).toContain('阶段等待通道');
  });
});
