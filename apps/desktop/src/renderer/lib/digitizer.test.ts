import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@cortexlume/contracts';
import { applySimilarityTransform, fitSimilarityTransform, landmarkAlias, nearestOptodeMappings } from './digitizer';

describe('digitizer five-point calibration', () => {
  it('recovers a rotated, scaled and translated point set', () => {
    const source: Vec3[] = [[0, 0, 0], [10, 0, 0], [0, 20, 0], [0, 0, 30], [5, 8, 13]];
    const target: Vec3[] = source.map(([x, y, z]) => [100 - 2 * y, -40 + 2 * x, 25 + 2 * z]);
    const transform = fitSimilarityTransform(source, target);
    expect(transform.scale).toBeCloseTo(2, 8);
    source.forEach((point, index) => expect(applySimilarityTransform(transform.matrix, point)).toEqual(expect.arrayContaining(target[index]!.map((value) => expect.closeTo(value, 7)))));
  });

  it('recognizes common fiducial aliases', () => {
    expect(landmarkAlias('Nasion')).toBe('Nz');
    expect(landmarkAlias('Left Preauricular')).toBe('LPA');
    expect(landmarkAlias('vertex')).toBe('Cz');
  });

  it('creates a one-to-one nearest mapping while respecting known optode types', () => {
    const sourceId = '11111111-1111-4111-8111-111111111111';
    const detectorId = '22222222-2222-4222-8222-222222222222';
    const session = {
      id: '33333333-3333-4333-8333-333333333333', name: 'test', importedAt: new Date().toISOString(),
      source: { format: 'TSV', fileName: 'test.tsv', sha256: 'abc' }, visible: true, optodeMappings: [],
      points: [
        { id: sourceId, label: 'S1', kind: 'source' as const, rawPosition: [0, 0, 0] as Vec3 },
        { id: detectorId, label: 'D1', kind: 'detector' as const, rawPosition: [0, 0, 0] as Vec3 },
      ],
      calibratedPoints: [{ pointId: sourceId, rasMm: [9, 0, 0] as Vec3 }, { pointId: detectorId, rasMm: [1, 0, 0] as Vec3 }],
      calibration: { method: 'five-point-similarity' as const, sourceUnit: 'mm' as const, matrix: Array(16).fill(0), scale: 1, rmsResidualMm: 0, maxResidualMm: 0, residuals: [], calibratedAt: new Date().toISOString() },
    };
    const mappings = nearestOptodeMappings(session as never, [sourceId, detectorId], [
      { instanceId: 'i1', optodeId: 'o1', label: 'S1', type: 'source', rasMm: [0, 0, 0] },
      { instanceId: 'i1', optodeId: 'o2', label: 'D1', type: 'detector', rasMm: [10, 0, 0] },
    ]);
    expect(mappings.map((mapping) => mapping.pointId)).toEqual([sourceId, detectorId]);
  });
});
