import type { LayoutDefinition, LayoutInstance, Vec2, Vec3 } from '@cortexlume/contracts';
import * as THREE from 'three';

export const SCALP_RADII: Vec3 = [86, 105, 100];
export const CORTEX_RADII: Vec3 = [72, 88, 82];

let scalpSurfaceProjector: ((point: Vec3) => Vec3) | null = null;
let scalpSphereCenterProjector: ((point: Vec3, radiusMm: number) => Vec3) | null = null;
let corticalSurfaceProjector: ((point: Vec3, radiusMm: number) => Vec3) | null = null;

export function registerSurfaceProjectors(projectors: {
  scalp(point: Vec3): Vec3;
  scalpSphereCenter(point: Vec3, radiusMm: number): Vec3;
  cortex(point: Vec3, radiusMm: number): Vec3;
}): void {
  scalpSurfaceProjector = projectors.scalp;
  scalpSphereCenterProjector = projectors.scalpSphereCenter;
  corticalSurfaceProjector = projectors.cortex;
}

export function projectToScalpSurface(point: Vec3): Vec3 {
  return scalpSurfaceProjector?.(point) ?? projectToEllipsoid(point);
}

export function projectScalpSphereCenter(scalpPoint: Vec3, radiusMm = 0): Vec3 {
  const contact = projectToScalpSurface(scalpPoint);
  if (radiusMm <= 0) return contact;
  return scalpSphereCenterProjector?.(contact, radiusMm)
    ?? add3(contact, scale3(ellipsoidNormal(contact), radiusMm));
}

export function projectToCorticalSurface(scalpPoint: Vec3, radiusMm = 0): Vec3 {
  if (corticalSurfaceProjector) return corticalSurfaceProjector(scalpPoint, Math.max(0, radiusMm));
  const contact = cortexProjection(scalpPoint);
  return radiusMm > 0 ? add3(contact, scale3(normalize3(scalpPoint), radiusMm)) : contact;
}

/**
 * MNI point where the inward projection first reaches the cortical surface.
 *
 * This is deliberately distinct from the sphere centre used to render an
 * optode in cortex mode. The latter remains outside gray matter by one optode
 * radius and therefore must never be used for probability-volume lookup.
 */
export function projectToCorticalContact(scalpPoint: Vec3): Vec3 {
  return projectToCorticalSurface(scalpPoint, 0);
}

export function channelSensitivityPath(
  sourceScalpPoint: Vec3,
  detectorScalpPoint: Vec3,
  optodeRadiusMm = 3.6,
  transmissionDepthMm = 25,
  sampleCount = 33,
): { points: Vec3[]; target: Vec3 } {
  const source = projectToCorticalContact(sourceScalpPoint);
  const detector = projectToCorticalContact(detectorScalpPoint);
  const sourceCenter = projectScalpSphereCenter(sourceScalpPoint, optodeRadiusMm);
  const detectorCenter = projectScalpSphereCenter(detectorScalpPoint, optodeRadiusMm);
  const scalpMidpoint: Vec3 = [
    (sourceCenter[0] + detectorCenter[0]) / 2,
    (sourceCenter[1] + detectorCenter[1]) / 2,
    (sourceCenter[2] + detectorCenter[2]) / 2,
  ];
  const surfaceMidpoint = projectToCorticalContact(scalpMidpoint);
  const inward = normalize3(scale3(scalpMidpoint, -1));
  const firstGrayDistance = distance3(scalpMidpoint, surfaceMidpoint);
  const target = add3(scalpMidpoint, scale3(inward, Math.max(firstGrayDistance, transmissionDepthMm)));
  // Choose the control point so t=.5 is exactly the requested channel target.
  const control: Vec3 = [
    2 * target[0] - (source[0] + detector[0]) / 2,
    2 * target[1] - (source[1] + detector[1]) / 2,
    2 * target[2] - (source[2] + detector[2]) / 2,
  ];
  const count = Math.max(3, Math.min(129, Math.round(sampleCount)));
  const points = Array.from({ length: count }, (_, index): Vec3 => {
    const t = index / (count - 1);
    const a = (1 - t) ** 2;
    const b = 2 * (1 - t) * t;
    const c = t ** 2;
    return [
      a * source[0] + b * control[0] + c * detector[0],
      a * source[1] + b * control[1] + c * detector[1],
      a * source[2] + b * control[2] + c * detector[2],
    ];
  });
  return { points, target };
}

export function add3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function scale3(value: Vec3, factor: number): Vec3 {
  return [value[0] * factor, value[1] * factor, value[2] * factor];
}

export function normalize3(value: Vec3): Vec3 {
  const length = Math.hypot(...value);
  return length === 0 ? [0, 0, 1] : scale3(value, 1 / length);
}

