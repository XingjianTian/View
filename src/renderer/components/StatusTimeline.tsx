import { useMemo } from 'react';
import type { Service } from '../../shared/contracts.js';
import type { StatusFeed, StatusOutcome, StatusRecord, StatusPage } from '../../shared/status.js';
import { effectiveStatusActivity, groupStatusRecords, isPanelBusinessRecord, isStatusScopeSnapshot, panelBusinessSourceLabel, selectPanelBusinessItems, selectStatusHeadline, statusHeadlineLabel, statusRecordTime } from '../status-helpers.js';
import type { PanelBusinessItem, StatusGroup } from '../status-helpers.js';

export { effectiveStatusActivity, groupStatusRecords, isPanelBusinessRecord, isStatusScopeSnapshot, panelBusinessSourceLabel, selectPanelBusinessItems, selectStatusHeadline, statusHeadlineLabel } from '../status-helpers.js';
export type { PanelBusinessItem, StatusGroup } from '../status-helpers.js';

export type TimelineMode = 'panel' | 'detail';
export type StatusAdapterKind = NonNullable<Service['statusAdapter']>['kind'];

type Props = {
  page?: StatusPage | undefined;
  loading?: boolean | undefined;
  onLoadMore?: (() => void) | undefined;
  onOpenDetails?: ((trigger: HTMLButtonElement) => void) | undefined;
  mode?: TimelineMode | undefined;
  statusAdapterKind?: StatusAdapterKind | undefined;
  previewLimit?: number | undefined;
};

const outcomeText: Record<StatusOutcome, string> = {
  active: '进行中',
  succeeded: '已完成',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消',
  unknown: '状态未知',
};

const evidenceText: Record<StatusRecord['evidenceKind'], string> = {
  business_event: '业务回执',
  stage_receipt: '阶段回执',
  snapshot_diff: '状态变化',
  container_observation: '容器观察',
};

const consistencyLabels: Record<string, string> = {
  scanning: '扫描中',
  bounded_partial: '有界部分读取',
  sweep_covered: '扫描覆盖完成',
  reconciled_non_atomic: '已核对，非原子窗口',
  verified_snapshot: '已验证快照',
  stale: '历史结果已过期',
  source_error: '来源读取失败',
  cohort_pending: '尚未收齐同窗统计',
  cohort_expired: '同窗统计已过期，当前未收齐',
};

