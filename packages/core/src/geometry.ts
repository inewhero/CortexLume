import type { LayoutDefinition, LayoutInstance, Vec2, Vec3 } from '@cortexlume/contracts';

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

export function distance3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function radialTangentBasis(anchor: Vec3, rotationRad: number): { u: Vec3; v: Vec3; normal: Vec3 } {
  const normal = normalize3(anchor);
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

/**
 * Build a surface seed from local patch coordinates without flattening a
 * large array into one tangent plane. The U axis follows a great-circle arc
 * from the anchor and V is parallel-transported before its own arc step.
 * Projecting this seed onto the locked scalp mesh preserves physical pitch
 * far better than a single nearest-point projection of anchor + U + V.
 */
export function arcSurfaceSeed(
  anchor: Vec3,
  center: Vec3,
  basis: Pick<ReturnType<typeof radialTangentBasis>, 'u' | 'v'>,
  uvMm: readonly [number, number],
): Vec3 {
  const radialVector = add3(anchor, scale3(center, -1));
  const radius = Math.hypot(...radialVector);
  if (!Number.isFinite(radius) || radius < 1) return anchor;
  const radial = scale3(radialVector, 1 / radius);
  const tangentU = normalize3(add3(basis.u, scale3(radial, -dot3(basis.u, radial))));
  const vWithoutRadial = add3(basis.v, scale3(radial, -dot3(basis.v, radial)));
  let tangentV = normalize3(add3(vWithoutRadial, scale3(tangentU, -dot3(vWithoutRadial, tangentU))));
  if (dot3(tangentV, basis.v) < 0) tangentV = scale3(tangentV, -1);

  const uAngle = uvMm[0] / radius;
  const afterU = add3(
    scale3(radial, Math.cos(uAngle)),
    scale3(tangentU, Math.sin(uAngle)),
  );
  const vAngle = uvMm[1] / radius;
  const afterUv = normalize3(add3(
    scale3(afterU, Math.cos(vAngle)),
    scale3(tangentV, Math.sin(vAngle)),
  ));
  return add3(center, scale3(afterUv, radius));
}

export function effectiveUv(layout: LayoutDefinition, instance: LayoutInstance, optodeId: string): Vec2 {
  return instance.overrides.find((override) => override.optodeId === optodeId)?.uvMm
    ?? layout.optodes.find((optode) => optode.id === optodeId)?.uvMm
    ?? [0, 0];
}

export function channelSensitivityPath(
  head: Pick<import('./headModel.js').HeadModel, 'projectCorticalContact' | 'projectScalpSphereCenter'>,
  sourceScalpPoint: Vec3,
  detectorScalpPoint: Vec3,
  optodeRadiusMm = 3.6,
  transmissionDepthMm = 25,
  sampleCount = 33,
  projectionCache?: Map<Vec3, { corticalContact: Vec3; sphereCenter: Vec3 }>,
): { points: Vec3[]; corticalContact: Vec3; target: Vec3 } {
  const project = (point: Vec3) => {
    const cached = projectionCache?.get(point);
    if (cached) return cached;
    const projected = {
      corticalContact: head.projectCorticalContact(point),
      sphereCenter: head.projectScalpSphereCenter(point, optodeRadiusMm),
    };
    projectionCache?.set(point, projected);
    return projected;
  };
  const sourceProjection = project(sourceScalpPoint);
  const detectorProjection = project(detectorScalpPoint);
  const source = sourceProjection.corticalContact;
  const detector = detectorProjection.corticalContact;
  const sourceCenter = sourceProjection.sphereCenter;
  const detectorCenter = detectorProjection.sphereCenter;
  const scalpMidpoint: Vec3 = [
    (sourceCenter[0] + detectorCenter[0]) / 2,
    (sourceCenter[1] + detectorCenter[1]) / 2,
    (sourceCenter[2] + detectorCenter[2]) / 2,
  ];
  const surfaceMidpoint = head.projectCorticalContact(scalpMidpoint);
  const inward = normalize3(scale3(scalpMidpoint, -1));
  const target = add3(scalpMidpoint, scale3(inward, Math.max(distance3(scalpMidpoint, surfaceMidpoint), transmissionDepthMm)));
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
  return { points, corticalContact: surfaceMidpoint, target };
}
