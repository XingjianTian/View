import type { DockerTransport } from '../transport/types.js';
import { parseLogText } from './parser.js';
import type { LogBatch, LogEntry, LogSourceKey } from './types.js';

export type LogPollerOptions = {
  sourceKey: LogSourceKey;
  deviceId: string;
  containerId: string;
  transport: DockerTransport;
  secrets?: readonly string[];
};

export class LogPoller {
  readonly sourceKey: LogSourceKey;
  readonly deviceId: string;
  readonly containerId: string;
  private readonly transport: DockerTransport;
  private readonly secrets: readonly string[];
  private cursor: string | undefined;
  private sequence = 0;
  private previousCounts = new Map<string, number>();
  private inFlight = false;

  constructor(options: LogPollerOptions) {
    this.sourceKey = options.sourceKey;
    this.deviceId = options.deviceId;
    this.containerId = options.containerId;
    this.transport = options.transport;
    this.secrets = options.secrets ?? [];
  }

  async poll(readAttemptId = 0): Promise<LogBatch> {
    if (this.inFlight) {
      return { entries: [], cursor: this.cursor ?? null, gap: 1, truncated: false, observedAt: new Date().toISOString(), bytes: 0 };
    }
    this.inFlight = true;
    try {
      const result = await this.transport.logs(this.containerId, this.cursor, undefined, { readAttemptId });
      // Docker preserves the container's stdout/stderr streams separately;
      // the CLI may therefore return valid container logs on either channel.
      const parsed = parseLogText(`${result.stdout}${result.stderr}`, this.secrets);
      const currentCounts = new Map<string, number>();
      const entries: LogEntry[] = [];
      let gap = parsed.gap;
      for (const item of parsed.entries) {
        const fingerprint = `${item.timestamp ?? ''}\u0000${item.message}`;
        const seenBefore = this.previousCounts.get(fingerprint) ?? 0;
        const seenNow = currentCounts.get(fingerprint) ?? 0;
        currentCounts.set(fingerprint, seenNow + 1);
        if (seenNow < seenBefore) continue;
        entries.push({
          id: `${this.sourceKey}:${this.sequence++}`,
          sourceKey: this.sourceKey,
          deviceId: this.deviceId,
          containerId: this.containerId,
          timestamp: item.timestamp,
          message: item.message,
          observedAt: result.observedAt,
        });
      }
      if (entries.length > 500) {
        gap += entries.length - 500;
        entries.splice(0, entries.length - 500);
      }
      const lastTimestamp = entries.map((entry) => entry.timestamp).filter((value): value is string => value !== null).at(-1);
      if (lastTimestamp) this.cursor = overlapCursor(lastTimestamp);
      this.previousCounts = currentCounts;
      return {
        entries,
        cursor: this.cursor ?? null,
        gap,
        truncated: result.truncated,
        observedAt: result.observedAt,
        bytes: Buffer.byteLength(result.stdout, 'utf8') + Buffer.byteLength(result.stderr, 'utf8'),
      };
    } finally {
      this.inFlight = false;
    }
  }

  getCursor(): string | null {
    return this.cursor ?? null;
  }
}

function overlapCursor(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? timestamp : new Date(Math.max(0, parsed - 1_000)).toISOString();
}
