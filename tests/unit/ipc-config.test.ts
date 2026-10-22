import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { ConfigStore } from '../../src/main/config/store.js';
import { registerIpc } from '../../src/main/ipc/index.js';

vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.0', isPackaged: true },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
}));

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function display() {
  return { layout: 'grid2x2' as const, focusSlot: 1, asciiMode: 'static' as const, asciiBrightness: 20, asciiStrength: 30, reducedMotion: true };
}

function eventFor(sender: object, frame: object) {
  return { sender, senderFrame: frame };
}

describe('configuration IPC notifications', () => {
  it('persists display changes without restarting runtime while retaining guarded errors and other config notifications', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-ipc-config-'));
    roots.push(root);
    const store = new ConfigStore(root);
    await store.load();
    const frame = { url: 'app://observatory/index.html' };
    const sender = { id: 17, mainFrame: frame, getURL: () => frame.url };
    const window = { isDestroyed: () => false, webContents: sender };
    const onConfigChanged = vi.fn();
    const onMenuLayout = vi.fn();
    const runtime = {
      start: vi.fn(),
      stop: vi.fn(),
      refresh: vi.fn(),
      snapshot: vi.fn(() => ({ devices: [], containers: [], observations: [], services: [], logs: [], containerPage: { offset: 0, limit: 96, total: 0, returned: 0, nextOffset: 0, hasMore: false, capacityExceeded: false }, truncated: false })),
      subscribe: vi.fn(() => () => undefined),
      transports: { stats: () => ({ entries: 0, references: 0, connections: 0, channels: 0 }) },
      openLog: vi.fn(),
      pollLog: vi.fn(),
      pauseLog: vi.fn(),
      searchLog: vi.fn(),
      closeLog: vi.fn(),
    };
    registerIpc({
      getWindow: () => window as never,
      getEpoch: () => 3,
      getWindowVisibility: () => ({ windowEpoch: 3, visible: true }),
      store,
      profiles: { summaries: () => [], getReference: () => null, chooseAndRegister: vi.fn() } as never,
      resources: { count: () => 0, register: vi.fn(() => async () => undefined) } as never,
      lifecycle: {} as never,
      runtime: runtime as never,
      onConfigChanged,
      onMenuLayout,
    });
    const handlers = new Map<string, (event: unknown, value: unknown) => Promise<unknown>>();
    for (const [channel, handler] of vi.mocked(ipcMain.handle).mock.calls) handlers.set(channel, handler as never);
    const invoke = (channel: string, payload: unknown, epoch = 3) => handlers.get(channel)?.(eventFor(sender, frame), { epoch, payload });

    const saved = await invoke('config:save-display', { display: display() });
    expect(saved).toEqual({ ok: true, value: expect.objectContaining({ display: display() }) });
    expect(onConfigChanged).not.toHaveBeenCalled();
    expect(runtime.start).not.toHaveBeenCalled();
    expect((await store.snapshot()).display).toEqual(display());
    const rebuilt = new ConfigStore(root);
    await rebuilt.load();
    expect(rebuilt.snapshot().display).toEqual(display());
    expect(JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8')).display).toEqual(display());

    expect(await invoke('app:get-window-visibility', undefined)).toEqual({ ok: true, value: { windowEpoch: 3, visible: true } });
    expect(await invoke('app:set-menu-layout', { layout: 'focus' })).toEqual({ ok: true, value: { layout: 'focus' } });
    expect(onMenuLayout).toHaveBeenCalledWith('focus');
    expect(store.snapshot().display).toEqual(display());
    expect(await invoke('app:set-menu-layout', { layout: 'invalid' })).toMatchObject({ ok: false });
    expect(await invoke('app:set-menu-layout', { layout: 'columns4' }, 2)).toMatchObject({ ok: false });
    expect(onMenuLayout).toHaveBeenCalledTimes(1);


    const invalid = await invoke('config:save-display', { display: { ...display(), asciiBrightness: 101 } });
    expect(invalid).toEqual({ ok: false, error: { code: 'invalid_request', message: '请求参数无效。' } });
    const stale = await invoke('config:save-display', { display: display() }, 2);
    expect(stale).toEqual({ ok: false, error: { code: 'invalid_request', message: '请求代次无效' } });
    expect(onConfigChanged).not.toHaveBeenCalled();

    const originalSaveDisplay = store.saveDisplay.bind(store);
    store.saveDisplay = vi.fn(async () => { throw new Error('write failed'); }) as never;
    const failed = await invoke('config:save-display', { display: { ...display(), layout: 'focus' } });
    expect(failed).toEqual({ ok: false, error: { code: 'config_write_failed', message: '设置未能保存。' } });
    expect(onConfigChanged).not.toHaveBeenCalled();
    store.saveDisplay = originalSaveDisplay;

    await invoke('config:save-device', { device: { id: 'device-1', name: '本机', transport: 'local', profileId: 'profile-1', enabled: true } });
    await invoke('config:save-service', { service: { id: 'service-1', name: '服务', category: '基础设施', bindings: [], businessAdapter: { kind: 'none' } } });
    await invoke('config:set-slots', { slots: [{ serviceId: 'service-1', logBindingId: null }, { serviceId: null, logBindingId: null }, { serviceId: null, logBindingId: null }, { serviceId: null, logBindingId: null }] });
    expect(onConfigChanged).toHaveBeenCalledTimes(3);
  });
});
