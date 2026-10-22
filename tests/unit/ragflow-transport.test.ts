import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRagflowReadBudget,
  emitRagflowDiagnostic,
  readRagflowAggregates,
  readRagflowIngestionLogs,
  type RagflowDiagnosticEvent,
  type RagflowDocumentsSource,
  type RagflowHttpResponse,
} from '../../src/main/transport/ragflow-documents.js';

const json = (data: unknown, code = 0): RagflowHttpResponse => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code, data }),
});

function source(datasetIds: readonly string[] = ['dataset-a']): RagflowDocumentsSource {
  return {
    sourceRef: 'ragflow-main',
    target: { containerId: 'a'.repeat(64), ip: '10.0.0.24', port: 9380 },
    bearerToken: 'private-bearer',
    datasetIds,
  };
}

afterEach(() => vi.useRealTimers());

describe('RAGFlow fixed summary and file-log readers', () => {
  it('keeps channel wait distinct from an opened channel in diagnostic order', () => {
    const phases: string[] = [];
    const budget = createRagflowReadBudget(undefined, (event) => phases.push(event.phase));
    emitRagflowDiagnostic(budget, 'target');
    emitRagflowDiagnostic(budget, 'channel_wait');
    emitRagflowDiagnostic(budget, 'channel');
    emitRagflowDiagnostic(budget, 'http_sent');
    emitRagflowDiagnostic(budget, 'http_complete');
    emitRagflowDiagnostic(budget, 'schema_complete');
    expect(phases).toEqual(['target', 'channel_wait', 'channel', 'http_sent', 'http_complete', 'schema_complete']);
  });

  it('emits bounded schema diagnostics and ignores a throwing diagnostic sink', async () => {
    const events: RagflowDiagnosticEvent[] = [];
    const response = json({
      doc_num: 1,
      status: { unstart_count: 0, running_count: 0, cancel_count: 0, done_count: 1, fail_count: 0 },
    });
    const budget = createRagflowReadBudget(undefined, (event) => {
      events.push(event);
      throw new Error('diagnostic sink failure');
    });
    await expect(readRagflowAggregates(source(), async () => response, undefined, undefined, budget)).resolves.toMatchObject({ complete: true });
    expect(events).toEqual([{
      phase: 'schema_complete',
      httpStatus: 200,
      bytes: Buffer.byteLength(response.body, 'utf8'),
      observedAt: expect.any(String),
    }]);
    expect(JSON.stringify(events)).not.toContain('private-bearer');
  });

  it('uses one audited summary route per registered dataset and maps all verified buckets', async () => {
    const paths: string[] = [];
    const result = await readRagflowAggregates(source(['dataset-a', 'dataset-b']), async (path) => {
      paths.push(path);
      return json({
        doc_num: 6,
        chunk_num: 20,
        token_num: 40,
        status: { unstart_count: 1, running_count: 1, cancel_count: 0, done_count: 3, fail_count: 1 },
      });
    });
    expect(paths).toEqual([
      '/api/v1/datasets/dataset-a/ingestions/summary',
      '/api/v1/datasets/dataset-b/ingestions/summary',
    ]);
    expect(result).toMatchObject({ complete: true, failedDatasetIds: [] });
    expect(result.datasets).toEqual([
      expect.objectContaining({ datasetId: 'dataset-a', total: 6, pendingCount: 1, processingCount: 1, completedCount: 3, failedCount: 1, unknownCount: 0, countConflict: false, countersComplete: true }),
      expect.objectContaining({ datasetId: 'dataset-b', total: 6 }),
    ]);
  });

  it('keeps an unaccounted difference as unknown and never converts a count conflict to zero', async () => {
    const difference = await readRagflowAggregates(source(), async () => json({
      doc_num: 7,
      status: { unstart_count: 1, running_count: 1, cancel_count: 0, done_count: 3, fail_count: 1 },
    }));
    expect(difference.datasets[0]).toMatchObject({ unknownCount: 1, countConflict: false, countersComplete: true });

    const conflict = await readRagflowAggregates(source(), async () => json({
      doc_num: 3,
      status: { unstart_count: 1, running_count: 1, cancel_count: 0, done_count: 3, fail_count: 1 },
    }));
    expect(conflict).toMatchObject({ complete: false, failedDatasetIds: [] });
    expect(conflict.datasets[0]).toMatchObject({ unknownCount: null, countConflict: true, countersComplete: false, completedCount: 3, failedCount: 1 });
  });

  it('rejects an empty registered range and malformed summary without guessing missing counters', async () => {
    await expect(readRagflowAggregates({ ...source(), datasetIds: [] }, async () => json({}))).rejects.toMatchObject({ code: 'profile_invalid' });
    await expect(readRagflowAggregates(source(), async () => json({ doc_num: 2, status: { done_count: 2 } }))).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(readRagflowAggregates(source(), async () => ({ status: 302, headers: { location: 'https://elsewhere.invalid' }, body: '' }))).rejects.toMatchObject({ code: 'redirect' });
    await expect(readRagflowAggregates(source(), async () => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: '{}' }))).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(readRagflowAggregates(source(), async () => json({}, 401))).rejects.toMatchObject({ code: 'http_error' });
  });

  it('reads only fixed file-log fields, hashes identities, and preserves bounded failure shape', async () => {
    const message = 'embedding stage: ' + 'x'.repeat(666) + '\r\n';
    expect(Buffer.byteLength(message, 'utf8')).toBe(685);
    const paths: string[] = [];
    const result = await readRagflowIngestionLogs({ ...source(), ingestionLogPages: { 'dataset-a': 2 } }, async (path) => {
      paths.push(path);
      return json({
        total: 3,
        logs: [{
          id: 'log-secret-id',
          document_id: 'document-secret-id',
          operation_status: 4,
          progress: 0.25,
          progress_msg: message,
          update_time: '2026-10-21T10:00:00Z',
          document_name: '/private/path/secret.pdf',
          dsl: { secret: 'do not persist' },
          tenant_id: 'tenant-secret',
          unknown_extension: 'discard',
        }],
      });
    });
    expect(paths).toEqual(['/api/v1/datasets/dataset-a/ingestions?page=2&page_size=1&orderby=create_time&desc=true&log_type=file']);
    const log = result.datasets[0]?.logs[0];
    expect(result).toMatchObject({ complete: true, hasMore: true, gap: true });
    expect(log).toMatchObject({ run: 'FAILED', progress: 0.25, failureCode: 'unclassified', messageClassified: null, failureStage: 'embedding', failureEvidenceLevel: 'unclassified_description', sourceAt: '2026-10-21T10:00:00.000Z' });
    expect(log?.logIdHash).toMatch(/^[a-f0-9]{24}$/);
    expect(log?.documentHash).toMatch(/^[a-f0-9]{24}$/);
    expect(log?.failureShape).toMatchObject({ hasLF: true, hasCR: true, oldParserWouldDrop: true, byteLength: Buffer.byteLength(message, 'utf8') });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.datasets[0]?.filter).toBe('all_file_logs');
  });

  it('uses only the fixed failed-operation filter when explicitly selected', async () => {
    const paths: string[] = [];
    const result = await readRagflowIngestionLogs({ ...source(), ingestionFailureOnly: true }, async (path) => {
      paths.push(path);
      return json({ total: 1, logs: [{ operation_status: 4, progress: 1 }] });
    });
    expect(paths).toEqual(['/api/v1/datasets/dataset-a/ingestions?page=1&page_size=1&orderby=create_time&desc=true&log_type=file&operation_status=4']);
    expect(result.datasets[0]).toMatchObject({ filter: 'failed_operations', total: 1 });
  });

  it('rejects a non-constant failure filter flag', async () => {
    await expect(readRagflowIngestionLogs({ ...source(), ingestionFailureOnly: false as never }, async () => json({ total: 0, logs: [] }))).rejects.toMatchObject({ code: 'profile_invalid' });
  });

  it('marks nonempty unknown descriptions separately from missing failure detail', async () => {
    const result = await readRagflowIngestionLogs(source(), async () => json({ total: 2, logs: [{ operation_status: 'FAIL', progress_msg: 'upstream returned an opaque failure' }] }));
    expect(result.datasets[0]?.logs[0]).toMatchObject({ failureCode: 'unclassified', messageClassified: null, failureStage: 'unknown', failureEvidenceLevel: 'unclassified_description' });

    const noDetail = await readRagflowIngestionLogs(source(), async () => json({ total: 2, logs: [{ operation_status: 'FAIL' }] }));
    expect(noDetail.datasets[0]?.logs[0]).toMatchObject({ failureCode: 'unclassified', messageClassified: null, failureStage: 'unknown', failureEvidenceLevel: 'source_no_detail', failureShape: null });
  });

  it('requires explicit HTTP status context before using an HTTP fallback category', async () => {
    const bareNumber = await readRagflowIngestionLogs(source(), async () => json({ total: 1, logs: [{ operation_status: 'FAIL', progress_msg: 'failed after 400 tokens' }] }));
    expect(bareNumber.datasets[0]?.logs[0]).toMatchObject({ failureCode: 'unclassified' });

    const httpStatus = await readRagflowIngestionLogs(source(), async () => json({ total: 1, logs: [{ operation_status: 'FAIL', progress_msg: 'HTTP 400 from upstream' }] }));
    expect(httpStatus.datasets[0]?.logs[0]).toMatchObject({ failureCode: 'http_4xx', messageClassified: 'http_4xx', failureEvidenceLevel: 'message_classified' });

    const statusCode = await readRagflowIngestionLogs(source(), async () => json({ total: 1, logs: [{ operation_status: 'FAIL', progress_msg: 'status_code:500 from upstream' }] }));
    expect(statusCode.datasets[0]?.logs[0]).toMatchObject({ failureCode: 'http_5xx', messageClassified: 'http_5xx', failureEvidenceLevel: 'message_classified' });

    const errorCode = await readRagflowIngestionLogs(source(), async () => json({ total: 1, logs: [{ operation_status: 'FAIL', progress_msg: 'Error code: 418 from upstream' }] }));
    expect(errorCode.datasets[0]?.logs[0]).toMatchObject({ failureCode: 'http_4xx', messageClassified: 'http_4xx', failureEvidenceLevel: 'message_classified' });
  });

  it('retains completed datasets and reports every remaining dataset on a bounded byte stop', async () => {
    let calls = 0;
    const result = await readRagflowAggregates(source(['dataset-a', 'dataset-b', 'dataset-c']), async () => {
      calls += 1;
      return json({ doc_num: 1, status: { unstart_count: 0, running_count: 0, cancel_count: 0, done_count: 1, fail_count: 0 }, padding: 'x'.repeat(190 * 1024) });
    });
    expect(calls).toBe(3);
    expect(result.datasets).toHaveLength(2);
    expect(result.failedDatasetIds).toEqual(['dataset-c']);
    expect(result.complete).toBe(false);
  });

  it('shares one absolute byte budget across summary and log reader calls', async () => {
    const budget = createRagflowReadBudget();
    await readRagflowAggregates(source(), async () => json({ doc_num: 0, status: { unstart_count: 0, running_count: 0, cancel_count: 0, done_count: 0, fail_count: 0 } }), undefined, undefined, budget);
    expect(budget.remainingBytes).toBeLessThan(512 * 1024);
    await expect(readRagflowIngestionLogs(source(), async () => json({ total: 0, logs: [] }), undefined, undefined, budget)).resolves.toMatchObject({ complete: true });
  });
});
