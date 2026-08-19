import type { AtlasLabel, CortexLumeProject } from '@cortexlume/contracts';

export interface PointAtlasAnnotation {
  corticalRegions: AtlasLabel[];
  deepStructures: AtlasLabel[];
}

export interface PathAtlasAnnotation {
  corticalRegions: AtlasLabel[];
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
