import { createHash } from 'node:crypto';
import type {
  FunctionalTargetMap,
  LayoutDefinition,
  LayoutInstance,
  PlanningCandidateMetrics,
  PlanningCandidateSummary,
  Vec3,
} from '@cortexlume/contracts';
import { channelSensitivityPath, distance3 } from './geometry.js';
import { HeadModel } from './headModel.js';
import { createGridLayout, deterministicUuid, type GridPatchSpec } from './layout.js';

const SURFACE_DISTANCE_TOLERANCE_MM = 1.5;
const NOMINAL_COVERAGE_TIE_TOLERANCE = 0.005;
const MAX_SCALP_CORTEX_GAP_MM = 40;

export interface PlannerPatchSpec extends GridPatchSpec {
  shortChannelCount?: number;
}

export interface PlannerRequest {
  target: FunctionalTargetMap;
  patches?: PlannerPatchSpec[];
  longChannelRangeMm?: [number, number];
  optodeRadiusMm?: number;
  transmissionDepthMm?: number;
  kernelSigmaMm?: number;
  supportRadiusMm?: number;
  seed: string;
}

export interface PlannerCandidate {
  summary: PlanningCandidateSummary;
  layouts: LayoutDefinition[];
  instances: LayoutInstance[];
}

export interface PlannerResult {
  candidates: PlannerCandidate[];
  recommendedCandidateId: string;
}

export interface TargetSurfaceComponentSummary {
  vertexCount: number;
  massFraction: number;
  peakVertex: number;
}

function stableTargetSamples(target: FunctionalTargetMap, areas: Float32Array, maximum: number): Array<{ vertex: number; mass: number }> {
  const values = target.vertexIndices.map((vertex, index) => ({ vertex, mass: areas[vertex]! * target.values[index]! }));
  if (values.length <= maximum) return values;
  const totalMass = values.reduce((sum, sample) => sum + sample.mass, 0);
  if (!(totalMass > 0)) return values.slice(0, maximum);
  const result: Array<{ vertex: number; mass: number }> = [];
  const stride = totalMass / maximum;
  let cumulative = 0;
  let sampleIndex = 0;
  for (let index = 0; index < maximum; index += 1) {
    const threshold = (index + 0.5) * stride;
    while (sampleIndex < values.length - 1 && cumulative + values[sampleIndex]!.mass < threshold) {
      cumulative += values[sampleIndex]!.mass;
      sampleIndex += 1;
    }
    result.push({ vertex: values[sampleIndex]!.vertex, mass: stride });
  }
  return result;
}

function pointSegmentDistanceSquared(point: Vec3, start: Vec3, end: Vec3): number {
  const dx = end[0] - start[0]; const dy = end[1] - start[1]; const dz = end[2] - start[2];
  const length = dx * dx + dy * dy + dz * dz;
  const t = length <= 1e-12 ? 0 : Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy + (point[2] - start[2]) * dz) / length));
  return (point[0] - start[0] - t * dx) ** 2 + (point[1] - start[1] - t * dy) ** 2 + (point[2] - start[2] - t * dz) ** 2;
}

function candidatePaths(
  head: HeadModel,
  layouts: LayoutDefinition[],
  instances: LayoutInstance[],
  radius: number,
  depth: number,
  sampleCount = 33,
): Vec3[][] {
  return instances.flatMap((instance, index) => {
    const layout = layouts[index]!;
    const positions = head.fittedOptodePositions(layout, instance);
    return layout.pairs.flatMap((pair) => {
      const source = positions.get(pair.sourceId); const detector = positions.get(pair.detectorId);
      return source && detector ? [channelSensitivityPath(head, source, detector, radius, depth, sampleCount).points] : [];
    });
  });
}

function targetMassCoverage(head: HeadModel, target: FunctionalTargetMap, paths: Vec3[][], sigma: number, support: number, maximumVertices = Number.POSITIVE_INFINITY): number {
  const samples = stableTargetSamples(target, head.vertexAreasMm2, maximumVertices);
  let total = 0; let covered = 0;
  const supportSquared = support ** 2;
  for (const sample of samples) {
    const point = head.surfaceVerticesRasMm[sample.vertex]!;
    let minimum = Number.POSITIVE_INFINITY;
    for (const path of paths) for (let index = 0; index < path.length - 1; index += 1) {
      minimum = Math.min(minimum, pointSegmentDistanceSquared(point, path[index]!, path[index + 1]!));
      if (minimum <= 1e-8) break;
    }
    const weight = minimum <= supportSquared ? Math.exp(-0.5 * minimum / sigma ** 2) : 0;
    total += sample.mass; covered += sample.mass * weight;
  }
  return total > 0 ? covered / total : 0;
}