export function StatusTimeline({ page, loading = false, onLoadMore, onOpenDetails, mode = 'detail', statusAdapterKind, previewLimit = 3 }: Props) {
  const headline = useMemo(() => selectStatusHeadline(page?.records ?? []), [page?.records]);
  const panelItems = useMemo(() => selectPanelBusinessItems(page?.records ?? []), [page?.records]);
  const scopeOverview = headline && isStatusScopeSnapshot(headline) ? headline : null;
  const scopeDatasetHistory = useMemo(() => scopeOverview
    ? (page?.records ?? []).filter((record) => isStatusDatasetSnapshot(record) && record.sourceRef === scopeOverview.sourceRef)
    : [], [page?.records, scopeOverview]);
  const scopeDatasets = useMemo(() => {
    const latestByTask = new Map<string, StatusRecord>();
    for (const record of scopeDatasetHistory) {
      const key = typeof record.facts.datasetAlias === 'string' && record.facts.datasetAlias.trim()
        ? `dataset:${record.facts.datasetAlias.trim()}`
        : record.taskKey?.trim() || record.id;
      const previous = latestByTask.get(key);
      if (!previous || isRecordNewer(record, previous)) latestByTask.set(key, record);
    }
    return [...latestByTask.values()].sort((left, right) => statusRecordTime(left) - statusRecordTime(right) || left.id.localeCompare(right.id));
  }, [scopeDatasetHistory]);
  const groups = useMemo(() => {
    const records = scopeOverview
      ? (page?.records ?? []).filter((record) => (record.id !== scopeOverview.id || record.sourceRef !== scopeOverview.sourceRef) && !(isStatusDatasetSnapshot(record) && record.sourceRef === scopeOverview.sourceRef))
      : (page?.records ?? []);
    return groupStatusRecords(records);
  }, [page?.records, scopeDatasets, scopeOverview]);
  const feeds = page?.feeds ?? [];
  const panelFeeds = mode === 'panel' ? feeds.filter((feed) => isPanelBusinessFeed(feed, statusAdapterKind)) : feeds;
  const statusAdapterUnconfigured = mode === 'panel' && statusAdapterKind === 'none';
  const hasUnconfigured = statusAdapterUnconfigured || panelFeeds.some((feed) => feed.health === 'unconfigured' || feed.errorCode === 'status_unconfigured');
  const hasFeedError = panelFeeds.some((feed) => feed.health === 'error');
  const hasStaleFeed = panelFeeds.some((feed) => feed.health === 'stale');
  const hasFreshFeed = panelFeeds.some((feed) => feed.health === 'fresh');
  const headlineTime = headline ? statusDisplayTime(headline) : null;
  const sectionNote = statusSectionNote(page?.records ?? [], feeds);
  return <section className={`status-timeline status-timeline-${mode}`} aria-label={mode === 'panel' ? '业务状态摘要' : '状态记录'}>
    <div className="status-timeline-head">
      <div><span className="status-section-label">{mode === 'panel' ? '业务状态' : '状态记录'}</span>{mode === 'detail' && <span className="status-section-note">{sectionNote}</span>}</div>
      {loading && <span className="status-loading">读取中…</span>}
    </div>
    {mode === 'panel'
      ? <PanelTimelineBody items={panelItems} feeds={panelFeeds} loading={loading} previewLimit={previewLimit} statusAdapterUnconfigured={statusAdapterUnconfigured} hasUnconfigured={hasUnconfigured} hasFeedError={hasFeedError} hasStaleFeed={hasStaleFeed} hasFreshFeed={hasFreshFeed} onOpenDetails={onOpenDetails} />
      : <>
        {feeds.length > 0 && <div className="status-feeds" aria-label="状态源健康">{feeds.map((feed) => <FeedHealth key={feed.sourceRef} feed={feed} />)}</div>}
        {!loading && groups.length === 0 && !scopeOverview && <div className="status-empty"><strong>{hasUnconfigured ? '业务状态源未接入' : hasFeedError ? '来源读取失败' : hasStaleFeed ? '历史结果已过期' : hasFreshFeed ? '读取成功，暂无状态记录' : '暂无状态记录'}</strong><span>{hasUnconfigured ? '可在设置中的状态数据源登记已有引用。' : hasFeedError ? '保留上一份可用结果，等待下一次读取。' : hasStaleFeed ? '保留上一份可用结果，等待来源恢复。' : hasFreshFeed ? '来源已读取，但本次范围没有记录。' : '等待真实状态回执或容器观察。'}</span></div>}
        {headline && (scopeOverview
          ? <ScopeHeadline record={scopeOverview} datasetRecords={scopeDatasets} feeds={feeds} />
          : <div className="status-headline"><span>{statusHeadlineLabel(headline, feeds)}</span><strong className="status-headline-summary" title={headline.summary}>{headline.summary}</strong>{headlineTime && <time dateTime={headlineTime.value}>{headlineTime.label} {formatStatusTime(headlineTime.value)}</time>}</div>)}
        {groups.length > 0 && <div className="status-groups">{groups.map((group, index) => <StatusGroupView key={group.key} group={group} latest={index === 0} />)}</div>}
        {page?.hasMore && <button type="button" className="status-load-more" onClick={onLoadMore} disabled={loading}>{loading ? '读取中…' : '加载更早记录'}</button>}
      </>}

  </section>;
}

function isPanelBusinessFeed(feed: StatusFeed, statusAdapterKind?: StatusAdapterKind): boolean {
  if (statusAdapterKind === 'none') return false;
  if (statusAdapterKind) return feed.sourceRef.startsWith(`${statusAdapterKind}:`);
  return feed.sourceRef.startsWith('http_json:')
    || feed.sourceRef.startsWith('article_receipt_json:')
    || feed.sourceRef.startsWith('ragflow_documents:')
    || feed.sourceRef.startsWith('quant_pg_receipts:')
    || feed.sourceRef.startsWith('tailscale_status:')
    || feed.sourceRef.startsWith('acme_certificates:')
    || feed.sourceRef.startsWith('openresty_status:');
}


