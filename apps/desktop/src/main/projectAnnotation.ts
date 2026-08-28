import {
  AtlasLabelSchema,
  CROSS_PROCESS_LIMITS,
  CortexLumeProjectSchema,
  type AtlasLabel,
  type CortexLumeProject,
  type Vec3,
} from '@cortexlume/contracts';

export interface PointAtlasAnnotation {
  corticalRegions: AtlasLabel[];
  deepStructures: AtlasLabel[];
}

export interface PathAtlasAnnotation {
  corticalRegions: AtlasLabel[];
}

export interface ScienceRequestOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface ProjectAnnotationClient {
  request<T>(pathname: string, payload: unknown, options?: ScienceRequestOptions): Promise<T>;
}

export interface ProjectAnnotationRunOptions extends ScienceRequestOptions {
  /** Absolute deadline shared by point and path batches. */
  deadline?: number;
  onProgress?: (completed: number, total: number, phase: 'atlas-points' | 'atlas-paths') => void;
}

/** Give Electron a turn to deliver operations:cancel between atlas batches. */
function yieldAnnotationTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface AtlasBatchResponse {
  atlasVerified?: boolean;
  issue?: string | null;
  results?: Array<{
    id: string;
    corticalRegions?: unknown[];
    deepStructures?: unknown[];
  }>;
}

interface AtlasPathBatchResponse {
  atlasVerified?: boolean;
  issue?: string | null;
  results?: Array<{ id: string; regions?: unknown[] }>;
}

function finiteVec3(value: Vec3 | null | undefined): Vec3 | null {
  return value && value.length === 3 && value.every(Number.isFinite) ? value : null;
}

export function chunkAtMost<T>(values: readonly T[], maximum: number): T[][] {
  if (!Number.isInteger(maximum) || maximum < 1) throw new Error('Chunk size must be a positive integer');
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += maximum) {
    chunks.push(values.slice(index, index + maximum));
  }
  return chunks;
}

function checkRunBudget(options: ProjectAnnotationRunOptions): void {
  if (options.signal?.aborted) throw new Error('Project annotation cancelled');
  if (options.deadline != null && Date.now() >= options.deadline) {
    throw new Error('Project annotation exceeded its overall time budget');
  }
}

function requestTimeout(options: ProjectAnnotationRunOptions): number | undefined {
  if (options.deadline == null) return options.timeoutMs;
  const remaining = options.deadline - Date.now();
  if (remaining <= 0) throw new Error('Project annotation exceeded its overall time budget');
  return options.timeoutMs == null ? remaining : Math.min(options.timeoutMs, remaining);
}

