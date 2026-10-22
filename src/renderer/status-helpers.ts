import type { StatusActivity, StatusFeed, StatusPage, StatusRecord } from '../shared/status.js';

const CLIENT_STATUS_CACHE_LIMIT = 200;

export type StatusGroup = {
  key: string;
  latest: StatusRecord;
  headline: StatusRecord;
  records: StatusRecord[];
};

export type PanelBusinessItem = {
  record: StatusRecord;
  summary: string;
  sourceLabel: string;
  time: number;
};

/** Merge a bounded IPC page into the renderer cache without losing older pages. */
export function mergeStatusPage(previous: StatusPage | undefined, next: StatusPage, refreshing = false): StatusPage {
  if (!previous) return next;
  const previousRecords = new Map(previous.records.map((record) => [statusRecordKey(record), record]));
  const overlapsPrevious = next.records.some((record) => previousRecords.has(statusRecordKey(record)));
  const records = new Map(previousRecords);
  for (const record of next.records) records.set(statusRecordKey(record), record);
  const ordered = [...records.values()].sort(compareRecency);
  const keepOlderCursor = refreshing && previous.hasMore && previous.nextCursor;
  const retainExhaustedHistory = refreshing && !previous.hasMore && overlapsPrevious;
  const preserveFrontier = !!keepOlderCursor || retainExhaustedHistory;
  const refreshHasGap = refreshing && !overlapsPrevious && next.records.length > 0;
  const feeds = next.feeds.length ? next.feeds : previous.feeds;
  return {
    ...next,
    records: ordered.slice(0, CLIENT_STATUS_CACHE_LIMIT),
    nextCursor: preserveFrontier ? previous.nextCursor : next.nextCursor,
    hasMore: refreshing && preserveFrontier ? previous.hasMore : next.hasMore,
    feeds: refreshHasGap ? feeds.map((feed) => ({ ...feed, gap: true })) : feeds,
  };
}

export function statusRecordTime(record: StatusRecord): number {
  const value = Date.parse(record.occurredAt ?? record.sourceAt ?? record.observedAt);
  return Number.isFinite(value) ? value : 0;
}

export function statusRecordKey(record: StatusRecord): string {
  return `${record.sourceRef}:${record.id}`;
}

/**
 * Select the small set of business facts that belongs in a service panel.
 * The renderer keeps the complete page/cache for the detail view; this is
 * only a presentation limit.
 */
export function selectPanelBusinessItems(records: readonly StatusRecord[], limit = 3): PanelBusinessItem[] {
  const candidates = records.filter(isPanelBusinessRecord);
  const latestRagScopeBySource = new Map<string, StatusRecord>();
  for (const record of candidates) {
    if (!isRagScopeSnapshot(record)) continue;
    const previous = latestRagScopeBySource.get(record.sourceRef);
    if (!previous || comparePanelRecord(record, previous) < 0) latestRagScopeBySource.set(record.sourceRef, record);
  }
  const authoritativeRagSources = new Set(
    [...latestRagScopeBySource.entries()]
      .filter(([, record]) => isAuthoritativeRagScope(record))
      .map(([sourceRef]) => sourceRef),
  );
  const deduped = new Map<string, StatusRecord>();
  for (const record of candidates) {
    // An authoritative RAG scope snapshot already contains the aggregate
    // counters. When the cohort is incomplete, show independent dataset
    // records instead of presenting a synthetic aggregate.
    const authoritative = authoritativeRagSources.has(record.sourceRef);
    if (authoritative && isRagDatasetSnapshot(record)) continue;
    if (!authoritative && isRagScopeSnapshot(record)) continue;
    const key = panelBusinessKey(record);
    const previous = deduped.get(key);
    if (!previous || comparePanelRecord(record, previous) < 0) deduped.set(key, record);
  }
  const items: PanelBusinessItem[] = [];
  const repeatedFailures = new Map<string, { item: PanelBusinessItem; count: number }>();
  for (const record of [...deduped.values()].sort(comparePanelRecord)) {
    const summary = panelBusinessSummary(record);
    // Different documents can have the same safe failure description. Keep
    // their evidence in history, but summarize that repetition on the panel.
    const failureKey = record.sourceRef.startsWith('ragflow_documents:') && record.outcome === 'failed'
      ? JSON.stringify([record.sourceRef, record.facts.datasetAlias, record.stage, summary, record.facts.errorStage, record.facts.errorCode, record.facts.errorReason, record.facts.errorEvidenceLevel])
      : null;
    const repeated = failureKey ? repeatedFailures.get(failureKey) : undefined;
    if (repeated) {
      repeated.count += 1;
      repeated.item.summary = `${summary}（${repeated.count} 条记录）`;
      continue;
    }
    const item = { record, summary, sourceLabel: panelBusinessSourceLabel(record), time: statusRecordTime(record) };
    items.push(item);
    if (failureKey) repeatedFailures.set(failureKey, { item, count: 1 });
  }
  return items.slice(0, Math.max(0, limit));
}

