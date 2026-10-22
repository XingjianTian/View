import { describe, expect, it } from 'vitest';
import { LifecycleManager, ResourceRegistry } from '../../src/main/lifecycle.js';

describe('resource lifecycle', () => {
  it('cleans an owner exactly once and leaves no registration behind', async () => {
    const registry = new ResourceRegistry();
    const lifecycle = new LifecycleManager(registry);
    const cleanups: string[] = [];
    const release = registry.register(42, lifecycle.nextEpoch(), 'test-resource', () => { cleanups.push('done'); });
    expect(registry.count()).toBe(1);
    await lifecycle.disposeWindow({ isDestroyed: () => false, webContents: { id: 42 } } as never);
    await release();
    expect(registry.count()).toBe(0);
    expect(cleanups).toEqual(['done']);
  });

  it('disposes all owners idempotently', async () => {
    const registry = new ResourceRegistry();
    const lifecycle = new LifecycleManager(registry);
    let count = 0;
    registry.register(1, lifecycle.nextEpoch(), 'one', () => { count += 1; });
    registry.register(2, lifecycle.nextEpoch(), 'two', () => { count += 1; });
    await lifecycle.disposeAll();
    await lifecycle.disposeAll();
    expect(count).toBe(2);
    expect(registry.labels()).toEqual([]);
  });

  it('uses the owner id captured before Electron destroys webContents', async () => {
    const registry = new ResourceRegistry();
    const lifecycle = new LifecycleManager(registry);
    let cleaned = 0;
    registry.register(42, lifecycle.nextEpoch(), 'closed-window-resource', () => { cleaned += 1; });
    const destroyedWindow = {
      isDestroyed: () => true,
      webContents: Object.defineProperty({}, 'id', { get: () => { throw new Error('Object has been destroyed'); } }),
    };
    await lifecycle.disposeWindow(destroyedWindow as never, 42);
    expect(cleaned).toBe(1);
    expect(registry.count()).toBe(0);
  });
});
