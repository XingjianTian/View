import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StatusPage, StatusRecord } from '../../src/shared/status.js';
import { formatStatusTime, isStatusScopeSnapshot, StatusTimeline } from '../../src/renderer/components/StatusTimeline.js';
import { groupStatusRecords, mergeStatusPage, panelBusinessSourceLabel, selectPanelBusinessItems, selectStatusHeadline, statusHeadlineLabel } from '../../src/renderer/status-helpers.js';

const articleRoot = 'a'.repeat(64);

function record(overrides: Partial<StatusRecord> = {}): StatusRecord {
  return {
    id: 'receipt-1',
    serviceId: 'paper',
    sourceRef: 'article_receipt_json:library',
    taskKey: articleRoot,
    stage: '归档',
    outcome: 'succeeded',
    summary: '论文已归档',
    occurredAt: '2026-10-20T10:00:00.000Z',
    sourceAt: '2026-10-20T10:00:00.000Z',
    observedAt: '2026-10-21T10:00:00.000Z',
    evidenceKind: 'stage_receipt',
    facts: {},
    evidenceRef: null,
    ...overrides,
  };
}

function page(records: StatusRecord[], nextCursor: string | null, hasMore: boolean, feeds: StatusPage['feeds'] = []): StatusPage {
  return { serviceId: 'paper', records: records.slice(0, 40), nextCursor, hasMore, feeds };
}

function headlineTimeText(markup: string): string {
  const scopeTime = markup.match(/<\/details><time[^>]*>([^<]*)<\/time>/)?.[1];
  if (scopeTime) return scopeTime;
  return markup.match(/<div class="status-headline">[\s\S]*?<time[^>]*>([^<]*)<\/time>/)?.[1] ?? '';
}

function groupTimeText(markup: string): string {
  return markup.match(/<time class="status-group-time"[^>]*>([^<]*)<\/time>/)?.[1] ?? '';
}