export function isPanelBusinessRecord(record: StatusRecord): boolean {
  if (record.evidenceKind === 'container_observation') return false;
  if (record.stage.includes('读取诊断') || record.stage.includes('采样') || record.stage.includes('容器观察')) return false;
  if (record.sourceRef.startsWith('docker:')) return false;
  return record.sourceRef.startsWith('article_receipt_json:')
    || record.sourceRef.startsWith('ragflow_documents:')
    || record.sourceRef.startsWith('quant_pg_receipts:')
    || record.sourceRef.startsWith('http_json:')
    || record.sourceRef.startsWith('tailscale_status:')
    || record.sourceRef.startsWith('acme_certificates:')
    || record.sourceRef.startsWith('openresty_status:');
}

export function panelBusinessSummary(record: StatusRecord): string {
  if (record.sourceRef.startsWith('article_receipt_json:')) return articlePanelSummary(record);
  if (record.sourceRef.startsWith('ragflow_documents:')) return ragflowPanelSummary(record);
  if (record.sourceRef.startsWith('quant_pg_receipts:')) return quantPanelSummary(record);
  return record.summary;
}

export function panelBusinessSourceLabel(record: StatusRecord): string {
  if (record.sourceRef.startsWith('tailscale_status:')) return '组网';
  if (record.sourceRef.startsWith('acme_certificates:')) return '证书续期';
  if (record.sourceRef.startsWith('openresty_status:')) return 'OpenResty';
  if (record.sourceRef.startsWith('article_receipt_json:')) return '论文回执';
  if (record.sourceRef.startsWith('ragflow_documents:')) return 'RAG入库';
  if (record.sourceRef.startsWith('quant_pg_receipts:')) {
    if (record.facts.businessKind === 'scope') return 'Quant范围';
    if (record.facts.businessKind === 'scan') return 'Quant扫描';
    if (record.facts.businessKind === 'task_history') return 'Quant任务';
    return 'Quant结果';
  }
  return '业务回执';
}

export function groupStatusRecords(records: readonly StatusRecord[]): StatusGroup[] {
  const grouped = new Map<string, StatusRecord[]>();
  for (const record of records) {
    const key = `${record.sourceRef}:${articleTaskRoot(record) ?? record.taskKey?.trim() ?? record.id}`;
    const current = grouped.get(key) ?? [];
    current.push(record);
    grouped.set(key, current);
  }
  return [...grouped.entries()]
    .map(([key, groupedRecords]) => {
      const sorted = groupedRecords.slice().sort(compareRecency);
      return { key, latest: sorted[0]!, headline: selectStatusHeadline(sorted)!, records: sorted };
    })
    .sort((left, right) => groupEvidencePriority(left) - groupEvidencePriority(right) || compareRecency(left.latest, right.latest));
}

export function isStatusScopeSnapshot(record: StatusRecord): boolean {
  const isRagflowScope = record.sourceRef.startsWith('ragflow_documents:') && record.stage === '源范围快照';
  const isQuantScope = record.sourceRef.startsWith('quant_pg_receipts:')
    && record.stage === '已读范围'
    && record.facts.businessKind === 'scope';
  return (isRagflowScope || isQuantScope) && record.evidenceKind === 'snapshot_diff';
}

export function selectStatusHeadline(records: readonly StatusRecord[]): StatusRecord | undefined {
  const latestScopeSnapshot = records
    .filter(isStatusScopeSnapshot)
    .sort(compareRecency)[0];
  if (latestScopeSnapshot) return latestScopeSnapshot;
  return records.slice().sort((left, right) => evidencePriority(left) - evidencePriority(right) || compareRecency(left, right))[0];
}

export function effectiveStatusActivity(record: StatusRecord, feeds: readonly StatusFeed[]): StatusActivity {
  const value = record.facts.activityState;
  const activity: StatusActivity = value === 'idle' || value === 'active' || value === 'historical' || value === 'unsupported' ? value : 'unknown';
  if (!isStatusScopeSnapshot(record) || (activity !== 'idle' && activity !== 'active')) return activity;
  const feed = feeds.find((item) => item.sourceRef === record.sourceRef);
  const summaryAuthoritative = record.facts.aggregateAuthoritative === true && record.facts.summaryError === null;
  return summaryAuthoritative && feed?.health === 'fresh' ? activity : 'unknown';
}

