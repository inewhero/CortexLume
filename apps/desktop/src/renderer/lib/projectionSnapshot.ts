import type {
  AtlasLabel,
  CortexLumeProject,
  LayoutInstance,
  ProjectionResult,
  Vec3,
} from '@cortexlume/contracts';
import {
  corticalRegionProbabilities,
  distance3,
  fittedOptodePositions,
  projectScalpSphereCenter,
  projectToCorticalSurface,
} from './geometry';

function midpoint(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

function atlasLabels(
  atlasId: string,
  values: Array<{ label: string; probability: number }>,
): AtlasLabel[] {
  return values.map((value) => ({
    atlasId,
    labelEn: value.label,
    probability: value.probability,
  }));
}

function baseQcFlags(project: CortexLumeProject): string[] {
  return project.template.verified ? [] : ['template_unverified'];
}

function fitQc(
  project: CortexLumeProject,
  realizedScalpDistances: number[],
  nominalDistances: number[],
): LayoutInstance['fitQc'] {
  const errors = realizedScalpDistances.map((value, index) =>
    Math.abs(value - (nominalDistances[index] ?? value)));
  const mean = errors.length > 0
    ? errors.reduce((total, value) => total + value, 0) / errors.length
    : 0;
  const maximum = errors.length > 0 ? Math.max(...errors) : 0;
  const flags = baseQcFlags(project);
  if (mean > 2) flags.push('mean_distance_distortion_gt_2mm');
  if (maximum > 5) flags.push('max_distance_distortion_gt_5mm');
  return {
    converged: true,
    iterations: 1,
    meanAbsoluteErrorMm: mean,
    maxAbsoluteErrorMm: maximum,
    flags,
  };
}

export function materializeProjectionSnapshot(project: CortexLumeProject): CortexLumeProject {
  const radiusMm = project.projectionSettings.optodeRadiusMm ?? 3.6;
  const projections: ProjectionResult[] = [];
  const instances = project.instances.map((instance) => {
    const layout = project.layouts.find((candidate) => candidate.id === instance.definitionId);
    if (!layout) return instance;

    const contacts = fittedOptodePositions(layout, instance);
    const scalpCenters = new Map<string, Vec3>();
    const cortexCenters = new Map<string, Vec3>();
    const commonFlags = baseQcFlags(project);

    for (const optode of layout.optodes) {
      const contact = contacts.get(optode.id);
      if (!contact) continue;
      const scalp = projectScalpSphereCenter(contact, radiusMm);
      const cortex = projectToCorticalSurface(contact, radiusMm);
      scalpCenters.set(optode.id, scalp);
      cortexCenters.set(optode.id, cortex);
      projections.push({
        instanceId: instance.id,
        subjectKind: 'optode',
        subjectId: optode.id,
        scalpRasMm: scalp,
        corticalRasMm: cortex,
        depthTargetRasMm: null,
        underlyingCorticalRegions: atlasLabels(
          'CortexLume-Cortical-Estimate',
          corticalRegionProbabilities(cortex),
        ),
        deepTargetStructures: [],
        tissueAtTarget: 'cortical gray matter',
        claimLevel: 'geometric',
        status: 'provisional',
        qcFlags: commonFlags,
      });
    }

    const realizedScalpDistances: number[] = [];
    const nominalDistances: number[] = [];
    for (const pair of layout.pairs) {
      const sourceScalp = scalpCenters.get(pair.sourceId);
      const detectorScalp = scalpCenters.get(pair.detectorId);
      const sourceCortex = cortexCenters.get(pair.sourceId);
      const detectorCortex = cortexCenters.get(pair.detectorId);
      if (!sourceScalp || !detectorScalp || !sourceCortex || !detectorCortex) {
        projections.push({
          instanceId: instance.id,
          subjectKind: 'pair',
          subjectId: pair.id,
          scalpRasMm: null,
          corticalRasMm: null,
          depthTargetRasMm: null,
          underlyingCorticalRegions: [],
          deepTargetStructures: [],
          tissueAtTarget: null,
          claimLevel: 'geometric',
          status: 'blocked',
          qcFlags: [...commonFlags, 'missing_pair_optode'],
        });
        continue;
      }

      const realizedScalp = distance3(sourceScalp, detectorScalp);
      const spacingError = Math.abs(realizedScalp - pair.nominalDistanceMm);
      const flags = [...commonFlags];
      if (spacingError > 5) flags.push('distance_distortion_gt_5mm');
      else if (spacingError > 2) flags.push('distance_distortion_gt_2mm');

      const scalp = midpoint(sourceScalp, detectorScalp);
      const cortex = projectToCorticalSurface(scalp, radiusMm);
      realizedScalpDistances.push(realizedScalp);
      nominalDistances.push(pair.nominalDistanceMm);
      projections.push({
        instanceId: instance.id,
        subjectKind: 'pair',
        subjectId: pair.id,
        scalpRasMm: scalp,
        corticalRasMm: cortex,
        depthTargetRasMm: null,
        underlyingCorticalRegions: atlasLabels(
          'CortexLume-Cortical-Estimate',
          corticalRegionProbabilities(cortex),
        ),
        deepTargetStructures: [],
        tissueAtTarget: 'cortical gray matter',
        claimLevel: 'geometric',
        status: 'provisional',
        qcFlags: flags,
      });
    }

    return {
      ...instance,
      fitQc: fitQc(project, realizedScalpDistances, nominalDistances),
    };
  });

  return {
    ...project,
    instances,
    verifiedResults: projections,
  };
}
