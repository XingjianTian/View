import { createHash } from 'node:crypto';
import type { DockerTransport } from '../transport/types.js';
import type {
  RagflowAggregateDataset,
  RagflowAggregateRead,
  RagflowFailureCode,
  RagflowFailureEvidenceLevel,
  RagflowFailureShape,
  RagflowDiagnosticEvent,
  RagflowFailureStage,
  RagflowIngestionLog,
  RagflowIngestionLogsRead,
  RagflowRun,
} from '../transport/ragflow-documents.js';
import { createRagflowReadBudget, monotonicRagflowNowMs, remainingRagflowReadMs, type RagflowDocumentsSource, type RagflowReadBudget } from '../transport/ragflow-documents.js';
import { TransportError } from '../transport/types.js';
import { sanitizeId, statusSourceRef, type StatusActivity, type StatusRecord, type StatusOutcome } from '../../shared/status.js';
import type { RegisteredRagflowDocumentsSource } from './source-registry.js';

type RagflowRecord = Omit<StatusRecord, 'serviceId'>;
type FactValue = string | number | boolean | null;
type FailureCounts = Record<RagflowFailureCode, number>;
type ScopeConsistency = 'scanning' | 'bounded_partial' | 'reconciled_non_atomic' | 'stale' | 'source_error' | 'cohort_pending' | 'cohort_expired';

type DatasetState = {
  datasetId: string;
  summary: RagflowAggregateDataset | null;
  summaryObservedAt: string | null;
  logPages: number;
  logFilter: 'all_file_logs' | 'failed_operations' | null;
  logs: RagflowIngestionLog[];
  logTotal: number | null;
  logHasMore: boolean;
};

type SummaryWindow = {
  summary: RagflowAggregateDataset;
  requestStartedAt: string;
  requestCompletedAt: string;
  observedAt: string;
};

type PendingCohort = {
  sourceIdentity: string;
  datasetIds: readonly string[];
  openedAtMs: number;
  expiresAtMs: number;
  firstRequestStartedAt: string | null;
  lastRequestCompletedAt: string | null;
  summaries: Map<string, SummaryWindow>;
  attempts: Map<string, number>;
};

type SourceState = {
  registered: RegisteredRagflowDocumentsSource;
  sourceIdentity: string;
  datasets: Map<string, DatasetState>;
  summaryRoundIncomplete: boolean;
  pendingCohort: PendingCohort | null;
  lastCohortStatus: 'none' | 'pending' | 'complete' | 'expired';
  lastExpiredAtMs: number | null;
  lastCompleteSummary: Map<string, RagflowAggregateDataset>;
  lastCompleteStartedAt: string | null;
  lastCompleteCompletedAt: string | null;
  lastCompleteObservedAt: string | null;
  summaryIndex: number;
  logIndex: number;
  phase: 'summary' | 'logs';
  sequence: number;
  lastSuccessAt: string | null;
  lastError: RagflowDocumentsReadResult['errorCode'];
  currentSummarySuccess: boolean;
};

type DatasetView = {
  datasetId: string;
  alias: string;
  summary: RagflowAggregateDataset | null;
  state: DatasetState;
  summaryCurrent: boolean;
  authoritative: boolean;
};

type ScopeSnapshot = {
  views: readonly DatasetView[];
  reportedDocuments: number | null;
  coveredDocuments: number;
  coverageMissing: number | null;
  coveragePercent: number | null;
  processingPercent: number | null;
  pendingCount: number | null;
  processingCount: number | null;
  completedCount: number | null;
  failedCount: number | null;
  cancelledCount: number | null;
  unknownCount: number | null;
  countConflict: boolean;
  consistency: ScopeConsistency;
  failureCounts: FailureCounts;
  aggregateAuthoritative: boolean;
  aggregateReadStartedAt: string | null;
  aggregateReadCompletedAt: string | null;
  aggregateObservedAt: string | null;
  aggregateError: RagflowDocumentsReadResult['errorCode'];
  summaryError: RagflowDocumentsReadResult['errorCode'];
  detailError: RagflowDocumentsReadResult['errorCode'];
  detailsComplete: boolean;
  failureDetailCoverageGap: boolean;
  activityState: StatusActivity;
};

export type RagflowDocumentsReadResult = {
  sourceRef: string;
  observedAt: string;
  health: 'fresh' | 'error';
  lastSuccessAt: string | null;
  records: RagflowRecord[];
  hasMore: boolean;
  gap: boolean;
  errorCode: 'status_timeout' | 'status_http' | 'status_invalid' | 'status_redirect' | 'status_incomplete' | 'status_source' | null;
};

export type RagflowSourceResolver = (profileId: string, sourceRef: string) => Promise<RegisteredRagflowDocumentsSource | null>;
export type RagflowTransportLease = { transport: DockerTransport; release: () => void | Promise<void> };
export type RagflowTransportAcquirer = (profileId: string) => Promise<RagflowTransportLease | null>;

const RUN_LABELS: Readonly<Record<RagflowRun, { stage: string; outcome: StatusOutcome }>> = Object.freeze({
  UNSTART: { stage: '待解析', outcome: 'active' },
  SCHEDULED: { stage: '处理中', outcome: 'active' },
  RUNNING: { stage: '处理中', outcome: 'active' },
  DONE: { stage: '报告完成', outcome: 'succeeded' },
  FAILED: { stage: '失败', outcome: 'failed' },
  CANCELLED: { stage: '取消', outcome: 'cancelled' },
});

const FAILURE_LABELS: Readonly<Record<RagflowFailureCode, string>> = Object.freeze({
  model_not_found: '模型不存在',
  invalid_api_key: '鉴权失败',
  rate_limit: '上游限流',
  context_length: '上下文超限',
  vector_dimension: '向量维度不匹配',
  timeout: '上游超时',
  http_4xx: '上游 HTTP 4xx',
  http_5xx: '上游 HTTP 5xx',
  unclassified: '已有来源描述，尚未归类/原因未能安全识别',
});

const STAGE_LABELS: Readonly<Record<RagflowFailureStage, string>> = Object.freeze({
  parsing: '解析阶段',
  embedding: '嵌入阶段',
  indexing: '索引阶段',
  metadata: '元数据阶段',
  unknown: '阶段未确认',
});