export function statusHeadlineLabel(record: StatusRecord, feeds: readonly StatusFeed[]): string {
  const feed = feeds.find((item) => item.sourceRef === record.sourceRef);
  const outcomeIsActive = record.outcome === 'active';
  const activity = effectiveStatusActivity(record, feeds);
  if (feed?.health === 'error') return '来源读取失败';
  if (feed?.health === 'stale') return '历史结果已过期';
  if (feed?.health === 'unconfigured' || feed?.errorCode === 'status_unconfigured') return '业务状态源未接入';
  if (record.evidenceKind === 'container_observation') {
    const hasUnconfiguredBusinessFeed = feeds.some((item) => item.health === 'unconfigured' || item.errorCode === 'status_unconfigured');
    return hasUnconfiguredBusinessFeed ? '业务状态源未接入' : '最近观察';
  }
  if (activity === 'idle') return '当前空闲';
  if (activity === 'active') return '当前业务摘要';
  if (outcomeIsActive) return '当前业务摘要';
  if (activity === 'historical') return '历史业务记录';
  if (activity === 'unsupported') return '业务状态源未接入';
  if (isStatusScopeSnapshot(record)) return '范围概览';
  if (record.sourceRef.startsWith('article_receipt_json:')) return outcomeIsActive ? '当前业务摘要' : '历史业务记录';
  if (record.facts.businessKind === 'scan' || record.facts.businessKind === 'task_history') return '历史业务记录';
  return outcomeIsActive ? '当前业务摘要' : '最近业务记录';
}

function compareRecency(left: StatusRecord, right: StatusRecord): number {
  const leftKey = statusRecordTime(left);
  const rightKey = statusRecordTime(right);
  if (leftKey !== rightKey) return rightKey - leftKey;
  return Date.parse(right.observedAt) - Date.parse(left.observedAt);
}

function comparePanelRecord(left: StatusRecord, right: StatusRecord): number {
  if (left.facts.infrastructureSnapshot === true && right.facts.infrastructureSnapshot === true && left.sourceRef === right.sourceRef) {
    const order = Number(left.facts.displayOrder ?? 0) - Number(right.facts.displayOrder ?? 0);
    if (left.taskKey !== right.taskKey && order) return order;
    const collected = Date.parse(right.observedAt) - Date.parse(left.observedAt);
    if (collected) return collected;
  }
  const leftTime = statusRecordTime(left);
  const rightTime = statusRecordTime(right);
  if (leftTime !== rightTime) return rightTime - leftTime;
  const leftObserved = Date.parse(left.observedAt);
  const rightObserved = Date.parse(right.observedAt);
  if (leftObserved !== rightObserved) return rightObserved - leftObserved;
  return right.id.localeCompare(left.id);
}

function evidencePriority(record: StatusRecord): number {
  if (record.evidenceKind === 'business_event' || record.evidenceKind === 'stage_receipt') return 0;
  if (record.evidenceKind === 'snapshot_diff') return 1;
  return 2;
}

function groupEvidencePriority(group: StatusGroup): number {
  return group.latest.evidenceKind === 'container_observation' ? 1 : 0;
}

function articleTaskRoot(record: StatusRecord): string | null {
  if (!record.sourceRef.startsWith('article_receipt_json:') || !record.taskKey) return null;
  const match = /^([0-9a-f]{64})(?::.*)?$/i.exec(record.taskKey);
  return match?.[1]?.toLowerCase() ?? null;
}

function panelBusinessKey(record: StatusRecord): string {
  const task = isRagScopeSnapshot(record) || isQuantScopeSnapshot(record)
    ? 'scope'
    : isRagDatasetSnapshot(record)
      ? `dataset:${typeof record.facts.datasetAlias === 'string' ? record.facts.datasetAlias : record.taskKey?.trim() || record.id}`
      : record.taskKey?.trim() || record.id;
  return `${record.sourceRef}:${task}:${record.stage}`;
}

function isRagScopeSnapshot(record: StatusRecord): boolean {
  return record.sourceRef.startsWith('ragflow_documents:') && record.stage === '源范围快照' && record.evidenceKind === 'snapshot_diff';
}

function isRagDatasetSnapshot(record: StatusRecord): boolean {
  return record.sourceRef.startsWith('ragflow_documents:') && record.stage === '数据集范围' && record.evidenceKind === 'snapshot_diff';
}

