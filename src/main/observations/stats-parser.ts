import type { MetricSample } from '../../shared/entities.js';
import { MetricSampleSchema } from '../../shared/entities.js';
import type { CommandResult } from '../transport/types.js';

export type ParsedStats = {
  values: Map<string, MetricSample>;
  complete: boolean;
  invalidRows: number;
};

export function parseStatsOutput(result: CommandResult, requestedIds: readonly string[], maxRows = 128): ParsedStats {
  const allowed = new Set(requestedIds);
  const values = new Map<string, MetricSample>();
  let invalidRows = 0;
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      invalidRows += 1;
      continue;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      invalidRows += 1;
      continue;
    }
    const record = raw as Record<string, unknown>;
    const id = stringField(record.Container) ?? stringField(record.ID);
    const canonicalId = id ? [...allowed].find((candidate) => candidate === id || candidate.startsWith(id) || id.startsWith(candidate)) : undefined;
    if (!canonicalId || values.size >= maxRows) {
      invalidRows += 1;
      continue;
    }
    try {
      values.set(canonicalId, MetricSampleSchema.parse({
        cpuPercent: parsePercent(record.CPUPerc),
        memoryBytes: parseMemoryUsage(record.MemUsage)?.used ?? null,
        memoryLimitBytes: parseMemoryUsage(record.MemUsage)?.limit ?? null,
        networkRxBytes: parseNetwork(record.NetIO)?.rx ?? null,
        networkTxBytes: parseNetwork(record.NetIO)?.tx ?? null,
        pids: parseNumber(record.PIDs),
      }));
    } catch {
      invalidRows += 1;
    }
  }
  return {
    values,
    invalidRows,
    complete: !result.truncated && invalidRows === 0 && values.size === requestedIds.length,
  };
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseNumber(value: unknown): number | null {
  const raw = stringField(value);
  if (!raw || !/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePercent(value: unknown): number | null {
  const raw = stringField(value)?.replace(/%$/, '').trim();
  if (!raw || !/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseMemoryUsage(value: unknown): { used: number | null; limit: number | null } | null {
  const raw = stringField(value);
  if (!raw) return null;
  const [used, limit] = raw.split('/').map((part) => parseUnit(part.trim()));
  return { used: used ?? null, limit: limit ?? null };
}

function parseNetwork(value: unknown): { rx: number | null; tx: number | null } | null {
  const raw = stringField(value);
  if (!raw) return null;
  const [rx, tx] = raw.split('/').map((part) => parseUnit(part.trim()));
  return { rx: rx ?? null, tx: tx ?? null };
}

function parseUnit(value: string): number | null {
  const match = value.match(/^([0-9]+(?:\.[0-9]+)?)\s*([kmgtpe]?i?b)?$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = (match[2] ?? 'B').toLowerCase();
  const powers: Record<string, number> = {
    b: 0,
    kb: 1,
    mb: 2,
    gb: 3,
    tb: 4,
    pb: 5,
    kib: 1,
    mib: 2,
    gib: 3,
    tib: 4,
    pib: 5,
  };
  const power = powers[unit];
  return power === undefined ? null : amount * 1024 ** power;
}

export const parseDockerUnitForTest = parseUnit;
