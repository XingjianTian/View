import { describe, expect, it } from 'vitest';
import type { ContainerObservation, Freshness, ObservationPoint } from '../../src/shared/entities.js';
import { trendPoints, trendSegments } from '../../src/renderer/components/ServicePanel.js';

function point(observedAt: string, cpuPercent: number | null, freshness: Freshness = 'fresh'): ObservationPoint {
  return {
    observedAt,
    sourceAt: observedAt,
    freshness,
    cpuPercent,
    memoryBytes: null,
    memoryLimitBytes: null,
    networkRxBytes: null,
    networkTxBytes: null,
    pids: null,
  };
}

describe('renderer service trend helpers', () => {
  it('keeps contiguous CPU samples in one segment', () => {
    const points = [
      point('2026-10-20T09:00:00.000Z', 10),
      point('2026-10-20T09:00:02.000Z', 20),
      point('2026-10-20T09:00:04.000Z', 15),
    ];
    expect(trendSegments(points)).toEqual([points]);
  });

  it('breaks the CPU line across a gap of missing samples', () => {
    const points = [
      point('2026-10-20T09:00:00.000Z', 10),
      point('2026-10-20T09:00:02.000Z', 20),
      point('2026-10-20T09:00:08.000Z', 15),
      point('2026-10-20T09:00:10.000Z', 18),
    ];
    expect(trendSegments(points)).toEqual([[points[0], points[1]], [points[2], points[3]]]);
  });

  it('deduplicates timestamps and leaves missing or non-fresh samples as breaks', () => {
    const observation: ContainerObservation = {
      key: 'device:abcdefabcdef',
      deviceId: 'device',
      containerId: 'abcdefabcdef',
      startedAt: null,
      current: null,
      history: [
        point('2026-10-20T09:00:00.000Z', 10),
        point('2026-10-20T09:00:00.000Z', 12),
        point('2026-10-20T09:00:02.000Z', null),
        point('2026-10-20T09:00:04.000Z', 30, 'stale'),
        point('2026-10-20T09:00:06.000Z', 40, 'partial'),
        point('2026-10-20T09:00:08.000Z', 50),
      ],
      coverage: { requested: 6, returned: 6, complete: true },
      errorCode: null,
      generation: 'g1',
    };
    const samples = trendPoints(observation);
    expect(samples).toHaveLength(5);
    expect(samples[0]).toMatchObject({ observedAt: '2026-10-20T09:00:00.000Z', cpuPercent: 12 });
    expect(samples.slice(1, 4)).toEqual([null, null, null]);
    expect(trendSegments(samples).map((segment) => segment.map((sample) => sample.cpuPercent))).toEqual([[12], [50]]);
  });
});