function PanelTimelineBody({ items, feeds, loading, previewLimit, statusAdapterUnconfigured, hasUnconfigured, hasFeedError, hasStaleFeed, hasFreshFeed, onOpenDetails }: {
  items: readonly PanelBusinessItem[];
  feeds: readonly StatusFeed[];
  loading: boolean;
  previewLimit: number;
  statusAdapterUnconfigured: boolean;
  hasUnconfigured: boolean;
  hasFeedError: boolean;
  hasStaleFeed: boolean;
  hasFreshFeed: boolean;
  onOpenDetails?: ((trigger: HTMLButtonElement) => void) | undefined;
}) {
  const notice = feeds.find((feed) => feed.health !== 'fresh' || feed.gap);
  const sourceRefs = new Set(items.map((item) => item.record.sourceRef));
  const sourceLabels = new Set(items.map((item) => item.sourceLabel));
  const showSourceLabels = sourceRefs.size > 1 && sourceLabels.size > 1;
  const collectedAt = feeds.map((feed) => feed.lastSuccessAt).filter((value): value is string => !!value).sort().at(-1);
  const readFailure = feeds.find((feed) => feed.health === 'error' || feed.health === 'stale' || feed.errorCode === 'status_timeout');
  return <div className="status-panel-body">
    {!statusAdapterUnconfigured && <div className="status-collected-at">最近采集：{collectedAt ? <time dateTime={collectedAt}>{formatStatusTime(collectedAt)}</time> : '尚未成功'}</div>}
    {readFailure && <div className={`status-result-warning status-feed-${readFailure.health}`} role="status">{readFailure.health === 'fresh' ? '统计已更新；详情读取超时，历史明细为上次结果' : <>{readFailure.health === 'stale' ? '采集结果已过期' : feedErrorText(readFailure.errorCode)}{items.length > 0 ? '，以下为上次结果' : '，暂无可用结果'}</>}</div>}
    {notice && !readFailure && (onOpenDetails
      ? <button type="button" className={`status-panel-feed status-feed-${notice.health}`} onClick={(event) => onOpenDetails(event.currentTarget)} title={`${notice.sourceRef}${notice.gap ? ' · 历史不连续' : ''}`} aria-label={`打开状态详情：${panelFeedNotice(notice)}`}>{panelFeedNotice(notice)}</button>
      : <span className={`status-panel-feed status-feed-${notice.health}`} title={`${notice.sourceRef}${notice.gap ? ' · 历史不连续' : ''}`}>{panelFeedNotice(notice)}</span>)}
    {loading && items.length === 0 && <span className="status-panel-muted">正在读取业务状态…</span>}
    {items.length > 0 && <div className="status-panel-items">{items.slice(0, previewLimit).map((item) => <PanelStatusItem key={`${item.record.sourceRef}:${item.record.id}`} item={item} showSource={showSourceLabels} />)}</div>}
    {!loading && items.length === 0 && <div className="status-empty status-panel-empty"><strong>{statusAdapterUnconfigured ? '业务状态未接入' : hasUnconfigured ? '业务状态源未接入' : hasFeedError ? '来源读取失败' : hasStaleFeed ? '历史结果已过期' : hasFreshFeed ? '读取成功，暂无业务记录' : '暂无业务记录'}</strong><span>{statusAdapterUnconfigured ? '可在设置中登记状态数据源。' : hasUnconfigured ? '详情中保留状态源和完整历史。' : hasFeedError ? '详情中保留最近可用结果与读取错误。' : hasStaleFeed ? '详情中保留最近结果，当前状态未确认。' : '等待真实业务回执。'}</span></div>}
  </div>;
}

function PanelStatusItem({ item, showSource }: { item: PanelBusinessItem; showSource: boolean }) {
  const time = statusDisplayTime(item.record);
  const historical = item.record.evidenceKind === 'business_event' || item.record.evidenceKind === 'stage_receipt' || item.record.facts.activityState === 'historical';
  return <article className="status-panel-item">
    <span className={`status-group-marker status-outcome-${item.record.outcome}`} role="img" aria-label={outcomeText[item.record.outcome]} />
    <div className="status-panel-copy"><strong>{showSource && <span className="status-panel-source">{item.sourceLabel}</span>}{item.summary} <time dateTime={time.value} title={`${time.label} ${formatStatusTime(time.value)}`}>· {historical ? '历史 · ' : ''}{time.label} {formatStatusTime(time.value)}</time></strong></div>
  </article>;
}

