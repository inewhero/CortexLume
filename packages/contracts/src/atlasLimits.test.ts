import { describe, expect, it } from 'vitest';
import {
  AtlasPathQueryBatchRequestSchema,
  AtlasQueryRequestSchema,
  CROSS_PROCESS_LIMITS,
} from './index';

describe('science atlas wire limits', () => {
  it('accepts the exact point batch limit and rejects limit plus one', () => {
    const point = { id: 'point', corticalRasMm: [0, 0, 0] as [number, number, number] };
    const maximum = AtlasQueryRequestSchema.safeParse({
      points: Array.from({ length: CROSS_PROCESS_LIMITS.atlasBatchPoints }, () => point),
    });
    expect(maximum.success).toBe(true);
    if (maximum.success) expect(maximum.data.points).toHaveLength(512);
    expect(AtlasQueryRequestSchema.safeParse({
      points: Array.from({ length: CROSS_PROCESS_LIMITS.atlasBatchPoints + 1 }, () => point),
    }).success).toBe(false);
  });

  it('accepts the exact path batch limit and rejects limit plus one', () => {
    const item = { id: 'path', points: [[0, 0, 0] as [number, number, number]] };
    const maximum = AtlasPathQueryBatchRequestSchema.safeParse({
      items: Array.from({ length: CROSS_PROCESS_LIMITS.atlasPathBatchItems }, () => item),
    });
    expect(maximum.success).toBe(true);
    if (maximum.success) expect(maximum.data.items).toHaveLength(128);
    expect(AtlasPathQueryBatchRequestSchema.safeParse({
      items: Array.from({ length: CROSS_PROCESS_LIMITS.atlasPathBatchItems + 1 }, () => item),
    }).success).toBe(false);
    expect(AtlasPathQueryBatchRequestSchema.parse({ paths: [item] }).items).toEqual([item]);
  });

  it('accepts exactly 129 path points and rejects one more', () => {
    const points = Array.from(
      { length: CROSS_PROCESS_LIMITS.maximumPathPointsPerChannel },
      () => [0, 0, 0] as [number, number, number],
    );
    const maximum = AtlasPathQueryBatchRequestSchema.safeParse({ items: [{ id: 'path', points }] });
    expect(maximum.success).toBe(true);
    if (maximum.success) expect(maximum.data.items[0]?.points).toHaveLength(129);
    const oversizedPoints = Array.from(
      { length: CROSS_PROCESS_LIMITS.maximumPathPointsPerChannel + 1 },
      () => [0, 0, 0] as [number, number, number],
    );
    expect(AtlasPathQueryBatchRequestSchema.safeParse({
      items: [{ id: 'path', points: oversizedPoints }],
    }).success).toBe(false);
  });
});