function surfaceCoverageWeights(head: HeadModel, paths: Vec3[][], sigma: number, support: number): Float32Array {
  const result = new Float32Array(head.surfaceVerticesRasMm.length);
  const supportSquared = support ** 2;
  for (let vertex = 0; vertex < head.surfaceVerticesRasMm.length; vertex += 1) {
    const point = head.surfaceVerticesRasMm[vertex]!;
    let minimum = Number.POSITIVE_INFINITY;
    for (const path of paths) for (let index = 0; index < path.length - 1; index += 1) {
      minimum = Math.min(minimum, pointSegmentDistanceSquared(point, path[index]!, path[index + 1]!));
      if (minimum <= 1e-8) break;
    }
    result[vertex] = minimum <= supportSquared ? Math.exp(-0.5 * minimum / sigma ** 2) : 0;
  }
  return result;
}

function targetSupportSpecificity(head: HeadModel, target: FunctionalTargetMap, coverageWeights: Float32Array): number {
  const support = new Uint8Array(head.surfaceVerticesRasMm.length);
  for (const vertex of target.vertexIndices) support[vertex] = 1;
  let totalCoverageMass = 0;
  let targetCoverageMass = 0;
  for (let vertex = 0; vertex < coverageWeights.length; vertex += 1) {
    const mass = head.vertexAreasMm2[vertex]! * coverageWeights[vertex]!;
    totalCoverageMass += mass;
    if (support[vertex]) targetCoverageMass += mass;
  }
  return totalCoverageMass > 0 ? targetCoverageMass / totalCoverageMass : 0;
}

export function summarizeTargetSurfaceComponents(head: HeadModel, target: FunctionalTargetMap): TargetSurfaceComponentSummary[] {
  const masses = new Float64Array(head.surfaceVerticesRasMm.length);
  let totalMass = 0;
  target.vertexIndices.forEach((vertex, index) => {
    const mass = head.vertexAreasMm2[vertex]! * target.values[index]!;
    masses[vertex] = mass;
    totalMass += mass;
  });
  return head.surfaceConnectedComponents(target.vertexIndices).map((vertices) => {
    let mass = 0;
    let peakVertex = vertices[0]!;
    for (const vertex of vertices) {
      mass += masses[vertex]!;
      if (masses[vertex]! > masses[peakVertex]!) peakVertex = vertex;
    }
    return { vertexCount: vertices.length, massFraction: totalMass > 0 ? mass / totalMass : 0, peakVertex };
  }).sort((left, right) => right.massFraction - left.massFraction || left.peakVertex - right.peakVertex);
}