function panelFeedNotice(feed: StatusFeed): string {
  const prefix = infrastructureLabel(feed.sourceRef) ?? (feed.sourceRef.startsWith('ragflow_documents:') ? 'RAG入库' : feed.sourceRef.startsWith('quant_pg_receipts:') ? 'Quant任务' : feed.sourceRef.startsWith('article_receipt_json:') ? '论文回执' : '业务回执');
  const status = feed.health === 'unconfigured' ? '未接入' : feed.health === 'stale' ? '已过期' : feed.health === 'error' ? feedErrorText(feed.errorCode) : '有缺口';
  return `${prefix} · ${status}`;
}

function ScopeHeadline({ record, datasetRecords, feeds }: { record: StatusRecord; datasetRecords: readonly StatusRecord[]; feeds: readonly StatusFeed[] }) {
  const time = statusDisplayTime(record);
  return <div className="status-headline">
    <span>{statusHeadlineLabel(record, feeds)}</span>
    <details className="status-headline-details">
      <summary><strong className="status-headline-summary" title={scopeHeadlineSummary(record, feeds)}>{scopeHeadlineSummary(record, feeds)}</strong></summary>
      <ScopeFacts record={record} datasetRecords={datasetRecords} feeds={feeds} />
    </details>
    <time dateTime={time.value}>{time.label} {formatStatusTime(time.value)}</time>
  </div>;
}

function ScopeFacts({ record, datasetRecords, feeds }: { record: StatusRecord; datasetRecords: readonly StatusRecord[]; feeds: readonly StatusFeed[] }) {
  if (record.sourceRef.startsWith('quant_pg_receipts:')) return <QuantScopeFacts record={record} />;
  const facts = record.facts;
  return <div className="status-scope-facts">
    <span className="status-scope-type">{record.stage}</span>
    <div className="status-fact-grid">
      <ScopeMetric label="来源报告总量" value={factText(facts.reportedDocuments)} />
      <ScopeMetric label="已覆盖文档" value={factText(facts.coveredDocuments)} />
      <ScopeMetric label="覆盖率" value={percentText(facts.coveragePercent)} />
      <ScopeMetric label="完成占比" value={percentText(facts.processingPercent)} />
      <ScopeMetric label="当前活动" value={activityText(effectiveStatusActivity(record, feeds))} />
      <ScopeMetric label="一致性" value={consistencyText(facts.consistency)} />
      <ScopeMetric label="失败分类" value={factText(facts.failureCounts)} />
    </div>
    {datasetRecords.length > 0 && <div className="status-scope-datasets" aria-label="数据集进展">
      {datasetRecords.map((dataset) => <DatasetFact key={`${dataset.sourceRef}:${dataset.id}`} record={dataset} />)}
    </div>}
    {scopeReadWarning(record, feeds) && <p className="status-scope-note">{scopeReadWarning(record, feeds)}</p>}
    <div className="status-scope-times"><span>扫描开始 {factText(facts.scanStartedAt)}</span><span>扫描结束 {factText(facts.scanEndedAt)}</span></div>
  </div>;
}

function QuantScopeFacts({ record }: { record: StatusRecord }) {
  const facts = record.facts;
  return <div className="status-scope-facts">
    <span className="status-scope-type">{record.stage}</span>
    <div className="status-fact-grid">
      <ScopeMetric label="扫描读取" value={factText(facts.scansRead)} />
      <ScopeMetric label="任务读取" value={factText(facts.tasksRead)} />
      <ScopeMetric label="历史记录" value={factText(facts.recorded)} />
      <ScopeMetric label="排队或运行记录" value={factText(facts.activeRecorded)} />
      <ScopeMetric label="完成" value={factText(facts.completedScans === undefined ? facts.completedTasks : Number(facts.completedScans) + Number(facts.completedTasks ?? 0))} />
      <ScopeMetric label="失败" value={factText(facts.failedRecorded)} />
      <ScopeMetric label="当前活动" value={activityText(facts.activityState)} />
      <ScopeMetric label="读取范围" value={facts.incomplete === true ? (facts.hasMore === true ? '仍有更多记录' : '范围尚不完整') : '范围完整'} />
    </div>
    <p className="status-scope-note">Quant 仅提供有界历史扫描与任务记录；当前队列活动未由历史记录确认。</p>
  </div>;
}

