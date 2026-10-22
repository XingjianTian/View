import type { BrowserWindow } from 'electron';

export type Cleanup = () => void | Promise<void>;

type Resource = {
  id: number;
  owner: number;
  epoch: number;
  label: string;
  cleanup: Cleanup;
};

export class ResourceRegistry {
  private nextId = 1;
  private resources = new Map<number, Resource>();

  register(owner: number, epoch: number, label: string, cleanup: Cleanup) {
    const id = this.nextId++;
    this.resources.set(id, { id, owner, epoch, label, cleanup });
    return () => this.release(id);
  }

  async release(id: number) {
    const resource = this.resources.get(id);
    if (!resource) return;
    this.resources.delete(id);
    await resource.cleanup();
  }

  async disposeOwner(owner: number, epoch?: number) {
    const matching = [...this.resources.values()].filter((resource) => resource.owner === owner && (epoch === undefined || resource.epoch === epoch));
    await Promise.allSettled(matching.map((resource) => this.release(resource.id)));
  }

  async disposeAll() {
    await Promise.allSettled([...this.resources.keys()].map((id) => this.release(id)));
  }

  count() {
    return this.resources.size;
  }

  labels() {
    return [...this.resources.values()].map((resource) => resource.label);
  }
}

export class LifecycleManager {
  private epoch = 0;
  private quitting = false;

  constructor(private readonly resources: ResourceRegistry) {}

  nextEpoch() {
    this.epoch += 1;
    return this.epoch;
  }

  currentEpoch() {
    return this.epoch;
  }

  isQuitting() {
    return this.quitting;
  }

  markQuitting() {
    this.quitting = true;
  }

  async disposeWindow(window: BrowserWindow, capturedOwnerId?: number) {
    let ownerId = capturedOwnerId;
    if (ownerId === undefined) {
      try {
        if (window.isDestroyed()) return;
        ownerId = window.webContents.id;
      } catch {
        // Electron may destroy webContents before the asynchronous `closed`
        // callback runs. The caller should pass the id captured on `close`.
        return;
      }
    }
    await this.resources.disposeOwner(ownerId);
  }

  async disposeAll() {
    await this.resources.disposeAll();
  }
}