function targetPeakAnchors(head: HeadModel, target: FunctionalTargetMap, count: number): Vec3[] {
  const massByVertex = new Float64Array(head.surfaceVerticesRasMm.length);
  target.vertexIndices.forEach((vertex, index) => {
    massByVertex[vertex] = target.values[index]! * head.vertexAreasMm2[vertex]!;
  });
  const ranked = target.vertexIndices.map((vertex, index) => ({ vertex, score: target.values[index]! * head.vertexAreasMm2[vertex]! }))
    .sort((a, b) => b.score - a.score || a.vertex - b.vertex);
  const selected: Vec3[] = [];
  const addScalpAnchor = (scalp: Vec3, minimumDistanceMm = 28) => {
    if (selected.every((existing) => distance3(existing, scalp) >= minimumDistanceMm)) selected.push(scalp);
  };
  const addAnchor = (point: Vec3, minimumDistanceMm = 28) => {
    addScalpAnchor(head.projectScalp(point), minimumDistanceMm);
  };
  const addWeightedCentroid = (vertices: readonly number[]) => {
    let total = 0;
    const centroid: Vec3 = [0, 0, 0];
    for (const vertex of vertices) {
      const mass = massByVertex[vertex]!;
      const point = head.surfaceVerticesRasMm[vertex]!;
      total += mass;
      centroid[0] += point[0] * mass;
      centroid[1] += point[1] * mass;
      centroid[2] += point[2] * mass;
    }
    if (total > 0) addAnchor([centroid[0] / total, centroid[1] / total, centroid[2] / total]);
  };

  // A broad or bilateral target is often best served from the mass centre between
  // its peaks. Peak-only sampling systematically placed a single patch on one
  // hemisphere even when the requested target was symmetric.
  let globalMass = 0;
  const globalCentroid: Vec3 = [0, 0, 0];
  for (const vertex of target.vertexIndices) {
    const mass = massByVertex[vertex]!;
    const point = head.surfaceVerticesRasMm[vertex]!;
    globalMass += mass;
    globalCentroid[0] += point[0] * mass;
    globalCentroid[1] += point[1] * mass;
    globalCentroid[2] += point[2] * mass;
  }
  if (globalMass > 0) {
    globalCentroid[0] /= globalMass;
    globalCentroid[1] /= globalMass;
    globalCentroid[2] /= globalMass;
    // A centroid close to the template origin indicates a widely distributed
    // target whose opposing lobes cancel. Projecting it to the nearest scalp is
    // arbitrary, so component centroids are the meaningful anchors instead.
    if (Math.hypot(...globalCentroid) >= 35) {
      const centre = head.projectScalp(globalCentroid);
      addScalpAnchor(centre);
      // Include a compact local stencil around the mass centre. At the lower
      // occipital boundary a 5-10 mm superior shift can turn a nominally good
      // placement into one that remains supported under digitizer error.
      for (const offset of [[0, 8], [0, -8], [8, 0], [-8, 0]] as const) {
        addScalpAnchor(head.projectScalpOffset(centre, 0, offset), 6);
      }
    }
  }
  const components = head.surfaceConnectedComponents(target.vertexIndices)
    .map((vertices) => ({
      vertices,
      mass: vertices.reduce((sum, vertex) => sum + massByVertex[vertex]!, 0),
    }))
    .sort((left, right) => right.mass - left.mass || left.vertices[0]! - right.vertices[0]!);
  for (const component of components.slice(0, 8)) {
    addWeightedCentroid(component.vertices);
    if (selected.length >= count) break;
  }
  for (const item of ranked) {
    addAnchor(head.surfaceVerticesRasMm[item.vertex]!, 35);
    if (selected.length >= count) break;
  }
  if (selected.length === 0) throw new Error('Functional target has no usable surface peak.');
  const origin = selected[0]!;
  for (const radius of [35, 50, 65, 80]) for (let step = 0; step < 12 && selected.length < count; step += 1) {
    const angle = step * Math.PI / 6;
    const candidate = head.projectScalpOffset(origin, 0, [Math.cos(angle) * radius, Math.sin(angle) * radius]);
    if (selected.every((existing) => distance3(existing, candidate) >= 28)) selected.push(candidate);
  }
  if (selected.length < 3) throw new Error(`Functional target provides only ${selected.length} distinct scalp anchors; at least 3 are required.`);
  return selected;
}

function makeInstance(namespace: string, layout: LayoutDefinition, anchorRasMm: Vec3, rotationRad: number): LayoutInstance {
  return {
    id: deterministicUuid(namespace, `instance:${layout.id}`), definitionId: layout.id,
    anchorRasMm, rotationRad, mappingRotationRad: 0, visible: true, locked: true,
    overrides: [], digitizerPositions: [], derivedFromInstanceId: null, digitizerSessionId: null,
  };
}

function bestRotation(head: HeadModel, target: FunctionalTargetMap, layout: LayoutDefinition, anchor: Vec3, namespace: string, radius: number, depth: number, sigma: number, support: number, range: [number, number]): number {
  const score = (degrees: number, maximumVertices: number) => {
    const instance = makeInstance(namespace, layout, anchor, degrees * Math.PI / 180);
    return {
      degrees,
      valid: instanceDistancesValid(head, layout, instance, range)
        && instanceCranialMetrics(head, layout, instance).fraction === 1,
      score: targetMassCoverage(head, target, candidatePaths(head, [layout], [instance], radius, depth, 11), sigma, support, maximumVertices),
    };
  };
  const ranked = (values: Array<{ degrees: number; valid: boolean; score: number }>) => values
    .sort((a, b) => Number(b.valid) - Number(a.valid) || b.score - a.score || a.degrees - b.degrees)[0]!;
  // Cranial support can change sharply near the inferior edge of a large patch.
  // A 30-degree coarse grid skipped the only valid posterior orientations for a
  // 5x3 visual patch, causing a correct midline anchor to be discarded.
  const coarse = ranked(Array.from({ length: 24 }, (_, index) => score(index * 15, 160)));
  return ranked(Array.from({ length: 15 }, (_, index) => score(coarse.degrees - 7 + index, 400))).degrees * Math.PI / 180;
}

