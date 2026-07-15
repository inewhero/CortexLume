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

export interface RegionProbability { label: string; probability: number }

interface RegionCentroid { label: string; center: Vec3; spread: Vec3 }

const CORTICAL_CENTROIDS: RegionCentroid[] = [
  { label: 'Frontal Pole', center: [30, 62, 24], spread: [26, 25, 28] },
  { label: 'Superior Frontal Gyrus', center: [24, 32, 58], spread: [24, 28, 25] },
  { label: 'Middle Frontal Gyrus', center: [42, 34, 32], spread: [23, 27, 26] },
  { label: 'Precentral Gyrus', center: [42, 2, 48], spread: [18, 20, 30] },
  { label: 'Postcentral Gyrus', center: [44, -20, 50], spread: [18, 20, 30] },
  { label: 'Superior Parietal Lobule', center: [30, -48, 58], spread: [24, 26, 25] },
  { label: 'Supramarginal Gyrus', center: [52, -38, 32], spread: [20, 24, 25] },
  { label: 'Superior Temporal Gyrus', center: [56, -12, 6], spread: [18, 36, 22] },
  { label: 'Middle Temporal Gyrus', center: [58, -38, -4], spread: [18, 34, 22] },
  { label: 'Lateral Occipital Cortex', center: [38, -78, 24], spread: [28, 26, 32] },
];

const DEEP_CENTROIDS: RegionCentroid[] = [
  { label: 'Thalamus', center: [12, -18, 8], spread: [11, 13, 11] },
  { label: 'Caudate', center: [13, 10, 12], spread: [9, 15, 13] },
  { label: 'Putamen', center: [25, 2, 1], spread: [10, 14, 11] },
  { label: 'Globus Pallidus', center: [21, -4, 0], spread: [8, 10, 9] },
  { label: 'Hippocampus', center: [27, -27, -12], spread: [12, 20, 10] },
  { label: 'Amygdala', center: [24, -4, -18], spread: [10, 11, 9] },
  { label: 'Insular Cortex', center: [38, -3, 5], spread: [9, 24, 20] },
];

function probabilities(point: Vec3, regions: RegionCentroid[]): RegionProbability[] {
  const scored = regions.flatMap((region) => {
    const sides: Array<'Left' | 'Right'> = Math.abs(region.center[0]) < 1 ? ['Right'] : ['Left', 'Right'];
    return sides.map((side) => {
      const centerX = side === 'Left' ? -Math.abs(region.center[0]) : Math.abs(region.center[0]);
      const squared = ((point[0] - centerX) / region.spread[0]) ** 2
        + ((point[1] - region.center[1]) / region.spread[1]) ** 2
        + ((point[2] - region.center[2]) / region.spread[2]) ** 2;
      return { label: `${side} ${region.label}`, score: Math.exp(-0.5 * squared) };
    });
  });
  const total = scored.reduce((sum, item) => sum + item.score, 0) || 1;
  return scored.map((item) => ({ label: item.label, probability: item.score / total }))
    .sort((a, b) => b.probability - a.probability).slice(0, 3);
}

export const corticalRegionProbabilities = (point: Vec3) => probabilities(point, CORTICAL_CENTROIDS);
export const deepStructureProbabilities = (point: Vec3) => probabilities(point, DEEP_CENTROIDS);
export const corticalRegionFromRas = (point: Vec3) => corticalRegionProbabilities(point)[0]?.label ?? '—';
export const deepRegionFromRas = (point: Vec3) => deepStructureProbabilities(point)[0]?.label ?? '—';

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
