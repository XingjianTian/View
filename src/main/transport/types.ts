import type { InfrastructureRead, RegisteredInfrastructureSource } from './infrastructure.js';
import type { ReadonlyOperation } from './readonly-commands.js';
import type { RemoteArticleReceiptRead } from './article-receipts.js';
import type { RagflowAggregateRead, RagflowDocumentsSource, RagflowIngestionLogsRead, RagflowReadBudget, RagflowTargetMetadata } from './ragflow-documents.js';
import type { QuantPostgresChannelLease, QuantPostgresTarget, QuantPostgresTargetMetadata } from './quant-postgres.js';

export type TransportErrorCode =
  | 'profile_missing'
  | 'profile_invalid'
  | 'cli_missing'
  | 'engine_unavailable'
  | 'host_key_untrusted'
  | 'auth_failed'
  | 'sudo_denied'
  | 'timeout'
  | 'deadline_unavailable'
  | 'incomplete'
  | 'cancelled'
  | 'http_error'
  | 'redirect'
  | 'invalid_response'
  | 'internal';

export class TransportError extends Error {
  constructor(readonly code: TransportErrorCode, message: string) {
    super(message);
    this.name = 'TransportError';
  }
}

export type CommandResult = {
  operation: ReadonlyOperation;
  stdout: string;
  stderr: string;
  code: number | null;
  truncated: boolean;
  observedAt: string;
};

/** Optional correlation carried only by the bounded container-log read path. */
export type LogReadContext = {
  readAttemptId: number;
};

export type DockerTransport = {
  readonly kind: 'local' | 'ssh';
  version(signal?: AbortSignal): Promise<CommandResult>;
  list(signal?: AbortSignal): Promise<CommandResult>;
  inspect(ids: readonly string[], signal?: AbortSignal): Promise<CommandResult>;
  stats(ids: readonly string[], signal?: AbortSignal): Promise<CommandResult>;
  logs(id: string, since?: string, signal?: AbortSignal, context?: LogReadContext): Promise<CommandResult>;
  readArticleReceipts?(rootPath: string, signal?: AbortSignal): Promise<RemoteArticleReceiptRead>;
  /** Main-process-only fixed server-side aggregate reader. */
  readRagflowAggregates?(source: RagflowDocumentsSource, signal?: AbortSignal, budget?: RagflowReadBudget): Promise<RagflowAggregateRead>;
  /** Main-process-only fixed historical file-log reader. */
  readRagflowIngestionLogs?(source: RagflowDocumentsSource, signal?: AbortSignal, budget?: RagflowReadBudget): Promise<RagflowIngestionLogsRead>;
  /** Main-process-only identity projection used to fail closed before forwarding. */
  verifyRagflowTarget?(target: RagflowDocumentsSource['target'], signal?: AbortSignal): Promise<RagflowTargetMetadata>;
  /** Main-process-only Quant PostgreSQL target identity projection. */
  verifyQuantPostgresTarget?(target: QuantPostgresTarget, signal?: AbortSignal): Promise<QuantPostgresTargetMetadata>;
  /** Opens one reader-owned direct-tcpip channel; the SSH client remains pooled. */
  openQuantPostgresChannel?(target: QuantPostgresTarget, signal?: AbortSignal): Promise<QuantPostgresChannelLease>;
  /** Main-process-only fixed reader for a registered infrastructure scope. */
  readInfrastructure?(source: RegisteredInfrastructureSource, signal?: AbortSignal): Promise<InfrastructureRead>;
  close(): Promise<void>;
  diagnostics?: () => { connections: number; channels: number };
};