function crossPatchClearance(
  head: HeadModel,
  layouts: LayoutDefinition[],
  instances: LayoutInstance[],
  nextLayout: LayoutDefinition,
  nextInstance: LayoutInstance,
): number {
  const nextPositions = [...head.fittedOptodePositions(nextLayout, nextInstance).values()];
  let minimum = Number.POSITIVE_INFINITY;
  instances.forEach((instance, index) => {
    for (const existing of head.fittedOptodePositions(layouts[index]!, instance).values()) {
      for (const next of nextPositions) minimum = Math.min(minimum, distance3(existing, next));
    }
  });
  return minimum;
}

function instanceDistancesValid(
  head: HeadModel,
  layout: LayoutDefinition,
  instance: LayoutInstance,
  range: [number, number],
): boolean {
  const positions = head.fittedOptodePositions(layout, instance);
  return layout.pairs.every((pair) => {
    if (pair.shortChannel) return true;
    const source = positions.get(pair.sourceId);
    const detector = positions.get(pair.detectorId);
    if (!source || !detector) return false;
    const actual = distance3(source, detector);
    return actual >= range[0] - SURFACE_DISTANCE_TOLERANCE_MM
      && actual <= range[1] + SURFACE_DISTANCE_TOLERANCE_MM;
  });
}

function instanceCranialMetrics(
  head: HeadModel,
  layout: LayoutDefinition,
  instance: LayoutInstance,
): { maximumGapMm: number; fraction: number } {
  const positions = [...head.fittedOptodePositions(layout, instance).values()];
  const gaps = positions.map((position) => head.scalpCortexDistanceMm(position));
  return {
    maximumGapMm: Math.max(...gaps),
    fraction: gaps.filter((gap) => gap <= MAX_SCALP_CORTEX_GAP_MM).length / Math.max(1, gaps.length),
  };
}

interface PlacementBeamState {
  instances: LayoutInstance[];
  usedAnchorIndices: number[];
  placementKeys: string[];
  distanceValid: boolean;
  approximateCoverage: number;
  minimumClearanceMm: number;
  signature: string;
  canonicalSignature: string;
}

function layoutGeometrySignature(layout: LayoutDefinition): string {
  const optodes = layout.optodes
    .map((optode) => `${optode.uvMm[0].toFixed(3)},${optode.uvMm[1].toFixed(3)}`)
    .sort()
    .join(';');
  const pairs = layout.pairs
    .map((pair) => `${pair.nominalDistanceMm.toFixed(3)}:${Number(pair.shortChannel)}`)
    .sort()
    .join(';');
  return `${optodes}/${pairs}`;
}

