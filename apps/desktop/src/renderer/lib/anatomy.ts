import * as THREE from 'three';
import type { Vec3 } from '@cortexlume/contracts';
import { SCALP_RADII, projectToEllipsoid } from './geometry';

export interface ScalpReferencePoint {
  label: string;
  rasMm: Vec3;
  kind: 'landmark' | 'ten-ten';
}

export const FIVE_POINT_LANDMARKS: ScalpReferencePoint[] = [
  { label: 'Nz', rasMm: projectToEllipsoid([0, 105, -18]), kind: 'landmark' },
  { label: 'Iz', rasMm: projectToEllipsoid([0, -105, -12]), kind: 'landmark' },
  { label: 'LPA', rasMm: projectToEllipsoid([-86, 0, -7]), kind: 'landmark' },
  { label: 'RPA', rasMm: projectToEllipsoid([86, 0, -7]), kind: 'landmark' },
  { label: 'Cz', rasMm: [0, 0, SCALP_RADII[2]], kind: 'landmark' },
];

const ROWS: Array<{ y: number; labels: string[]; xs: number[] }> = [
  { y: 0.84, labels: ['Fp1', 'Fpz', 'Fp2'], xs: [-0.22, 0, 0.22] },
  { y: 0.68, labels: ['AF7', 'AF3', 'AFz', 'AF4', 'AF8'], xs: [-0.63, -0.31, 0, 0.31, 0.63] },
  { y: 0.48, labels: ['F9', 'F7', 'F5', 'F3', 'F1', 'Fz', 'F2', 'F4', 'F6', 'F8', 'F10'], xs: [-0.82, -0.68, -0.5, -0.33, -0.16, 0, 0.16, 0.33, 0.5, 0.68, 0.82] },
  { y: 0.25, labels: ['FT9', 'FT7', 'FC5', 'FC3', 'FC1', 'FCz', 'FC2', 'FC4', 'FC6', 'FT8', 'FT10'], xs: [-0.92, -0.76, -0.55, -0.35, -0.17, 0, 0.17, 0.35, 0.55, 0.76, 0.92] },
  { y: 0, labels: ['T9', 'T7', 'C5', 'C3', 'C1', 'Cz', 'C2', 'C4', 'C6', 'T8', 'T10'], xs: [-0.98, -0.82, -0.61, -0.4, -0.2, 0, 0.2, 0.4, 0.61, 0.82, 0.98] },
  { y: -0.25, labels: ['TP9', 'TP7', 'CP5', 'CP3', 'CP1', 'CPz', 'CP2', 'CP4', 'CP6', 'TP8', 'TP10'], xs: [-0.92, -0.76, -0.55, -0.35, -0.17, 0, 0.17, 0.35, 0.55, 0.76, 0.92] },
  { y: -0.48, labels: ['P9', 'P7', 'P5', 'P3', 'P1', 'Pz', 'P2', 'P4', 'P6', 'P8', 'P10'], xs: [-0.82, -0.68, -0.5, -0.33, -0.16, 0, 0.16, 0.33, 0.5, 0.68, 0.82] },
  { y: -0.68, labels: ['PO7', 'PO3', 'POz', 'PO4', 'PO8'], xs: [-0.63, -0.31, 0, 0.31, 0.63] },
  { y: -0.84, labels: ['O1', 'Oz', 'O2'], xs: [-0.22, 0, 0.22] },
];

function pointOnUpperScalp(xFraction: number, yFraction: number): Vec3 {
  const x = xFraction * SCALP_RADII[0];
  const y = yFraction * SCALP_RADII[1];
  const remaining = Math.max(0.025, 1 - xFraction ** 2 - yFraction ** 2);
  const z = Math.sqrt(remaining) * SCALP_RADII[2];
  return projectToEllipsoid([x, y, z]);
}

export const TEN_TEN_POINTS: ScalpReferencePoint[] = ROWS.flatMap((row) =>
  row.labels.map((label, index) => ({
    label,
    rasMm: pointOnUpperScalp(row.xs[index] ?? 0, row.y),
    kind: 'ten-ten' as const,
  })),
).filter((point) => point.label !== 'Cz');

export function scalpArc(start: Vec3, end: Vec3, segments = 48): Vec3[] {
  return Array.from({ length: segments + 1 }, (_, index) => {
    const t = index / segments;
    const blend: Vec3 = [
      start[0] * (1 - t) + end[0] * t,
      start[1] * (1 - t) + end[1] * t,
      start[2] * (1 - t) + end[2] * t,
    ];
    return projectToEllipsoid(blend);
  });
}

export function createLobulatedGeometry(seed: number, strength = 0.045): THREE.SphereGeometry {
  const geometry = new THREE.SphereGeometry(1, 96, 72);
  const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const longitude = Math.atan2(z, x);
    const latitude = Math.asin(Math.max(-1, Math.min(1, y)));
    const folds = (
      Math.sin(longitude * 9 + seed) * Math.cos(latitude * 7 - seed * 0.7)
      + Math.sin(longitude * 15 - seed * 1.3) * Math.sin(latitude * 11 + 0.6)
      + Math.cos((x + z) * 18 + seed * 2.1) * 0.45
    ) / 2.45;
    const factor = 1 + folds * strength;
    positions.setXYZ(index, x * factor, y * factor, z * factor);
  }
  geometry.computeVertexNormals();
  return geometry;
}
