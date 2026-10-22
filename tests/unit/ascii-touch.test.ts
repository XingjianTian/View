import { describe, expect, it } from 'vitest';
import { ASCII_TOUCH_DURATION_MS, ASCII_TOUCH_STATIC_FRAME_MS, drawAsciiTouchFrame, touchFrameAt, type TouchImagePair } from '../../src/renderer/ascii/touch.js';

function fakeContext(calls: string[]) {
  return {
    clearRect: () => calls.push('clearRect'),
    drawImage: () => calls.push('drawImage'),
    save: () => undefined,
    restore: () => undefined,
    createRadialGradient: () => ({ addColorStop: () => undefined }),
    fillRect: () => undefined,
    translate: () => undefined,
    rotate: () => undefined,
    beginPath: () => undefined,
    moveTo: () => undefined,
    quadraticCurveTo: () => undefined,
    fill: () => undefined,
    fillText: () => undefined,
  } as unknown as CanvasRenderingContext2D;
}

describe('ASCII touch reference timing', () => {
  it('keeps the approach, contact and loop timings deterministic', () => {
    const opening = touchFrameAt(0, 1280, 720);
    const approach = touchFrameAt(2_500, 1280, 720);
    const contact = touchFrameAt(ASCII_TOUCH_STATIC_FRAME_MS, 1280, 720, true);
    const wrapped = touchFrameAt(ASCII_TOUCH_DURATION_MS, 1280, 720);

    expect(opening).toMatchObject({ time: 0, arrival: 0, opacity: 0 });
    expect(approach.arrival).toBeGreaterThan(.9);
    expect(approach.opacity).toBe(1);
    expect(contact).toMatchObject({ time: ASCII_TOUCH_STATIC_FRAME_MS, arrival: 1, opacity: 1 });
    expect(wrapped.time).toBe(opening.time);
  });

  it('preserves the reference scale relationship at the review viewports', () => {
    const narrow = touchFrameAt(ASCII_TOUCH_STATIC_FRAME_MS, 1280, 720, true);
    const wide = touchFrameAt(ASCII_TOUCH_STATIC_FRAME_MS, 1920, 1080, true);

    expect(wide.scale).toBeGreaterThan(narrow.scale);
    expect(narrow.centerX).toBe(640);
    expect(wide.centerX).toBe(960);
  });

  it('keeps the post-dissolution tail clear while static contact remains visible', () => {
    const images = [{}, {}] as unknown as TouchImagePair;
    const staticCalls: string[] = [];
    const lateCalls: string[] = [];
    const staticContext = fakeContext(staticCalls);
    const lateContext = fakeContext(lateCalls);

    drawAsciiTouchFrame(staticContext, 1280, 720, ASCII_TOUCH_STATIC_FRAME_MS, images, { intensity: .65, staticFrame: true });
    drawAsciiTouchFrame(lateContext, 1280, 720, 6_500, images, { intensity: .65 });
    drawAsciiTouchFrame(lateContext, 1280, 720, 8_000, images, { intensity: .65 });

    expect(staticCalls.filter((call) => call === 'drawImage')).toHaveLength(2);
    expect(lateCalls.filter((call) => call === 'drawImage')).toHaveLength(0);
    expect(lateCalls.filter((call) => call === 'clearRect')).toHaveLength(2);
  });
});