function DatasetFact({ record }: { record: StatusRecord }) {
  const facts = record.facts;
  return <div className="status-scope-dataset">
    <strong>{factText(facts.datasetAlias)}</strong>
    <span>总量 {factText(facts.reportedDocuments)} · 覆盖 {factText(facts.coveredDocuments)} · 覆盖率 {percentText(facts.coveragePercent)}</span>
    <span>完成 {factText(facts.completedCount)} · 失败 {factText(facts.failedCount)} · 待处理 {factText(facts.pendingCount)} · 处理中 {factText(facts.processingCount)} · 取消 {factText(facts.cancelledCount)} · 未知 {factText(facts.unknownCount)}</span>
    <small>一致性 {consistencyText(facts.consistency)} · 失败分类 {factText(facts.failureCounts)} · {factText(facts.fileLogFilter)} {factText(facts.fileLogTotal)}{facts.fileLogHasMore === true ? ' · 仍有更多' : ''} · 统计观察 {typeof facts.aggregateObservedAt === 'string' ? formatStatusTime(facts.aggregateObservedAt) : '—'}</small>
  </div>;
}

function isStatusDatasetSnapshot(record: StatusRecord): boolean {
  return record.sourceRef.startsWith('ragflow_documents:') && record.stage === '数据集范围' && record.evidenceKind === 'snapshot_diff';
}

function ScopeMetric({ label, value }: { label: string; value: string }) {
  return <span className="status-scope-metric"><small>{label}</small><strong>{value}</strong></span>;
}

function factText(value: unknown): string {
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

function consistencyText(value: unknown): string {
  return typeof value === 'string' ? consistencyLabels[value] ?? value : factText(value);
}

function activityText(value: unknown): string {
  if (value === 'idle') return '当前空闲';
  if (value === 'active') return '当前处理中';
  if (value === 'historical') return '历史记录；当前活动未确认';
  if (value === 'unsupported') return '业务状态源未接入';
  return '当前活动未确认';
}

function statusSectionNote(records: readonly StatusRecord[], feeds: readonly StatusFeed[]): string {
  const refs = [...records.map((record) => record.sourceRef), ...feeds.map((feed) => feed.sourceRef)];
  if (refs.some((sourceRef) => sourceRef.startsWith('tailscale_status:'))) return '组网连接与限定探测';
  if (refs.some((sourceRef) => sourceRef.startsWith('acme_certificates:'))) return '证书有效期与续期回执';
  if (refs.some((sourceRef) => sourceRef.startsWith('openresty_status:'))) return '代理观察与近期错误';
  if (refs.some((sourceRef) => sourceRef.startsWith('ragflow_documents:'))) return 'RAG入库统计';
  if (refs.some((sourceRef) => sourceRef.startsWith('quant_pg_receipts:'))) return 'Quant扫描与任务历史';
  if (refs.some((sourceRef) => sourceRef.startsWith('article_receipt_json:'))) return '论文下载与同步回执';
  if (records.some((record) => record.evidenceKind === 'container_observation')) return '容器运行观察';
  return '业务回执与运行观察';
}

function scopeHeadlineSummary(record: StatusRecord, feeds: readonly StatusFeed[]): string {
  if (effectiveStatusActivity(record, feeds) !== 'unknown') return record.summary;
  if (record.facts.activityState !== 'idle' && record.facts.activityState !== 'active') return record.summary;
  const feed = feeds.find((item) => item.sourceRef === record.sourceRef);
  const summary = record.summary
    .replace(/当前(?:空闲|处理中|活动状态未确认)/g, '')
    .replace(/；{2,}/g, '；')
    .replace(/^；|；$/g, '');
  const warning = feed?.health === 'stale' ? '历史结果已过期' : feed?.health === 'error' ? '来源读取失败' : '当前活动未确认';
  return `${summary}；${warning}，保留最近范围摘要`;
}

function scopeReadWarning(record: StatusRecord, feeds: readonly StatusFeed[]): string | null {
  const feed = feeds.find((item) => item.sourceRef === record.sourceRef);
  if (feed?.health === 'error') {
    return record.facts.aggregateAuthoritative === true
      ? '详情读取失败；当前活动指标来自最近完成的统计摘要。'
      : '来源读取失败；当前活动状态未确认。';
  }
  if (feed?.health === 'stale') return '历史结果已过期；当前活动状态未确认。';
  if (record.facts.aggregateAuthoritative === true && record.facts.summaryError === null && record.facts.detailError !== null && record.facts.detailError !== undefined) {
    return '详情读取不完整；当前活动指标来自最近完成的统计摘要。';
  }
  if (!feed && record.facts.activityState === 'idle') return '当前活动未由来源确认。';
  return null;
}

function isRecordNewer(candidate: StatusRecord, current: StatusRecord): boolean {
  const candidateTime = Date.parse(candidate.observedAt);
  const currentTime = Date.parse(current.observedAt);
  if (candidateTime !== currentTime) return candidateTime > currentTime;
  const candidateRevision = typeof candidate.facts.refreshRevision === 'number' ? candidate.facts.refreshRevision : null;
  const currentRevision = typeof current.facts.refreshRevision === 'number' ? current.facts.refreshRevision : null;
  if (candidateRevision !== null && currentRevision !== null && candidateRevision !== currentRevision) return candidateRevision > currentRevision;
  return candidate.id > current.id;
}

function percentText(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) + '%' : '—';
}

