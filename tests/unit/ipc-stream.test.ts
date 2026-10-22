import { describe, expect, it } from 'vitest';
import { ObservationStream } from '../../src/main/ipc/observation-stream.js';

describe('observation IPC backpressure', () => {
  it('caps batches at two pending acknowledgements and resumes after ack', () => {
    const stream = new ObservationStream(7);
    stream.enqueue('logs', { line: 'one' });
    const first = stream.flush();
    stream.enqueue('logs', { line: 'two' });
    const second = stream.flush();
    expect(first?.seq).toBe(1);
    expect(second?.seq).toBe(2);
    stream.enqueue('logs', { line: 'three' });
    expect(stream.flush()).toBeNull();
    expect(stream.stats().pending).toBe(2);
    expect(stream.confirm(7, 1)).toBe(true);
    expect(stream.stats().pending).toBe(1);
    expect(stream.flush()?.seq).toBe(3);
  });

  it('pauses after an unacknowledged batch and rejects stale epoch confirmations', () => {
    let now = 1_000;
    const stream = new ObservationStream(7, () => now);
    stream.enqueue('observations', { value: 1 });
    expect(stream.flush()).not.toBeNull();
    now += 5_001;
    stream.tick();
    stream.enqueue('observations', { value: 2 });
    expect(stream.flush()).toBeNull();
    expect(stream.confirm(6, 1)).toBe(false);
    expect(stream.resume(7)).toBe(true);
    expect(stream.confirm(7, 1)).toBe(true);
  });

  it('drops one oversized payload and reports a gap instead of queueing it', () => {
    const stream = new ObservationStream(1);
    stream.enqueue('logs', 'x'.repeat(70 * 1024));
    expect(stream.flush()).toBeNull();
    expect(stream.stats().gap).toBe(1);
  });
});