function placementBeam(
  head: HeadModel,
  request: Required<Omit<PlannerRequest, 'patches'>> & { patches: PlannerPatchSpec[] },
  layouts: LayoutDefinition[],
  anchors: Vec3[],
  namespace: string,
): PlacementBeamState[] {
  let beam: PlacementBeamState[] = [{
    instances: [], usedAnchorIndices: [], placementKeys: [], approximateCoverage: 0,
    distanceValid: true, minimumClearanceMm: Number.POSITIVE_INFINITY, signature: '', canonicalSignature: '',
  }];
  const beamWidth = Math.max(12, request.patches.length * 6);
  for (let patchIndex = 0; patchIndex < layouts.length; patchIndex += 1) {
    const layout = layouts[patchIndex]!;
    const geometrySignature = layoutGeometrySignature(layout);
    const choices = anchors.map((anchor, anchorIndex) => {
      const instance = makeInstance(
        `${namespace}:choice:${patchIndex}:${anchorIndex}`,
        layout,
        anchor,
        bestRotation(
          head, request.target, layout, anchor,
          `${namespace}:rotation:${patchIndex}:${anchorIndex}`,
          request.optodeRadiusMm, request.transmissionDepthMm,
          request.kernelSigmaMm, request.supportRadiusMm, request.longChannelRangeMm,
        ),
      );
      return {
        anchorIndex,
        instance,
        distanceValid: instanceDistancesValid(head, layout, instance, request.longChannelRangeMm),
        cranialValid: instanceCranialMetrics(head, layout, instance).fraction === 1,
      };
    }).filter((choice) => choice.distanceValid && choice.cranialValid);
    if (choices.length === 0) throw new Error(`Patch ${patchIndex + 1} has no placement fully supported by the cranial scalp.`);
    const expanded: PlacementBeamState[] = [];
    for (const state of beam) for (const choice of choices) {
      if (state.usedAnchorIndices.includes(choice.anchorIndex)) continue;
      const clearance = state.instances.length === 0
        ? Number.POSITIVE_INFINITY
        : crossPatchClearance(head, layouts, state.instances, layout, choice.instance);
      if (clearance < 12) continue;
      const instances = [...state.instances, choice.instance];
      const signature = `${state.signature}/${choice.anchorIndex}:${choice.instance.rotationRad.toFixed(9)}`;
      const placementKeys = [...state.placementKeys, `${geometrySignature}@${choice.anchorIndex}:${choice.instance.rotationRad.toFixed(9)}`];
      expanded.push({
        instances,
        usedAnchorIndices: [...state.usedAnchorIndices, choice.anchorIndex],
        placementKeys,
        distanceValid: state.distanceValid && choice.distanceValid,
        approximateCoverage: targetMassCoverage(
          head, request.target,
          candidatePaths(head, layouts.slice(0, instances.length), instances, request.optodeRadiusMm, request.transmissionDepthMm, 11),
          request.kernelSigmaMm, request.supportRadiusMm, 400,
        ),
        minimumClearanceMm: Math.min(state.minimumClearanceMm, clearance),
        signature,
        canonicalSignature: [...placementKeys].sort().join('|'),
      });
    }
    expanded.sort((a, b) => Number(b.distanceValid) - Number(a.distanceValid)
      || b.approximateCoverage - a.approximateCoverage
      || b.minimumClearanceMm - a.minimumClearanceMm
      || a.signature.localeCompare(b.signature));
    const unique = new Map<string, PlacementBeamState>();
    for (const state of expanded) if (!unique.has(state.canonicalSignature)) unique.set(state.canonicalSignature, state);
    beam = [...unique.values()].slice(0, beamWidth);
    if (beam.length === 0) throw new Error(`No non-overlapping placement remains after patch ${patchIndex + 1}.`);
  }
  return beam;
}

function diverseBeamStates(states: readonly PlacementBeamState[], count: number): PlacementBeamState[] {
  const selected: PlacementBeamState[] = [];
  for (const state of states) {
    const distinct = selected.every((existing) => state.instances.some((instance, index) => (
      distance3(instance.anchorRasMm, existing.instances[index]!.anchorRasMm) >= 40
    )));
    if (distinct) selected.push(state);
    if (selected.length >= count) return selected;
  }
  for (const state of states) {
    if (!selected.includes(state)) selected.push(state);
    if (selected.length >= count) break;
  }
  return selected;
}

