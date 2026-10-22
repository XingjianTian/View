export type LogSourceKey = string;

export type LogEntry = {
  id: string;
  sourceKey: LogSourceKey;
  deviceId: string;
  containerId: string;
  timestamp: string | null;
  message: string;
  observedAt: string;
};

export type LogBatch = {
  entries: LogEntry[];
  cursor: string | null;
  gap: number;
  truncated: boolean;
  observedAt: string;
  bytes?: number;
};

export type LogDiagnosticPhase = 'connection' | 'deadline' | 'channel' | 'remote' | 'output' | 'parse' | 'read';

export type LogDiagnosticOutcome =
  | 'success_new'
  | 'success_idle'
  | 'ssh_connection_error'
  | 'deadline_error'
  | 'channel_error'
  | 'remote_timeout'
  | 'remote_error'
  | 'output_truncated'
  | 'parse_error'
  | 'cancelled'
  | 'unknown_error';

/** Fixed, renderer-safe summary of one bounded container-log read. */
export type LogReadDiagnostic = {
  readAttemptId: number;
  source: 'container_logs';
  connectionGeneration: number | null;
  phase: LogDiagnosticPhase;
  elapsedMs: number;
  budgetMs: number | null;
  channels: number | null;
  bytes: number;
  outcome: LogDiagnosticOutcome;
  observedAt: string;
};

export type LogSourceState = {
  sourceKey: LogSourceKey;
  deviceId: string;
  containerId: string;
  generation: string | null;
  cursor: string | null;
  entries: LogEntry[];
  bytes: number;
  gap: number;
  paused: boolean;
  complete: boolean;
  lastSuccessAt: string | null;
  errorCode: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  lastErrorDiagnostic: LogReadDiagnostic | null;
  diagnostic: LogReadDiagnostic | null;
};
