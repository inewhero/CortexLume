import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayoutDefinition, LayoutInstance } from '@cortexlume/contracts';
import * as THREE from 'three';
import {
  SCALP_RADII,
  channelSensitivityPath,
  distance3,
  effectiveUv,
  findLayoutOverlaps,
  fittedOptodePositions,
  projectScalpSphereCenter,
  projectToCorticalContact,
  projectToCorticalSurface,
  projectToEllipsoid,
  rasFromThree,
  threeFromRas,
  clearSurfaceProjectors,
  getSurfaceModelStatus,
  subscribeSurfaceModelStatus,
} from './geometry';
import { registerVerifiedTestSurfaceProjectors } from './testSurfaceProjectors';
import { arcSurfaceSeed } from '@cortexlume/core';
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
      digitizerPositions: [],
      derivedFromInstanceId: null,
      digitizerSessionId: null,
    };

function ellipsoidEquation([x, y, z]: [number, number, number]): number {
  const [rx, ry, rz] = SCALP_RADII;
  return (x / rx) ** 2 + (y / ry) ** 2 + (z / rz) ** 2;
}

describe('geometric head mapping', () => {
  beforeEach(() => registerVerifiedTestSurfaceProjectors());

  it('fails scientific projection clearly until HeadModel projectors are registered', () => {
    clearSurfaceProjectors();
    expect(getSurfaceModelStatus()).toMatchObject({ ready: false, verified: false });
    expect(() => projectToCorticalContact([1, 2, 3])).toThrow(/HeadModel cortical surface projector is not registered/);
  });

  it('reports a registered verified surface-model path', () => {
    expect(getSurfaceModelStatus()).toMatchObject({
      ready: true,
      verified: true,
      source: 'verified test mesh projector double',
    });
  });

  it('publishes reactive loading and verified status transitions', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSurfaceModelStatus(listener);
    clearSurfaceProjectors();
    expect(getSurfaceModelStatus().state).toBe('loading');
    registerVerifiedTestSurfaceProjectors();
    expect(getSurfaceModelStatus().state).toBe('verified');
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
  it('round-trips RAS+ coordinates through the Three.js axis convention', () => {
    const ras: [number, number, number] = [-42.25, 18.5, 63.75];
    expect(rasFromThree(new THREE.Vector3(...threeFromRas(ras)))).toEqual(ras);
  });
  it('projects points onto the scalp ellipsoid', () => {
    const point = projectToEllipsoid([25, -40, 85]);
    expect(ellipsoidEquation(point)).toBeCloseTo(1, 10);
  });

  it('uses arc length instead of tangent-plane compression for long offsets', () => {
    const radius = 100;
    const anchor: [number, number, number] = [0, 0, radius];
    const basis = { u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number] };
    const a = arcSurfaceSeed(anchor, [0, 0, 0], basis, [-105, 0]);
    const b = arcSurfaceSeed(anchor, [0, 0, 0], basis, [-75, 0]);
    const angle = Math.acos((a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / radius ** 2);
    expect(angle * radius).toBeCloseTo(30, 8);
  });

  it('keeps an optode sphere outside the scalp and offsets cortical contact by its radius', () => {
    const scalp = projectToEllipsoid([25, -40, 85]);
    const sphereCenter = projectScalpSphereCenter(scalp, 4);
    const pointContact = projectToCorticalSurface(scalp, 0);
    expect(projectToCorticalContact(scalp)).toEqual(pointContact);
    const sphereContact = projectToCorticalSurface(scalp, 4);
    expect(Math.hypot(...sphereCenter)).toBeGreaterThan(Math.hypot(...scalp));
    expect(Math.hypot(...sphereContact)).toBeGreaterThan(Math.hypot(...pointContact));
  });

  it('builds a channel path whose midpoint is the requested transmission target', () => {
    const source = projectToEllipsoid([-20, 60, 75]);
    const detector = projectToEllipsoid([20, 60, 75]);
    const path = channelSensitivityPath(source, detector, 3.6, 55, 33);
    expect(path.points).toHaveLength(33);
    expect(path.points[16]).toEqual(path.target);
    expect(path.corticalContact).not.toEqual(path.target);
    expect(distance3(path.points[0]!, projectToCorticalContact(source))).toBeLessThan(1e-8);
    expect(distance3(path.points[32]!, projectToCorticalContact(detector))).toBeLessThan(1e-8);
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

  it('uses confirmed digitizer coordinates as the patch geometry', () => {
    const measured: [number, number, number] = [-61, 22, 73];
    const positions = fittedOptodePositions(layout, {
      ...instance,
      digitizerPositions: [{ optodeId: 'source-1', digitizerPointId: 'digitizer-1', scalpRasMm: measured }],
    });
    expect(positions.get('source-1')).toEqual(measured);
  });

  it('provides five landmarks and a dense 10-10 position set on the scalp', () => {
    expect(FIVE_POINT_LANDMARKS.map((point) => point.label)).toEqual(['Nz', 'Iz', 'LPA', 'RPA', 'Cz']);
    expect(TEN_TEN_POINTS.length).toBeGreaterThan(60);
    for (const point of [...FIVE_POINT_LANDMARKS, ...TEN_TEN_POINTS]) {
      expect(ellipsoidEquation(point.rasMm)).toBeCloseTo(1, 8);
    }
  });

  it('reports overlapping layout instances', () => {
    const duplicate = { ...instance, id: 'instance-2' };
    expect(findLayoutOverlaps([layout], [instance, duplicate])).toEqual([
      expect.objectContaining({ a: 'instance-1', b: 'instance-2', minimumDistanceMm: 0 }),
    ]);
  });
});
