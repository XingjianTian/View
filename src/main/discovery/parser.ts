import type { CommandResult } from '../transport/types.js';
import {
  ContainerEntitySchema,
  type ComposeIdentity,
  type ContainerEntity,
  containerKey,
  generationFor,
} from '../../shared/entities.js';

export type ContainerCandidate = {
  deviceId: string;
  id: string;
  name: string;
  image: string;
  state: ContainerEntity['state'];
  sourceAt: string;
  compose: ComposeIdentity;
};

export type ParsedList = {
  containers: ContainerCandidate[];
  complete: boolean;
  invalidRows: number;
};

export function parseContainerList(result: CommandResult, deviceId: string, maxContainers = 512): ParsedList {
  const candidates: ContainerCandidate[] = [];
  let invalidRows = 0;
  for (const line of nonEmptyLines(result.stdout)) {
    const fields = parseJsonFields(line);
    const id = stringValue(fields[0]);
    if (!id || !/^[a-f0-9]{12,64}$/.test(id) || candidates.length >= maxContainers) {
      invalidRows += 1;
      continue;
    }
    const name = stringValue(fields[1]) ?? id.slice(0, 12);
    candidates.push({
      deviceId,
      id,
      name,
      image: stringValue(fields[2]) ?? '未知镜像',
      state: normalizeState(stringValue(fields[3])),
      sourceAt: result.observedAt,
      compose: {
        project: stringValue(fields[9]),
        service: stringValue(fields[10]),
        ordinal: numberValue(fields[11]),
      },
    });
  }
  const rowCount = nonEmptyLines(result.stdout).length;
  return { containers: candidates, complete: !result.truncated && invalidRows === 0 && rowCount <= maxContainers, invalidRows };
}

export function mergeInspectedContainers(candidates: readonly ContainerCandidate[], result: CommandResult): { containers: ContainerEntity[]; complete: boolean } {
  const inspected = new Map<string, ParsedInspect>();
  let invalidRows = 0;
  for (const line of nonEmptyLines(result.stdout)) {
    const fields = parseJsonFields(line);
    const id = stringValue(fields[0]);
    if (!id || !/^[a-f0-9]{12,64}$/.test(id)) {
      invalidRows += 1;
      continue;
    }
    inspected.set(id, {
      id,
      name: stringValue(fields[1]),
      image: stringValue(fields[2]),
      state: normalizeState(stringValue(fields[3])),
      health: normalizeHealth(stringValue(fields[4])),
      startedAt: dateValue(fields[5]),
      finishedAt: dateValue(fields[6]),
      exitCode: numberValue(fields[7]),
      restartCount: numberValue(fields[8]),
      tty: booleanValue(fields[9]),
      networkMode: stringValue(fields[10]),
    });
  }
  const containers = candidates.map((candidate) => {
    const detail = inspected.get(candidate.id);
    const base = {
      key: containerKey(candidate.deviceId, candidate.id),
      deviceId: candidate.deviceId,
      id: candidate.id,
      name: detail?.name ?? candidate.name,
      image: detail?.image ?? candidate.image,
      compose: candidate.compose,
      state: detail?.state ?? candidate.state,
      health: detail?.health ?? 'none',
      startedAt: detail?.startedAt ?? null,
      finishedAt: detail?.finishedAt ?? null,
      exitCode: detail?.exitCode ?? null,
      restartCount: detail?.restartCount ?? null,
      tty: detail?.tty ?? null,
      networkMode: detail?.networkMode ?? null,
      logsAvailable: true,
      sourceAt: candidate.sourceAt,
      generation: '',
    };
    const parsed = ContainerEntitySchema.parse({ ...base, generation: generationFor(base) });
    return parsed;
  });
  return { containers, complete: !result.truncated && invalidRows === 0 && inspected.size >= candidates.length };
}

type ParsedInspect = {
  id: string;
  name: string | null;
  image: string | null;
  state: ContainerEntity['state'];
  health: ContainerEntity['health'];
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  restartCount: number | null;
  tty: boolean | null;
  networkMode: string | null;
};

function parseJsonFields(line: string): unknown[] {
  return line.split('\t').map((value) => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value.trim() || undefined;
    }
  });
}

function nonEmptyLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function dateValue(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.startsWith('0001-')) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeState(value: string | null): ContainerEntity['state'] {
  switch (value?.toLowerCase()) {
    case 'created': return 'created';
    case 'running': return 'running';
    case 'paused': return 'paused';
    case 'restarting': return 'restarting';
    case 'removing': return 'removing';
    case 'exited': return 'exited';
    case 'dead': return 'dead';
    default: return 'unknown';
  }
}

function normalizeHealth(value: string | null): ContainerEntity['health'] {
  switch (value?.toLowerCase()) {
    case 'healthy': return 'healthy';
    case 'unhealthy': return 'unhealthy';
    case 'starting': return 'starting';
    case 'none':
    case '':
    case undefined:
    case null: return 'none';
    default: return 'unknown';
  }
}
