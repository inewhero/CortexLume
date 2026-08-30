import type {
  CortexLumeProject,
  DigitizerSession,
  LayoutInstance,
  ProjectionResult,
  Vec3,
} from '@cortexlume/contracts';
import type { ExportRunOptions } from './projectExport';
import {
  matlabCellStrings,
  matlabChar,
  matlabDouble,
  matlabStruct,
  writeMatlabV5,
} from './matlabV5';

export interface AtlasViewerExportBundle {
  files: Record<string, string | Uint8Array>;
  warnings: string[];
}

interface IndexedOptode {
  instanceId: string;
  optodeId: string;
  label: string;
  index: number;
  scalpRasMm: Vec3;
}

interface IndexedChannel {
  instanceId: string;
  pairId: string;
  channelNumber: number | null;
  sourceIndex: number;
  detectorIndex: number;
}

interface AtlasViewerGeometry {
  sources: IndexedOptode[];
  detectors: IndexedOptode[];
  channels: IndexedChannel[];
  landmarks: { labels: string[]; positions: Vec3[]; session: DigitizerSession } | null;
}

const ATLAS_VIEWER_SD_FILE = 'cortexlume_atlasviewer.SD';

/** Let Electron service operations:cancel between bounded geometry steps. */
function yieldExportTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function checkExportBudget(options: ExportRunOptions): void {
  if (options.signal?.aborted) throw new Error('Project export cancelled');
  if (options.deadline != null && Date.now() >= options.deadline) {
    throw new Error('Project export exceeded its overall time budget');
  }
}

function exportInstances(project: CortexLumeProject): LayoutInstance[] {
  const superseded = new Set(project.instances.flatMap((instance) =>
    instance.derivedFromInstanceId ? [instance.derivedFromInstanceId] : []));
  return project.instances.filter((instance) => !superseded.has(instance.id));
}

function resultKey(instanceId: string, kind: ProjectionResult['subjectKind'], subjectId: string): string {
  return `${instanceId}:${kind}:${subjectId}`;
}

function finiteVector(value: Vec3 | null | undefined): value is Vec3 {
  return value != null && value.length === 3 && value.every(Number.isFinite);
}

function requireVerifiedScalpResult(
  results: Map<string, ProjectionResult>,
  instanceId: string,
  kind: ProjectionResult['subjectKind'],
  subjectId: string,
): ProjectionResult & { scalpRasMm: Vec3 } {
  const result = results.get(resultKey(instanceId, kind, subjectId));
  if (!result || result.status !== 'verified' || !result.qcFlags.includes('surface_model_verified')) {
    throw new Error(
      `AtlasViewer export unavailable: ${instanceId}:${kind}:${subjectId} is missing a verified surface projection.`,
    );
  }
  if (!finiteVector(result.scalpRasMm)) {
    throw new Error(
      `AtlasViewer export unavailable: ${instanceId}:${kind}:${subjectId} has no finite 3D scalp coordinate.`,
    );
  }
  return result as ProjectionResult & { scalpRasMm: Vec3 };
}

function sharedFivePointLandmarks(
  project: CortexLumeProject,
  instances: LayoutInstance[],
): AtlasViewerGeometry['landmarks'] {
  const sessionIds = new Set(instances.map((instance) => instance.digitizerSessionId));
  if (sessionIds.size !== 1) return null;
  const sessionId = [...sessionIds][0];
  if (sessionId == null) return null;
  const session = project.digitizerSessions.find((candidate) => candidate.id === sessionId);
  if (!session || session.calibration.method !== 'five-point-similarity') return null;
  const expected = ['Nz', 'Iz', 'LPA', 'RPA', 'Cz'] as const;
  const byLabel = new Map(session.calibration.residuals.map((item) => [item.label, item]));
  if (byLabel.size !== expected.length) return null;
  const positions = expected.map((label) => byLabel.get(label)?.measuredRasMm);
  if (!positions.every(finiteVector)) return null;
  return { labels: [...expected], positions: positions as Vec3[], session };
}