describe('renderer status cache and grouping', () => {
  it('keeps older pages when the eight-second first page refresh arrives and caps the client cache at 200', () => {
    const first = page(Array.from({ length: 40 }, (_, index) => record({ id: `first-${index}`, occurredAt: `2026-10-20T10:${String(index).padStart(2, '0')}:00.000Z` })), 'cursor-older', true);
    const older = page(Array.from({ length: 40 }, (_, index) => record({ id: `older-${index}`, occurredAt: `2026-10-19T10:${String(index).padStart(2, '0')}:00.000Z` })), 'cursor-oldest', true);
    const loaded = mergeStatusPage(first, older);
    const refreshed = page([
      record({ id: 'newest', occurredAt: '2026-10-21T10:00:00.000Z' }),
      ...Array.from({ length: 39 }, (_, index) => record({ id: `first-${index}`, occurredAt: `2026-10-20T10:${String(index).padStart(2, '0')}:00.000Z` })),
    ], 'cursor-refresh', true);
    const merged = mergeStatusPage(loaded, refreshed, true);
    expect(merged.records).toHaveLength(81);
    expect(merged.records.map((item) => item.id)).toContain('older-0');
    expect(merged.records.map((item) => item.id)).toContain('newest');
    expect(merged.nextCursor).toBe('cursor-oldest');
    expect(merged.hasMore).toBe(true);

    const capped = mergeStatusPage(merged, page(Array.from({ length: 40 }, (_, index) => record({ id: `latest-${index}`, occurredAt: `2026-10-22T10:${String(index).padStart(2, '0')}:00.000Z` })), 'cursor-next', true), true);
    expect(capped.records).toHaveLength(121);
    const overfilled = mergeStatusPage(capped, page(Array.from({ length: 40 }, (_, index) => record({ id: `more-${index}`, occurredAt: `2026-10-23T10:${String(index).padStart(2, '0')}:00.000Z` })), 'cursor-more', true), true);
    const final = mergeStatusPage(overfilled, page(Array.from({ length: 40 }, (_, index) => record({ id: `last-${index}`, occurredAt: `2026-10-24T10:${String(index).padStart(2, '0')}:00.000Z` })), 'cursor-last', true), true);
    expect(final.records).toHaveLength(200);
    expect(final.records.map((item) => item.id)).not.toContain('older-0');
  });

  it('keeps an exhausted history exhausted across a first-page refresh and marks a non-overlapping refresh as a gap', () => {
    const feed = { sourceRef: 'http_json:library', health: 'fresh' as const, lastSuccessAt: '2026-10-21T10:00:00.000Z', observedAt: '2026-10-21T10:00:00.000Z', cursor: null, hasMore: true, gap: false, errorCode: null };
    const complete = page(Array.from({ length: 12 }, (_, index) => record({ id: `complete-${index}` })), null, false, [feed]);
    const refreshed = page(complete.records, 'cursor-new', true, [feed]);
    const retained = mergeStatusPage(complete, refreshed, true);
    expect(retained.hasMore).toBe(false);
    expect(retained.nextCursor).toBeNull();
    expect(retained.feeds[0]?.gap).toBe(false);

    const disjoint = page(Array.from({ length: 12 }, (_, index) => record({ id: `new-${index}`, occurredAt: '2026-10-22T10:00:00.000Z' })), 'cursor-gap', true, [feed]);
    const gap = mergeStatusPage(complete, disjoint, true);
    expect(gap.hasMore).toBe(true);
    expect(gap.nextCursor).toBe('cursor-gap');
    expect(gap.feeds[0]?.gap).toBe(true);
  });

  it('groups article stages by source and task root while keeping business headlines ahead of newer Docker observations', () => {
    const records = [
      record({ id: 'article-stage', taskKey: `${articleRoot}:archive`, occurredAt: '2026-10-21T10:00:00.000Z', outcome: 'active', summary: '归档阶段进行中' }),
      record({ id: 'article-business', taskKey: articleRoot, evidenceKind: 'business_event', occurredAt: '2026-10-20T10:00:00.000Z', summary: '论文下载完成' }),
      record({ id: 'article-zotero', taskKey: `${articleRoot}:zotero`, occurredAt: '2026-10-20T11:00:00.000Z', summary: '已同步 Zotero' }),
      record({ id: 'same-root-other-source', sourceRef: 'http_json:library', taskKey: articleRoot, occurredAt: '2026-10-21T09:00:00.000Z' }),
      record({ id: 'docker-new', sourceRef: 'docker:local', taskKey: null, evidenceKind: 'container_observation', stage: '容器观察', occurredAt: '2026-10-22T10:00:00.000Z', summary: '容器仍在运行' }),
    ];
    const groups = groupStatusRecords(records);
    const articleGroup = groups.find((group) => group.key === `article_receipt_json:library:${articleRoot}`);
    expect(articleGroup?.records).toHaveLength(3);
    expect(articleGroup?.latest.id).toBe('article-stage');
    expect(articleGroup?.headline.id).toBe('article-stage');
    expect(groups.filter((group) => group.key.endsWith(`:${articleRoot}`))).toHaveLength(2);
    expect(groups[0]?.latest.id).toBe('article-stage');
    expect(groups.at(-1)?.latest.id).toBe('docker-new');
  });

  it('keeps a newer container observation after business evidence groups', () => {
    const groups = groupStatusRecords([
      record({ id: 'business-old', evidenceKind: 'business_event', occurredAt: '2026-10-20T10:00:00.000Z', summary: '论文任务已完成' }),
      record({ id: 'container-new', sourceRef: 'docker:local', taskKey: null, evidenceKind: 'container_observation', stage: '容器观察', occurredAt: '2026-10-22T10:00:00.000Z', summary: '容器仍在运行' }),
    ]);
    expect(groups.map((group) => group.latest.id)).toEqual(['business-old', 'container-new']);
  });

  it('uses the latest RAGFlow scope snapshot as the headline ahead of newer document receipts', () => {
    const sourceRef = 'ragflow_documents:nas-profile:ragflow-knowledge';
    const headline = selectStatusHeadline([
      record({ id: 'rag-doc-newer', sourceRef, stage: '文档报告', evidenceKind: 'stage_receipt', occurredAt: '2026-10-21T12:00:00.000Z', summary: '文档报告完成100%' }),
      record({ id: 'rag-scope-old', sourceRef, stage: '源范围快照', evidenceKind: 'snapshot_diff', occurredAt: '2026-10-21T10:00:00.000Z', summary: '旧范围摘要' }),
      record({ id: 'rag-scope-new', sourceRef, stage: '源范围快照', evidenceKind: 'snapshot_diff', occurredAt: '2026-10-21T11:00:00.000Z', summary: '最新范围摘要' }),
    ]);
    expect(headline?.id).toBe('rag-scope-new');
  });

  it('uses the latest Quant scope snapshot as the headline ahead of newer task receipts', () => {
    const sourceRef = 'quant_pg_receipts:quant-profile:quant-status';
    const scopeFacts = { businessKind: 'scope' };
    const headline = selectStatusHeadline([
      record({ id: 'quant-task-newer', sourceRef, stage: '任务完成', evidenceKind: 'stage_receipt', facts: { businessKind: 'task_history' }, occurredAt: '2026-10-21T12:00:00.000Z', summary: '任务完成' }),
      record({ id: 'quant-scope-old', sourceRef, stage: '已读范围', evidenceKind: 'snapshot_diff', facts: scopeFacts, occurredAt: '2026-10-21T10:00:00.000Z', summary: '旧Quant范围摘要' }),
      record({ id: 'quant-scope-new', sourceRef, stage: '已读范围', evidenceKind: 'snapshot_diff', facts: scopeFacts, occurredAt: '2026-10-21T11:00:00.000Z', summary: '最新Quant范围摘要' }),
    ]);
    expect(headline?.id).toBe('quant-scope-new');
  });

  it('keeps generic HTTP and article evidence priority unchanged', () => {
    const genericHeadline = selectStatusHeadline([
      record({ id: 'http-stage', sourceRef: 'http_json:library', evidenceKind: 'stage_receipt', occurredAt: '2026-10-21T10:00:00.000Z' }),
      record({ id: 'http-snapshot', sourceRef: 'http_json:library', evidenceKind: 'snapshot_diff', occurredAt: '2026-10-21T11:00:00.000Z' }),
    ]);
    expect(genericHeadline?.id).toBe('http-stage');

    const articleHeadline = selectStatusHeadline([
      record({ id: 'article-business-headline', evidenceKind: 'business_event', occurredAt: '2026-10-21T10:00:00.000Z' }),
      record({ id: 'article-snapshot', evidenceKind: 'snapshot_diff', occurredAt: '2026-10-21T11:00:00.000Z' }),
    ]);
    expect(articleHeadline?.id).toBe('article-business-headline');
  });

  it('identifies only the registered RAGFlow or Quant scope snapshot as the expandable overview', () => {
    const ragflowSourceRef = 'ragflow_documents:nas-profile:ragflow-knowledge';
    const quantSourceRef = 'quant_pg_receipts:quant-profile:quant-status';
    expect(isStatusScopeSnapshot(record({ sourceRef: ragflowSourceRef, stage: '源范围快照', evidenceKind: 'snapshot_diff' }))).toBe(true);
    expect(isStatusScopeSnapshot(record({ sourceRef: ragflowSourceRef, stage: '源范围快照', evidenceKind: 'stage_receipt' }))).toBe(false);
    expect(isStatusScopeSnapshot(record({ sourceRef: quantSourceRef, stage: '已读范围', evidenceKind: 'snapshot_diff', facts: { businessKind: 'scope' } }))).toBe(true);
    expect(isStatusScopeSnapshot(record({ sourceRef: quantSourceRef, stage: '已读范围', evidenceKind: 'snapshot_diff', facts: { businessKind: 'task_history' } }))).toBe(false);
    expect(isStatusScopeSnapshot(record({ sourceRef: quantSourceRef, stage: '已读范围', evidenceKind: 'stage_receipt', facts: { businessKind: 'scope' } }))).toBe(false);
    expect(isStatusScopeSnapshot(record({ sourceRef: 'http_json:library', stage: '源范围快照', evidenceKind: 'snapshot_diff' }))).toBe(false);
  });

  it('renders the RAGFlow overview once as an expandable evidence headline and keeps document history in the list', () => {
    const sourceRef = 'ragflow_documents:nas-profile:ragflow-knowledge';
    const scope = record({ id: 'rag-scope', sourceRef, taskKey: 'scope-current', stage: '源范围快照', outcome: 'partial', evidenceKind: 'snapshot_diff', summary: '已读60篇：处理完成49，状态未知11；范围未读完', occurredAt: null, sourceAt: null });
    const datasetPersonalOld = record({ id: 'rag-dataset-personal-old', sourceRef, taskKey: 'dataset-personal', stage: '数据集范围', outcome: 'partial', evidenceKind: 'snapshot_diff', summary: '个人剪藏旧窗口：总量29；已覆盖29/29', observedAt: '2026-10-20T10:00:00.000Z', facts: { datasetAlias: '个人剪藏', reportedDocuments: 29, coveredDocuments: 29, coveragePercent: 100, pendingCount: 0, processingCount: 0, completedCount: 29, failedCount: 0, cancelledCount: 0, unknownCount: 0, consistency: 'bounded_partial', failureCounts: '暂无已核实失败' } });
    const datasetPersonal = record({ id: 'rag-dataset-personal', sourceRef, taskKey: 'dataset-personal', stage: '数据集范围', outcome: 'partial', evidenceKind: 'snapshot_diff', summary: '个人剪藏：总量30；已覆盖30/30', facts: { datasetAlias: '个人剪藏', reportedDocuments: 30, coveredDocuments: 30, coveragePercent: 100, pendingCount: 0, processingCount: 0, completedCount: 30, failedCount: 0, cancelledCount: 0, unknownCount: 0, consistency: 'bounded_partial', failureCounts: '暂无已核实失败', aggregateObservedAt: '2026-10-21T10:00:00.000Z' } });
    const datasetWork = record({ id: 'rag-dataset-work', sourceRef, taskKey: 'dataset-work', stage: '数据集范围', outcome: 'partial', evidenceKind: 'snapshot_diff', summary: '工作知识库：总量30；已覆盖30/30', facts: { datasetAlias: '工作知识库', reportedDocuments: 30, coveredDocuments: 30, coveragePercent: 100, pendingCount: 0, processingCount: 0, completedCount: 30, failedCount: 0, cancelledCount: 0, unknownCount: 0, consistency: 'bounded_partial', failureCounts: '暂无已核实失败' } });
    const document = record({ id: 'rag-doc', sourceRef, taskKey: 'scope-current', stage: '报告完成', outcome: 'succeeded', evidenceKind: 'stage_receipt', summary: '文档报告完成' });
    const oldScope = record({ id: 'rag-scope-old', sourceRef, taskKey: 'scope-old', stage: '源范围快照', outcome: 'partial', evidenceKind: 'snapshot_diff', summary: '旧范围摘要', occurredAt: null, sourceAt: null, observedAt: '2026-10-20T10:00:00.000Z' });
    const markup = renderToStaticMarkup(createElement(StatusTimeline, { page: { serviceId: 'knowledge', records: [scope, datasetPersonalOld, datasetPersonal, datasetWork, document, oldScope], nextCursor: null, hasMore: false, feeds: [] } }));
    const groupsStart = markup.indexOf('<div class="status-groups">');
    expect(markup).toContain('class="status-headline-details"');
    expect(markup).toContain(scope.summary);
    expect(markup).toContain('class="status-scope-datasets"');
    expect(markup).toContain('个人剪藏');
    expect(markup).toContain('工作知识库');
    expect(markup).toContain('总量 30');
    expect(markup).toContain(`统计观察 ${formatStatusTime('2026-10-21T10:00:00.000Z')}`);
    expect(markup).toContain('统计观察 —');
    expect(markup).toContain('有界部分读取');
    expect(markup).not.toContain('bounded_partial');
    expect(markup).not.toContain(datasetPersonalOld.summary);
    expect(headlineTimeText(markup)).toMatch(/^观察 /);
    expect(markup.slice(groupsStart)).toContain(document.summary);
    expect(markup.slice(groupsStart)).toContain(oldScope.summary);
    expect(markup.slice(groupsStart)).not.toContain(scope.summary);
    expect(markup.slice(groupsStart)).not.toContain(datasetPersonal.summary);
    expect(markup.slice(groupsStart)).not.toContain(datasetWork.summary);
  });

  it('renders a Quant scope overview without an empty-state duplicate when no history remains', () => {
    const sourceRef = 'quant_pg_receipts:quant-profile:quant-status';
    const scope = record({ id: 'quant-scope', sourceRef, taskKey: null, stage: '已读范围', outcome: 'partial', evidenceKind: 'snapshot_diff', facts: { businessKind: 'scope', incomplete: true }, summary: '扫描完成12，任务完成8；失败1，排队/运行中3；范围尚不完整', occurredAt: null, sourceAt: '2026-10-21T12:00:00.000Z' });
    const markup = renderToStaticMarkup(createElement(StatusTimeline, { page: { serviceId: 'quant', records: [scope], nextCursor: null, hasMore: false, feeds: [] } }));
    expect(markup).toContain('class="status-headline-details"');
    expect(markup).toContain(scope.summary);
    expect(markup).toContain('已读范围');
    expect(headlineTimeText(markup)).toMatch(/^来源 /);
    expect(markup).not.toContain('暂无状态记录');
    expect(markup).not.toContain('class="status-groups"');
  });

  it('renders Quant scope facts from its history capability instead of RAGFlow counters', () => {
    const sourceRef = 'quant_pg_receipts:quant-profile:quant-status';
    const scope = record({ id: 'quant-empty-scope', sourceRef, taskKey: null, stage: '已读范围', outcome: 'unknown', evidenceKind: 'snapshot_diff', facts: {
      businessKind: 'scope',
      scansRead: 0,
      tasksRead: 0,
      recorded: 0,
      activeRecorded: 0,
      completedScans: 0,
      completedTasks: 0,
      failedRecorded: 0,
      activityState: 'historical',
      incomplete: false,
      hasMore: false,
    }, summary: '本次范围暂无可用记录；范围完整；当前活动未由历史记录确认', occurredAt: null, sourceAt: '2026-10-21T12:00:00.000Z' });
    const markup = renderToStaticMarkup(createElement(StatusTimeline, { page: { serviceId: 'quant', records: [scope], nextCursor: null, hasMore: false, feeds: [] } }));
    expect(markup).toContain('扫描读取');
    expect(markup).toContain('当前活动未确认');
    expect(markup).not.toContain('来源报告总量');
    expect(markup).not.toContain('覆盖率');
  });

  it('keeps a proven idle summary visible when optional detail logs fail', () => {
    const sourceRef = 'ragflow_documents:nas-profile:ragflow-knowledge';
    const scope = record({
      id: 'rag-idle-detail-error',
      sourceRef,
      stage: '源范围快照',
      evidenceKind: 'snapshot_diff',
      facts: {
        aggregateAuthoritative: true,
        summaryError: null,
        detailError: 'status_source',
        activityState: 'idle',
        failedCount: 664,
      },
      summary: '当前摘要已完成；历史失败664；当前空闲',
    });
    const feed = { sourceRef, health: 'fresh' as const, lastSuccessAt: '2026-10-21T09:00:00.000Z', observedAt: '2026-10-21T10:00:00.000Z', cursor: null, hasMore: true, gap: true, errorCode: 'status_source' as const };
    const markup = renderToStaticMarkup(createElement(StatusTimeline, { page: { serviceId: 'knowledge', records: [scope], nextCursor: null, hasMore: false, feeds: [feed] } }));
    expect(statusHeadlineLabel(scope, [feed])).toBe('当前空闲');
    expect(markup).toContain('当前空闲');
    expect(markup).toContain('统计已更新 · 详情读取失败');
    expect(markup).toContain('详情读取不完整；当前活动指标来自最近完成的统计摘要。');
    const timeoutMarkup = renderToStaticMarkup(createElement(StatusTimeline, { page: { serviceId: 'knowledge', records: [scope], nextCursor: null, hasMore: false, feeds: [{ ...feed, errorCode: 'status_timeout' as const }] } }));
    expect(timeoutMarkup).toContain('统计已更新 · 详情读取超时');
  });

  it('removes a retained idle label when the current summary read times out', () => {
    const sourceRef = 'ragflow_documents:nas-profile:ragflow-knowledge';
    const scope = record({ id: 'rag-timeout', sourceRef, stage: '源范围快照', evidenceKind: 'snapshot_diff', facts: { aggregateAuthoritative: false, summaryError: 'status_timeout', detailError: 'status_timeout', activityState: 'idle' }, summary: '保留最近完成摘要；当前空闲' });
    const errorFeed = { sourceRef, health: 'error' as const, lastSuccessAt: '2026-10-21T09:00:00.000Z', observedAt: '2026-10-21T10:00:00.000Z', cursor: null, hasMore: true, gap: true, errorCode: 'status_timeout' as const };
    const markup = renderToStaticMarkup(createElement(StatusTimeline, { page: { serviceId: 'knowledge', records: [scope], nextCursor: null, hasMore: false, feeds: [errorFeed] } }));
    const staleFeed = { ...errorFeed, health: 'stale' as const, errorCode: 'status_expired' as const };
    expect(statusHeadlineLabel(scope, [errorFeed])).toBe('来源读取失败');
    expect(markup).toContain('来源读取失败');
    expect(markup).not.toContain('当前空闲');
    expect(statusHeadlineLabel(scope, [])).toBe('范围概览');
    expect(statusHeadlineLabel(scope, [staleFeed])).toBe('历史结果已过期');
  });

  it('removes a retained idle label when the matching source is stale', () => {
    const sourceRef = 'ragflow_documents:nas-profile:ragflow-knowledge';
    const scope = record({ id: 'rag-stale', sourceRef, stage: '源范围快照', evidenceKind: 'snapshot_diff', facts: { aggregateAuthoritative: true, summaryError: null, detailError: null, activityState: 'idle' }, summary: '最近完成摘要；当前空闲' });
    const staleFeed = { sourceRef, health: 'stale' as const, lastSuccessAt: '2026-10-21T09:00:00.000Z', observedAt: '2026-10-21T10:00:00.000Z', cursor: null, hasMore: true, gap: true, errorCode: 'status_expired' as const };
    const markup = renderToStaticMarkup(createElement(StatusTimeline, { page: { serviceId: 'knowledge', records: [scope], nextCursor: null, hasMore: false, feeds: [staleFeed] } }));
    expect(statusHeadlineLabel(scope, [staleFeed])).toBe('历史结果已过期');
    expect(markup).toContain('历史结果已过期');
    expect(markup).not.toContain('当前空闲');
  });

  it('labels a successful empty source read separately from a missing source', () => {
    const feed = { sourceRef: 'article_receipt_json:library', health: 'fresh' as const, lastSuccessAt: '2026-10-21T10:00:00.000Z', observedAt: '2026-10-21T10:00:00.000Z', cursor: null, hasMore: false, gap: false, errorCode: null };
    const markup = renderToStaticMarkup(createElement(StatusTimeline, { page: { serviceId: 'paper', records: [], nextCursor: null, hasMore: false, feeds: [feed] } }));
    expect(markup).toContain('读取成功，暂无状态记录');
    expect(markup).not.toContain('读取超时');
  });

  it('keeps article receipt activity scoped to the receipt itself', () => {
    const feed = { sourceRef: 'article_receipt_json:library', health: 'fresh' as const, lastSuccessAt: '2026-10-21T10:00:00.000Z', observedAt: '2026-10-21T10:00:00.000Z', cursor: null, hasMore: false, gap: false, errorCode: null };
    const active = record({ sourceRef: feed.sourceRef, outcome: 'active', facts: { activityState: 'active' } });
    const terminal = record({ sourceRef: feed.sourceRef, outcome: 'succeeded', facts: { activityState: 'historical' } });
    expect(statusHeadlineLabel(active, [feed])).toBe('当前业务摘要');
    expect(statusHeadlineLabel(terminal, [feed])).toBe('历史业务记录');
  });

  it('labels Docker-only observation as an unconfigured business source', () => {
    const container = record({ id: 'docker-only', sourceRef: 'docker:timer', taskKey: null, evidenceKind: 'container_observation', stage: '容器观察', outcome: 'active', summary: '容器仍在运行', occurredAt: null, sourceAt: null });
    const feed = { sourceRef: 'http_json:timer', health: 'unconfigured' as const, lastSuccessAt: null, observedAt: '2026-10-21T10:00:00.000Z', cursor: null, hasMore: false, gap: false, errorCode: 'status_unconfigured' as const };
    expect(statusHeadlineLabel(container, [feed])).toBe('业务状态源未接入');
  });

  it('labels headline time by the actual available timestamp', () => {
    const cases = [
      { id: 'rag-complete', sourceRef: 'ragflow_documents:nas-profile:ragflow-knowledge', evidenceKind: 'stage_receipt' as const, summary: 'RAGFlow文档完成', occurredAt: null, sourceAt: null, expected: '观察' },
      { id: 'quant-complete', sourceRef: 'quant_pg_receipts:quant-profile:quant-status', evidenceKind: 'stage_receipt' as const, summary: '扫描完成', occurredAt: '2026-10-21T12:00:00.000Z', sourceAt: '2026-10-21T12:00:00.000Z', expected: '发生' },
      { id: 'source-only', sourceRef: 'article_receipt_json:library', evidenceKind: 'stage_receipt' as const, summary: '论文回执', occurredAt: null, sourceAt: '2026-10-21T11:00:00.000Z', expected: '来源' },
      { id: 'docker-observation', sourceRef: 'docker:local', evidenceKind: 'container_observation' as const, summary: '容器仍在运行', occurredAt: null, sourceAt: null, expected: '观察' },
    ];
    for (const item of cases) {
      const markup = renderToStaticMarkup(createElement(StatusTimeline, {
        page: {
          serviceId: 'paper',
          records: [record({ ...item, taskKey: item.sourceRef.startsWith('article_receipt_json:') ? articleRoot : null, observedAt: '2026-10-21T13:00:00.000Z' })],
          nextCursor: null,
          hasMore: false,
          feeds: [],
        },
      }));
      expect(headlineTimeText(markup)).toMatch(new RegExp(`^${item.expected} `));
      expect(groupTimeText(markup)).toMatch(new RegExp(`^${item.expected} `));
    }
  });

  it('maps source error categories to concise safe Chinese labels', () => {
    const labels = [
      ['status_auth', '认证失败'],
      ['status_permission', '读取权限不足'],
      ['status_schema', '数据结构不符'],
      ['status_connection', '连接失败'],
    ] as const;
    for (const [errorCode, label] of labels) {
      const markup = renderToStaticMarkup(createElement(StatusTimeline, {
        page: {
          serviceId: 'paper',
          records: [],
          nextCursor: null,
          hasMore: false,
          feeds: [{
            sourceRef: 'quant_pg_receipts:quant-status',
            health: 'error',
            lastSuccessAt: null,
            observedAt: '2026-10-21T12:00:00.000Z',
            cursor: null,
            hasMore: false,
            gap: false,
            errorCode,
          }],
        },
      }));
      expect(markup).toContain(label);
    }
  });

  it('collapses identical RAG failure descriptions across documents without counting poll refreshes or losing reasons', () => {
    const failure = record({ id: 'failure-1', sourceRef: 'ragflow_documents:knowledge', taskKey: 'document-1', stage: '失败', outcome: 'failed', summary: '工作知识库：嵌入阶段失败；已有来源描述，尚未归类', facts: { datasetAlias: '工作知识库', errorStage: '嵌入', errorCode: 'unclassified', errorReason: '未归类', errorEvidenceLevel: 'unclassified_description' } });
    const refresh = { ...failure, id: 'failure-1-refresh', observedAt: '2026-10-22T00:00:00Z' };
    const otherDocument = { ...failure, id: 'failure-2', taskKey: 'document-2' };
    const otherReason = { ...failure, id: 'failure-3', taskKey: 'document-3', facts: { ...failure.facts, errorCode: 'quota_exceeded', errorReason: '配额不足' } };
    const history = [failure, refresh, otherDocument, otherReason];
    const items = selectPanelBusinessItems(history);
    expect(items).toHaveLength(2);
    expect(items[0]?.summary).toContain('（2 条记录）');
    expect(items[0]?.record.id).toBe('failure-1-refresh');
    expect(items[1]?.record.facts.errorReason).toBe('配额不足');
    expect(history).toHaveLength(4);
  });

  it('selects three newest business summaries, filters diagnostics, and deduplicates refreshed dataset identity', () => {
    const article = record({
      id: 'article-group',
      stage: '分组结果',
      occurredAt: '2026-10-21T11:00:00.000Z',
      facts: { papers: 4, succeeded: 3, failed: 1, partial: 0 },
    });
    const datasetOld = record({
      id: 'dataset-old',
      sourceRef: 'ragflow_documents:profile:knowledge',
      taskKey: 'dataset-refresh-1',
      stage: '数据集范围',
      evidenceKind: 'snapshot_diff',
      occurredAt: null,
      sourceAt: '2026-10-21T09:00:00.000Z',
      observedAt: '2026-10-21T09:00:00.000Z',
      facts: { datasetAlias: '个人剪藏', reportedDocuments: 11, coveredDocuments: 11, completedCount: 10, failedCount: 1, consistency: 'bounded_partial' },
    });
    const datasetNew = { ...datasetOld, id: 'dataset-new', taskKey: 'dataset-refresh-2', sourceAt: '2026-10-21T10:00:00.000Z', observedAt: '2026-10-21T10:00:00.000Z', facts: { ...datasetOld.facts, reportedDocuments: 12, coveredDocuments: 12, completedCount: 12, failedCount: 0 } };
    const quant = record({
      id: 'quant-history',
      sourceRef: 'quant_pg_receipts:profile:status',
      taskKey: 'quant-task-stable',
      stage: '任务完成',
      occurredAt: '2026-10-21T08:00:00.000Z',
      facts: { businessKind: 'task_history' },
      summary: '后台任务：量化任务 · 已完成',
    });
    const docker = record({ id: 'docker-new', sourceRef: 'docker:local', taskKey: null, stage: '容器观察', evidenceKind: 'container_observation', occurredAt: '2026-10-21T13:00:00.000Z', summary: '容器仍在运行' });
    const diagnostic = record({ id: 'rag-diagnostic', sourceRef: 'ragflow_documents:profile:knowledge', taskKey: 'ragflow-read-diagnostic-1', stage: '读取诊断', evidenceKind: 'stage_receipt', occurredAt: '2026-10-21T12:00:00.000Z', summary: '读取诊断：范围未完成' });
    const untrustedScope = record({ id: 'rag-scope', sourceRef: 'ragflow_documents:profile:knowledge', taskKey: 'scope-refresh-2', stage: '源范围快照', evidenceKind: 'snapshot_diff', occurredAt: null, sourceAt: null, observedAt: '2026-10-21T14:00:00.000Z', facts: { aggregateAuthoritative: false, summaryError: 'status_source', reportedDocuments: 23, completedCount: 23 }, summary: '已读23篇；范围未读完' });

    const items = selectPanelBusinessItems([docker, diagnostic, untrustedScope, quant, datasetOld, datasetNew, article]);
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.record.id)).toEqual(['article-group', 'dataset-new', 'quant-history']);
    expect(items[0]?.summary).toContain('论文下载：3/4 篇完成');
    expect(items[1]?.summary).toContain('个人剪藏：完成 12');
    expect(items[1]?.summary).toContain('部分读取');
    expect(items[1]?.record.facts.coveredDocuments).toBe(12);
    expect(items[2]?.sourceLabel).toBe('Quant任务');
    expect(items.some((item) => item.record.id === 'docker-new' || item.record.id === 'rag-diagnostic' || item.record.id === 'rag-scope')).toBe(false);
    expect(panelBusinessSourceLabel(article)).toBe('论文回执');
  });

  it('keeps independent RAG dataset counts when an aggregate scope is not authoritative', () => {
    const sourceRef = 'ragflow_documents:profile:knowledge';
    const scope = record({ id: 'scope', sourceRef, stage: '源范围快照', evidenceKind: 'snapshot_diff', facts: { aggregateAuthoritative: false, summaryError: 'status_source', reportedDocuments: 60, completedCount: 60 }, observedAt: '2026-10-21T12:00:00.000Z' });
    const personal = record({ id: 'personal', sourceRef, taskKey: 'dataset-profile-personal', stage: '数据集范围', evidenceKind: 'snapshot_diff', facts: { datasetAlias: '个人剪藏', reportedDocuments: 30, coveredDocuments: 29, completedCount: 29, failedCount: 1, consistency: 'bounded_partial' }, observedAt: '2026-10-21T11:00:00.000Z' });
    const work = record({ id: 'work', sourceRef, taskKey: 'dataset-profile-work', stage: '数据集范围', evidenceKind: 'snapshot_diff', facts: { datasetAlias: '工作知识库', reportedDocuments: 30, coveredDocuments: 30, completedCount: 30, failedCount: 0, consistency: 'bounded_partial' }, observedAt: '2026-10-21T10:00:00.000Z' });
    const items = selectPanelBusinessItems([scope, personal, work]);
    expect(items.map((item) => item.record.id)).toEqual(['personal', 'work']);
    expect(items.map((item) => item.summary)).toEqual([
      expect.stringContaining('个人剪藏：完成 29'),
      expect.stringContaining('工作知识库：完成 30'),
    ]);
    expect(items.some((item) => item.summary.includes('已读60'))).toBe(false);
    const markup = renderToStaticMarkup(createElement(StatusTimeline, { mode: 'panel', page: { serviceId: 'knowledge', records: [scope, personal, work], nextCursor: null, hasMore: false, feeds: [] } }));
    expect(markup).toContain('status-timeline-panel');
    expect(markup).toContain('个人剪藏：完成 29');
    expect(markup).toContain('工作知识库：完成 30');
    expect(markup).not.toContain('status-headline-details');
    expect(markup).not.toContain('status-groups');
  });

  it('keeps RAG processing distinct when the queue count is unknown', () => {
    const scope = record({
      id: 'rag-processing-only',
      sourceRef: 'ragflow_documents:profile:knowledge',
      stage: '源范围快照',
      evidenceKind: 'snapshot_diff',
      facts: { aggregateAuthoritative: true, summaryError: null, completedCount: null, failedCount: null, pendingCount: null, processingCount: 4 },
    });
    const [item] = selectPanelBusinessItems([scope]);
    expect(item?.summary).toContain('完成 待确认');
    expect(item?.summary).toContain('失败 待确认');
    expect(item?.summary).toContain('处理中 4');
    expect(item?.summary).not.toContain('排队');
    expect(item?.summary).not.toContain('待处理');
  });

  it('keeps a known RAG queue count separate when processing is zero', () => {
    const scope = record({
      id: 'rag-queue-only',
      sourceRef: 'ragflow_documents:profile:knowledge',
      stage: '源范围快照',
      evidenceKind: 'snapshot_diff',
      facts: { aggregateAuthoritative: true, summaryError: null, completedCount: 7, failedCount: 1, pendingCount: 3, processingCount: 0 },
    });
    const [item] = selectPanelBusinessItems([scope]);
    expect(item?.summary).toContain('完成 7');
    expect(item?.summary).toContain('失败 1');
    expect(item?.summary).toContain('排队 3');
    expect(item?.summary).not.toContain('处理中');
    expect(item?.summary).not.toContain('待处理');
  });

  it('does not turn an unread RAG dataset snapshot into zero counts', () => {
    const dataset = record({
      id: 'rag-dataset-unread',
      sourceRef: 'ragflow_documents:profile:knowledge',
      taskKey: 'dataset-profile-personal',
      stage: '数据集范围',
      evidenceKind: 'snapshot_diff',
      facts: { datasetAlias: '个人剪藏', reportedDocuments: null, coveredDocuments: 0, completedCount: 0, failedCount: 0, pendingCount: 0, processingCount: 0, cancelledCount: 0, unknownCount: null, aggregateObservedAt: null, consistency: 'scanning' },
    });
    const [item] = selectPanelBusinessItems([dataset]);
    expect(item?.summary).toBe('个人剪藏：统计尚未读取');
    expect(item?.summary).not.toContain('完成 0');
    expect(item?.summary).not.toContain('读取中');
  });

  it('keeps a genuinely read empty RAG dataset distinguishable from an unread snapshot', () => {
    const dataset = record({
      id: 'rag-dataset-empty',
      sourceRef: 'ragflow_documents:profile:knowledge',
      taskKey: 'dataset-profile-personal',
      stage: '数据集范围',
      evidenceKind: 'snapshot_diff',
      facts: { datasetAlias: '个人剪藏', reportedDocuments: 0, coveredDocuments: 0, completedCount: 0, failedCount: 0, pendingCount: 0, processingCount: 0, cancelledCount: 0, unknownCount: 0, aggregateObservedAt: '2026-10-21T12:00:00.000Z', consistency: 'reconciled_non_atomic' },
    });
    const [item] = selectPanelBusinessItems([dataset]);
    expect(item?.summary).toContain('个人剪藏：完成 0');
    expect(item?.summary).toContain('已核对');
    expect(item?.summary).not.toContain('统计尚未读取');
  });

  it('does not use Docker feeds as a panel business-source health result', () => {
    const dockerFeed = { sourceRef: 'docker:nas-device', health: 'unconfigured' as const, lastSuccessAt: null, observedAt: '2026-10-21T12:00:00.000Z', cursor: null, hasMore: false, gap: false, errorCode: 'status_unconfigured' as const };
    const pageWithDockerFeed = { serviceId: 'infra', records: [], nextCursor: null, hasMore: false, feeds: [dockerFeed] };
    const panelMarkup = renderToStaticMarkup(createElement(StatusTimeline, { mode: 'panel', statusAdapterKind: 'none', page: pageWithDockerFeed }));
    expect(panelMarkup).toContain('业务状态未接入');
    expect(panelMarkup).not.toContain('暂无业务记录');
    expect(panelMarkup).not.toContain('业务状态源未接入');
    const businessFeed = { ...dockerFeed, sourceRef: 'ragflow_documents:profile:knowledge' };
    const matchingPanelMarkup = renderToStaticMarkup(createElement(StatusTimeline, { mode: 'panel', statusAdapterKind: 'ragflow_documents', page: { ...pageWithDockerFeed, feeds: [dockerFeed, businessFeed] } }));
    expect(matchingPanelMarkup).toContain('业务状态源未接入');
    const detailMarkup = renderToStaticMarkup(createElement(StatusTimeline, { mode: 'detail', page: pageWithDockerFeed }));
    expect(detailMarkup).toContain('容器观测');
    expect(detailMarkup).toContain('未接入');
  });

  it('states Quant completion grain and bounded history explicitly in the panel summary', () => {
    const scope = record({
      id: 'quant-scope-summary',
      sourceRef: 'quant_pg_receipts:profile:status',
      taskKey: null,
      stage: '已读范围',
      evidenceKind: 'snapshot_diff',
      facts: { businessKind: 'scope', completedScans: 9, completedTasks: 5, failedRecorded: 2, incomplete: true, hasMore: true },
      summary: '范围读取完成',
    });
    const [item] = selectPanelBusinessItems([scope]);
    expect(item?.summary).toBe('Quant：完成：扫描9、任务5；失败2 · 部分历史');
  });

  it('chooses RAG scope authority per source from the newest scope snapshot', () => {
    const sourceA = 'ragflow_documents:profile:personal';
    const sourceB = 'ragflow_documents:profile:work';
    const oldAuthoritativeA = record({ id: 'a-scope-old', sourceRef: sourceA, stage: '源范围快照', evidenceKind: 'snapshot_diff', observedAt: '2026-10-21T09:00:00.000Z', facts: { aggregateAuthoritative: true, summaryError: null, completedCount: 4 }, summary: '旧聚合' });
    const latestPartialA = record({ id: 'a-scope-new', sourceRef: sourceA, stage: '源范围快照', evidenceKind: 'snapshot_diff', observedAt: '2026-10-21T11:00:00.000Z', facts: { aggregateAuthoritative: false, summaryError: 'status_source', completedCount: 5 }, summary: '最新范围未收齐' });
    const datasetA = record({ id: 'a-dataset', sourceRef: sourceA, taskKey: 'refresh-a', stage: '数据集范围', evidenceKind: 'snapshot_diff', observedAt: '2026-10-21T10:30:00.000Z', facts: { datasetAlias: '个人剪藏', completedCount: 5, failedCount: 0 }, summary: '个人剪藏完成5' });
    const latestAuthoritativeB = record({ id: 'b-scope', sourceRef: sourceB, stage: '源范围快照', evidenceKind: 'snapshot_diff', observedAt: '2026-10-21T10:00:00.000Z', facts: { aggregateAuthoritative: true, summaryError: null, completedCount: 8 }, summary: '工作聚合' });
    const datasetB = record({ id: 'b-dataset', sourceRef: sourceB, taskKey: 'refresh-b', stage: '数据集范围', evidenceKind: 'snapshot_diff', observedAt: '2026-10-21T12:00:00.000Z', facts: { datasetAlias: '工作知识库', completedCount: 8, failedCount: 0 }, summary: '工作知识库完成8' });

    const items = selectPanelBusinessItems([oldAuthoritativeA, latestPartialA, datasetA, latestAuthoritativeB, datasetB]);
    expect(items.map((item) => item.record.id)).toEqual(['a-dataset', 'b-scope']);
  });
});

describe('infrastructure business source presentation', () => {
  it.each([
    ['tailscale_status', '组网'], ['acme_certificates', '证书续期'], ['openresty_status', 'OpenResty'],
  ])('shows the sanitized %s summary and its dedicated source label', (kind, label) => {
    const snapshot = record({ sourceRef: `${kind}:nas:scope`, stage: '当前业务状态', evidenceKind: 'snapshot_diff', summary: '已登记对象的安全业务摘要', facts: {} });
    const items = selectPanelBusinessItems([snapshot], 3);
    expect(items).toHaveLength(1);
    expect(items[0]?.summary).toBe(snapshot.summary);
    expect(panelBusinessSourceLabel(snapshot)).toBe(label);
    const markup = renderToStaticMarkup(createElement(StatusTimeline, { page: page([snapshot], null, false, [{ sourceRef: snapshot.sourceRef, health: 'error', errorCode: 'status_timeout', observedAt: snapshot.observedAt, lastSuccessAt: snapshot.observedAt, cursor: null, hasMore: false, gap: false }]), loading: false, onLoadMore: () => undefined }));
    expect(markup).toContain(label);
    expect(markup).toContain('读取超时');
  });
});