function evaluateCandidate(head: HeadModel, request: Required<Omit<PlannerRequest, 'patches'>> & { patches: PlannerPatchSpec[] }, layouts: LayoutDefinition[], instances: LayoutInstance[]): { metrics: PlanningCandidateMetrics; rejectionReasons: string[] } {
  const rejectionReasons: string[] = [];
  const positions = instances.map((instance, index) => head.fittedOptodePositions(layouts[index]!, instance));
  const spacingDistortions: number[] = [];
  const cranialGaps = positions.flatMap((points) => [...points.values()].map((point) => head.scalpCortexDistanceMm(point)));
  const cranialOptodeFraction = cranialGaps.filter((gap) => gap <= MAX_SCALP_CORTEX_GAP_MM).length / Math.max(1, cranialGaps.length);
  const maximumScalpCortexGapMm = Math.max(...cranialGaps);
  if (cranialOptodeFraction < 1) rejectionReasons.push('optode_outside_cranial_support');
  layouts.forEach((layout, index) => layout.pairs.forEach((pair) => {
    const source = positions[index]!.get(pair.sourceId); const detector = positions[index]!.get(pair.detectorId);
    if (!source || !detector) { rejectionReasons.push('projection_failed'); return; }
    const actual = distance3(source, detector);
    spacingDistortions.push(Math.abs(actual - pair.nominalDistanceMm));
    if (!pair.shortChannel && (
      actual < request.longChannelRangeMm[0] - SURFACE_DISTANCE_TOLERANCE_MM
      || actual > request.longChannelRangeMm[1] + SURFACE_DISTANCE_TOLERANCE_MM
    )) rejectionReasons.push('channel_distance_out_of_range');
  }));
  let minimumClearance = Number.POSITIVE_INFINITY;
  for (let a = 0; a < positions.length; a += 1) for (let b = a; b < positions.length; b += 1) {
    const pointsA = [...positions[a]!.values()]; const pointsB = [...positions[b]!.values()];
    for (let i = 0; i < pointsA.length; i += 1) for (let j = b === a ? i + 1 : 0; j < pointsB.length; j += 1) {
      minimumClearance = Math.min(minimumClearance, distance3(pointsA[i]!, pointsB[j]!));
    }
  }
  for (let a = 0; a < positions.length; a += 1) for (let b = a + 1; b < positions.length; b += 1) {
    for (const pointA of positions[a]!.values()) for (const pointB of positions[b]!.values()) if (distance3(pointA, pointB) < 12) rejectionReasons.push('cross_patch_optode_overlap');
  }
  const paths = candidatePaths(head, layouts, instances, request.optodeRadiusMm, request.transmissionDepthMm);
  const nominal = targetMassCoverage(head, request.target, paths, request.kernelSigmaMm, request.supportRadiusMm);
  const coverageWeights = surfaceCoverageWeights(head, paths, request.kernelSigmaMm, request.supportRadiusMm);
  const specificity = targetSupportSpecificity(head, request.target, coverageWeights);
  const robust: number[] = [];
  let cranialRobustPasses = 0;
  let cranialRobustTrials = 0;
  for (let patchIndex = 0; patchIndex < instances.length; patchIndex += 1) {
    const base = instances[patchIndex]!;
    for (const [u, v] of [[0, 0], [5, 0], [-5, 0], [0, 5], [0, -5]] as const) for (const degrees of [-5, 0, 5]) {
      const perturbed = instances.map((instance, index) => index !== patchIndex ? instance : {
        ...instance,
        anchorRasMm: head.projectScalpOffset(instance.anchorRasMm, instance.rotationRad, [u, v]),
        rotationRad: instance.rotationRad + degrees * Math.PI / 180,
      });
      cranialRobustTrials += 1;
      if (instanceCranialMetrics(head, layouts[patchIndex]!, perturbed[patchIndex]!).fraction < 1) {
        robust.push(0);
        continue;
      }
      cranialRobustPasses += 1;
      robust.push(targetMassCoverage(
        head,
        request.target,
        candidatePaths(head, layouts, perturbed, request.optodeRadiusMm, request.transmissionDepthMm, 17),
        request.kernelSigmaMm,
        request.supportRadiusMm,
        1500,
      ));
    }
  }
  robust.sort((a, b) => a - b);
  const cranialRobustPassFraction = cranialRobustPasses / Math.max(1, cranialRobustTrials);
  const metrics: PlanningCandidateMetrics = {
    nominalTargetMassCoverage: nominal,
    robustP10TargetMassCoverage: robust[Math.floor((robust.length - 1) * 0.1)] ?? nominal,
    robustWorstTargetMassCoverage: robust[0] ?? nominal,
    minimumOptodeClearanceMm: Number.isFinite(minimumClearance) ? minimumClearance : 0,
    meanSpacingDistortionMm: spacingDistortions.reduce((sum, value) => sum + value, 0) / Math.max(1, spacingDistortions.length),
    targetSupportSpecificity: specificity,
    balancedTargetCoverage: nominal + specificity > 0 ? 2 * nominal * specificity / (nominal + specificity) : 0,
    maximumScalpCortexGapMm,
    cranialOptodeFraction,
    cranialRobustPassFraction,
  };
  return { metrics, rejectionReasons: [...new Set(rejectionReasons)].sort() };
}

