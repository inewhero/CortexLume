import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@cortexlume/contracts';
import { applySimilarityTransform, calibrateDigitizer, fitSimilarityTransform, FIVE_POINT_LABELS, landmarkAlias, nearestOptodeMappings } from './digitizer';

describe('digitizer five-point calibration', () => {
  it.each<Vec3>([[1, 0, 0], [0, 1, 0], [0, 0, 1], [1 / 3, 2 / 3, 2 / 3]])(
    'recovers an exact half-turn about axis (%s, %s, %s)',
    (ax, ay, az) => {
      const source: Vec3[] = [[0, 90, 0], [0, -90, 0], [-70, 0, 0], [70, 0, 0], [0, 0, 100]];
      // R = 2 aa^T - I gives an exact half-turn without sin(pi) roundoff.
      const target: Vec3[] = source.map(([x, y, z]) => {
        const projection = ax * x + ay * y + az * z;
        return [12 + 1.7 * (2 * ax * projection - x), -34 + 1.7 * (2 * ay * projection - y), 56 + 1.7 * (2 * az * projection - z)];
      });
      const transform = fitSimilarityTransform(source, target);
      expect(transform.scale).toBeCloseTo(1.7, 10);
      source.forEach((point, index) => {
        const actual = applySimilarityTransform(transform.matrix, point);
        actual.forEach((value, coordinate) => expect(value).toBeCloseTo(target[index]![coordinate]!, 8));
      });
    },
  );

  it.each([0, 179.999999, 180.000001])('recovers a %s degree rotation about an oblique axis', (degrees) => {
    const source: Vec3[] = [[3, 7, 11], [81, -2, 4], [-5, 63, 9], [6, -8, 95], [-31, -27, -18]];
    const axis: Vec3 = [1 / 3, 2 / 3, 2 / 3];
    const angle = degrees * Math.PI / 180;
    const c = Math.cos(angle); const s = Math.sin(angle);
    const target = source.map((point): Vec3 => {
      const projection = point.reduce((sum, value, index) => sum + value * axis[index]!, 0);
      const cross: Vec3 = [axis[1] * point[2] - axis[2] * point[1], axis[2] * point[0] - axis[0] * point[2], axis[0] * point[1] - axis[1] * point[0]];
      return point.map((value, index) => 17 + 0.6 * (c * value + s * cross[index]! + (1 - c) * projection * axis[index]!)) as Vec3;
    });
    const transform = fitSimilarityTransform(source, target);
    expect(transform.scale).toBeCloseTo(0.6, 10);
    source.forEach((point, index) => {
      applySimilarityTransform(transform.matrix, point).forEach((value, coordinate) =>
        expect(value).toBeCloseTo(target[index]![coordinate]!, 8));
    });
  });

  it('calibrates a half-turn session including unit conversion and an extra optode', () => {
    const landmarks: Vec3[] = [[0, 9, 0], [0, -9, 0], [-7, 0, 0], [7, 0, 0], [0, 0, 10]];
    const expected = ([x, y, z]: Vec3): Vec3 => [12 - 10 * x, -34 - 10 * y, 56 + 10 * z];
    const points = [...landmarks, [2, 3, 4] as Vec3].map((rawPosition, index) => ({
      id: crypto.randomUUID(), label: FIVE_POINT_LABELS[index] ?? 'S1', kind: 'source' as const, rawPosition,
    }));
    const session = calibrateDigitizer({ name: 'Half-turn', source: { format: 'MANUAL', fileName: null, sha256: null }, points },
      { Nz: points[0]!.id, Iz: points[1]!.id, LPA: points[2]!.id, RPA: points[3]!.id, Cz: points[4]!.id },
      { Nz: expected(landmarks[0]!), Iz: expected(landmarks[1]!), LPA: expected(landmarks[2]!), RPA: expected(landmarks[3]!), Cz: expected(landmarks[4]!) }, 'cm');
    expect(session.calibration.scale).toBeCloseTo(1, 10);
    expect(session.calibration.rmsResidualMm).toBeLessThan(1e-8);
    expect(session.calibration.maxResidualMm).toBeLessThan(1e-8);
    session.calibratedPoints.forEach((point, index) => {
      point.rasMm.forEach((value, coordinate) => expect(value).toBeCloseTo(expected(points[index]!.rawPosition)[coordinate]!, 8));
    });
  });

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
