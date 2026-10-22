import { TextDecoder } from 'node:util';
import type { LogEntry } from './types.js';

const MAX_ENTRY_BYTES = 16 * 1024;
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))(?:\s+|$)(.*)$/s;
const ANSI = /[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:;\d{0,4})*)?[0-9A-ORZcf-nqry=><]))/g;

export type ParsedLogLine = Omit<LogEntry, 'id' | 'sourceKey' | 'deviceId' | 'containerId' | 'observedAt'>;

export class LogChunkParser {
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });
  private carry = '';
  private gap = 0;
  private readonly secrets: string[];

  constructor(secrets: readonly string[] = []) {
    this.secrets = [...new Set(secrets.filter((secret) => secret.length > 0 && secret.length <= 4096))].sort((a, b) => b.length - a.length);
  }

  push(chunk: Uint8Array | string, flush = false): ParsedLogLine[] {
    const decoded = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: !flush });
    this.carry += decoded;
    const lines = this.carry.split(/\r?\n/);
    this.carry = flush ? '' : (lines.pop() ?? '');
    if (flush && this.carry) lines.push(this.carry);
    return lines.flatMap((line) => this.parseLine(line));
  }

  finish(): ParsedLogLine[] {
    const remainder = this.decoder.decode();
    if (remainder) this.carry += remainder;
    return this.push('', true);
  }

  takeGap(): number {
    const value = this.gap;
    this.gap = 0;
    return value;
  }

  private parseLine(line: string): ParsedLogLine[] {
    if (!line) return [];
    const cleaned = redact(stripAnsi(line), this.secrets);
    if (Buffer.byteLength(cleaned, 'utf8') > MAX_ENTRY_BYTES) {
      this.gap += 1;
      return [];
    }
    const match = cleaned.match(TIMESTAMP);
    const timestamp = match?.[1] && !Number.isNaN(Date.parse(match[1])) ? match[1] : null;
    const message = match?.[2] ?? cleaned;
    return [{ timestamp, message }];
  }
}

export function parseLogText(text: string, secrets: readonly string[] = []): { entries: ParsedLogLine[]; gap: number } {
  const parser = new LogChunkParser(secrets);
  const entries = parser.push(text, true);
  return { entries, gap: parser.takeGap() };
}

export function stripAnsi(value: string): string {
  return value.replace(ANSI, '');
}

export function redact(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets) {
    if (!secret) continue;
    result = result.split(secret).join('[已脱敏]');
  }
  return result;
}

export const logLimits = {
  maxEntryBytes: MAX_ENTRY_BYTES,
  sourceEntries: 2_000,
  sourceBytes: 2 * 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
  pollEntries: 500,
  pollBytes: 256 * 1024,
} as const;