function isQuantScopeSnapshot(record: StatusRecord): boolean {
  return record.sourceRef.startsWith('quant_pg_receipts:') && record.stage === '已读范围' && record.evidenceKind === 'snapshot_diff' && record.facts.businessKind === 'scope';
}

function isAuthoritativeRagScope(record: StatusRecord): boolean {
  return isRagScopeSnapshot(record) && record.facts.aggregateAuthoritative === true && record.facts.summaryError === null;
}

function articlePanelSummary(record: StatusRecord): string {
  if (record.stage !== '分组结果') return record.summary;
  const papers = finiteFact(record.facts.papers);
  const succeeded = finiteFact(record.facts.succeeded);
  const failed = finiteFact(record.facts.failed);
  const partial = finiteFact(record.facts.partial);
  if (papers === null || succeeded === null) return record.summary;
  const parts = [`论文下载：${succeeded}/${papers} 篇完成`];
  if (failed !== null && failed > 0) parts.push(`失败 ${failed}`);
  if (partial !== null && partial > 0) parts.push(`部分 ${partial}`);
  return parts.join(' · ');
}

function ragflowPanelSummary(record: StatusRecord): string {
  const facts = record.facts;
  if (record.stage !== '源范围快照' && record.stage !== '数据集范围') return record.summary;
  if (record.stage === '源范围快照' && !isAuthoritativeRagScope(record)) return 'RAG入库：各库统计尚未收齐，保留独立数据集结果';
  const prefix = record.stage === '数据集范围' && typeof facts.datasetAlias === 'string' ? facts.datasetAlias : 'RAG入库';
  if (record.stage === '数据集范围' && !hasRagDatasetSummaryEvidence(facts)) return `${prefix}：统计尚未读取`;
  const completed = finiteFact(facts.completedCount);
  const failed = finiteFact(facts.failedCount);
  const pending = finiteFact(facts.pendingCount);
  const processing = finiteFact(facts.processingCount);
  const unknown = finiteFact(facts.unknownCount);
  if (completed === null && failed === null && pending === null && processing === null && unknown === null) return record.summary;
  const parts = [`${prefix}：完成 ${factOrUnknown(completed)} · 失败 ${factOrUnknown(failed)}`];
  if (pending !== null && pending > 0) parts.push(`排队 ${pending}`);
  if (processing !== null && processing > 0) parts.push(`处理中 ${processing}`);
  if (unknown !== null && unknown > 0) parts.push(`未归类 ${unknown}`);
  if (facts.consistency !== null && facts.consistency !== undefined) parts.push(panelConsistency(facts.consistency));
  return parts.join(' · ');
}

function hasRagDatasetSummaryEvidence(facts: StatusRecord['facts']): boolean {
  const reportedDocuments = finiteFact(facts.reportedDocuments);
  const observedAt = typeof facts.aggregateObservedAt === 'string' ? Date.parse(facts.aggregateObservedAt) : Number.NaN;
  return reportedDocuments !== null || Number.isFinite(observedAt);
}

function quantPanelSummary(record: StatusRecord): string {
  const facts = record.facts;
  if (record.stage !== '已读范围') return record.summary;
  const completedScans = finiteFact(facts.completedScans);
  const completedTasks = finiteFact(facts.completedTasks);
  const failed = finiteFact(facts.failedRecorded);
  if (completedScans === null && completedTasks === null && failed === null) return record.summary;
  const completion: string[] = [];
  if (completedScans !== null) completion.push(`扫描${completedScans}`);
  if (completedTasks !== null) completion.push(`任务${completedTasks}`);
  const parts: string[] = [];
  if (completion.length > 0) parts.push(`完成：${completion.join('、')}`);
  if (failed !== null && failed > 0) parts.push(`失败${failed}`);
  const range = facts.incomplete === true ? (facts.hasMore === true ? '部分历史' : '历史不完整') : '历史完整';
  return `Quant：${parts.join('；')} · ${range}`;
}

function finiteFact(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function factOrUnknown(value: number | null): string {
  return value === null ? '待确认' : String(value);
}

function panelConsistency(value: unknown): string {
  if (typeof value !== 'string') return String(value);
  return {
    scanning: '扫描中',
    bounded_partial: '部分读取',
    sweep_covered: '覆盖完成',
    reconciled_non_atomic: '已核对',
    verified_snapshot: '已验证',
    stale: '已过期',
    source_error: '来源读取失败',
    cohort_pending: '待收齐',
    cohort_expired: '同窗未收齐',
  }[value] ?? value;
}