function initialGeometry(project: CortexLumeProject, instances: LayoutInstance[]): AtlasViewerGeometry {
  if (!project.template.verified
    || project.template.coordinateConvention !== 'RAS+'
    || project.template.units !== 'mm') {
    throw new Error('AtlasViewer export requires the verified MNI RAS+ millimetre template.');
  }
  if (instances.length === 0) {
    throw new Error('AtlasViewer export requires at least one non-superseded 3D layout instance.');
  }
  return {
    sources: [], detectors: [], channels: [],
    landmarks: sharedFivePointLandmarks(project, instances),
  };
}

function appendInstance(
  project: CortexLumeProject,
  instance: LayoutInstance,
  geometry: AtlasViewerGeometry,
  results: Map<string, ProjectionResult>,
  options: ExportRunOptions,
): void {
  checkExportBudget(options);
  const layout = project.layouts.find((candidate) => candidate.id === instance.definitionId);
  if (!layout) throw new Error(`AtlasViewer export unavailable: layout ${instance.definitionId} was not found.`);

  const sourceIndex = new Map<string, number>();
  const detectorIndex = new Map<string, number>();
  for (const optode of layout.optodes) {
    checkExportBudget(options);
    const result = requireVerifiedScalpResult(results, instance.id, 'optode', optode.id);
    if (optode.type === 'source') {
      const index = geometry.sources.length + 1;
      sourceIndex.set(optode.id, index);
      geometry.sources.push({
        instanceId: instance.id, optodeId: optode.id, label: optode.label,
        index, scalpRasMm: result.scalpRasMm,
      });
    } else {
      const index = geometry.detectors.length + 1;
      detectorIndex.set(optode.id, index);
      geometry.detectors.push({
        instanceId: instance.id, optodeId: optode.id, label: optode.label,
        index, scalpRasMm: result.scalpRasMm,
      });
    }
  }

  for (const pair of layout.pairs) {
    checkExportBudget(options);
    requireVerifiedScalpResult(results, instance.id, 'pair', pair.id);
    const source = sourceIndex.get(pair.sourceId);
    const detector = detectorIndex.get(pair.detectorId);
    if (source == null || detector == null) {
      throw new Error(`AtlasViewer export unavailable: channel ${pair.id} does not reference one source and one detector.`);
    }
    geometry.channels.push({
      instanceId: instance.id,
      pairId: pair.id,
      channelNumber: pair.channelNumber ?? null,
      sourceIndex: source,
      detectorIndex: detector,
    });
  }
}

function measurementRows(geometry: AtlasViewerGeometry, wavelengthCount: number): number[][] {
  const rows: number[][] = [];
  // Match AtlasViewer's convertProbe2SD ordering: one complete, stable channel
  // block per wavelength. Indices are one-based [source, detector, type, wavelength].
  for (let wavelengthIndex = 1; wavelengthIndex <= wavelengthCount; wavelengthIndex += 1) {
    geometry.channels.forEach((channel) => {
      rows.push([channel.sourceIndex, channel.detectorIndex, 1, wavelengthIndex]);
    });
  }
  return rows;
}

function assertCompleteGeometry(geometry: AtlasViewerGeometry, measList: number[][]): void {
  if (geometry.sources.length === 0 || geometry.detectors.length === 0 || geometry.channels.length === 0) {
    throw new Error('AtlasViewer export requires at least one source, one detector, and one source-detector channel.');
  }
  if (measList.length === 0) {
    throw new Error('AtlasViewer export requires at least one wavelength measurement.');
  }
}

