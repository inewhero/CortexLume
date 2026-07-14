import { describe, expect, it } from 'vitest';
import type { LayoutDefinition, LayoutInstance } from '@cortexlume/contracts';
import {
  SCALP_RADII,
  corticalRegionProbabilities,
  corticalRegionFromRas,
  deepStructureProbabilities,
  effectiveUv,
  findLayoutOverlaps,
  fittedOptodePositions,
  projectScalpSphereCenter,
  projectToCorticalSurface,
  projectToEllipsoid,
} from './geometry';
import { FIVE_POINT_LANDMARKS, TEN_TEN_POINTS } from './anatomy';

const layout: LayoutDefinition = {
  id: 'layout-1',
  version: 1,
  name: 'test layout',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  gridSpacingMm: 5,
  optodes: [{ id: 'source-1', label: 'S1', type: 'source', uvMm: [10, 5] }],
  pairs: [],
};

const instance: LayoutInstance = {
  id: 'instance-1',
  definitionId: layout.id,
  anchorRasMm: [-55, -8, 70],
  rotationRad: 0,
  mappingRotationRad: 0,
  visible: true,
  locked: true,
  overrides: [],
};

function ellipsoidEquation([x, y, z]: [number, number, number]): number {
  const [rx, ry, rz] = SCALP_RADII;
  return (x / rx) ** 2 + (y / ry) ** 2 + (z / rz) ** 2;
}

describe('geometric head mapping', () => {
  it('projects points onto the scalp ellipsoid', () => {
    const point = projectToEllipsoid([25, -40, 85]);
    expect(ellipsoidEquation(point)).toBeCloseTo(1, 10);
  });

  it('keeps an optode sphere outside the scalp and offsets cortical contact by its radius', () => {
    const scalp = projectToEllipsoid([25, -40, 85]);
    const sphereCenter = projectScalpSphereCenter(scalp, 4);
    const pointContact = projectToCorticalSurface(scalp, 0);
    const sphereContact = projectToCorticalSurface(scalp, 4);
    expect(Math.hypot(...sphereCenter)).toBeGreaterThan(Math.hypot(...scalp));
    expect(Math.hypot(...sphereContact)).toBeGreaterThan(Math.hypot(...pointContact));
  });

  it('uses an individual optode override when present', () => {
    const overridden = { ...instance, overrides: [{ optodeId: 'source-1', uvMm: [-3, 7] as [number, number] }] };
    expect(effectiveUv(layout, overridden, 'source-1')).toEqual([-3, 7]);
  });

  it('keeps every fitted optode on the scalp ellipsoid', () => {
    const points = fittedOptodePositions(layout, instance);
    for (const point of points.values()) {
      expect(ellipsoidEquation(point)).toBeCloseTo(1, 10);
    }
  });

  it('provides five landmarks and a dense 10-10 position set on the scalp', () => {
    expect(FIVE_POINT_LANDMARKS.map((point) => point.label)).toEqual(['Nz', 'Iz', 'LPA', 'RPA', 'Cz']);
    expect(TEN_TEN_POINTS.length).toBeGreaterThan(60);
    for (const point of [...FIVE_POINT_LANDMARKS, ...TEN_TEN_POINTS]) {
      expect(ellipsoidEquation(point.rasMm)).toBeCloseTo(1, 8);
    }
  });

  it('returns an English cortical region for MNI coordinates', () => {
    expect(corticalRegionFromRas([-42, 8, 62])).toBe('Left Precentral Gyrus');
    expect(corticalRegionProbabilities([-42, 8, 62])).toHaveLength(3);
    expect(deepStructureProbabilities([-20, -8, 5])).toHaveLength(3);
  });

  it('reports overlapping layout instances', () => {
    const duplicate = { ...instance, id: 'instance-2' };
    expect(findLayoutOverlaps([layout], [instance, duplicate])).toEqual([
      expect.objectContaining({ a: 'instance-1', b: 'instance-2', minimumDistanceMm: 0 }),
    ]);
  });
});
