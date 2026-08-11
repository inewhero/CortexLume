import type { DigitizerCalibration, DigitizerOptodeMapping, DigitizerPoint, DigitizerSession, OptodeType, Vec3 } from '@cortexlume/contracts';

export const FIVE_POINT_LABELS = ['Nz', 'Iz', 'LPA', 'RPA', 'Cz'] as const;
export type FivePointLabel = typeof FIVE_POINT_LABELS[number];

export interface SimilarityTransform {
  matrix: number[];
  scale: number;
}

export interface MappingTarget {
  instanceId: string;
  optodeId: string;
  label: string;
  type: OptodeType;
  rasMm: Vec3;
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const multiply = (a: Vec3, value: number): Vec3 => [a[0] * value, a[1] * value, a[2] * value];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3) => Math.sqrt(dot(a, a));
export const distanceBetween = (a: Vec3, b: Vec3) => norm(subtract(a, b));

function centroid(points: Vec3[]): Vec3 {
  return multiply(points.reduce(add, [0, 0, 0] as Vec3), 1 / points.length);
}

function quaternionRotation(source: Vec3[], target: Vec3[]): number[] {
  const s: [Vec3, Vec3, Vec3] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < source.length; i += 1) {
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) s[row]![column] = s[row]![column]! + source[i]![row]! * target[i]![column]!;
    }
  }
  const sxx = s[0][0]; const sxy = s[0][1]; const sxz = s[0][2];
  const syx = s[1][0]; const syy = s[1][1]; const syz = s[1][2];
  const szx = s[2][0]; const szy = s[2][1]; const szz = s[2][2];
  const trace = sxx + syy + szz;
  const n = [
    [trace, syz - szy, szx - sxz, sxy - syx],
    [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
    [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
    [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz],
  ];
  const shift = Math.max(...n.map((row) => row.reduce((sum, value) => sum + Math.abs(value), 0))) + 1;
  let q = [1, 0, 0, 0];
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const next = n.map((row, index) => row.reduce((sum, value, column) => sum + value * q[column]!, shift * q[index]!));
    const length = Math.hypot(...next);
    q = next.map((value) => value / length);
  }
  const w = q[0]!; const x = q[1]!; const y = q[2]!; const z = q[3]!;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

function rotate(rotation: number[], point: Vec3): Vec3 {
  return [
    rotation[0]! * point[0] + rotation[1]! * point[1] + rotation[2]! * point[2],
    rotation[3]! * point[0] + rotation[4]! * point[1] + rotation[5]! * point[2],
    rotation[6]! * point[0] + rotation[7]! * point[1] + rotation[8]! * point[2],
  ];
}

export function fitSimilarityTransform(source: Vec3[], target: Vec3[]): SimilarityTransform {
  if (source.length !== target.length || source.length < 3) throw new Error('At least three corresponding points are required.');
  const sourceCenter = centroid(source);
  const targetCenter = centroid(target);
  const centeredSource = source.map((point) => subtract(point, sourceCenter));
  const centeredTarget = target.map((point) => subtract(point, targetCenter));
  const rotation = quaternionRotation(centeredSource, centeredTarget);
  const denominator = centeredSource.reduce((sum, point) => sum + dot(point, point), 0);
  if (denominator < 1e-9) throw new Error('Digitizer landmarks do not span a valid 3D geometry.');
  const scale = centeredSource.reduce((sum, point, index) => sum + dot(centeredTarget[index]!, rotate(rotation, point)), 0) / denominator;
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('Five-point calibration produced an invalid scale. Check landmark correspondence and units.');
  const translation = subtract(targetCenter, multiply(rotate(rotation, sourceCenter), scale));
  return {
    scale,
    matrix: [
      scale * rotation[0]!, scale * rotation[1]!, scale * rotation[2]!, translation[0],
      scale * rotation[3]!, scale * rotation[4]!, scale * rotation[5]!, translation[1],
      scale * rotation[6]!, scale * rotation[7]!, scale * rotation[8]!, translation[2],
      0, 0, 0, 1,
    ],
  };
}

export function applySimilarityTransform(matrix: number[], point: Vec3): Vec3 {
  return [
    matrix[0]! * point[0] + matrix[1]! * point[1] + matrix[2]! * point[2] + matrix[3]!,
    matrix[4]! * point[0] + matrix[5]! * point[1] + matrix[6]! * point[2] + matrix[7]!,
    matrix[8]! * point[0] + matrix[9]! * point[1] + matrix[10]! * point[2] + matrix[11]!,
  ];
}

export function calibrateDigitizer(
  input: { name: string; source: DigitizerSession['source']; points: DigitizerPoint[] },
  assignments: Record<FivePointLabel, string>,
  targets: Record<FivePointLabel, Vec3>,
  sourceUnit: DigitizerCalibration['sourceUnit'],
): DigitizerSession {
  const unitScale = sourceUnit === 'm' ? 1000 : sourceUnit === 'cm' ? 10 : 1;
  const byId = new Map(input.points.map((point) => [point.id, point]));
  const measured = FIVE_POINT_LABELS.map((label) => {
    const point = byId.get(assignments[label]);
    if (!point) throw new Error(`Assign a digitized point to ${label}.`);
    return multiply(point.rawPosition, unitScale);
  });
  if (new Set(Object.values(assignments)).size !== FIVE_POINT_LABELS.length) throw new Error('Each calibration landmark must use a different digitized point.');
  const target = FIVE_POINT_LABELS.map((label) => targets[label]);
  const transform = fitSimilarityTransform(measured, target);
  const residuals = FIVE_POINT_LABELS.map((label, index) => {
    const measuredRasMm = applySimilarityTransform(transform.matrix, measured[index]!);
    return { label, measuredRasMm, targetRasMm: target[index]!, residualMm: norm(subtract(measuredRasMm, target[index]!)) };
  });
  const calibration: DigitizerCalibration = {
    method: 'five-point-similarity', sourceUnit, matrix: transform.matrix, scale: transform.scale,
    rmsResidualMm: Math.sqrt(residuals.reduce((sum, item) => sum + item.residualMm ** 2, 0) / residuals.length),
    maxResidualMm: Math.max(...residuals.map((item) => item.residualMm)), residuals,
    calibratedAt: new Date().toISOString(),
  };
  return {
    id: crypto.randomUUID(), name: input.name, importedAt: new Date().toISOString(), source: input.source,
    points: input.points,
    calibratedPoints: input.points.map((point) => ({
      pointId: point.id,
      rasMm: applySimilarityTransform(transform.matrix, multiply(point.rawPosition, unitScale)),
    })),
    calibration, optodeMappings: [], visible: true,
  };
}

function optimalAssignment(cost: number[][]): number[] {
  const size = cost.length;
  const u = Array(size + 1).fill(0) as number[];
  const v = Array(size + 1).fill(0) as number[];
  const p = Array(size + 1).fill(0) as number[];
  const way = Array(size + 1).fill(0) as number[];
  for (let i = 1; i <= size; i += 1) {
    p[0] = i;
    let column0 = 0;
    const minimum = Array(size + 1).fill(Number.POSITIVE_INFINITY) as number[];
    const used = Array(size + 1).fill(false) as boolean[];
    do {
      used[column0] = true;
      const row0 = p[column0]!;
      let delta = Number.POSITIVE_INFINITY;
      let column1 = 0;
      for (let column = 1; column <= size; column += 1) {
        if (used[column]) continue;
        const current = cost[row0 - 1]![column - 1]! - u[row0]! - v[column]!;
        if (current < minimum[column]!) { minimum[column] = current; way[column] = column0; }
        if (minimum[column]! < delta) { delta = minimum[column]!; column1 = column; }
      }
      for (let column = 0; column <= size; column += 1) {
        if (used[column]) { u[p[column]!]! += delta; v[column]! -= delta; } else minimum[column]! -= delta;
      }
      column0 = column1;
    } while (p[column0] !== 0);
    do {
      const column1 = way[column0]!;
      p[column0] = p[column1]!;
      column0 = column1;
    } while (column0 !== 0);
  }
  const assignment = Array(size).fill(-1) as number[];
  for (let column = 1; column <= size; column += 1) assignment[p[column]! - 1] = column - 1;
  return assignment;
}

export function nearestOptodeMappings(session: DigitizerSession, pointIds: string[], targets: MappingTarget[]): DigitizerOptodeMapping[] {
  if (pointIds.length !== targets.length) throw new Error(`Digitizer has ${pointIds.length} optode points, but the selected scope contains ${targets.length}.`);
  const positions = new Map(session.calibratedPoints.map((point) => [point.pointId, point.rasMm]));
  const points = pointIds.map((pointId) => ({ pointId, point: session.points.find((candidate) => candidate.id === pointId), rasMm: positions.get(pointId) })) ;
  if (points.some((point) => !point.point || !point.rasMm)) throw new Error('Digitizer optode coordinates are incomplete.');
  const cost = targets.map((target) => points.map((point) => {
    const geometric = norm(subtract(target.rasMm, point.rasMm!));
    const incompatible = point.point!.kind !== 'unknown' && point.point!.kind !== target.type;
    return geometric + (incompatible ? 100_000 : 0);
  }));
  const assignment = optimalAssignment(cost);
  return targets.map((target, targetIndex) => {
    const point = points[assignment[targetIndex]!]!;
    return { pointId: point.pointId, instanceId: target.instanceId, optodeId: target.optodeId, distanceMm: norm(subtract(target.rasMm, point.rasMm!)) };
  });
}

export function landmarkAlias(label: string): FivePointLabel | null {
  const normalized = label.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (['nz', 'nasion', 'fidnz'].includes(normalized)) return 'Nz';
  if (['iz', 'inion', 'fidiz'].includes(normalized)) return 'Iz';
  if (['lpa', 'leftpreauricular', 'leftauricular', 'fidt9'].includes(normalized)) return 'LPA';
  if (['rpa', 'rightpreauricular', 'rightauricular', 'fidt10'].includes(normalized)) return 'RPA';
  if (['cz', 'vertex'].includes(normalized)) return 'Cz';
  return null;
}
