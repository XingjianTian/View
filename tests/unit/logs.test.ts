import { describe, expect, it, vi } from 'vitest';
import { LogRingBuffer } from '../../src/main/logs/buffer.js';
import { LogManager } from '../../src/main/logs/manager.js';
import { LogChunkParser, parseLogText } from '../../src/main/logs/parser.js';
import { LogPoller } from '../../src/main/logs/poller.js';
import type { DockerTransport } from '../../src/main/transport/types.js';

function transport(logs: string[]): DockerTransport {
  return {
    kind: 'local',
    version: async () => ({ operation: 'version', stdout: '1', stderr: '', code: 0, truncated: false, observedAt: new Date().toISOString() }),
    list: async () => ({ operation: 'list', stdout: '', stderr: '', code: 0, truncated: false, observedAt: new Date().toISOString() }),
    inspect: async () => ({ operation: 'inspect', stdout: '', stderr: '', code: 0, truncated: false, observedAt: new Date().toISOString() }),
    stats: async () => ({ operation: 'stats', stdout: '', stderr: '', code: 0, truncated: false, observedAt: new Date().toISOString() }),
    logs: async () => ({ operation: 'logs', stdout: logs.shift() ?? '', stderr: '', code: 0, truncated: false, observedAt: new Date().toISOString() }),
    close: async () => undefined,
  };
}

