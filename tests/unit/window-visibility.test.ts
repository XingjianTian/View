import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { WindowVisibilityController, type VisibilityWindow } from '../../src/main/window-visibility.js';

class FakeWindow extends EventEmitter implements VisibilityWindow {
  destroyed = false;
  visible = true;
  minimized = false;
  readonly webContents = { send: vi.fn() };

  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  on(event: string, listener: () => void) { return super.on(event, listener); }
  removeListener(event: string, listener: () => void) { return super.removeListener(event, listener); }
}

describe('window visibility bridge', () => {
  it('publishes hide/minimize/restore state, ignores blur, and cleans duplicate listeners', () => {
    let epoch = 3;
    const bridge = new WindowVisibilityController(() => epoch);
    const window = new FakeWindow();
    bridge.attach(window);
    expect(bridge.snapshot()).toEqual({ windowEpoch: 3, visible: true });
    expect(window.webContents.send).toHaveBeenCalledWith('observatory:window-visibility', { windowEpoch: 3, visible: true });

    window.emit('blur');
    expect(bridge.snapshot().visible).toBe(true);
    window.emit('hide');
    expect(bridge.snapshot()).toEqual({ windowEpoch: 3, visible: false });
    window.emit('show');
    expect(bridge.snapshot().visible).toBe(true);
    window.minimized = true;
    window.emit('minimize');
    expect(bridge.snapshot().visible).toBe(false);
    window.minimized = false;
    window.emit('restore');
    expect(bridge.snapshot().visible).toBe(true);

    const sendCount = window.webContents.send.mock.calls.length;
    bridge.attach(window);
    window.emit('hide');
    expect(window.webContents.send).toHaveBeenCalledTimes(sendCount + 1);
  });

  it('rejects events from a detached old window and advances epoch only once per publish', () => {
    let epoch = 5;
    const bridge = new WindowVisibilityController(() => epoch);
    const oldWindow = new FakeWindow();
    const currentWindow = new FakeWindow();
    bridge.attach(oldWindow);
    bridge.attach(currentWindow);
    epoch = 6;
    bridge.setWindowVisible(currentWindow, false);
    oldWindow.emit('show');
    expect(bridge.snapshot()).toEqual({ windowEpoch: 6, visible: false });
    bridge.setEpochVisible(false);
    expect(currentWindow.webContents.send).toHaveBeenCalledTimes(1);
    bridge.detach(currentWindow);
    currentWindow.emit('show');
    expect(bridge.snapshot()).toEqual({ windowEpoch: 6, visible: false });
  });
});