export function quadraticPathThroughTarget(source: Vec3, target: Vec3, detector: Vec3, count = 33): Vec3[] {
  const control: Vec3 = [
    2 * target[0] - (source[0] + detector[0]) / 2,
    2 * target[1] - (source[1] + detector[1]) / 2,
    2 * target[2] - (source[2] + detector[2]) / 2,
  ];
  return Array.from({ length: count }, (_, index): Vec3 => {
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
}

/**
 * Annotate all project results using bounded point and path batches.  The
 * callback is deliberately request-shaped so this helper can be exercised
 * without Electron or a running sidecar.
 */
export async function annotateProjectAtlas(
  project: CortexLumeProject,
  client: ProjectAnnotationClient,
  options: ProjectAnnotationRunOptions = {},
): Promise<CortexLumeProject> {
  const resultsBySubject = new Map(project.verifiedResults.map((result) => [
    `${result.instanceId ?? ''}:${result.subjectKind}:${result.subjectId}`, result,
  ]));
  const instancesById = new Map(project.instances.map((instance) => [instance.id, instance]));
  const layoutsById = new Map(project.layouts.map((layout) => [layout.id, layout]));
  // Do not spend a sidecar point slot on blocked/missing projection results.
  // A result is eligible when at least one independent atlas coordinate is
  // present; the sidecar accepts the other coordinate as null and returns an
  // empty list for that modality.  Keeping the original result index lets us
  // merge sparse responses without changing project ordering.
  const pointItems = project.verifiedResults.flatMap((result, index) => {
    const corticalRasMm = finiteVec3(result.corticalRasMm);
    const deepTargetRasMm = finiteVec3(result.depthTargetRasMm);
    return corticalRasMm || deepTargetRasMm
      ? [{ result, index, corticalRasMm, deepTargetRasMm }]
      : [];
  });
  const pointChunks = chunkAtMost(
    pointItems,
    CROSS_PROCESS_LIMITS.atlasBatchPoints,
  );
  const pathItems = project.verifiedResults.flatMap((result, index) => {
    const pairCortical = finiteVec3(result.corticalRasMm);
    if (result.subjectKind !== 'pair' || !result.instanceId || !pairCortical) return [];
    const instance = instancesById.get(result.instanceId);
    const layout = instance ? layoutsById.get(instance.definitionId) : undefined;
    const pair = layout?.pairs.find((candidate) => candidate.id === result.subjectId);
    if (!pair) return [];
    const source = finiteVec3(resultsBySubject.get(`${result.instanceId}:optode:${pair.sourceId}`)?.corticalRasMm);
    const detector = finiteVec3(resultsBySubject.get(`${result.instanceId}:optode:${pair.detectorId}`)?.corticalRasMm);
    if (!source || !detector) return [];
    return [{
      id: String(index),
      points: quadraticPathThroughTarget(
        source,
        finiteVec3(result.depthTargetRasMm) ?? pairCortical,
        detector,
      ),
    }];
  });
  const pathChunks = chunkAtMost(pathItems, CROSS_PROCESS_LIMITS.atlasPathBatchItems);
  const total = pointItems.length + pathItems.length;
  let completed = 0;
  options.onProgress?.(completed, total, 'atlas-points');

  const pointAnnotations = new Map<number, PointAtlasAnnotation>();
  let atlasVerified = true;
  let atlasIssue: string | null = null;
  for (const chunk of pointChunks) {
    await yieldAnnotationTurn();
    checkRunBudget(options);
    const response = await client.request<AtlasBatchResponse>('/v1/atlas/query-batch', {
      points: chunk.map(({ result, index }) => ({
        id: String(index),
        corticalRasMm: finiteVec3(result.corticalRasMm),
        deepTargetRasMm: finiteVec3(result.depthTargetRasMm),
      })),
      probabilityThreshold: project.projectionSettings.atlasProbabilityThreshold,
    }, { signal: options.signal, timeoutMs: requestTimeout(options) });
    atlasVerified = atlasVerified && response.atlasVerified !== false;
    atlasIssue ??= response.issue ?? null;
    const requestedIds = new Set(chunk.map(({ index }) => String(index)));
    const uniqueResults = new Map<string, NonNullable<AtlasBatchResponse['results']>[number] | null>();
    for (const result of response.results ?? []) {
      if (!result || typeof result !== 'object' || typeof result.id !== 'string') continue;
      if (!requestedIds.has(result.id)) continue;
      uniqueResults.set(result.id, uniqueResults.has(result.id) ? null : result);
    }
    for (const [id, result] of uniqueResults) {
      // A duplicate response is ambiguous and therefore contributes no
      // annotation. This also prevents a later duplicate from overwriting a
      // previously validated result with attacker-controlled labels.
      if (!result) continue;
      const index = Number(id);
      if (!Number.isInteger(index)) continue;
      pointAnnotations.set(index, {
        corticalRegions: AtlasLabelSchema.array().parse(result.corticalRegions ?? []),
        deepStructures: AtlasLabelSchema.array().parse(result.deepStructures ?? []),
      });
    }
    checkRunBudget(options);
    completed += chunk.length;
    options.onProgress?.(completed, total, 'atlas-points');
  }

  const pathAnnotations: Array<PathAtlasAnnotation | null> = project.verifiedResults.map(() => null);
  for (const chunk of pathChunks) {
    await yieldAnnotationTurn();
    checkRunBudget(options);
    const response = await client.request<AtlasPathBatchResponse>('/v1/atlas/query-path-batch', {
      items: chunk,
      probabilityThreshold: project.projectionSettings.atlasProbabilityThreshold,
    }, { signal: options.signal, timeoutMs: requestTimeout(options) });
    atlasVerified = atlasVerified && response.atlasVerified !== false;
    atlasIssue ??= response.issue ?? null;
    const requestedIds = new Set(chunk.map(({ id }) => id));
    const uniqueResults = new Map<string, NonNullable<AtlasPathBatchResponse['results']>[number] | null>();
    for (const item of response.results ?? []) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string') continue;
      if (!requestedIds.has(item.id)) continue;
      uniqueResults.set(item.id, uniqueResults.has(item.id) ? null : item);
    }
    for (const [id, item] of uniqueResults) {
      if (!item) continue;
      const index = Number(id);
      if (!Number.isInteger(index)) continue;
      pathAnnotations[index] = {
        corticalRegions: AtlasLabelSchema.array().parse(item.regions ?? []),
      };
    }
    checkRunBudget(options);
    completed += chunk.length;
    options.onProgress?.(completed, total, 'atlas-paths');
  }

  checkRunBudget(options);
  return CortexLumeProjectSchema.parse(mergeProjectAtlasAnnotations(
    project, pointAnnotations, pathAnnotations, atlasVerified, atlasIssue,
  ));
}

export function mergeProjectAtlasAnnotations(
  project: CortexLumeProject,
  pointAnnotations: ReadonlyMap<number, PointAtlasAnnotation>,
  pathAnnotations: ReadonlyArray<PathAtlasAnnotation | null>,
  atlasVerified: boolean,
  atlasIssue: string | null,
): CortexLumeProject {
  return {
    ...project,
    verifiedResults: project.verifiedResults.map((result, index) => {
      const point = pointAnnotations.get(index);
      const path = pathAnnotations[index];
      return {
        ...result,
        underlyingCorticalRegions: path?.corticalRegions ?? point?.corticalRegions ?? [],
        deepTargetStructures: point?.deepStructures ?? [],
        qcFlags: [
          ...result.qcFlags.filter((flag) => flag !== 'atlas_lookup_pending' && !flag.startsWith('atlas_unavailable')),
          ...(atlasVerified ? [] : [atlasIssue ?? 'atlas_unavailable']),
        ],
      };
    }),
  };
}
