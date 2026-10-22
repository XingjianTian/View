import { describe, expect, it } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { IpcGuard, IpcGuardError, safeError } from '../../src/main/ipc/guard.js';

function fakeEvent(overrides: Partial<{ sender: object; senderFrame: object }> = {}) {
  const frame = { url: 'app://observatory/index.html' };
  const sender = {
    id: 7,
    mainFrame: frame,
    getURL: () => 'app://observatory/index.html',
  };
  return {
    sender: overrides.sender ?? sender,
    senderFrame: overrides.senderFrame ?? frame,
  } as unknown as IpcMainInvokeEvent;
}

describe('IPC guard', () => {
  it('accepts only the active document epoch', () => {
    const initial = fakeEvent();
    const webContents = initial.sender;
    const guard = new IpcGuard({
      getWindow: () => ({ isDestroyed: () => false, webContents } as never),
      getEpoch: () => 3,
    });
    expect(guard.envelope(initial, 'test', { epoch: 3, payload: { ok: true } }).epoch).toBe(3);
    expect(() => guard.envelope(fakeEvent(), 'test', { epoch: 2 })).toThrowError(IpcGuardError);
    expect(() => guard.envelope(fakeEvent({ sender: webContents, senderFrame: { url: 'app://observatory/child' } }), 'test', { epoch: 3 })).toThrowError(IpcGuardError);
  });

  it('returns a stable redacted error envelope', () => {
    const result = safeError(new Error('private-secret-token'));
    expect(result).toEqual({ ok: false, error: { code: 'internal', message: '操作未完成，请查看本机匿名诊断状态。' } });
    expect(JSON.stringify(result)).not.toContain('private-secret-token');
  });
});