export function planLayouts(head: HeadModel, input: PlannerRequest): PlannerResult {
  const request = {
    ...input,
    patches: input.patches?.length ? input.patches : [{}],
    longChannelRangeMm: input.longChannelRangeMm ?? [25, 40] as [number, number],
    optodeRadiusMm: input.optodeRadiusMm ?? 3.6,
    transmissionDepthMm: input.transmissionDepthMm ?? 25,
    kernelSigmaMm: input.kernelSigmaMm ?? 12,
    supportRadiusMm: input.supportRadiusMm ?? 24,
  };
  if (request.supportRadiusMm < request.kernelSigmaMm) throw new Error('Coverage support radius must be at least one sigma.');
  const namespace = createHash('sha256').update(`${request.seed}\0placement-beam`).digest('hex');
  const layouts = request.patches.map((spec, patchIndex) => createGridLayout(
    { ...spec, name: spec.name ?? `Agent patch ${patchIndex + 1}` },
    `${namespace}:patch:${patchIndex}`,
    '2000-01-01T00:00:00.000Z',
  ));
  const anchorCount = Math.max(20, Math.min(32, request.patches.length * 8 + 12));
  const peaks = targetPeakAnchors(head, request.target, anchorCount);
  const beam = placementBeam(head, request, layouts, peaks, namespace);
  const candidates: PlannerCandidate[] = [];
  for (const [candidateIndex, state] of diverseBeamStates(beam, 3).entries()) {
    const instances = state.instances.map((instance, patchIndex) => ({
      ...instance,
      id: deterministicUuid(`${namespace}:candidate:${candidateIndex}`, `instance:${patchIndex}:${state.canonicalSignature}`),
    }));
    const evaluation = evaluateCandidate(head, request, layouts, instances);
    const stableId = createHash('sha256').update(`${namespace}\0${state.canonicalSignature}`).digest('hex').slice(0, 20);
    candidates.push({
      layouts, instances,
      summary: {
        stableId, rank: 1, accepted: evaluation.rejectionReasons.length === 0,
        rejectionReasons: evaluation.rejectionReasons, metrics: evaluation.metrics,
        placements: instances.map((instance) => ({ layoutId: instance.definitionId, instanceId: instance.id, anchorRasMm: instance.anchorRasMm, rotationRad: instance.rotationRad })),
      },
    });
  }
  if (candidates.length !== 3) throw new Error('Planning did not produce three complete placement candidates.');
  candidates.sort((a, b) => {
    if (a.summary.accepted !== b.summary.accepted) return a.summary.accepted ? -1 : 1;
    const am = a.summary.metrics; const bm = b.summary.metrics;
    const nominalDifference = bm.nominalTargetMassCoverage - am.nominalTargetMassCoverage;
    return Math.abs(nominalDifference) > NOMINAL_COVERAGE_TIE_TOLERANCE ? nominalDifference
      : (bm.balancedTargetCoverage ?? 0) - (am.balancedTargetCoverage ?? 0)
      || (bm.cranialRobustPassFraction ?? 0) - (am.cranialRobustPassFraction ?? 0)
      || bm.robustP10TargetMassCoverage - am.robustP10TargetMassCoverage
      || bm.robustWorstTargetMassCoverage - am.robustWorstTargetMassCoverage
      || (am.maximumScalpCortexGapMm ?? Number.POSITIVE_INFINITY) - (bm.maximumScalpCortexGapMm ?? Number.POSITIVE_INFINITY)
      || bm.minimumOptodeClearanceMm - am.minimumOptodeClearanceMm
      || am.meanSpacingDistortionMm - bm.meanSpacingDistortionMm
      || a.summary.stableId.localeCompare(b.summary.stableId);
  });
  candidates.forEach((candidate, index) => { candidate.summary.rank = index + 1; });
  if (!candidates.some((candidate) => candidate.summary.accepted)) throw new Error(`No valid placement candidate: ${candidates.flatMap((candidate) => candidate.summary.rejectionReasons).join(', ')}`);
  return { candidates, recommendedCandidateId: candidates.find((candidate) => candidate.summary.accepted)!.summary.stableId };
}
