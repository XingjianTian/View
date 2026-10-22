import { describe, expect, it } from 'vitest';
import { parseContainerList, mergeInspectedContainers } from '../../src/main/discovery/parser.js';
import type { CommandResult } from '../../src/main/transport/types.js';

const idA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const idB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function result(stdout: string, operation: CommandResult['operation'] = 'list', truncated = false): CommandResult {
  return { operation, stdout, stderr: '', code: 0, truncated, observedAt: '2026-10-20T10:00:00.000Z' };
}

function row(fields: readonly unknown[]): string {
  return fields.map((field) => JSON.stringify(field)).join('\t');
}

describe('container discovery parsing', () => {
  it('keeps the full device-scoped ID and compose identity', () => {
    const parsed = parseContainerList(result([
      row([idA, 'worker', 'image@sha256:abc', 'running', 'Up', '2026', '1 hour', '', '', 'proj', 'worker', 1]),
      row([idB, 'worker', 'image@sha256:def', 'exited', 'Exited', '2026', '2 hours', '', '', 'proj', 'worker', 2]),
    ].join('\n')), 'nas');
    expect(parsed.complete).toBe(true);
    expect(parsed.containers.map((item) => item.id)).toEqual([idA, idB]);
    expect(parsed.containers[0]?.compose).toEqual({ project: 'proj', service: 'worker', ordinal: 1 });

    const merged = mergeInspectedContainers(parsed.containers, result([
      row([idA, '/worker', 'image@sha256:abc', 'running', 'healthy', '2026-10-20T09:00:00.000Z', '0001-01-01T00:00:00Z', 0, 2, true, 'default']),
      row([idB, '/worker', 'image@sha256:def', 'exited', 'none', '0001-01-01T00:00:00Z', '2026-10-20T08:00:00.000Z', 1, 0, false, 'default']),
    ].join('\n'), 'inspect'));
    expect(merged.complete).toBe(true);
    expect(merged.containers[0]).toMatchObject({ key: `nas:${idA}`, state: 'running', health: 'healthy', restartCount: 2, tty: true });
    expect(merged.containers[1]).toMatchObject({ state: 'exited', health: 'none', startedAt: null, exitCode: 1 });
  });

  it('marks truncation and malformed rows incomplete without inventing containers', () => {
    const parsed = parseContainerList(result('not-json\n', 'list', true), 'local');
    expect(parsed.containers).toHaveLength(0);
    expect(parsed.complete).toBe(false);
    expect(parsed.invalidRows).toBe(1);
  });
});
