import { describe, expect, it } from 'vitest';
import { acceptsVisibilityQuery } from '../../src/renderer/window-visibility.js';

describe('renderer window visibility query ordering', () => {
  it('ignores a same-epoch query result after a native notification', () => {
    const result = { ok: true as const, value: { windowEpoch: 4, visible: true } };
    expect(acceptsVisibilityQuery(result, 4, 0, 1)).toBe(false);
    expect(acceptsVisibilityQuery(result, 4, 0, 0)).toBe(true);
  });

  it('rejects a query from another window epoch', () => {
    const result = { ok: true as const, value: { windowEpoch: 3, visible: true } };
    expect(acceptsVisibilityQuery(result, 4, 0, 0)).toBe(false);
  });

  it('rejects failed queries', () => {
    const result = { ok: false as const, error: { code: 'engine_unavailable' as const, message: 'query failed' } };
    expect(acceptsVisibilityQuery(result, 4, 0, 0)).toBe(false);
  });
});