describe('bounded logs', () => {
  it('shares a source poll across duplicate panel subscribers', async () => {
    let calls = 0;
    const source = transport(['2026-10-20T10:00:00.000000001Z shared\n']);
    const counting: DockerTransport = { ...source, logs: async (...args) => { calls += 1; return source.logs(...args); } };
    const manager = new LogManager();
    expect(manager.open({ sourceKey: 'local:c', deviceId: 'local', containerId: 'c'.repeat(64), transport: counting })).toBe(true);
    expect(manager.retain('local:c')).toBe(true);
    const results = await Promise.all([manager.poll('local:c'), manager.poll('local:c')]);
    expect(calls).toBe(1);
    expect(results[0]?.entries).toHaveLength(1);
    manager.release('local:c');
    manager.release('local:c');
    await manager.close();
  });

  it('assigns distinct read attempt ids across four active sources', async () => {
    const manager = new LogManager();
    const sourceKeys = ['local:a', 'local:b', 'nas:c', 'nas:d'];
    for (const [index, sourceKey] of sourceKeys.entries()) {
      const containerId = String.fromCharCode(97 + index).repeat(64);
      expect(manager.open({ sourceKey, deviceId: sourceKey.split(':')[0] ?? 'local', containerId, transport: transport(['']) })).toBe(true);
    }
    const states = await Promise.all(sourceKeys.map((sourceKey) => manager.poll(sourceKey)));
    const attemptIds = states.map((state) => state?.diagnostic?.readAttemptId).filter((value): value is number => value !== undefined);
    expect(attemptIds).toHaveLength(4);
    expect(new Set(attemptIds).size).toBe(4);
    await manager.close();
  });

  it('clears cursor and cached lines when the same container id gets a new generation', async () => {
    const id = 'a'.repeat(64);
    const sourceKey = `local:${id}`;
    const manager = new LogManager();
    const first = transport(['2026-10-20T10:00:00.000000001Z old generation\n']);
    const second = transport(['2026-10-20T10:05:00.000000001Z new generation\n']);
    expect(manager.open({ sourceKey, deviceId: 'local', containerId: id, generation: 'local:container:old', continuous: true, transport: first })).toBe(true);
    expect((await manager.poll(sourceKey))?.entries[0]?.message).toBe('old generation');
    const oldCursor = manager.get(sourceKey)?.cursor;
    expect(manager.get(sourceKey)?.generation).toBe('local:container:old');

    expect(manager.open({ sourceKey, deviceId: 'local', containerId: id, generation: 'local:container:new', continuous: true, transport: second })).toBe(true);
    expect(manager.get(sourceKey)?.entries).toEqual([]);
    expect(manager.get(sourceKey)?.cursor).toBeNull();
    expect(manager.get(sourceKey)?.generation).toBe('local:container:new');
    manager.release(sourceKey, 'local:container:old', true);
    expect((await manager.poll(sourceKey))?.entries[0]?.message).toBe('new generation');
    expect(manager.get(sourceKey)?.entries).toHaveLength(1);
    expect(manager.get(sourceKey)?.cursor).not.toBe(oldCursor);
    expect(manager.get(sourceKey)?.cursor).not.toBeNull();
    expect(manager.get(sourceKey)?.generation).toBe('local:container:new');
    await manager.close();
  });

  it('takes one finite log snapshot for a stopped container', async () => {
    let calls = 0;
    const source = transport(['2026-10-20T10:00:00.000000001Z stopped snapshot\n']);
    const counting: DockerTransport = { ...source, logs: async (...args) => { calls += 1; return source.logs(...args); } };
    const manager = new LogManager();
    const sourceKey = `local:${'b'.repeat(64)}`;
    expect(manager.open({ sourceKey, deviceId: 'local', containerId: 'b'.repeat(64), generation: 'local:container:stopped', continuous: false, transport: counting })).toBe(true);
    expect((await manager.poll(sourceKey))?.entries).toHaveLength(1);
    expect((await manager.poll(sourceKey))?.entries).toHaveLength(1);
    expect(calls).toBe(1);
    await manager.close();
  });

  it('assembles split UTF-8, preserves nanosecond timestamps, strips ANSI and redacts secrets', () => {
    const parser = new LogChunkParser(['sëcret-token']);
    const text = '2026-10-20T10:00:00.123456789Z hello sëcret-token \u001b[31mred\u001b[0m\n';
    const bytes = Buffer.from(text, 'utf8');
    const first = parser.push(bytes.subarray(0, 17));
    const second = parser.push(bytes.subarray(17));
    const entries = [...first, ...second, ...parser.finish()];
    expect(entries).toEqual([{ timestamp: '2026-10-20T10:00:00.123456789Z', message: 'hello [已脱敏] red' }]);
  });

  it('drops oversized lines and reports a gap', () => {
    const parsed = parseLogText(`${'x'.repeat(16 * 1024 + 1)}\n`);
    expect(parsed.entries).toEqual([]);
    expect(parsed.gap).toBe(1);
  });

  it('keeps real duplicate messages while suppressing only overlap occurrences', async () => {
    const source = transport([
      '2026-10-20T10:00:00.000000001Z same\n2026-10-20T10:00:00.000000002Z same\n',
      '2026-10-20T10:00:00.000000001Z same\n2026-10-20T10:00:00.000000002Z same\n2026-10-20T10:00:00.000000002Z same\n',
    ]);
    const poller = new LogPoller({ sourceKey: 'local:container', deviceId: 'local', containerId: 'a'.repeat(64), transport: source });
    expect((await poller.poll()).entries).toHaveLength(2);
    const next = await poller.poll();
    expect(next.entries).toHaveLength(1);
    expect(next.entries[0]?.message).toBe('same');
  });

  it('keeps source and global memory bounded and searches only cached literal text', () => {
    const buffer = new LogRingBuffer();
    const entries = Array.from({ length: 2_100 }, (_, index) => ({ id: String(index), sourceKey: 'local:c', deviceId: 'local', containerId: 'c', timestamp: null, message: `line ${index} needle`, observedAt: new Date(Date.now() + index).toISOString() }));
    buffer.append('local:c', { deviceId: 'local', containerId: 'c' }, entries);
    const stats = buffer.stats();
    expect(stats.entries).toBeLessThanOrEqual(2_000);
    expect(stats.bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(stats.gap).toBeGreaterThan(0);
    expect(buffer.get('local:c')?.complete).toBe(false);
    expect(buffer.search('local:c', 'needle').every((entry) => entry.message.includes('needle'))).toBe(true);
  });

  it('clears the current read error after a later success while retaining the failure receipt', async () => {
    vi.useFakeTimers();
    try {
      let failed = true;
      const source = transport(['']);
      const recovering: DockerTransport = {
        ...source,
        logs: async (...args) => {
          if (failed) {
            failed = false;
            throw Object.assign(new Error('bounded timeout'), { code: 'timeout' });
          }
          return source.logs(...args);
        },
      };
      const manager = new LogManager();
      const sourceKey = `local:${'c'.repeat(64)}`;
      expect(manager.open({ sourceKey, deviceId: 'local', containerId: 'c'.repeat(64), transport: recovering })).toBe(true);
      const failedState = await manager.poll(sourceKey);
      expect(failedState?.errorCode).toBe('timeout');
      expect(failedState?.lastErrorCode).toBe('timeout');
      expect(failedState?.diagnostic?.outcome).toBe('unknown_error');

      await vi.advanceTimersByTimeAsync(1_501);
      const recovered = await manager.poll(sourceKey);
      expect(recovered?.errorCode).toBeNull();
      expect(recovered?.lastErrorCode).toBe('timeout');
      expect(recovered?.diagnostic?.outcome).toBe('success_idle');
      expect(recovered?.complete).toBe(true);
      await manager.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not turn a historical gap into complete after a successful read', () => {
    const buffer = new LogRingBuffer();
    const sourceKey = 'local:gap';
    buffer.ensure(sourceKey, { deviceId: 'local', containerId: 'gap' });
    buffer.append(sourceKey, { deviceId: 'local', containerId: 'gap' }, [], 2, false, {
      readAttemptId: 1,
      source: 'container_logs',
      connectionGeneration: null,
      phase: 'parse',
      elapsedMs: 1,
      budgetMs: 5_000,
      channels: 0,
      bytes: 10,
      outcome: 'parse_error',
      observedAt: new Date().toISOString(),
    });
    expect(buffer.get(sourceKey)?.lastSuccessAt).toBeNull();
    buffer.setError(sourceKey, 'timeout');
    buffer.append(sourceKey, { deviceId: 'local', containerId: 'gap' }, [], 0, false, {
      readAttemptId: 2,
      source: 'container_logs',
      connectionGeneration: null,
      phase: 'read',
      elapsedMs: 1,
      budgetMs: 5_000,
      channels: 0,
      bytes: 0,
      outcome: 'success_idle',
      observedAt: new Date().toISOString(),
    });
    const state = buffer.get(sourceKey);
    expect(state?.errorCode).toBeNull();
    expect(state?.lastErrorCode).toBe('timeout');
    expect(state?.gap).toBe(2);
    expect(state?.complete).toBe(false);
    expect(state?.lastSuccessAt).not.toBeNull();
  });

  it('classifies the bounded local output limit without SSH trace', async () => {
    const source = transport(['']);
    const manager = new LogManager();
    const sourceKey = `local:${'f'.repeat(64)}`;
    const truncated: DockerTransport = {
      ...source,
      logs: async () => { throw Object.assign(new Error('output limit'), { code: 'incomplete' }); },
    };
    expect(manager.open({ sourceKey, deviceId: 'local', containerId: 'f'.repeat(64), transport: truncated })).toBe(true);
    const state = await manager.poll(sourceKey);
    expect(state?.diagnostic).toMatchObject({ outcome: 'output_truncated', phase: 'output' });
    expect(state?.errorCode).toBe('incomplete');
    expect(state?.complete).toBe(false);
    await manager.close();
  });

  it('keeps a parser gap in the parse phase after a successful transport end', async () => {
    const manager = new LogManager();
    const sourceKey = `local:${'i'.repeat(64)}`;
    const traced: DockerTransport = {
      ...transport(['']),
      logs: async (...args) => {
        const context = args[3];
        if (context) manager.recordTransportTrace('local', {
          phase: 'output_end', clientId: 1, requestId: 6, operation: 'logs', outcome: '0', connectionGeneration: 1, channels: 0, bytes: 16 * 1024 + 1, elapsedMs: 2, atMs: Date.now(), readAttemptId: context.readAttemptId,
        });
        return {
          operation: 'logs',
          stdout: `${'x'.repeat(16 * 1024 + 1)}\n`,
          stderr: '',
          code: 0,
          truncated: false,
          observedAt: new Date().toISOString(),
        };
      },
    };
    expect(manager.open({ sourceKey, deviceId: 'local', containerId: 'i'.repeat(64), transport: traced })).toBe(true);
    const state = await manager.poll(sourceKey);
    expect(state?.diagnostic).toMatchObject({ outcome: 'parse_error', phase: 'parse' });
    expect(state?.errorCode).toBe('parse_gap');
    expect(state?.complete).toBe(false);
    await manager.close();
  });

  it('classifies a traced opened channel timeout as a remote timeout', async () => {
    const source = transport(['']);
    const manager = new LogManager();
    const sourceKey = `nas:${'d'.repeat(64)}`;
    const traced: DockerTransport = {
      ...source,
      logs: async (...args) => {
        const context = args[3];
        if (context) manager.recordTransportTrace('nas', {
          phase: 'channel_open', clientId: 1, requestId: 1, operation: 'logs', connectionGeneration: 2, channels: 1, elapsedMs: 3, atMs: Date.now(), readAttemptId: context.readAttemptId,
        });
        if (context) manager.recordTransportTrace('nas', {
          phase: 'output_end', clientId: 1, requestId: 1, operation: 'logs', outcome: 'timeout', connectionGeneration: 2, channels: 1, elapsedMs: 5_000, atMs: Date.now(), readAttemptId: context.readAttemptId,
        });
        throw Object.assign(new Error('bounded timeout'), { code: 'timeout' });
      },
    };
    expect(manager.open({ sourceKey, deviceId: 'nas', containerId: 'd'.repeat(64), transport: traced })).toBe(true);
    const state = await manager.poll(sourceKey);
    expect(state?.diagnostic).toMatchObject({ outcome: 'remote_timeout', phase: 'remote', connectionGeneration: 2, channels: 1 });
    expect(state?.errorCode).toBe('timeout');
    await manager.close();
  });

  it('does not treat a warm client channel failure as a new SSH connection error', async () => {
    const source = transport(['']);
    const manager = new LogManager();
    const sourceKey = `nas:${'g'.repeat(64)}`;
    const traced: DockerTransport = {
      ...source,
      logs: async (...args) => {
        const context = args[3];
        if (context) manager.recordTransportTrace('nas', {
          phase: 'exec_start', clientId: 1, requestId: 4, operation: 'logs', connectionGeneration: 4, channels: 0, elapsedMs: 1, atMs: Date.now(), readAttemptId: context.readAttemptId,
        });
        if (context) manager.recordTransportTrace('nas', {
          phase: 'output_end', clientId: 1, requestId: 4, operation: 'logs', outcome: 'channel_error', connectionGeneration: 4, channels: 0, elapsedMs: 2, atMs: Date.now(), readAttemptId: context.readAttemptId,
        });
        throw Object.assign(new Error('channel unavailable'), { code: 'engine_unavailable' });
      },
    };
    expect(manager.open({ sourceKey, deviceId: 'nas', containerId: 'g'.repeat(64), transport: traced })).toBe(true);
    const state = await manager.poll(sourceKey);
    expect(state?.diagnostic).toMatchObject({ outcome: 'channel_error', phase: 'channel', connectionGeneration: 4 });
    await manager.close();
  });

  it('keeps a deadline probe timeout in the deadline phase', async () => {
    const source = transport(['']);
    const manager = new LogManager();
    const sourceKey = `nas:${'e'.repeat(64)}`;
    const traced: DockerTransport = {
      ...source,
      logs: async (...args) => {
        const context = args[3];
        if (context) manager.recordTransportTrace('nas', {
          phase: 'ssh_ready', clientId: 1, operation: 'ssh_connect', connectionGeneration: 3, channels: 0, elapsedMs: 2, atMs: Date.now(), readAttemptId: context.readAttemptId,
        });
        if (context) manager.recordTransportTrace('nas', {
          phase: 'output_end', clientId: 1, requestId: 2, operation: 'deadline', outcome: 'timeout', connectionGeneration: 3, channels: 0, elapsedMs: 5_000, bytes: 0, atMs: Date.now(), readAttemptId: context.readAttemptId,
        });
        throw Object.assign(new Error('deadline probe timeout'), { code: 'timeout' });
      },
    };
    expect(manager.open({ sourceKey, deviceId: 'nas', containerId: 'e'.repeat(64), transport: traced })).toBe(true);
    const state = await manager.poll(sourceKey);
    expect(state?.diagnostic).toMatchObject({ outcome: 'deadline_error', phase: 'deadline', connectionGeneration: 3 });
    expect(state?.errorCode).toBe('timeout');
    await manager.close();
  });

  it('maps a remote logs exit 124 to a remote timeout', async () => {
    const source = transport(['']);
    const manager = new LogManager();
    const sourceKey = `nas:${'h'.repeat(64)}`;
    const traced: DockerTransport = {
      ...source,
      logs: async (...args) => {
        const context = args[3];
        if (context) manager.recordTransportTrace('nas', {
          phase: 'channel_open', clientId: 1, requestId: 5, operation: 'logs', connectionGeneration: 5, channels: 1, elapsedMs: 1, atMs: Date.now(), readAttemptId: context.readAttemptId,
        });
        if (context) manager.recordTransportTrace('nas', {
          phase: 'output_end', clientId: 1, requestId: 5, operation: 'logs', outcome: '124', connectionGeneration: 5, channels: 1, elapsedMs: 5_000, atMs: Date.now(), readAttemptId: context.readAttemptId,
        });
        throw Object.assign(new Error('remote command exit'), { code: 'engine_unavailable' });
      },
    };
    expect(manager.open({ sourceKey, deviceId: 'nas', containerId: 'h'.repeat(64), transport: traced })).toBe(true);
    const state = await manager.poll(sourceKey);
    expect(state?.diagnostic).toMatchObject({ outcome: 'remote_timeout', phase: 'remote', connectionGeneration: 5 });
    await manager.close();
  });
});
