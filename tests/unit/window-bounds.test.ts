import { describe, expect, it } from 'vitest';
import { clampWindowBounds } from '../../src/main/window.js';

const defaults = { width: 1440, height: 900, minWidth: 1120, minHeight: 700 };
const displays = [
  { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
  { id: 2, workArea: { x: 1920, y: 0, width: 1280, height: 1024 } },
] as const;

describe('clampWindowBounds', () => {
  it('keeps a saved window inside its recorded display work area', () => {
    expect(clampWindowBounds({ x: 3100, y: 900, width: 1800, height: 1200, displayId: '2' }, defaults, displays, displays[0])).toEqual({
      x: 1920,
      y: 0,
      width: 1280,
      height: 1024,
      displayId: '2',
    });
  });

  it('matches the display containing a saved window center when display id is unavailable', () => {
    expect(clampWindowBounds({ x: 2050, y: 80, width: 1120, height: 700 }, defaults, displays, displays[0])).toEqual({
      x: 2050,
      y: 80,
      width: 1120,
      height: 700,
      displayId: '2',
    });
  });
});