export function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross3(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function projectToEllipsoid(point: Vec3, radii = SCALP_RADII): Vec3 {
  const denominator = Math.sqrt(
    (point[0] * point[0]) / (radii[0] * radii[0])
      + (point[1] * point[1]) / (radii[1] * radii[1])
      + (point[2] * point[2]) / (radii[2] * radii[2]),
  );
  if (denominator === 0) return [0, 0, radii[2]];
  return scale3(point, 1 / denominator);
}

export function ellipsoidNormal(point: Vec3, radii = SCALP_RADII): Vec3 {
  return normalize3([
    point[0] / (radii[0] * radii[0]),
    point[1] / (radii[1] * radii[1]),
    point[2] / (radii[2] * radii[2]),
  ]);
}

export function tangentBasis(anchor: Vec3, rotationRad: number): { u: Vec3; v: Vec3; normal: Vec3 } {
  const normal = ellipsoidNormal(anchor);
  const anterior: Vec3 = [0, 1, 0];
  const superior: Vec3 = [0, 0, 1];
  let v = normalize3(add3(anterior, scale3(normal, -dot3(anterior, normal))));
  if (Math.abs(dot3(v, normal)) > 0.99 || Math.hypot(...v) < 0.5) {
    v = normalize3(add3(superior, scale3(normal, -dot3(superior, normal))));
  }
  let u = normalize3(cross3(v, normal));
  const cosine = Math.cos(rotationRad);
  const sine = Math.sin(rotationRad);
  const rotatedU = add3(scale3(u, cosine), scale3(v, sine));
  const rotatedV = add3(scale3(v, cosine), scale3(u, -sine));
  u = normalize3(rotatedU);
  v = normalize3(rotatedV);
  return { u, v, normal };
}

export function effectiveUv(layout: LayoutDefinition, instance: LayoutInstance, optodeId: string): Vec2 {
  return instance.overrides.find((override) => override.optodeId === optodeId)?.uvMm
    ?? layout.optodes.find((optode) => optode.id === optodeId)?.uvMm
    ?? [0, 0];
}

export function fittedOptodePositions(
  layout: LayoutDefinition,
  instance: LayoutInstance,
): Map<string, Vec3> {
  const anchor = projectToScalpSurface(instance.anchorRasMm);
  const basis = tangentBasis(anchor, instance.rotationRad + (instance.mappingRotationRad ?? 0));
  return new Map(layout.optodes.map((optode) => {
    const uv = effectiveUv(layout, instance, optode.id);
    const tangentPoint = add3(anchor, add3(scale3(basis.u, uv[0]), scale3(basis.v, uv[1])));
    return [optode.id, projectToScalpSurface(tangentPoint)] as const;
  }));
}

export function cortexProjection(scalpRasMm: Vec3): Vec3 {
  const direction = normalize3(scalpRasMm);
  return projectToEllipsoid(direction, CORTEX_RADII);
}

export function inwardDepthTarget(corticalRasMm: Vec3, depthMm: number): Vec3 {
  return add3(corticalRasMm, scale3(normalize3(corticalRasMm), -depthMm));
}

export function distance3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export interface LayoutOverlap { a: string; b: string; minimumDistanceMm: number }

export function findLayoutOverlaps(
  layouts: LayoutDefinition[], instances: LayoutInstance[], thresholdMm = 12,
): LayoutOverlap[] {
  const positions = instances.map((instance) => {
    const layout = layouts.find((item) => item.id === instance.definitionId);
    return { instance, points: layout ? [...fittedOptodePositions(layout, instance).values()] : [] };
  });
  const overlaps: LayoutOverlap[] = [];
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = i + 1; j < positions.length; j += 1) {
      let minimum = Number.POSITIVE_INFINITY;
      for (const a of positions[i]!.points) for (const b of positions[j]!.points) minimum = Math.min(minimum, distance3(a, b));
      if (minimum < thresholdMm) overlaps.push({ a: positions[i]!.instance.id, b: positions[j]!.instance.id, minimumDistanceMm: minimum });
    }
  }
  return overlaps;
}

export function threeFromRas(point: Vec3): [number, number, number] {
  return [point[0], point[2], -point[1]];
}

export function rasFromThree(point: THREE.Vector3): Vec3 {
  return [point.x, -point.z, point.y];
}

export function localUvFromScalpPoint(anchor: Vec3, rotationRad: number, point: Vec3): Vec2 {
  const basis = tangentBasis(anchor, rotationRad);
  const delta: Vec3 = [point[0] - anchor[0], point[1] - anchor[1], point[2] - anchor[2]];
  return [dot3(delta, basis.u), dot3(delta, basis.v)];
}

export function formatRas(point: Vec3 | null | undefined): string {
  return point ? point.map((value) => value.toFixed(1)).join(', ') : '—';
}
