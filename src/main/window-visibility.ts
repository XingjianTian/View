import type { WindowVisibility } from '../shared/contracts.js';

export type VisibilityWindow = {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  webContents: { send(channel: string, value: WindowVisibility): void };
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
};

type WindowEntry = {
  window: VisibilityWindow;
  release: () => void;
};

export class WindowVisibilityController {
  private state: WindowVisibility = { windowEpoch: 0, visible: false };
  private entry: WindowEntry | null = null;

  constructor(private readonly getEpoch: () => number) {}

  attach(window: VisibilityWindow): void {
    if (this.entry?.window === window) {
      this.setWindowVisible(window, this.isVisible(window));
      return;
    }
    this.entry?.release();
    const listeners: Array<[string, () => void]> = [
      ['show', () => this.setWindowVisible(window, this.isVisible(window))],
      ['hide', () => this.setWindowVisible(window, false)],
      ['minimize', () => this.setWindowVisible(window, false)],
      ['restore', () => this.setWindowVisible(window, this.isVisible(window))],
    ];
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      for (const [event, listener] of listeners) window.removeListener(event, listener);
      if (this.entry?.window === window) this.entry = null;
    };
    this.entry = { window, release };
    for (const [event, listener] of listeners) window.on(event, listener);
    this.setWindowVisible(window, this.isVisible(window));
  }

  detach(window: VisibilityWindow): void {
    if (this.entry?.window === window) this.entry.release();
  }

  setEpochVisible(visible: boolean): void {
    this.publish(null, visible);
  }

  setWindowVisible(window: VisibilityWindow, visible: boolean): void {
    if (this.entry?.window !== window || window.isDestroyed()) return;
    this.publish(window, visible);
  }

  snapshot(): WindowVisibility {
    return this.state;
  }

  private publish(window: VisibilityWindow | null, visible: boolean): void {
    const next: WindowVisibility = { windowEpoch: this.getEpoch(), visible };
    const changed = next.windowEpoch !== this.state.windowEpoch || next.visible !== this.state.visible;
    this.state = next;
    if (!changed || !window || window.isDestroyed()) return;
    try {
      window.webContents.send('observatory:window-visibility', next);
    } catch {
      // A renderer can disappear between the visibility event and send.
    }
  }

  private isVisible(window: VisibilityWindow): boolean {
    return !window.isDestroyed() && window.isVisible() && !window.isMinimized();
  }
}
