import type {
  CortexLumeProject,
  LayoutInstance,
  ProjectionResult,
  Vec3,
} from '@cortexlume/contracts';
import {
  channelSensitivityPath,
  distance3,
  fittedOptodePositions,
  projectScalpSphereCenter,
  projectToCorticalContact,
  projectToCorticalSurface,
  assertVerifiedSurfaceModel,
  getSurfaceModelStatus,
} from './geometry';

function midpoint(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

function baseQcFlags(project: CortexLumeProject): string[] {
  return project.template.verified ? [] : ['template_unverified'];
}

function fitQc(
  project: CortexLumeProject,
  realizedScalpDistances: number[],
  nominalDistances: number[],
): LayoutInstance['fitQc'] {
  const errors = realizedScalpDistances.flatMap((value, index) => {
    const nominal = nominalDistances[index];
    return Number.isFinite(value) && nominal != null && Number.isFinite(nominal)
      ? [Math.abs(value - nominal)]
      : [];
  });
  const mean = errors.length > 0
    ? errors.reduce((total, value) => total + value, 0) / errors.length
    : 0;
  const maximum = errors.length > 0 ? Math.max(...errors) : 0;
  const flags = baseQcFlags(project);
  if (errors.length === 0) flags.push('no_valid_distance_samples');
  if (mean > 2) flags.push('mean_distance_distortion_gt_2mm');
  if (maximum > 5) flags.push('max_distance_distortion_gt_5mm');
  return {
    converged: errors.length > 0,
    iterations: errors.length > 0 ? 1 : 0,
    meanAbsoluteErrorMm: mean,
    maxAbsoluteErrorMm: maximum,
    flags,
  };
}

export function materializeProjectionSnapshot(project: CortexLumeProject): CortexLumeProject {
  assertVerifiedSurfaceModel();
  const surfaceStatus = getSurfaceModelStatus();
  const radiusMm = project.projectionSettings.optodeRadiusMm ?? 3.6;
  const defaultDepthMm = project.projectionSettings.defaultDepthMm ?? 25;
  const projections: ProjectionResult[] = [];
  const superseded = new Set(project.instances.flatMap((instance) =>
    instance.derivedFromInstanceId ? [instance.derivedFromInstanceId] : []));
  const projectionStatus: ProjectionResult['status'] = project.template.verified && surfaceStatus.verified
    ? 'verified'
    : 'provisional';
  const instances = project.instances.map((instance) => {
    if (superseded.has(instance.id)) return instance;
    const layout = project.layouts.find((candidate) => candidate.id === instance.definitionId);
    if (!layout) return instance;

    const contacts = fittedOptodePositions(layout, instance);
    const scalpCenters = new Map<string, Vec3>();
    const displayCenters = new Map<string, Vec3>();
    const cortexCenters = new Map<string, Vec3>();
    const commonFlags = [...baseQcFlags(project), 'surface_model_verified'];

    for (const optode of layout.optodes) {
      const contact = contacts.get(optode.id);
      if (!contact) continue;
      const scalp = projectScalpSphereCenter(contact, radiusMm);
      const display = projectToCorticalSurface(contact, radiusMm);
      const cortex = projectToCorticalContact(contact);
      scalpCenters.set(optode.id, scalp);
      displayCenters.set(optode.id, display);
      cortexCenters.set(optode.id, cortex);
      projections.push({
        instanceId: instance.id,
        subjectKind: 'optode',
        subjectId: optode.id,
        scalpRasMm: scalp,
        displayRasMm: display,
        corticalRasMm: cortex,
        depthTargetRasMm: null,
        underlyingCorticalRegions: [],
        deepTargetStructures: [],
        tissueAtTarget: null,
        claimLevel: 'geometric',
        status: projectionStatus,
        qcFlags: [...commonFlags, 'atlas_lookup_pending'],
      });
    }

    const realizedScalpDistances: number[] = [];
    const nominalDistances: number[] = [];
    for (const pair of layout.pairs) {
      const sourceScalp = scalpCenters.get(pair.sourceId);
      const detectorScalp = scalpCenters.get(pair.detectorId);
      const sourceContact = contacts.get(pair.sourceId);
      const detectorContact = contacts.get(pair.detectorId);
      const sourceCortex = cortexCenters.get(pair.sourceId);
      const detectorCortex = cortexCenters.get(pair.detectorId);
      const sourceDisplay = displayCenters.get(pair.sourceId);
      const detectorDisplay = displayCenters.get(pair.detectorId);
      if (!sourceScalp || !detectorScalp || !sourceDisplay || !detectorDisplay
        || !sourceCortex || !detectorCortex || !sourceContact || !detectorContact) {
        projections.push({
          instanceId: instance.id,
          subjectKind: 'pair',
          subjectId: pair.id,
          scalpRasMm: null,
          displayRasMm: null,
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
      const display = midpoint(sourceDisplay, detectorDisplay);
      const transmissionDepthMm = instance.pairDepthOverridesMm?.[pair.id]
        ?? defaultDepthMm;
      const sensitivity = channelSensitivityPath(
        sourceContact,
        detectorContact,
        radiusMm,
        transmissionDepthMm,
      );
      realizedScalpDistances.push(realizedScalp);
      nominalDistances.push(pair.nominalDistanceMm);
      projections.push({
        instanceId: instance.id,
        subjectKind: 'pair',
        subjectId: pair.id,
        scalpRasMm: scalp,
        displayRasMm: display,
        corticalRasMm: sensitivity.corticalContact,
        depthTargetRasMm: sensitivity.target,
        underlyingCorticalRegions: [],
        deepTargetStructures: [],
        tissueAtTarget: null,
        claimLevel: 'geometric',
        status: projectionStatus,
        qcFlags: [...flags, 'atlas_lookup_pending'],
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
