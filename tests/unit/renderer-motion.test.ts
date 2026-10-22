import { describe, expect, it } from 'vitest';
import { motionEnabled, visibleElapsedDelta } from '../../src/renderer/motion.js';

describe('renderer motion helpers', () => {
  it('keeps motion disabled for static, user reduced, and system reduced states', () => {
    expect(motionEnabled('dynamic', false, false)).toBe(true);
    expect(motionEnabled('static', false, false)).toBe(false);
    expect(motionEnabled('off', false, false)).toBe(false);
    expect(motionEnabled('dynamic', true, false)).toBe(false);
    expect(motionEnabled('dynamic', false, true)).toBe(false);
    expect(motionEnabled('dynamic', false, false, true)).toBe(false);
  });

  it('does not advance the visible clock across a long sleep gap', () => {
    expect(visibleElapsedDelta(240)).toBe(240);
    expect(visibleElapsedDelta(1_001)).toBe(0);
    expect(visibleElapsedDelta(-1)).toBe(0);
  });
});
