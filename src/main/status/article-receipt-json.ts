import { createHash } from 'node:crypto';
import { sanitizeId, statusSourceRef, type StatusRecord, type StatusOutcome } from '../../shared/status.js';
import type { DockerTransport } from '../transport/types.js';
import type { RemoteArticleReceiptFile, RemoteArticleReceiptRead } from '../transport/article-receipts.js';
import type { RegisteredArticleReceiptSource } from './source-registry.js';

type ArticleRecord = Omit<StatusRecord, 'serviceId'>;
type ArticleFacts = Record<string, string | number | boolean | null>;
type ArticleRecordIdentity = {
  sourceRef: string;
  fileDirectory: RemoteArticleReceiptFile['directory'];
  fileName: string;
  taskKey: string;
  stage: string;
  outcome: StatusOutcome;
  summary: string;
  occurredAt: string | null;
  facts: ArticleFacts;
};
type ArticleRecordIdFactory = (identity: ArticleRecordIdentity) => string;

export type ArticleReceiptReadResult = {
  sourceRef: string;
  observedAt: string;
  health: 'fresh' | 'error';
  lastSuccessAt: string | null;
  records: ArticleRecord[];
  errorCode: 'status_timeout' | 'status_incomplete' | 'status_invalid' | 'status_source' | null;
};

export type ArticleSourceResolver = (profileId: string, sourceRef: string) => Promise<RegisteredArticleReceiptSource | null>;
export type ArticleTransportLease = { transport: DockerTransport; release: () => void | Promise<void> };
export type ArticleTransportAcquirer = (profileId: string) => Promise<ArticleTransportLease | null>;

const STEP_LABELS: Record<string, string> = {
  download: '下载',
  zotero: 'Zotero入库',
  metadata: '元数据',
  registration: '登记',
  fulltext: '全文',
  reading: '精读',
  index: '知识库索引',
  github: 'GitHub同步',
};
const RECEIPT_ID = /^[0-9a-f]{64}$/;
const REQUEST_PAPER_STATUSES = new Set(['completed', 'failed', 'partial_failure', 'partial']);
const TASK_STATUSES = new Set(['pending', 'running', 'started', 'succeeded', 'downloaded', 'completed', 'failed', 'rejected', 'unavailable', 'cancelled', 'canceled']);
const ZOTERO_STATUSES = new Set(['synced', 'retry_pending', 'failed', 'pending', 'unknown']);
const MAX_RECORD_VERSIONS = 4096;
const OPTIONAL_COMPLETION_DATE_KEYS = ['completed_at', 'failed_at', 'finished_at'] as const;

export class ArticleReceiptJsonReader {
  private readonly inFlight = new Map<string, Promise<ArticleReceiptReadResult>>();
  private readonly recordVersions = new Map<string, { fingerprint: string; version: number; id: string }>();

  constructor(private readonly resolveSource: ArticleSourceResolver, private readonly acquireTransport: ArticleTransportAcquirer) {}