const EMPTY_FAILURE_COUNTS = (): FailureCounts => ({
  model_not_found: 0,
  invalid_api_key: 0,
  rate_limit: 0,
  context_length: 0,
  vector_dimension: 0,
  timeout: 0,
  http_4xx: 0,
  http_5xx: 0,
  unclassified: 0,
});

const RAGFLOW_COHORT_MS = 90_000;
const RAGFLOW_COHORT_MAX_ATTEMPTS = 2;

export class RagflowDocumentsStatusAdapter {
  private readonly inFlight = new Map<string, Promise<RagflowDocumentsReadResult>>();
  private readonly checkpoints = new Map<string, SourceState>();

  constructor(
    private readonly resolveSource: RagflowSourceResolver,
    private readonly acquireTransport: RagflowTransportAcquirer,
    private readonly monotonicNow: () => number = monotonicRagflowNowMs,
  ) {}

  async readSnapshots(profileId: string, sourceRef: string, signal?: AbortSignal, now = new Date()): Promise<RagflowDocumentsReadResult> {
    const key = profileId + '\u001f' + sourceRef;
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

  private async readSnapshotsInternal(profileId: string, sourceRef: string, signal: AbortSignal | undefined, now: Date): Promise<RagflowDocumentsReadResult> {
    const feedSourceRef = statusSourceRef('ragflow_documents', profileId + ':' + sourceRef);
    const fallbackObservedAt = validObservedAt(now.toISOString(), now.toISOString());
    // The deadline starts before source resolution and lease acquisition.
    const diagnosticEvents: RagflowDiagnosticEvent[] = [];
    const budget = createRagflowReadBudget(undefined, (event) => {
      if (diagnosticEvents.length < 24) diagnosticEvents.push(event);
    });
    if (signal?.aborted) return this.error(feedSourceRef, fallbackObservedAt, 'status_timeout');
    let lease: RagflowTransportLease | null = null;
    const stateKey = profileId + '\u001f' + sourceRef;
    const cachedState = this.checkpoints.get(stateKey);
    try {
      let registered: RegisteredRagflowDocumentsSource | null;
      try {
        registered = await awaitRagflowBudget(this.resolveSource(profileId, sourceRef), budget, 'RAGFlow 来源解析超时。');
      } catch (cause) {
        if (cachedState) return this.recordsWithError(feedSourceRef, cachedState, cachedState.registered, now, mapTransportError(cause, signal));
        throw cause;
      }
      if (signal?.aborted || remainingRagflowReadMs(budget) <= 0) {
        return cachedState
          ? this.recordsWithError(feedSourceRef, cachedState, cachedState.registered, now, 'status_timeout')
          : this.error(feedSourceRef, new Date().toISOString(), 'status_timeout');
      }
      if (!registered) {
        return cachedState
          ? this.recordsWithError(feedSourceRef, cachedState, cachedState.registered, now, 'status_source')
          : this.error(feedSourceRef, new Date().toISOString(), 'status_source');
      }
      const datasetIds = registered.source.datasetIds ?? [];
      if (datasetIds.length === 0) return this.error(feedSourceRef, new Date().toISOString(), 'status_source');
      const stateIdentity = sourceIdentity(profileId, sourceRef, registered, datasetIds);
      const state = this.ensureState(stateKey, datasetIds, registered, stateIdentity);
      this.expirePendingCohort(state, this.monotonicNow());
      const acquisition = this.acquireTransport(profileId);
      try {
        lease = await awaitRagflowBudget(acquisition, budget, 'RAGFlow 读取租约超时。');
      } catch (error) {
        void acquisition.then((lateLease) => lateLease?.release()).catch(() => undefined);
        return this.recordsWithError(feedSourceRef, state, registered, now, mapTransportError(error, signal));
      }
      if (signal?.aborted || remainingRagflowReadMs(budget) <= 0) return this.recordsWithError(feedSourceRef, state, registered, now, 'status_timeout');
      if (!lease?.transport) return this.recordsWithError(feedSourceRef, state, registered, now, 'status_source');

      state.sequence += 1;
      state.lastError = null;
      let aggregateRead: RagflowAggregateRead | null = null;
      let aggregateError: RagflowDocumentsReadResult['errorCode'] = null;
      let logsRead: RagflowIngestionLogsRead | null = null;
      let logsError: RagflowDocumentsReadResult['errorCode'] = null;
      let diagnosticOperation: 'summary' | 'file_logs' | null = null;
      let diagnosticScopeIndex: number | null = null;
      let diagnosticPage: number | null = null;
      let diagnosticFilter: 'all_file_logs' | 'failed_operations' | null = null;

      if (state.phase === 'summary') {
        state.currentSummarySuccess = false;
        const datasetId = this.nextSummaryDataset(state, datasetIds);
        diagnosticOperation = 'summary';
        diagnosticScopeIndex = datasetId === null ? null : datasetIds.indexOf(datasetId) + 1;
        if (!datasetId) {
          state.phase = 'logs';
        } else if (!lease.transport.readRagflowAggregates) {
          aggregateError = 'status_source';
        } else {
          const scoped = { ...registered.source, datasetIds: [datasetId] };
          try {
            aggregateRead = await lease.transport.readRagflowAggregates(scoped, signal, budget);
            const applied = this.applySummary(state, aggregateRead, datasetIds, this.monotonicNow());
            state.currentSummarySuccess = applied && aggregateRead.datasets.some((dataset) => dataset.datasetId === datasetId)
              && aggregateRead.failedDatasetIds.includes(datasetId) === false
              && aggregateRead.datasets.find((dataset) => dataset.datasetId === datasetId)?.countersComplete === true;
            if (!aggregateRead.complete || aggregateRead.failedDatasetIds.length > 0) aggregateError = 'status_incomplete';
          } catch (cause) {
            aggregateError = mapTransportError(cause, signal);
          }
        }
        if (aggregateError) state.summaryRoundIncomplete = true;
        // Keep the candidate cohort across refreshes. Once each missing
        // dataset has used its two normal opportunities, historical logs get
        // a bounded turn before a later cohort can start after expiry.
        if (!state.pendingCohort || !hasSummaryCandidate(state.pendingCohort, datasetIds)) state.phase = 'logs';
      } else {
        const datasetId = datasetIds[state.logIndex % datasetIds.length]!;
        diagnosticOperation = 'file_logs';
        diagnosticScopeIndex = datasetIds.indexOf(datasetId) + 1;
        state.logIndex = (state.logIndex + 1) % datasetIds.length;
        if (!lease.transport.readRagflowIngestionLogs) {
          logsError = 'status_source';
        } else {
          const datasetState = state.datasets.get(datasetId);
          const trustedSummary = state.pendingCohort?.summaries.get(datasetId)?.summary
            ?? state.lastCompleteSummary.get(datasetId)
            ?? datasetState?.summary
            ?? null;
          const ingestionFailureOnly = trustedSummary?.countersComplete === true
            && trustedSummary.countConflict === false
            && trustedSummary.failedCount > 0;
          const logFilter = ingestionFailureOnly ? 'failed_operations' : 'all_file_logs';
          diagnosticFilter = logFilter;
          if (datasetState && datasetState.logFilter !== logFilter) {
            datasetState.logFilter = logFilter;
            datasetState.logPages = 1;
            datasetState.logs = [];
            datasetState.logTotal = null;
            datasetState.logHasMore = false;
          }
          const page = datasetState?.logPages ?? 1;
          diagnosticPage = page;
          const scoped: RagflowDocumentsSource = {
            ...registered.source,
            datasetIds: [datasetId],
            ingestionLogPages: { [datasetId]: page },
            ...(ingestionFailureOnly ? { ingestionFailureOnly: true as const } : {}),
          };
          try {
            logsRead = await lease.transport.readRagflowIngestionLogs(scoped, signal, budget);
            this.applyLogs(state, logsRead);
            if (!logsRead.complete || logsRead.failedDatasetIds.length > 0) logsError = 'status_incomplete';
          } catch (cause) {
            logsError = mapTransportError(cause, signal);
          }
        }
        if (state.logIndex === 0) {
          state.phase = 'summary';
        }
      }

      const currentError = aggregateError ?? logsError;
      state.lastError = currentError;
      const observedAt = aggregateRead?.observedAt ?? logsRead?.observedAt ?? new Date().toISOString();
      if (aggregateRead?.datasets.length || logsRead?.datasets.length) state.lastSuccessAt = validObservedAt(observedAt, now.toISOString());
      const scope = summarizeScope(state, registered, aggregateError, logsError);
      const records: RagflowRecord[] = [
        mapScopeSnapshot(scope, registered, feedSourceRef, observedAt, state.sequence),
        ...scope.views.map((view) => mapDatasetSnapshot(view, feedSourceRef, observedAt, state.sequence)),
      ];
      for (const view of scope.views) {
        const dataset = view.state;
        for (const [index, log] of dataset.logs.entries()) {
          if (log.run === 'FAILED') records.push(mapIngestionLog(log, view, registered, feedSourceRef, observedAt, state.sequence, index));
        }
      }
      const diagnostic = mapReadDiagnostic(
        diagnosticEvents,
        diagnosticOperation,
        diagnosticScopeIndex,
        diagnosticPage,
        diagnosticFilter,
        currentError,
        state.sequence,
        feedSourceRef,
        observedAt,
      );
      if (diagnostic) records.push(diagnostic);
      const hasFullSummary = scope.aggregateAuthoritative;
      const incomplete = !hasFullSummary || !scope.detailsComplete || scope.failureDetailCoverageGap || state.phase !== 'summary';
      const summaryHealthy = scope.aggregateAuthoritative && scope.summaryError === null;
      const hasKnownSnapshot = state.lastCompleteSummary.size > 0
        || [...state.datasets.values()].some((dataset) => dataset.summary !== null || dataset.logs.length > 0);
      if (!aggregateRead?.datasets.length && !logsRead?.datasets.length && !hasKnownSnapshot && !diagnostic) {
        return this.error(feedSourceRef, validObservedAt(observedAt, now.toISOString()), currentError ?? 'status_source');
      }
      return {
        sourceRef: feedSourceRef,
        observedAt: validObservedAt(observedAt, now.toISOString()),
        health: summaryHealthy ? 'fresh' : currentError || incomplete ? 'error' : aggregateRead?.datasets.length || logsRead?.datasets.length ? 'fresh' : 'error',
        lastSuccessAt: state.lastSuccessAt,
        records,
        hasMore: incomplete,
        gap: incomplete || Boolean(currentError),
        errorCode: currentError ?? (incomplete ? 'status_incomplete' : null),
      };
    } catch (cause) {
      return this.error(feedSourceRef, new Date().toISOString(), mapTransportError(cause, signal));
    } finally {
      if (lease) {
        try { await lease.release(); } catch { /* cleanup must not reject status */ }
      }
    }
  }

  private ensureState(key: string, datasetIds: readonly string[], registered: RegisteredRagflowDocumentsSource, identity: string): SourceState {
    const existing = this.checkpoints.get(key);
    if (existing && existing.sourceIdentity === identity) {
      existing.registered = registered;
      if (existing.summaryIndex >= datasetIds.length) existing.summaryIndex = 0;
      if (existing.logIndex >= datasetIds.length) existing.logIndex = 0;
      return existing;
    }
    const state = createSourceState(registered, datasetIds, identity);
    this.checkpoints.set(key, state);
    return state;
  }

  private nextSummaryDataset(state: SourceState, datasetIds: readonly string[]): string | null {
    if (!state.pendingCohort) this.openPendingCohort(state, datasetIds);
    const pending = state.pendingCohort;
    if (!pending) return null;
    for (let offset = 0; offset < datasetIds.length; offset += 1) {
      const index = (state.summaryIndex + offset) % datasetIds.length;
      const datasetId = datasetIds[index]!;
      if (pending.summaries.has(datasetId)) continue;
      const attempts = pending.attempts.get(datasetId) ?? 0;
      if (attempts >= RAGFLOW_COHORT_MAX_ATTEMPTS) continue;
      pending.attempts.set(datasetId, attempts + 1);
      state.summaryIndex = (index + 1) % datasetIds.length;
      return datasetId;
    }
    return null;
  }

  private openPendingCohort(state: SourceState, datasetIds: readonly string[]): void {
    const openedAtMs = this.monotonicNow();
    const pending: PendingCohort = {
      sourceIdentity: state.sourceIdentity,
      datasetIds: [...datasetIds],
      openedAtMs,
      expiresAtMs: openedAtMs + RAGFLOW_COHORT_MS,
      firstRequestStartedAt: null,
      lastRequestCompletedAt: null,
      summaries: new Map(),
      attempts: new Map(),
    };
    state.pendingCohort = pending;
    state.summaryRoundIncomplete = false;
    state.lastCohortStatus = 'pending';
  }

  private expirePendingCohort(state: SourceState, nowMs: number): void {
    const pending = state.pendingCohort;
    if (!pending || nowMs < pending.expiresAtMs) return;
    state.lastExpiredAtMs = nowMs;
    state.lastCohortStatus = 'expired';
    state.pendingCohort = null;
    state.summaryRoundIncomplete = true;
    state.phase = 'summary';
    state.summaryIndex = 0;
  }

  private applySummary(state: SourceState, read: RagflowAggregateRead, datasetIds: readonly string[], nowMs: number): boolean {
    const pending = state.pendingCohort;
    if (!pending || pending.sourceIdentity !== state.sourceIdentity || nowMs >= pending.expiresAtMs) {
      this.expirePendingCohort(state, nowMs);
      return false;
    }
    const requestStartedAt = validOptionalObservedAt(read.requestStartedAt, read.observedAt);
    const requestCompletedAt = validOptionalObservedAt(read.requestCompletedAt, read.observedAt);
    const observedAt = validObservedAt(read.observedAt, requestCompletedAt);
    pending.firstRequestStartedAt = pending.firstRequestStartedAt === null
      ? requestStartedAt
      : earliestIso(pending.firstRequestStartedAt, requestStartedAt);
    pending.lastRequestCompletedAt = pending.lastRequestCompletedAt === null
      ? requestCompletedAt
      : latestIso(pending.lastRequestCompletedAt, requestCompletedAt);
    for (const dataset of read.datasets) {
      const datasetState = state.datasets.get(dataset.datasetId);
      if (!datasetState) continue;
      datasetState.summary = dataset;
      datasetState.summaryObservedAt = observedAt;
      if (read.complete && !read.failedDatasetIds.includes(dataset.datasetId) && dataset.countersComplete && datasetIds.includes(dataset.datasetId)) {
        pending.summaries.set(dataset.datasetId, {
          summary: dataset,
          requestStartedAt,
          requestCompletedAt,
          observedAt,
        });
      }
    }
    const complete = datasetIds.length > 0 && datasetIds.every((datasetId) => pending.summaries.has(datasetId));
    if (!complete) return true;
    state.lastCompleteSummary = new Map(datasetIds.map((datasetId) => [datasetId, pending.summaries.get(datasetId)!.summary]));
    const windows = datasetIds.map((datasetId) => pending.summaries.get(datasetId)!);
    state.lastCompleteStartedAt = windows.reduce((earliest, window) => earliestIso(earliest, window.requestStartedAt), windows[0]!.requestStartedAt);
    state.lastCompleteCompletedAt = windows.reduce((latest, window) => latestIso(latest, window.requestCompletedAt), windows[0]!.requestCompletedAt);
    state.lastCompleteObservedAt = windows.reduce((latest, window) => latestIso(latest, window.observedAt), windows[0]!.observedAt);
    state.pendingCohort = null;
    state.summaryRoundIncomplete = false;
    state.lastCohortStatus = 'complete';
    state.lastExpiredAtMs = null;
    return true;
  }

  private applyLogs(state: SourceState, read: RagflowIngestionLogsRead): void {
    for (const dataset of read.datasets) {
      const datasetState = state.datasets.get(dataset.datasetId);
      if (!datasetState) continue;
      if (datasetState.logFilter !== dataset.filter) {
        datasetState.logFilter = dataset.filter;
        datasetState.logPages = dataset.page;
        datasetState.logs = [];
      }
      datasetState.logTotal = dataset.total;
      datasetState.logHasMore = dataset.hasMore;
      if (dataset.hasMore && dataset.page < 512) datasetState.logPages = dataset.page + 1;
      else datasetState.logPages = 1;
      const merged = [...datasetState.logs];
      for (const log of dataset.logs) {
        const key = log.logIdHash ?? `${log.documentHash ?? ''}:${log.sourceAt ?? ''}:${log.failureCode ?? ''}`;
        if (!merged.some((item) => (item.logIdHash ?? `${item.documentHash ?? ''}:${item.sourceAt ?? ''}:${item.failureCode ?? ''}`) === key)) merged.push(log);
      }
      datasetState.logs = merged.slice(-16);
    }
  }

  private recordsWithError(feedSourceRef: string, state: SourceState, registered: RegisteredRagflowDocumentsSource, now: Date, errorCode: RagflowDocumentsReadResult['errorCode']): RagflowDocumentsReadResult {
    if (!state.lastCompleteSummary.size && ![...state.datasets.values()].some((item) => item.summary || item.logs.length > 0)) return this.error(feedSourceRef, now.toISOString(), errorCode);
    state.lastError = errorCode;
    state.currentSummarySuccess = false;
    const scope = summarizeScope(state, registered, errorCode, null);
    const observedAt = now.toISOString();
    const records: RagflowRecord[] = [mapScopeSnapshot(scope, registered, feedSourceRef, observedAt, state.sequence), ...scope.views.map((view) => mapDatasetSnapshot(view, feedSourceRef, observedAt, state.sequence))];
    for (const view of scope.views) for (const [index, log] of view.state.logs.entries()) {
      if (log.run === 'FAILED') records.push(mapIngestionLog(log, view, registered, feedSourceRef, observedAt, state.sequence, index));
    }
    return { sourceRef: feedSourceRef, observedAt, health: 'error', lastSuccessAt: state.lastSuccessAt, records, hasMore: true, gap: true, errorCode };
  }

  private error(sourceRef: string, observedAt: string, errorCode: RagflowDocumentsReadResult['errorCode']): RagflowDocumentsReadResult {
    return { sourceRef, observedAt, health: 'error', lastSuccessAt: null, records: [], hasMore: false, gap: false, errorCode };
  }
}

function createDatasetState(datasetId: string): DatasetState {
  return { datasetId, summary: null, summaryObservedAt: null, logPages: 1, logFilter: null, logs: [], logTotal: null, logHasMore: false };
}

function createSourceState(registered: RegisteredRagflowDocumentsSource, datasetIds: readonly string[], identity: string): SourceState {
  const datasets = new Map<string, DatasetState>();
  for (const datasetId of datasetIds) datasets.set(datasetId, createDatasetState(datasetId));
  return {
    registered,
    sourceIdentity: identity,
    datasets,
    summaryRoundIncomplete: false,
    pendingCohort: null,
    lastCohortStatus: 'none',
    lastExpiredAtMs: null,
    lastCompleteSummary: new Map(),
    lastCompleteStartedAt: null,
    lastCompleteCompletedAt: null,
    lastCompleteObservedAt: null,
    summaryIndex: 0,
    logIndex: 0,
    phase: 'summary',
    sequence: 0,
    lastSuccessAt: null,
    lastError: null,
    currentSummarySuccess: false,
  };
}

function sourceIdentity(profileId: string, sourceRef: string, registered: RegisteredRagflowDocumentsSource, datasetIds: readonly string[]): string {
  const target = registered.source.target;
  const bearerHash = createHash('sha256').update(registered.source.bearerToken).digest('hex');
  return hashIdentity(
    profileId,
    sourceRef,
    registered.source.sourceRef,
    [...datasetIds].sort().join(','),
    target.containerId,
    target.ip,
    target.port,
    target.network,
    target.hostHeader,
    bearerHash,
  );
}

function hasSummaryCandidate(pending: PendingCohort, datasetIds: readonly string[]): boolean {
  return datasetIds.some((datasetId) => !pending.summaries.has(datasetId) && (pending.attempts.get(datasetId) ?? 0) < RAGFLOW_COHORT_MAX_ATTEMPTS);
}

function validOptionalObservedAt(value: string | undefined, fallback: string): string {
  return validObservedAt(value ?? fallback, fallback);
}

function earliestIso(a: string, b: string): string {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function latestIso(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function summarizeScope(
  state: SourceState,
  registered: RegisteredRagflowDocumentsSource,
  summaryError: RagflowDocumentsReadResult['errorCode'],
  detailError: RagflowDocumentsReadResult['errorCode'],
): ScopeSnapshot {
  const datasetIds = registered.source.datasetIds ?? [];
  const hasLastComplete = datasetIds.length > 0
    && datasetIds.every((datasetId) => state.lastCompleteSummary.get(datasetId)?.countersComplete === true);
  const authoritative = hasLastComplete
    && !state.pendingCohort
    && state.lastCohortStatus === 'complete'
    && !state.summaryRoundIncomplete
    && !summaryError;
  const overallSummaries = hasLastComplete ? state.lastCompleteSummary : null;
  const views: DatasetView[] = datasetIds.map((datasetId) => {
    const value = state.datasets.get(datasetId) ?? createDatasetState(datasetId);
    const pendingSummary = state.pendingCohort?.summaries.get(datasetId)?.summary ?? null;
    const summary = pendingSummary ?? value.summary ?? state.lastCompleteSummary.get(datasetId) ?? null;
    return {
      datasetId,
      alias: datasetAlias(registered, datasetId),
      summary,
      state: value,
      summaryCurrent: pendingSummary !== null,
      authoritative: authoritative && state.lastCompleteSummary.get(datasetId) === summary,
    };
  });
  const counts = aggregateCounts(overallSummaries, datasetIds);
  const reportedDocuments = overallSummaries
    ? [...overallSummaries.values()].reduce((sum, value) => Math.min(Number.MAX_SAFE_INTEGER, sum + value.total), 0)
    : null;
  const unknownCount = counts.conflict ? null : counts.unknown;
  const processingPercent = reportedDocuments === null || reportedDocuments === 0
    ? reportedDocuments === 0 ? 100 : null
    : !counts.conflict && counts.completed !== null
      ? roundPercent((counts.completed / reportedDocuments) * 100)
      : null;
  const hasSummary = views.some((view) => view.summary !== null);
  const countConflict = views.some((view) => view.summary?.countConflict === true);
  const summaryWindowIncomplete = Boolean(state.pendingCohort) || state.lastCohortStatus === 'expired' || state.summaryRoundIncomplete || Boolean(summaryError && !state.currentSummarySuccess);
  const cohortExpired = state.lastExpiredAtMs !== null;
  const consistency: ScopeConsistency = state.pendingCohort && hasLastComplete
    ? 'stale'
    : cohortExpired && !hasLastComplete
        ? 'cohort_expired'
      : state.pendingCohort
        ? 'cohort_pending'
      : state.lastCohortStatus === 'expired'
          ? hasLastComplete ? 'stale' : 'cohort_expired'
        : summaryError && !hasSummary
          ? 'source_error'
          : hasLastComplete && !authoritative
            ? 'stale'
            : authoritative && !summaryWindowIncomplete
              ? 'reconciled_non_atomic'
              : hasSummary
                ? 'bounded_partial'
                : 'scanning';
  const failureCounts = EMPTY_FAILURE_COUNTS();
  for (const view of views) for (const log of view.state.logs) if (log.run === 'FAILED' && log.failureCode) failureCounts[log.failureCode] += 1;
  const visibleFailedCount = counts.failed ?? (views.some((view) => (view.summary?.failedCount ?? 0) > 0) ? 1 : 0);
  const failureDetailCoverageGap = visibleFailedCount > 0;
  const detailsComplete = reportedDocuments === 0 && authoritative;
  const derivedDetailError = detailError ?? (authoritative && (state.phase !== 'summary' || !detailsComplete || failureDetailCoverageGap) ? 'status_incomplete' : null);
  const activeCount = (counts.pending ?? 0) + (counts.processing ?? 0);
  const activityState: StatusActivity = !authoritative || counts.conflict || counts.unknown === null
    ? 'unknown'
    : activeCount > 0
      ? 'active'
      : counts.unknown > 0
        ? 'unknown'
        : 'idle';
  return {
    views,
    reportedDocuments,
    coveredDocuments: 0,
    coverageMissing: reportedDocuments === null ? null : reportedDocuments,
    coveragePercent: reportedDocuments === null ? null : reportedDocuments === 0 ? 100 : 0,
    processingPercent,
    pendingCount: counts.pending,
    processingCount: counts.processing,
    completedCount: counts.completed,
    failedCount: counts.failed,
    cancelledCount: counts.cancelled,
    unknownCount,
    countConflict,
    consistency,
    failureCounts,
    aggregateAuthoritative: authoritative,
    aggregateReadStartedAt: hasLastComplete ? state.lastCompleteStartedAt : state.pendingCohort?.firstRequestStartedAt ?? null,
    aggregateReadCompletedAt: hasLastComplete ? state.lastCompleteCompletedAt : state.pendingCohort?.lastRequestCompletedAt ?? null,
    aggregateObservedAt: hasLastComplete ? state.lastCompleteObservedAt : null,
    aggregateError: summaryError ?? derivedDetailError ?? state.lastError,
    summaryError,
    detailError: derivedDetailError,
    detailsComplete,
    failureDetailCoverageGap,
    activityState,
  };
}

function aggregateCounts(summaries: Map<string, RagflowAggregateDataset> | null, datasetIds: readonly string[]): { pending: number | null; processing: number | null; completed: number | null; failed: number | null; cancelled: number | null; unknown: number | null; conflict: boolean } {
  if (!summaries || datasetIds.some((datasetId) => !summaries.has(datasetId))) {
    return { pending: null, processing: null, completed: null, failed: null, cancelled: null, unknown: null, conflict: false };
  }
  const result = { pending: 0, processing: 0, completed: 0, failed: 0, cancelled: 0, unknown: 0, conflict: false };
  for (const datasetId of datasetIds) {
    const summary = summaries.get(datasetId)!;
    result.pending += summary.pendingCount;
    result.processing += summary.processingCount;
    result.completed += summary.completedCount;
    result.failed += summary.failedCount;
    result.cancelled += summary.cancelledCount;
    if (summary.unknownCount === null) result.conflict = true;
    else result.unknown += summary.unknownCount;
  }
  return result;
}

function mapScopeSnapshot(scope: ScopeSnapshot, registered: RegisteredRagflowDocumentsSource, sourceRef: string, observedAt: string, revision: number): RagflowRecord {
  const problemCount = (scope.failedCount ?? 0) + (scope.cancelledCount ?? 0) + (scope.unknownCount ?? 0);
  const activeCount = (scope.pendingCount ?? 0) + (scope.processingCount ?? 0);
  const hasCounts = scope.completedCount !== null && scope.failedCount !== null && scope.pendingCount !== null && scope.processingCount !== null && scope.cancelledCount !== null;
  const outcome: StatusOutcome = scope.consistency === 'source_error'
    ? 'unknown'
    : scope.consistency === 'stale' || scope.consistency === 'cohort_expired'
      ? 'partial'
      : !hasCounts || scope.consistency === 'cohort_pending'
        ? 'partial'
      : problemCount > 0 && scope.completedCount === 0
        ? 'failed'
        : activeCount > 0 || problemCount > 0 || !scope.aggregateAuthoritative
          ? 'partial'
          : 'succeeded';
  const rangeText = scope.reportedDocuments === null ? '总量待确认' : `总量${scope.reportedDocuments}`;
  const coverageText = scope.coverageMissing === null ? '详情覆盖待确认' : `详情覆盖${scope.coveredDocuments}/${scope.reportedDocuments}`;
  const unknownText = scope.countConflict ? '计数冲突' : scope.unknownCount === null ? '未归类待确认' : `未归类${scope.unknownCount}`;
  const failureGapText = scope.failureDetailCoverageGap ? '；失败详情覆盖有缺口' : '';
  const summary = `${rangeText}；${coverageText}；完成${countText(scope.completedCount)}，失败${countText(scope.failedCount)}，待处理${countText(scope.pendingCount)}，处理中${countText(scope.processingCount)}，取消${countText(scope.cancelledCount)}，${unknownText}；${consistencyText(scope.consistency)}；${activityText(scope.activityState)}${failureGapText}`;
  const facts: Record<string, FactValue> = {
    reportedDocuments: scope.reportedDocuments,
    coveredDocuments: scope.coveredDocuments,
    coverageMissing: scope.coverageMissing,
    coveragePercent: scope.coveragePercent,
    processingPercent: scope.processingPercent,
    pendingCount: scope.pendingCount,
    processingCount: scope.processingCount,
    completedCount: scope.completedCount,
    failedCount: scope.failedCount,
    cancelledCount: scope.cancelledCount,
    unknownCount: scope.unknownCount,
    countConflict: scope.countConflict,
    consistency: consistencyText(scope.consistency),
    aggregateAuthoritative: scope.aggregateAuthoritative,
    aggregateReadStartedAt: scope.aggregateReadStartedAt,
    aggregateReadCompletedAt: scope.aggregateReadCompletedAt,
    scanStartedAt: scope.aggregateReadStartedAt,
    scanEndedAt: scope.aggregateReadCompletedAt,
    aggregateObservedAt: scope.aggregateObservedAt,
    aggregateError: scope.aggregateError,
    summaryError: scope.summaryError,
    detailError: scope.detailError,
    failureCounts: formatFailureCounts(scope.failureCounts),
    failureDetailCoverageGap: scope.failureDetailCoverageGap,
    detailsComplete: scope.detailsComplete,
    activityState: scope.activityState,
    registeredDatasets: scope.views.length,
    refreshRevision: revision,
  };
  const identity = hashIdentity(sourceRef, 'scope', observedAt, revision, scope.reportedDocuments, scope.completedCount, scope.failedCount, scope.unknownCount, scope.consistency);
  return {
    id: sanitizeId(`ragflow-scope-${identity}`, 'ragflow-scope'),
    sourceRef,
    taskKey: 'scope-' + hashIdentity(sourceRef),
    stage: '源范围快照',
    outcome,
    summary,
    occurredAt: null,
    sourceAt: null,
    observedAt: validObservedAt(observedAt, new Date().toISOString()),
    evidenceKind: 'snapshot_diff',
    facts,
    evidenceRef: 'scope-' + hashIdentity(registered.source.sourceRef),
  };
}

function mapDatasetSnapshot(view: DatasetView, sourceRef: string, observedAt: string, revision: number): RagflowRecord {
  const summary = view.summary;
  const counts = summary
    ? { completed: summary.completedCount, failed: summary.failedCount, pending: summary.pendingCount, processing: summary.processingCount, cancelled: summary.cancelledCount, unknown: summary.unknownCount }
    : { completed: 0, failed: 0, pending: 0, processing: 0, cancelled: 0, unknown: null };
  const problemCount = counts.failed + counts.cancelled + (counts.unknown ?? 0);
  const consistency: ScopeConsistency = view.authoritative
    ? 'reconciled_non_atomic'
    : summary
      ? view.summaryCurrent ? 'bounded_partial' : 'stale'
      : 'scanning';
  const outcome: StatusOutcome = consistency === 'reconciled_non_atomic' && problemCount === 0 && counts.pending + counts.processing === 0
    ? 'succeeded'
    : problemCount > 0 && counts.completed === 0
      ? 'failed'
      : counts.pending + counts.processing > 0 || problemCount > 0
        ? 'partial'
        : 'unknown';
  const totalText = summary ? `总量${summary.total}` : '总量待确认';
  const unknownText = counts.unknown === null ? '计数冲突' : `未归类${counts.unknown}`;
  const logFilterText = view.state.logFilter === 'failed_operations' ? '失败操作日志' : view.state.logFilter === 'all_file_logs' ? '文件操作日志' : '日志待读取';
  const logTotalText = view.state.logTotal === null ? '待确认' : String(view.state.logTotal);
  const failureGapText = counts.failed > 0 ? '；失败详情覆盖有缺口' : '';
  const activityState: StatusActivity = !view.authoritative || counts.unknown === null
    ? 'unknown'
    : counts.pending + counts.processing > 0
      ? 'active'
      : counts.unknown > 0
        ? 'unknown'
        : 'idle';
  const summaryText = `${view.alias}：${totalText}；详情覆盖0/${summary?.total ?? '?'}；完成${counts.completed}，失败${counts.failed}，待处理${counts.pending}，处理中${counts.processing}，取消${counts.cancelled}，${unknownText}；${consistencyText(consistency)}；${activityText(activityState)}；${logFilterText}${logTotalText}${failureGapText}`;
  const facts: Record<string, FactValue> = {
    datasetAlias: view.alias,
    reportedDocuments: summary?.total ?? null,
    coveredDocuments: 0,
    coveragePercent: summary ? summary.total === 0 ? 100 : 0 : null,
    pendingCount: counts.pending,
    processingCount: counts.processing,
    completedCount: counts.completed,
    failedCount: counts.failed,
    cancelledCount: counts.cancelled,
    unknownCount: counts.unknown,
    consistency: consistencyText(consistency),
    aggregateObservedAt: view.state.summaryObservedAt,
    failureCounts: formatFailureCounts(failureCountsForLogs(view.state.logs)),
    fileLogFilter: logFilterText,
    fileLogTotal: view.state.logTotal,
    fileLogHasMore: view.state.logHasMore,
    failureDetailCoverageGap: counts.failed > 0,
    detailsComplete: summary?.total === 0,
    activityState,
    refreshRevision: revision,
  };
  const identity = hashIdentity(sourceRef, view.datasetId, observedAt, revision, summary?.total, counts.completed, counts.failed, counts.unknown);
  return {
    id: sanitizeId(`ragflow-dataset-${identity}`, 'ragflow-dataset'),
    sourceRef,
    taskKey: 'dataset-' + hashIdentity(sourceRef, view.datasetId),
    stage: '数据集范围',
    outcome,
    summary: summaryText,
    occurredAt: null,
    sourceAt: null,
    observedAt: validObservedAt(observedAt, new Date().toISOString()),
    evidenceKind: 'snapshot_diff',
    facts,
    evidenceRef: 'dataset-scope-' + hashIdentity(view.datasetId),
  };
}

function mapReadDiagnostic(
  events: readonly RagflowDiagnosticEvent[],
  operation: 'summary' | 'file_logs' | null,
  scopeIndex: number | null,
  page: number | null,
  filter: 'all_file_logs' | 'failed_operations' | null,
  errorCode: RagflowDocumentsReadResult['errorCode'],
  sequence: number,
  sourceRef: string,
  observedAt: string,
): RagflowRecord | null {
  if (!operation && events.length === 0 && !errorCode) return null;
  const first = events[0] ?? null;
  const last = events.at(-1) ?? null;
  const httpSent = events.some((event) => event.phase === 'http_sent');
  const httpCompleted = events.some((event) => event.phase === 'http_complete' || event.phase === 'schema_complete');
  const bytes = events.reduce((max, event) => Math.max(max, event.bytes), 0);
  const phase = last?.phase ?? (errorCode ? 'source_error' : 'not_observed');
  const phaseCompleted = last !== null && last.phase !== 'channel_wait';
  const nextPhase = last ? nextDiagnosticPhase(last.phase) : null;
  const safeError = errorCode;
  const facts: Record<string, FactValue> = {
    readSequence: sequence,
    operation,
    scopeIndex,
    page,
    filter,
    httpSent,
    httpCompleted,
    phase,
    phaseCompleted,
    nextPhase,
    bytes: Math.min(512 * 1024, bytes),
    safeError,
    startedAt: first?.observedAt ?? null,
    endedAt: last?.observedAt ?? null,
  };
  const outcome: StatusOutcome = errorCode ? 'partial' : httpCompleted ? 'succeeded' : 'unknown';
  const description = operation === 'summary' ? '统计读取' : operation === 'file_logs' ? '文件日志读取' : '读取';
  return {
    id: sanitizeId(`ragflow-read-diagnostic-${hashIdentity(sourceRef, sequence, operation, scopeIndex, page, filter)}`, 'ragflow-read-diagnostic'),
    sourceRef,
    taskKey: 'ragflow-read-diagnostic-' + hashIdentity(sourceRef, operation ?? 'none'),
    stage: '读取诊断',
    outcome,
    summary: `${description}诊断；范围序号${scopeIndex ?? '待确认'}；阶段${diagnosticPhaseText(phase)}${phase === 'channel_wait' ? '' : phaseCompleted && nextPhase ? `已完成，下一阶段${diagnosticPhaseText(nextPhase)}` : ''}`,
    occurredAt: null,
    sourceAt: null,
    observedAt: validObservedAt(observedAt, new Date().toISOString()),
    evidenceKind: 'snapshot_diff',
    facts,
    evidenceRef: 'ragflow-read-' + hashIdentity(sourceRef),
  };
}

function nextDiagnosticPhase(phase: RagflowDiagnosticEvent['phase']): RagflowDiagnosticEvent['phase'] | null {
  const next: Partial<Record<RagflowDiagnosticEvent['phase'], RagflowDiagnosticEvent['phase'] | null>> = {
    connection: 'deadline',
    deadline: 'target',
    target: 'channel_wait',
    channel_wait: 'channel',
    channel: 'http_sent',
    http_sent: 'http_complete',
    http_complete: 'schema_complete',
    schema_complete: null,
  };
  return next[phase] ?? null;
}

function diagnosticPhaseText(phase: string): string {
  const labels: Record<string, string> = {
    connection: '连接',
    deadline: '期限确认',
    target: '目标验证',
    channel_wait: '等待通道',
    channel: '通道',
    http_sent: '请求发送',
    http_complete: '响应完成',
    schema_complete: '结构校验',
    source_error: '来源错误',
    not_observed: '未观测',
  };
  return labels[phase] ?? phase;
}

function mapIngestionLog(log: RagflowIngestionLog, view: DatasetView, registered: RegisteredRagflowDocumentsSource, sourceRef: string, observedAt: string, revision: number, index: number): RagflowRecord {
  const stage = log.failureStage ?? 'unknown';
  const code = log.failureCode ?? 'unclassified';
  const evidence = log.failureEvidenceLevel ?? 'source_no_detail';
  const evidenceText = evidence === 'message_classified'
    ? `来源文本分类：${FAILURE_LABELS[code]}`
    : code !== 'unclassified'
      ? FAILURE_LABELS[code]
    : evidence === 'stage_only'
      ? '仅确认阶段'
      : evidence === 'unclassified_description'
        ? '已有来源描述，尚未归类/原因未能安全识别'
        : '来源未返回可确认失败细节';
  const taskKey = 'log-' + hashIdentity(sourceRef, view.datasetId, log.logIdHash ?? log.documentHash ?? index);
  const facts: Record<string, FactValue> = {
    datasetAlias: view.alias,
    errorStage: STAGE_LABELS[stage],
    errorReason: evidence === 'source_no_detail'
      ? '来源未返回可确认失败细节'
      : evidence === 'message_classified'
        ? `来源文本分类：${failureReason(code, stage)}`
        : failureReason(code, stage),
    errorEvidenceLevel: evidence,
    errorCode: code,
    documentHash: log.documentHash,
    run: log.run,
    progress: log.progress,
    failureCharLength: log.failureShape?.charLength ?? null,
    failureByteLength: log.failureShape?.byteLength ?? null,
    failureHasLF: log.failureShape?.hasLF ?? null,
    failureHasCR: log.failureShape?.hasCR ?? null,
    failureOldParserWouldDrop: log.failureShape?.oldParserWouldDrop ?? null,
  };
  return {
    id: sanitizeId(`ragflow-log-${hashIdentity(taskKey, observedAt, revision)}`, 'ragflow-log'),
    sourceRef,
    taskKey,
    stage: '失败',
    outcome: 'failed',
    summary: `${view.alias}：${STAGE_LABELS[stage]}失败；${evidenceText}`,
    occurredAt: null,
    sourceAt: log.sourceAt,
    observedAt: validObservedAt(observedAt, new Date().toISOString()),
    evidenceKind: 'stage_receipt',
    facts,
    evidenceRef: 'dataset-' + hashIdentity(registered.source.sourceRef, view.datasetId),
  };
}

function failureCountsForLogs(logs: readonly RagflowIngestionLog[]): FailureCounts {
  const counts = EMPTY_FAILURE_COUNTS();
  for (const log of logs) if (log.run === 'FAILED' && log.failureCode) counts[log.failureCode] += 1;
  return counts;
}

function consistencyText(value: ScopeConsistency): string {
  if (value === 'reconciled_non_atomic') return '源报告已取得，统计窗口非原子';
  if (value === 'bounded_partial') return '有界部分读取';
  if (value === 'source_error') return '来源读取失败';
  if (value === 'stale') return '保留上次成功统计，当前来源未齐';
  if (value === 'cohort_pending') return '尚未收齐同窗统计';
  if (value === 'cohort_expired') return '同窗统计已过期，当前未收齐';
  return '读取中';
}

function activityText(value: StatusActivity): string {
  if (value === 'idle') return '当前空闲';
  if (value === 'active') return '当前处理中';
  if (value === 'historical') return '历史记录';
  if (value === 'unsupported') return '业务状态源未接入';
  return '当前活动状态未确认';
}

function formatFailureCounts(counts: FailureCounts): string {
  const result: string[] = [];
  for (const key of Object.keys(counts) as RagflowFailureCode[]) if (counts[key] > 0) result.push(FAILURE_LABELS[key] + counts[key]);
  return result.length > 0 ? result.join('，').slice(0, 220) : '暂无已核实失败详情';
}

function failureReason(code: RagflowFailureCode, stage: RagflowFailureStage): string {
  return `${STAGE_LABELS[stage]}：${FAILURE_LABELS[code]}`;
}

function mapTransportError(cause: unknown, signal?: AbortSignal): RagflowDocumentsReadResult['errorCode'] {
  if (signal?.aborted) return 'status_timeout';
  if (cause instanceof TransportError) {
    if (cause.code === 'timeout' || cause.code === 'cancelled') return 'status_timeout';
    if (cause.code === 'redirect') return 'status_redirect';
    if (cause.code === 'http_error') return 'status_http';
    if (cause.code === 'invalid_response') return 'status_invalid';
    if (cause.code === 'incomplete') return 'status_incomplete';
  }
  return 'status_source';
}

function validObservedAt(value: string, fallback: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(fallback).toISOString();
}

async function awaitRagflowBudget<T>(operation: Promise<T>, budget: RagflowReadBudget, message: string): Promise<T> {
  const remaining = remainingRagflowReadMs(budget);
  if (remaining <= 0) throw new TransportError('timeout', message);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TransportError('timeout', message)), Math.max(1, remaining));
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function roundPercent(value: number): number {
  return Math.round(value * 10) / 10;
}

function countText(value: number | null): string {
  return value === null ? '待确认' : String(value);
}

function datasetAlias(registered: RegisteredRagflowDocumentsSource, datasetId: string): string {
  const alias = registered.datasetAliases.get(datasetId)?.trim();
  if (alias && alias.length <= 64 && /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,63}$/u.test(alias)) return alias;
  return '数据集-' + hashIdentity(datasetId).slice(0, 8);
}

function hashIdentity(...values: unknown[]): string {
  return createHash('sha256').update(values.map((value) => String(value ?? '')).join('\u001f')).digest('hex').slice(0, 24);
}