function StatusGroupView({ group, latest }: { group: StatusGroup; latest: boolean }) {
  const record = group.headline;
  const time = statusDisplayTime(record);
  const evidenceCount = group.records.length > 1 ? ` · ${group.records.length} 条证据` : '';
  return <details className={`status-group ${latest ? 'status-group-latest' : ''}`}>
    <summary className="status-group-summary">
      <span className={`status-group-marker status-outcome-${record.outcome}`} role="img" aria-label={outcomeText[record.outcome]} title={outcomeText[record.outcome]} />
      <span className="status-group-copy"><strong>{record.summary}</strong><small><time className="status-group-time" dateTime={time.value}>{time.label} {formatStatusTime(time.value)}</time>{evidenceCount}</small></span>
      <span className="status-group-chevron" aria-hidden="true">›</span>
    </summary>
    <div className="status-evidence-list">{group.records.map((item) => <EvidenceRow key={`${item.id}:${item.stage}:${item.outcome}`} record={item} />)}</div>
  </details>;
}

function statusDisplayTime(record: StatusRecord): { value: string; label: '发生' | '来源' | '观察' } {
  if (record.occurredAt) return { value: record.occurredAt, label: '发生' };
  if (record.sourceAt) return { value: record.sourceAt, label: '来源' };
  return { value: record.observedAt, label: '观察' };
}

function EvidenceRow({ record }: { record: StatusRecord }) {
  const timestamps = [
    record.occurredAt ? <time key="occurred" dateTime={record.occurredAt}>发生 {formatStatusTime(record.occurredAt)}</time> : null,
    record.sourceAt ? <time key="source" dateTime={record.sourceAt}>源 {formatStatusTime(record.sourceAt)}</time> : null,
    <time key="observed" dateTime={record.observedAt}>观察 {formatStatusTime(record.observedAt)}</time>,
  ].filter(Boolean);
  const factEntries = Object.entries(record.facts).slice(0, 4);
  return <article className="status-evidence-row">
    <div className="status-evidence-main"><strong>{record.stage}</strong><span>{record.summary}</span></div>
    <div className="status-evidence-meta"><span>{evidenceText[record.evidenceKind]}</span><span title={record.sourceRef}>{sourceLabel(record.sourceRef)}</span><span className={`status-outcome status-outcome-${record.outcome}`}>{outcomeText[record.outcome]}</span></div>
    <div className="status-evidence-times">{timestamps}</div>
    {factEntries.length > 0 && <div className="status-facts">{factEntries.map(([key, value]) => <span key={key}>{key}: {String(value ?? '—')}</span>)}</div>}
  </article>;
}