  /** The only public read operation for this fixed-purpose source. */
  async readSnapshots(profileId: string, sourceRef: string, signal?: AbortSignal, now = new Date()): Promise<ArticleReceiptReadResult> {
    const key = `${profileId}\u001f${sourceRef}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const read = this.readSnapshotsInternal(profileId, sourceRef, signal, now);
    this.inFlight.set(key, read);
    try {
      return await read;
    } finally {
      if (this.inFlight.get(key) === read) this.inFlight.delete(key);
    }
  }

  private async readSnapshotsInternal(profileId: string, sourceRef: string, signal?: AbortSignal, now = new Date()): Promise<ArticleReceiptReadResult> {
    const startedAt = now.toISOString();
    const feedSourceRef = statusSourceRef('article_receipt_json', `${profileId}:${sourceRef}`);
    if (signal?.aborted) return { sourceRef: feedSourceRef, observedAt: startedAt, health: 'error', lastSuccessAt: null, records: [], errorCode: 'status_timeout' };
    let lease: ArticleTransportLease | null = null;
    try {
      const source = await this.resolveSource(profileId, sourceRef);
      if (signal?.aborted) return this.error(feedSourceRef, new Date().toISOString(), 'status_timeout');
      if (!source) return this.error(feedSourceRef, new Date().toISOString(), 'status_source');
      lease = await this.acquireTransport(profileId);
      if (signal?.aborted) return this.error(feedSourceRef, new Date().toISOString(), 'status_timeout');
      if (!lease?.transport.readArticleReceipts) return this.error(feedSourceRef, new Date().toISOString(), 'status_source');
      let remote: RemoteArticleReceiptRead;
      try {
        remote = await lease.transport.readArticleReceipts(source.rootPath, signal);
      } catch (error) {
        const transportCode = error instanceof Error && 'code' in error ? (error as { code?: unknown }).code : undefined;
        const code = transportCode === 'timeout' || transportCode === 'cancelled' ? 'status_timeout' : 'status_source';
        return this.error(feedSourceRef, new Date().toISOString(), code);
      }
      const observedAt = new Date().toISOString();
      let complete = true;
      const records: ArticleRecord[] = [];
      for (const file of remote.files) {
        let mapped: ArticleRecord[] | null;
        try {
          mapped = mapFile(file, feedSourceRef, observedAt, (identity) => this.recordId(identity));
        } catch {
          mapped = null;
        }
        if (mapped === null) {
          complete = false;
          continue;
        }
        records.push(...mapped);
      }
      const errorCode = remote.errorCode === 'strict_reader_unavailable' || remote.errorCode === 'source_unavailable'
        ? 'status_source'
        : remote.complete && complete ? null : 'status_incomplete';
      return {
        sourceRef: feedSourceRef,
        observedAt,
        health: errorCode ? 'error' : 'fresh',
        lastSuccessAt: errorCode ? null : observedAt,
        records,
        errorCode,
      };
    } catch (error) {
      return this.error(feedSourceRef, new Date().toISOString(), isCancelled(error) || signal?.aborted ? 'status_timeout' : 'status_source');
    } finally {
      if (lease) {
        try { await lease.release(); } catch { /* cleanup errors cannot reject a source read */ }
      }
    }
  }

  private error(sourceRef: string, observedAt: string, errorCode: ArticleReceiptReadResult['errorCode']): ArticleReceiptReadResult {
    return { sourceRef, observedAt, health: 'error', lastSuccessAt: null, records: [], errorCode };
  }

  private recordId(identity: ArticleRecordIdentity): string {
    const key = `${identity.sourceRef}\u001f${identity.fileDirectory}\u001f${identity.fileName}\u001f${identity.taskKey}\u001f${identity.stage}`;
    const fingerprint = hashIdentity(identity.outcome, identity.summary, identity.occurredAt, stableFacts(identity.facts));
    const previous = this.recordVersions.get(key);
    if (previous?.fingerprint === fingerprint) return previous.id;
    const version = (previous?.version ?? 0) + 1;
    const id = `article-${hashIdentity(key, version, fingerprint)}`;
    this.recordVersions.set(key, { fingerprint, version, id });
    while (this.recordVersions.size > MAX_RECORD_VERSIONS) {
      const oldest = this.recordVersions.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.recordVersions.delete(oldest);
    }
    return id;
  }
}

function mapFile(file: RemoteArticleReceiptFile, sourceRef: string, observedAt: string, makeId: ArticleRecordIdFactory): ArticleRecord[] | null {
  if (file.directory === 'research-requests') return mapRequest(file, sourceRef, observedAt, makeId);
  if (file.directory === 'jobs') return mapJob(file, sourceRef, observedAt, makeId);
  return mapQueue(file, sourceRef, observedAt, makeId);
}

function mapRequest(file: RemoteArticleReceiptFile, sourceRef: string, observedAt: string, makeId: ArticleRecordIdFactory): ArticleRecord[] | null {
  const payload = object(file.payload);
  if (!payload) return null;
  const fileId = receiptId(file);
  const requestId = receiptIdValue(payload.request_id);
  const dois = stringArray(payload.dois, 1, 20)?.map(normalizeDoi);
  if (!fileId || !requestId || requestId !== fileId || !dois || dois.some((doi) => !doi)) return null;
  const createdAt = readDate(payload.created_at);
  if (payload.created_at !== undefined && payload.created_at !== null && !createdAt) return null;
  const result = object(payload.result);
  if (!result) {
    if (!createdAt) return null;
    return [record(file, sourceRef, observedAt, requestId, '请求登记', 'active', '请求已登记，等待分组终态回执。', createdAt, { terminal: false, papers: dois.length }, makeId)];
  }
  if (result.request_id !== requestId) return null;
  const completedAt = readDate(result.completed_at);
  if (!completedAt || !REQUEST_PAPER_STATUSES.has(typeof result.status === 'string' ? result.status : '')) return null;
  if (!Array.isArray(result.papers) || result.papers.length !== dois.length || result.papers.length === 0) return null;
  const seenDois = new Set<string>();
  const papers: Record<string, unknown>[] = [];
  for (const rawPaper of result.papers) {
    const paper = object(rawPaper);
    const doi = typeof paper?.doi === 'string' ? normalizeDoi(paper.doi) : '';
    const status = typeof paper?.status === 'string' ? paper.status : '';
    if (!paper || !doi || seenDois.has(doi) || !dois.includes(doi) || !REQUEST_PAPER_STATUSES.has(status) || status === 'partial_failure' || status === 'partial') return null;
    seenDois.add(doi);
    papers.push(paper);
  }
  if (seenDois.size !== dois.length) return null;
  const outcome = outcomeForGroup(result.status, papers);
  if (!outcome) return null;
  const counts = countPaperOutcomes(papers);
  const records: ArticleRecord[] = [record(file, sourceRef, observedAt, requestId, '分组结果', outcome, groupSummary(outcome, counts), completedAt, {
    papers: papers.length,
    succeeded: counts.succeeded,
    failed: counts.failed,
    partial: counts.partial,
    terminal: true,
  }, makeId)];
  papers.forEach((paper, index) => {
    const paperOutcome = outcomeForPaper(paper.status);
    const independent = independentPaperFacts(paper);
    records.push(record(file, sourceRef, observedAt, `${requestId}:${index + 1}`, '论文终态', paperOutcome, `第${index + 1}篇：${outcomeLabel(paperOutcome)}`, completedAt, {
      paperNumber: index + 1,
      archived: independent.archived,
      zoteroSynced: independent.zoteroSynced,
      githubSynced: independent.githubSynced,
    }, makeId));
  });
  return records;
}

function mapJob(file: RemoteArticleReceiptFile, sourceRef: string, observedAt: string, makeId: ArticleRecordIdFactory): ArticleRecord[] | null {
  const payload = object(file.payload);
  if (!payload) return null;
  const fileId = receiptId(file);
  const payloadId = payload.id === undefined ? fileId : receiptIdValue(payload.id);
  if (!fileId || !payloadId || payloadId !== fileId) return null;
  const lastResult = object(payload.last_result);
  if (payload.last_result !== undefined && !lastResult) return null;
  if (hasInvalidDates(payload) || (lastResult !== null && hasInvalidDates(lastResult))) return null;
  const jobStatus = taskStatus(payload.status);
  const downloadStatus = taskStatus(lastResult?.status) ?? jobStatus;
  if (!downloadStatus) return null;
  if (lastResult && !validJobResult(lastResult)) return null;
  const taskKey = fileId;
  const downloadOutcome = outcomeForTask(downloadStatus);
  const records: ArticleRecord[] = [record(file, sourceRef, observedAt, taskKey, '下载任务', downloadOutcome, '下载任务：' + taskOutcomeLabel(downloadStatus, downloadOutcome), completionDate(lastResult ?? payload), { taskStatus: downloadStatus }, makeId)];
  if (jobStatus && isTerminalFailure(jobStatus) && outcomeForTask(jobStatus) !== downloadOutcome) {
    records.push(record(file, sourceRef, observedAt, taskKey + ':job', '任务结果', outcomeForTask(jobStatus), '任务结果：' + outcomeLabel(outcomeForTask(jobStatus)), completionDate(payload), { taskStatus: jobStatus }, makeId));
  }
  if (lastResult && typeof lastResult.archived === 'boolean') {
    const archiveOutcome: StatusOutcome = lastResult.archived ? 'succeeded' : 'unknown';
    records.push(record(file, sourceRef, observedAt, taskKey + ':archive', 'NAS归档', archiveOutcome, 'NAS归档：' + outcomeLabel(archiveOutcome), null, { confirmed: lastResult.archived }, makeId));
  }
  if (lastResult && typeof lastResult.zotero_status === 'string') {
    const zoteroStatus = lastResult.zotero_status;
    const zoteroOutcome: StatusOutcome = zoteroStatus === 'synced' ? 'succeeded'
      : zoteroStatus === 'retry_pending' ? 'partial'
        : zoteroStatus === 'failed' ? 'failed'
          : zoteroStatus === 'pending' ? 'active'
            : 'unknown';
    records.push(record(file, sourceRef, observedAt, taskKey + ':zotero', 'Zotero入库', zoteroOutcome, 'Zotero入库：' + taskOutcomeLabel(zoteroStatus, zoteroOutcome), null, { status: zoteroStatus, confirmed: zoteroStatus === 'synced' }, makeId));
  }
  return records;
}

function mapQueue(file: RemoteArticleReceiptFile, sourceRef: string, observedAt: string, makeId: ArticleRecordIdFactory): ArticleRecord[] | null {
  const payload = object(file.payload);
  if (!payload) return null;
  const fileId = receiptId(file);
  const taskKey = receiptIdValue(payload.id);
  if (!fileId || !taskKey || taskKey !== fileId) return null;
  if (payload.paper_id !== undefined && (typeof payload.paper_id !== 'string' || !/^P-[a-f0-9]{12}$/.test(payload.paper_id))) return null;
  if (payload.github_commit !== undefined && (typeof payload.github_commit !== 'string' || !/^[a-f0-9]{40}$/.test(payload.github_commit))) return null;
  if (payload.terminal_failure !== undefined && typeof payload.terminal_failure !== 'boolean') return null;
  const updatedAt = payload.updated_at === undefined ? null : readDate(payload.updated_at);
  if (payload.updated_at !== undefined && !updatedAt) return null;
  const steps = object(payload.steps);
  if (!steps) return null;
  const entries = Object.entries(steps);
  if (entries.some(([step, rawStatus]) => !STEP_LABELS[step] || !taskStatus(rawStatus))) return null;
  const records: ArticleRecord[] = [];
  if (entries.length === 0) {
    const outcome: StatusOutcome = payload.terminal_failure === true ? 'failed' : 'unknown';
    records.push(record(file, sourceRef, observedAt, taskKey, '处理队列', outcome, '处理队列：' + outcomeLabel(outcome), null, { taskStatus: payload.terminal_failure === true ? 'failed' : null }, makeId));
    return records;
  }
  for (const [step, rawStatus] of entries) {
    const status = taskStatus(rawStatus)!;
    const label = STEP_LABELS[step];
    if (!label) return null;
    let outcome = outcomeForTask(status);
    const facts: Record<string, string | number | boolean | null> = { taskStatus: status };
    if (step === 'github' && status === 'succeeded') {
      const hasPaperId = typeof payload.paper_id === 'string' && /^P-[a-f0-9]{12}$/.test(payload.paper_id);
      const hasCommit = typeof payload.github_commit === 'string' && /^[a-f0-9]{40}$/.test(payload.github_commit);
      facts.hasPaperId = hasPaperId;
      facts.hasCommit = hasCommit;
      if (!hasPaperId || !hasCommit) outcome = 'partial';
    }
    records.push(record(file, sourceRef, observedAt, taskKey + ':' + step, label, outcome, label + '：' + taskOutcomeLabel(status, outcome), null, facts, makeId));
  }
  return records;
}

function record(file: RemoteArticleReceiptFile, sourceRef: string, observedAt: string, taskKey: string, stage: string, outcome: StatusOutcome, summary: string, occurredAt: string | null, facts: ArticleFacts, makeId: ArticleRecordIdFactory): ArticleRecord {
  const safeTask = safeTaskKey(taskKey) ?? `receipt:${file.fileName.slice(0, 16)}`;
  const activityState = outcome === 'active' ? 'active' : outcome === 'unknown' ? 'unknown' : 'historical';
  const recordFacts = { ...facts, activityState };
  const id = makeId({ sourceRef, fileDirectory: file.directory, fileName: file.fileName, taskKey: safeTask, stage, outcome, summary, occurredAt, facts: recordFacts });
  return {
    id,
    sourceRef,
    taskKey: safeTask,
    stage,
    outcome,
    summary,
    occurredAt,
    sourceAt: file.sourceAt,
    observedAt,
    evidenceKind: 'stage_receipt',
    facts: recordFacts,
    evidenceRef: sanitizeId(`receipt-${file.directory}-${file.fileName.slice(0, 16)}`, 'receipt'),
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function safeTaskKey(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(value) ? value : null;
}

function receiptId(file: RemoteArticleReceiptFile): string | null {
  const value = file.fileName.slice(0, -'.json'.length);
  return RECEIPT_ID.test(value) ? value : null;
}

function receiptIdValue(value: unknown): string | null {
  return typeof value === 'string' && RECEIPT_ID.test(value) ? value : null;
}

function stringArray(value: unknown, minimum: number, maximum: number): string[] | null {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum || value.some((item) => typeof item !== 'string' || item.trim().length === 0 || item.length > 512)) return null;
  return value as string[];
}

function normalizeDoi(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\/doi\.org\//, '');
}

function taskStatus(value: unknown): string | null {
  return typeof value === 'string' && TASK_STATUSES.has(value) ? value : null;
}

function validJobResult(value: Record<string, unknown>): boolean {
  if (value.status !== undefined && !taskStatus(value.status)) return false;
  if (value.archived !== undefined && typeof value.archived !== 'boolean') return false;
  if (value.zotero_status !== undefined && (typeof value.zotero_status !== 'string' || !ZOTERO_STATUSES.has(value.zotero_status))) return false;
  return true;
}

function isTerminalFailure(value: string): boolean {
  return value === 'failed' || value === 'rejected' || value === 'unavailable' || value === 'cancelled' || value === 'canceled';
}

function readDate(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return null;
    const date = new Date(parsed);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  return null;
}

function hasInvalidDates(value: Record<string, unknown>): boolean {
  return OPTIONAL_COMPLETION_DATE_KEYS.some((key) => {
    const raw = value[key];
    return raw !== undefined && raw !== null && readDate(raw) === null;
  });
}

function completionDate(value: Record<string, unknown>): string | null {
  for (const key of ['completed_at', 'failed_at', 'finished_at']) {
    const date = readDate(value[key]);
    if (date) return date;
  }
  return null;
}

function outcomeForTask(value: string | null): StatusOutcome {
  if (value === 'pending' || value === 'running' || value === 'started') return 'active';
  if (value === 'succeeded' || value === 'downloaded' || value === 'completed') return 'succeeded';
  if (value === 'failed' || value === 'rejected' || value === 'unavailable') return 'failed';
  if (value === 'cancelled' || value === 'canceled') return 'cancelled';
  return 'unknown';
}

function taskOutcomeLabel(status: string | null, outcome: StatusOutcome): string {
  return status === 'pending' ? '等待处理' : outcomeLabel(outcome);
}

function outcomeForGroup(value: unknown, papers: readonly Record<string, unknown>[]): StatusOutcome | null {
  if (!papers.length) return null;
  const allCompleted = papers.every((paper) => paper.status === 'completed');
  const allFailed = papers.every((paper) => paper.status === 'failed');
  if (value === 'completed') return allCompleted ? 'succeeded' : 'partial';
  if (value === 'partial_failure') return 'partial';
  if (value === 'failed') return allFailed ? 'failed' : 'partial';
  return null;
}

function outcomeForPaper(value: unknown): StatusOutcome {
  if (value === 'completed') return 'succeeded';
  if (value === 'failed') return 'failed';
  if (value === 'partial_failure' || value === 'partial') return 'partial';
  return 'unknown';
}

function countPaperOutcomes(papers: readonly Record<string, unknown>[]): { succeeded: number; failed: number; partial: number } {
  return papers.reduce<{ succeeded: number; failed: number; partial: number }>((counts, paper) => {
    const outcome = outcomeForPaper(paper.status);
    if (outcome === 'succeeded') counts.succeeded += 1;
    else if (outcome === 'failed') counts.failed += 1;
    else if (outcome === 'partial') counts.partial += 1;
    return counts;
  }, { succeeded: 0, failed: 0, partial: 0 });
}

function groupSummary(outcome: StatusOutcome, counts: { succeeded: number; failed: number; partial: number }): string {
  return `分组结果：${outcomeLabel(outcome)}（成功${counts.succeeded}篇，失败${counts.failed}篇，部分${counts.partial}篇）`;
}

function outcomeLabel(outcome: StatusOutcome): string {
  return ({ active: '进行中', succeeded: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消', unknown: '状态未知' } satisfies Record<StatusOutcome, string>)[outcome];
}

function independentPaperFacts(paper: Record<string, unknown>): { archived: boolean | null; zoteroSynced: boolean | null; githubSynced: boolean | null } {
  const steps = object(paper.steps);
  return {
    archived: typeof paper.archived === 'boolean' ? paper.archived : null,
    zoteroSynced: paper.zotero_status === 'synced' ? true : paper.zotero_status ? false : null,
    githubSynced: steps?.github === 'succeeded' && typeof paper.github_commit === 'string' && /^[a-f0-9]{40}$/.test(paper.github_commit) ? true : steps?.github ? false : null,
  };
}

function hashIdentity(...values: unknown[]): string {
  return createHash('sha256').update(values.map((value) => String(value ?? '')).join('\u001f')).digest('hex').slice(0, 24);
}

function stableFacts(facts: ArticleFacts): string {
  return JSON.stringify(Object.entries(facts).sort(([left], [right]) => left.localeCompare(right)));
}

function isCancelled(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message === 'cancelled');
}