function atlasViewerReadme(hasLandmarks: boolean): string {
  return `${[
    'CortexLume AtlasViewer SD export',
    '',
    `Load ${ATLAS_VIEWER_SD_FILE} with AtlasViewer's probe import workflow.`,
    'The file is an uncompressed little-endian MATLAB Level-5 file containing one variable named SD.',
    'SrcPos3D and DetPos3D are verified CortexLume scalp optode sphere-centre coordinates in MNI152NLin6Asym RAS+ millimetres.',
    'SrcPos and DetPos intentionally mirror those same Nx3 coordinates because AtlasViewer requires the base fields for optode counts; they are not a separate 2D projection.',
    'MeasList uses one-based [source index, detector index, data-type index, wavelength index] rows; data-type index is 1.',
    hasLandmarks
      ? 'Landmarks3D contains the calibrated template-space positions from the one complete five-point digitizer calibration shared by every exported instance (Nz, Iz, LPA, RPA, Cz).'
      : 'Landmarks3D is empty because the exported instances do not share one complete five-point digitizer calibration. Complete probe registration in AtlasViewer.',
    'This interchange file does not claim subject registration. Inspect and approve AtlasViewer registration before analysis.',
    'CortexLume cortical-contact coordinates, depth targets, and atlas labels are not SD fields and are therefore not embedded in the .SD file.',
    'See cortexlume_atlasviewer.json for index-to-label mapping, coordinate semantics, provenance, and warnings.',
  ].join('\r\n')}\r\n`;
}

function finishBundle(
  project: CortexLumeProject,
  geometry: AtlasViewerGeometry,
  options: ExportRunOptions,
): AtlasViewerExportBundle {
  checkExportBudget(options);
  const measList = measurementRows(geometry, project.deviceProfile.wavelengthsNm.length);
  assertCompleteGeometry(geometry, measList);
  const empty = matlabDouble([], 0);
  const sourcePositions = geometry.sources.map((item) => item.scalpRasMm);
  const detectorPositions = geometry.detectors.map((item) => item.scalpRasMm);
  // AtlasViewer's convertSD2probe checks isempty(SD.Landmarks3D) before
  // dereferencing labels/pos. Use a real MATLAB [] when no shared five-point
  // calibration exists so the official path cannot mistake an empty scalar
  // struct for supplied registration data.
  const landmarks = geometry.landmarks == null
    ? matlabDouble([], 0)
    : matlabStruct({
      labels: matlabCellStrings(geometry.landmarks.labels),
      pos: matlabDouble(geometry.landmarks.positions),
    });
  const sd = matlabStruct({
    SpatialUnit: matlabChar('mm'),
    Lambda: matlabDouble([project.deviceProfile.wavelengthsNm]),
    // AtlasViewer's own converter selects SrcPos3D/DetPos3D for geometry but,
    // when optpos_reg is absent, derives nsrc/ndet from the mandatory base
    // SrcPos/DetPos matrices. Preserve the verified 3D coordinates in both
    // field pairs; a lossy arbitrary 2D projection would corrupt distances.
    SrcPos: matlabDouble(sourcePositions),
    DetPos: matlabDouble(detectorPositions),
    DummyPos: matlabDouble([], 3),
    SrcPos3D: matlabDouble(sourcePositions),
    DetPos3D: matlabDouble(detectorPositions),
    DummyPos3D: matlabDouble([], 3),
    nSrcs: matlabDouble([[geometry.sources.length]]),
    nDets: matlabDouble([[geometry.detectors.length]]),
    nDummys: matlabDouble([[0]]),
    MeasList: matlabDouble(measList),
    MeasListAct: matlabDouble(measList.map(() => [1])),
    SpringList: empty,
    AnchorList: empty,
    Landmarks3D: landmarks,
    SrcGrommetType: empty,
    DetGrommetType: empty,
    DummyGrommetType: empty,
    SrcGrommetRot: empty,
    DetGrommetRot: empty,
    DummyGrommetRot: empty,
  });
  const sdBytes = writeMatlabV5({ SD: sd });
  checkExportBudget(options);

  const warnings = [
    'AtlasViewer SD carries probe geometry only; CortexLume cortical contacts, depth targets, and atlas labels remain in the JSON sidecar.',
    'SrcPos3D and DetPos3D are CortexLume scalp optode sphere centres, not raw scalp mesh contact vertices.',
    geometry.landmarks
      ? 'A shared five-point Landmarks3D set is included, but this export does not claim subject registration; verify alignment in AtlasViewer.'
      : 'No complete five-point Landmarks3D set is shared by every exported instance; complete probe registration in AtlasViewer.',
  ];
  const sidecar = {
    format: 'cortexlume-atlasviewer-sd-export',
    formatVersion: 1,
    atlasViewerFile: ATLAS_VIEWER_SD_FILE,
    matlabVariable: 'SD',
    project: { id: project.id, name: project.name, updatedAt: project.updatedAt },
    coordinateSystem: {
      space: project.template.id,
      convention: project.template.coordinateConvention,
      units: project.template.units,
      srcPosAndDetPos: 'Compatibility mirrors of SrcPos3D and DetPos3D; Nx3, not projected to 2D.',
      srcPos3DAndDetPos3D: 'Verified scalp optode sphere centres.',
      excludedFromSd: ['displayRasMm', 'corticalRasMm', 'depthTargetRasMm', 'atlas labels'],
    },
    registration: geometry.landmarks ? {
      subjectRegistered: false,
      landmarks3DIncluded: true,
      method: geometry.landmarks.session.calibration.method,
      sessionId: geometry.landmarks.session.id,
      coordinateSpace: `${project.template.id} ${project.template.coordinateConvention} ${project.template.units}`,
      positionSemantics: 'calibration residual measuredRasMm after the five-point similarity transform',
      labels: geometry.landmarks.labels,
      rmsResidualMm: geometry.landmarks.session.calibration.rmsResidualMm,
      maxResidualMm: geometry.landmarks.session.calibration.maxResidualMm,
    } : {
      subjectRegistered: false,
      landmarks3DIncluded: false,
    },
    wavelengthsNm: project.deviceProfile.wavelengthsNm,
    counts: {
      sources: geometry.sources.length,
      detectors: geometry.detectors.length,
      channels: geometry.channels.length,
      measurementRows: measList.length,
    },
    sourceIndex: geometry.sources,
    detectorIndex: geometry.detectors,
    channels: geometry.channels,
    warnings,
  };
  return {
    files: {
      [ATLAS_VIEWER_SD_FILE]: sdBytes,
      'cortexlume_atlasviewer.json': `${JSON.stringify(sidecar, null, 2)}\n`,
      'README_ATLASVIEWER.txt': atlasViewerReadme(geometry.landmarks != null),
    },
    warnings,
  };
}

export function buildAtlasViewerExport(
  project: CortexLumeProject,
  options: ExportRunOptions = {},
): AtlasViewerExportBundle {
  checkExportBudget(options);
  const instances = exportInstances(project);
  const geometry = initialGeometry(project, instances);
  const results = new Map(project.verifiedResults.map((result) => [
    resultKey(result.instanceId ?? '', result.subjectKind, result.subjectId), result,
  ]));
  options.onProgress?.(0, Math.max(1, instances.length), 'export-atlasviewer-geometry');
  instances.forEach((instance, index) => {
    appendInstance(project, instance, geometry, results, options);
    options.onProgress?.(index + 1, Math.max(1, instances.length), 'export-atlasviewer-geometry');
  });
  return finishBundle(project, geometry, options);
}

export async function buildAtlasViewerExportAsync(
  project: CortexLumeProject,
  options: ExportRunOptions = {},
): Promise<AtlasViewerExportBundle> {
  checkExportBudget(options);
  const instances = exportInstances(project);
  const geometry = initialGeometry(project, instances);
  const results = new Map(project.verifiedResults.map((result) => [
    resultKey(result.instanceId ?? '', result.subjectKind, result.subjectId), result,
  ]));
  options.onProgress?.(0, Math.max(1, instances.length), 'export-atlasviewer-geometry');
  for (const [index, instance] of instances.entries()) {
    await yieldExportTurn();
    checkExportBudget(options);
    appendInstance(project, instance, geometry, results, options);
    options.onProgress?.(index + 1, Math.max(1, instances.length), 'export-atlasviewer-geometry');
  }
  await yieldExportTurn();
  checkExportBudget(options);
  options.onProgress?.(0, 1, 'export-atlasviewer-mat');
  const bundle = finishBundle(project, geometry, options);
  options.onProgress?.(1, 1, 'export-atlasviewer-mat');
  return bundle;
}