function FeedHealth({ feed }: { feed: StatusFeed }) {
  const businessSource = feed.sourceRef.startsWith('http_json:') || feed.sourceRef.startsWith('article_receipt_json:') || feed.sourceRef.startsWith('ragflow_documents:') || feed.sourceRef.startsWith('quant_pg_receipts:') || feed.sourceRef.startsWith('tailscale_status:') || feed.sourceRef.startsWith('acme_certificates:') || feed.sourceRef.startsWith('openresty_status:');
  const unconfigured = feed.health === 'unconfigured' || feed.errorCode === 'status_unconfigured';
  const prefix = infrastructureLabel(feed.sourceRef) ?? (feed.sourceRef.startsWith('ragflow_documents:') ? 'RAGFlow知识库' : feed.sourceRef.startsWith('quant_pg_receipts:') ? 'Quant后台任务' : businessSource ? '业务回执' : '容器观测');
  const label = unconfigured
    ? businessSource ? '业务状态源未接入' : `${prefix} · 未接入`
    : feed.health === 'fresh' ? `${prefix} · ${freshFeedText(feed)}`
      : feed.health === 'stale' ? `${prefix} · 已过期`
        : `${prefix} · ${feedErrorText(feed.errorCode)}`;
  return <span className={`status-feed status-feed-${feed.health}`} title={`${feed.sourceRef}${feed.gap ? ' · 历史不连续' : ''}`}><i aria-hidden="true" />{label}{feed.gap ? ' · 有缺口' : ''}</span>;
}

function freshFeedText(feed: StatusFeed): string {
  if (!feed.errorCode) return '已更新';
  if (feed.sourceRef.startsWith('ragflow_documents:')) {
    if (feed.errorCode === 'status_timeout') return '统计已更新 · 详情读取超时';
    if (feed.errorCode === 'status_incomplete') return '统计已更新 · 详情未完整';
    if (feed.errorCode === 'status_expired') return '统计已更新 · 详情已过期';
    if (feed.errorCode === 'status_source') return '统计已更新 · 详情读取失败';
    return `统计已更新 · 详情${feedErrorText(feed.errorCode)}`;
  }
  return `已更新 · ${feedErrorText(feed.errorCode)}`;
}

export function formatStatusTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '—';
  return new Date(timestamp).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

function infrastructureLabel(sourceRef: string): string | null {
  if (sourceRef.startsWith('tailscale_status:')) return '组网';
  if (sourceRef.startsWith('acme_certificates:')) return '证书续期';
  if (sourceRef.startsWith('openresty_status:')) return 'OpenResty';
  return null;
}

function sourceLabel(sourceRef: string): string {
  const infrastructure = infrastructureLabel(sourceRef);
  if (infrastructure) return infrastructure;
  const [, value = sourceRef] = sourceRef.split(':', 2);
  if (sourceRef.startsWith('article_receipt_json:')) return `论文回执 · ${value}`;
  if (sourceRef.startsWith('ragflow_documents:')) return `RAGFlow知识库 · ${value}`;
  if (sourceRef.startsWith('quant_pg_receipts:')) return `Quant后台任务 · ${value}`;
  if (sourceRef.startsWith('http_json:')) return `HTTP 回执 · ${value}`;
  if (sourceRef.startsWith('docker:')) return `Docker · ${value}`;
  return sourceRef;
}

function feedErrorText(errorCode: StatusFeed['errorCode']): string {
  if (errorCode === 'status_timeout') return '读取超时';
  if (errorCode === 'status_invalid') return '格式错误';
  if (errorCode === 'status_http') return 'HTTP 错误';
  if (errorCode === 'status_incomplete') return '部分读取';
  if (errorCode === 'status_expired') return '源过期';
  if (errorCode === 'status_auth') return '认证失败';
  if (errorCode === 'status_permission') return '读取权限不足';
  if (errorCode === 'status_schema') return '数据结构不符';
  if (errorCode === 'status_connection') return '连接失败';
  return '来源错误';
}
