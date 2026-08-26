import type {
  AtlasLabel,
  CortexLumeProject,
  LayoutDefinition,
  LayoutInstance,
  ProjectionResult,
  Vec3,
} from '@cortexlume/contracts';

export interface ExportBundle {
  files: Record<string, string>;
  warnings: string[];
}

function cell(value: unknown, delimiter: ',' | '\t'): string {
  const raw = value == null ? '' : String(value);
  const spreadsheetFormula = typeof value === 'string'
    && (/^[\t\r\n]/.test(raw) || /^[\u0000-\u0020]*[=+\-@]/.test(raw));
  const text = spreadsheetFormula ? `'${raw}` : raw;
  const needsQuotes = text.includes('"') || text.includes('\r') || text.includes('\n')
    || text.includes(delimiter);
  return needsQuotes ? `"${text.replaceAll('"', '""')}"` : text;
}

function table(rows: unknown[][], delimiter: ',' | '\t'): string {
  return `${rows.map((row) => row.map((value) => cell(value, delimiter)).join(delimiter)).join('\r\n')}\r\n`;
}

function csvTable(rows: unknown[][]): string {
  return `\uFEFF${table(rows, ',')}`;
}

function resultMap(project: CortexLumeProject): Map<string, ProjectionResult> {
  return new Map(project.verifiedResults.map(
    (result) => [`${result.instanceId ?? ''}:${result.subjectKind}:${result.subjectId}`, result],
  ));
}

function resultKey(instanceId: string, subjectKind: ProjectionResult['subjectKind'], subjectId: string): string {
  return `${instanceId}:${subjectKind}:${subjectId}`;
}

function vector(value: Vec3 | null | undefined, empty: unknown = ''): unknown[] {
  return value ?? [empty, empty, empty];
}

function topRegions(values: AtlasLabel[], count = 3): unknown[] {
  const sorted = values.slice().sort((a, b) => b.probability - a.probability).slice(0, count);
  return Array.from({ length: count }, (_, index) => {
    const region = sorted[index];
    return [region?.labelEn ?? '', region ? Number((region.probability * 100).toFixed(2)) : ''];
  }).flat();
}

function distance3(a: Vec3 | null | undefined, b: Vec3 | null | undefined): number | '' {
  if (!a || !b) return '';
  return Number(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]).toFixed(3));
}

function instanceCodes(project: CortexLumeProject): Map<string, string> {
  return new Map(project.instances.map(
    (instance, index) => [instance.id, `P${String(index + 1).padStart(2, '0')}`],
  ));
}

function exportInstances(project: CortexLumeProject): LayoutInstance[] {
  const superseded = new Set(project.instances.flatMap((instance) =>
    instance.derivedFromInstanceId ? [instance.derivedFromInstanceId] : []));
  return project.instances.filter((instance) => !superseded.has(instance.id));
}

function layoutForInstance(
  project: CortexLumeProject,
  instance: LayoutInstance,
): LayoutDefinition | undefined {
  return project.layouts.find((layout) => layout.id === instance.definitionId);
}

function assertProjectionResultsReady(project: CortexLumeProject): void {
  const missingOrUnverified: string[] = [];
  const results = resultMap(project);
  for (const instance of exportInstances(project)) {
    const layout = layoutForInstance(project, instance);
    if (!layout) continue;
    for (const subject of layout.optodes) {
      const result = results.get(resultKey(instance.id, 'optode', subject.id));
      if (!result || result.status !== 'verified' || !result.qcFlags.includes('surface_model_verified')) {
        missingOrUnverified.push(`${instance.id}:${subject.id}`);
      }
    }
    for (const subject of layout.pairs) {
      const result = results.get(resultKey(instance.id, 'pair', subject.id));
      if (!result || result.status !== 'verified' || !result.qcFlags.includes('surface_model_verified')) {
        missingOrUnverified.push(`${instance.id}:${subject.id}`);
      }
    }
  }
  if (missingOrUnverified.length > 0) {
    throw new Error(
      `Scientific export unavailable: ${missingOrUnverified.length} projection result(s) are missing or unverified. `
      + 'Open the 3D head view and wait for the verified HeadModel surfaces before exporting.',
    );
  }
}

function qualityControl(project: CortexLumeProject) {
  const results = resultMap(project);
  const codes = instanceCodes(project);
  const channelSpacing = exportInstances(project).flatMap((instance) => {
    const layout = layoutForInstance(project, instance);
    if (!layout) return [];
    return layout.pairs.map((pair) => {
      const result = results.get(resultKey(instance.id, 'pair', pair.id));
      const sourceResult = results.get(resultKey(instance.id, 'optode', pair.sourceId));
      const detectorResult = results.get(resultKey(instance.id, 'optode', pair.detectorId));
      const actual = distance3(sourceResult?.scalpRasMm, detectorResult?.scalpRasMm);
      const error = actual === '' ? null : Number(Math.abs(actual - pair.nominalDistanceMm).toFixed(3));
      return {
        patch: codes.get(instance.id) ?? instance.id,
        channel: pair.channelNumber,
        nominalDistanceMm: Number(pair.nominalDistanceMm.toFixed(3)),
        actualScalpSpacingMm: actual === '' ? null : actual,
        absoluteErrorMm: error,
        errorPercent: error == null
          ? null
          : Number((error / pair.nominalDistanceMm * 100).toFixed(2)),
        status: error == null || result?.status === 'blocked'
          ? 'unavailable'
          : error > 5 ? 'fail' : error > 2 ? 'check' : 'pass',
        flags: result?.qcFlags ?? ['projection_result_missing'],
      };
    });
  });
  return {
    channelSpacing: {
      definition: 'Absolute difference between the 2D nominal source-detector distance and the projected 3D optode-sphere-centre distance on the scalp.',
      thresholdsMm: { passMaximum: 2, checkMaximum: 5 },
      results: channelSpacing,
    },
  };
}

function exportMetadata(project: CortexLumeProject, kind: string, warnings: string[]) {
  return {
    format: 'cortexlume-export',
    formatVersion: 4,
    kind,
    exportedAt: new Date().toISOString(),
    project: {
      id: project.id,
      name: project.name,
      updatedAt: project.updatedAt,
      formatVersion: project.formatVersion,
    },
    counts: {
      layouts: project.layouts.length,
      instances: project.instances.length,
      results: project.verifiedResults.length,
      digitizerSessions: project.digitizerSessions.length,
    },
    coordinateSystem: {
      space: project.template.id,
      convention: project.template.coordinateConvention,
      units: project.template.units,
      scalp: 'Optode sphere centre on the scalp surface.',
      display: 'Collision-safe optode sphere centre used internally for CortexLume cortical visualization.',
      corticalContact: 'First gray-matter/cortical-surface contact; this coordinate is used for cortical probability-volume lookup.',
      depthTarget: 'Configured channel-sensitivity-path target; this coordinate is used for deep-structure lookup.',
    },
    technical: {
      template: project.template,
      projectionSettings: project.projectionSettings,
      deviceProfile: project.deviceProfile,
      layouts: project.layouts,
      instances: project.instances,
      digitizerSessions: project.digitizerSessions,
      projectionResults: project.verifiedResults,
      qualityControl: qualityControl(project),
    },
    warnings,
  };
}

export function buildCsvExport(project: CortexLumeProject): ExportBundle {
  assertProjectionResultsReady(project);
  const warnings: string[] = [];
  const results = resultMap(project);
  const codes = instanceCodes(project);
  const instances = exportInstances(project);
  const optodeRows: unknown[][] = [[
    'patch', 'optode', 'type',
    'scalp_mni_r', 'scalp_mni_a', 'scalp_mni_s',
    'display_mni_r', 'display_mni_a', 'display_mni_s',
    'cortical_contact_mni_r', 'cortical_contact_mni_a', 'cortical_contact_mni_s',
    'cortical_region_1', 'cortical_region_1_percent',
    'cortical_region_2', 'cortical_region_2_percent',
    'cortical_region_3', 'cortical_region_3_percent',
  ]];
  const channelRows: unknown[][] = [[
    'patch', 'channel', 'source', 'detector',
    'nominal_distance_mm', 'actual_scalp_spacing_mm', 'actual_display_spacing_mm', 'actual_cortical_contact_spacing_mm',
    'short_channel',
    'scalp_mni_r', 'scalp_mni_a', 'scalp_mni_s',
    'display_mni_r', 'display_mni_a', 'display_mni_s',
    'cortical_contact_mni_r', 'cortical_contact_mni_a', 'cortical_contact_mni_s',
    'depth_target_mni_r', 'depth_target_mni_a', 'depth_target_mni_s',
    'cortical_region_1', 'cortical_region_1_percent',
    'cortical_region_2', 'cortical_region_2_percent',
    'cortical_region_3', 'cortical_region_3_percent',
  ]];

  for (const instance of instances) {
    const layout = layoutForInstance(project, instance);
    if (!layout) continue;
    const code = codes.get(instance.id) ?? '';
    const byId = new Map(layout.optodes.map((optode) => [optode.id, optode]));
    for (const optode of layout.optodes) {
      const result = results.get(resultKey(instance.id, 'optode', optode.id));
      optodeRows.push([
        code, optode.label, optode.type,
        ...vector(result?.scalpRasMm),
        ...vector(result?.displayRasMm),
        ...vector(result?.corticalRasMm),
        ...topRegions(result?.underlyingCorticalRegions ?? []),
      ]);
    }
    for (const pair of layout.pairs) {
      const result = results.get(resultKey(instance.id, 'pair', pair.id));
      const sourceResult = results.get(resultKey(instance.id, 'optode', pair.sourceId));
      const detectorResult = results.get(resultKey(instance.id, 'optode', pair.detectorId));
      const actualScalpSpacing = distance3(sourceResult?.scalpRasMm, detectorResult?.scalpRasMm);
      const actualDisplaySpacing = distance3(sourceResult?.displayRasMm, detectorResult?.displayRasMm);
      const actualCortexSpacing = distance3(sourceResult?.corticalRasMm, detectorResult?.corticalRasMm);
      channelRows.push([
        code, pair.channelNumber ?? '',
        byId.get(pair.sourceId)?.label ?? pair.sourceId,
        byId.get(pair.detectorId)?.label ?? pair.detectorId,
        Number(pair.nominalDistanceMm.toFixed(3)),
        actualScalpSpacing, actualDisplaySpacing, actualCortexSpacing,
        pair.shortChannel,
        ...vector(result?.scalpRasMm),
        ...vector(result?.displayRasMm),
        ...vector(result?.corticalRasMm),
        ...vector(result?.depthTargetRasMm),
        ...topRegions(result?.underlyingCorticalRegions ?? []),
      ]);
    }
  }

  if (project.instances.length === 0) {
    warnings.push('No 3D patch instances exist; exported coordinate columns are empty.');
  }
  const expectedResults = instances.reduce((total, instance) => {
    const layout = layoutForInstance(project, instance);
    return total + (layout ? layout.optodes.length + layout.pairs.length : 0);
  }, 0);
  if (project.verifiedResults.length < expectedResults) {
    warnings.push('Some placed optodes or channels do not have computed projection results.');
  }

  const files: Record<string, string> = {
    'cortexlume_optodes.csv': csvTable(optodeRows),
    'cortexlume_channels.csv': csvTable(channelRows),
  };
  files['cortexlume_export.json'] = `${JSON.stringify(exportMetadata(project, 'csv', warnings), null, 2)}\n`;
  return { files, warnings };
}

function brainNetMatlabScript(): string {
  return `${[
    "% CortexLume BrainNet Viewer bridge",
    "% Opens the validated cortical-MNI node file with CortexLume S/D styling.",
    "root = fileparts(mfilename('fullpath'));",
    "nodePath = fullfile(root, 'cortexlume_brainnet.node');",
    "assert(isfile(nodePath), 'CortexLume:MissingNodeFile', 'Missing cortexlume_brainnet.node');",
    "brainNetMap = which('BrainNet_MapCfg');",
    "assert(~isempty(brainNetMap), 'CortexLume:BrainNetNotFound', 'BrainNet Viewer is not on the MATLAB path');",
    "brainNetRoot = fileparts(brainNetMap);",
    "surfacePath = fullfile(brainNetRoot, 'Data', 'SurfTemplate', 'BrainMesh_ICBM152.nv');",
    "assert(isfile(surfacePath), 'CortexLume:BrainNetSurfaceMissing', 'BrainNet ICBM152 surface was not found');",
    "H = BrainNet_MapCfg(surfacePath, nodePath);",
    "global EC surf",
    "% BrainNet receives CortexLume cortical MNI coordinates unchanged.",
    "% BrainNet defaults to one color and ignores node column 4. Use it as a modular S/D index.",
    "EC.nod.color = 3;",
    "EC.nod.ModularNumber = [1; 2];",
    "EC.nod.CM = [223 75 63; 28 131 179] / 255;",
    "EC.nod.CMm = EC.nod.CM;",
    "EC.nod.size = 2;",
    "EC.nod.size_value = 2;",
    "EC.nod.size_ratio = 1;",
    "% An opaque neutral surface preserves sulcal anatomy without a plastic highlight.",
    "EC.msh.color = [0.82 0.84 0.83];",
    "EC.msh.color_table = EC.msh.color;",
    "EC.msh.color_table_tmp = EC.msh.color;",
    "EC.msh.alpha = 1;",
    "EC.glb.material = 'dull';",
    "EC.glb.lighting = 'phong';",
    "EC.glb.shading = 'interp';",
    "% Keep dense arrays readable; labels remain in the node file and can be enabled in BrainNet.",
    "EC.lbl = 2;",
    "% Build eight standard directions plus one array-facing optimized direction.",
    "centroid = mean(surf.sphere(:, 1:3), 1);",
    "optimizedAz = atan2d(centroid(1), -centroid(2));",
    "optimizedEl = atan2d(centroid(3), hypot(centroid(1), centroid(2)));",
    "viewAngles = [-90 0; 90 0; 180 0; 0 0; 0 90; -45 25; 45 25; 0 45; optimizedAz optimizedEl];",
    "viewNames = {'01_left', '02_right', '03_anterior', '04_posterior', '05_dorsal', '06_left_oblique', '07_right_oblique', '08_posterior_dorsal', '09_optimized'};",
    "viewImages = cell(9, 1);",
    "viewPaths = cell(9, 1);",
    "EC.lot.view = 1;",
    "EC.lot.view_direction = 4;",
    "set(H, 'Position', [50 50 1200 900], 'PaperPositionMode', 'auto');",
    "for index = 1:9",
    "    EC.lot.view_az = viewAngles(index, 1);",
    "    EC.lot.view_el = viewAngles(index, 2);",
    "    BrainNet('NV_m_nm_Callback', H);",
    "    delete(findall(H, 'Type', 'ColorBar'));",
    "    delete(findall(H, 'Tag', 'Colorbar'));",
    "    viewPaths{index} = fullfile(root, ['cortexlume_brainnet_' viewNames{index} '.png']);",
    "    print(H, viewPaths{index}, '-dpng', '-r120');",
    "    viewImages{index} = imread(viewPaths{index});",
    "end",
    "% fNIRS-oriented layout: lateral/dorsal/lateral, oblique/optimized/oblique, anterior/posterior-dorsal/posterior.",
    "mosaic = [viewImages{1} viewImages{5} viewImages{2}; viewImages{6} viewImages{9} viewImages{7}; viewImages{3} viewImages{8} viewImages{4}];",
    "imwrite(mosaic, fullfile(root, 'cortexlume_brainnet_10_mosaic.png'));",
    "% Leave the interactive viewer on the optimized ninth view without a colorbar.",
    "EC.lot.view_az = optimizedAz;",
    "EC.lot.view_el = optimizedEl;",
    "BrainNet('NV_m_nm_Callback', H);",
    "delete(findall(H, 'Type', 'ColorBar'));",
    "delete(findall(H, 'Tag', 'Colorbar'));",
    "fprintf('CortexLume: wrote 8 standard views, 1 optimized view, and 1 mosaic (red source, blue detector).\\n');",
  ].join('\r\n')}\r\n`;
}

export function buildBrainNetExport(project: CortexLumeProject): ExportBundle {
  assertProjectionResultsReady(project);
  const csv = buildCsvExport(project);
  const warnings = [...csv.warnings];
  const results = resultMap(project);
  const codes = instanceCodes(project);
  const nodes: Array<{ label: string; coordinate: Vec3; color: number }> = [];

  for (const instance of exportInstances(project)) {
    const layout = layoutForInstance(project, instance);
    if (!layout) continue;
    const patch = codes.get(instance.id) ?? instance.id;
    for (const optode of layout.optodes) {
      const coordinate = results.get(resultKey(instance.id, 'optode', optode.id))?.corticalRasMm;
      if (!coordinate?.every(Number.isFinite)) continue;
      nodes.push({
        label: `${patch}-${optode.label}`.replaceAll(/\s+/g, '-'),
        coordinate,
        color: optode.type === 'source' ? 1 : 2,
      });
    }
  }
  if (nodes.length === 0) warnings.push('BrainNet Viewer output contains no finite cortical optode coordinates.');
  const files = {
    ...csv.files,
    'cortexlume_export.json': `${JSON.stringify(exportMetadata(project, 'brainnet-viewer', warnings), null, 2)}\n`,
    'cortexlume_brainnet.node': `${nodes.map((node) => [
      ...node.coordinate.map((value) => value.toFixed(6)),
      node.color,
      '4.000',
      node.label,
    ].join(' ')).join('\r\n')}\r\n`,
    'cortexlume_open_brainnet.m': brainNetMatlabScript(),
    'README_BRAINNET.txt': `${[
      'CortexLume BrainNet Viewer export',
      '',
      'Run cortexlume_open_brainnet.m in MATLAB to open the validated .node file in BrainNet Viewer.',
      'Scalp MNI is the physical optode sphere centre: nearest scalp contact plus one outward optode radius.',
      'Display MNI is the collision-safe sphere centre reached by sweeping the finite optode inward against the CortexLume cortical mesh; it is mesh-specific and is not used for BrainNet nodes.',
      'Cortical contact MNI is the first contact with the correspondence-backed gray-matter surface and is used for cortical atlas lookup.',
      'Columns 1-3 are cortical-contact MNI x/y/z (R/A/S) in millimetres; no display-axis conversion is applied.',
      'Column 4 uses modular index 1 for sources and 2 for detectors. The script enforces red source and blue detector colors.',
      'Node labels are stored in column 6 but hidden by default in BrainNet Viewer.',
      'BrainNet receives the exported cortical MNI coordinates unchanged; no snapping, offset, or display-space correction is applied.',
      'No edge file is generated: CortexLume exports optode locations only.',
      'The MATLAB script writes eight fNIRS-relevant PNG views, one array-facing optimized PNG, and one logically arranged 3x3 mosaic without colorbars or a ventral view.',
    ].join('\r\n')}\r\n`,
  };
  return { files, warnings };
}

export function buildBidsGeometryExport(project: CortexLumeProject): ExportBundle {
  assertProjectionResultsReady(project);
  const warnings = [
    'Add the matching SNIRF recording to complete the BIDS NIRS dataset.',
  ];
  const results = resultMap(project);
  const codes = instanceCodes(project);
  const settings = project.bidsSettings;
  const subject = `sub-${settings.subjectLabel}`;
  const session = settings.sessionLabel ? `ses-${settings.sessionLabel}` : '';
  const acquisition = settings.acquisitionLabel ? `acq-${settings.acquisitionLabel}` : '';
  const run = settings.runIndex == null ? '' : `run-${String(settings.runIndex).padStart(2, '0')}`;
  const nirsDirectory = [subject, session, 'nirs'].filter(Boolean).join('/');
  const sharedPrefix = [subject, session, acquisition].filter(Boolean).join('_');
  const recordingPrefix = [
    subject,
    session,
    `task-${settings.taskLabel}`,
    acquisition,
    run,
  ].filter(Boolean).join('_');
  const optodeRows: unknown[][] = [[
    'name', 'type', 'x', 'y', 'z',
    'display_x', 'display_y', 'display_z',
    'cortical_contact_x', 'cortical_contact_y', 'cortical_contact_z',
    'cortical_region_1', 'cortical_region_1_percent',
    'cortical_region_2', 'cortical_region_2_percent',
    'cortical_region_3', 'cortical_region_3_percent',
  ]];
  const channelRows: unknown[][] = [[
    'name', 'type', 'source', 'detector', 'wavelength_nominal', 'units',
    'short_channel', 'status', 'status_description',
    'nominal_distance_mm', 'actual_scalp_spacing_mm', 'actual_cortical_contact_spacing_mm',
  ]];
  const optodeNames = new Map<string, string>();
  let missingCoordinates = 0;
  let sourceCount = 0;
  let detectorCount = 0;
  let shortChannelCount = 0;

  for (const instance of exportInstances(project)) {
    const layout = layoutForInstance(project, instance);
    if (!layout) continue;
    const code = codes.get(instance.id)!;
    for (const optode of layout.optodes) {
      const name = `${code}_${optode.label}`;
      optodeNames.set(`${instance.id}:${optode.id}`, name);
      const result = results.get(resultKey(instance.id, 'optode', optode.id));
      if (!result?.scalpRasMm) missingCoordinates += 1;
      if (optode.type === 'source') sourceCount += 1;
      else detectorCount += 1;
      optodeRows.push([
        name, optode.type,
        ...vector(result?.scalpRasMm, 'n/a'),
        ...vector(result?.displayRasMm, 'n/a'),
        ...vector(result?.corticalRasMm, 'n/a'),
        ...topRegions(result?.underlyingCorticalRegions ?? [])
          .map((value) => value === '' ? 'n/a' : value),
      ]);
    }
  }

  for (const instance of exportInstances(project)) {
    const layout = layoutForInstance(project, instance);
    if (!layout) continue;
    const code = codes.get(instance.id)!;
    for (const pair of layout.pairs) {
      const result = results.get(resultKey(instance.id, 'pair', pair.id));
      const sourceResult = results.get(resultKey(instance.id, 'optode', pair.sourceId));
      const detectorResult = results.get(resultKey(instance.id, 'optode', pair.detectorId));
      const actualScalpSpacing = distance3(sourceResult?.scalpRasMm, detectorResult?.scalpRasMm);
      const actualCortexSpacing = distance3(sourceResult?.corticalRasMm, detectorResult?.corticalRasMm);
      const spacingError = actualScalpSpacing === ''
        ? null
        : Math.abs(actualScalpSpacing - pair.nominalDistanceMm);
      const status = spacingError != null && spacingError <= 5 && result?.status !== 'blocked'
        ? 'good'
        : 'bad';
      const statusDescription = spacingError == null
        ? 'Missing projected optode coordinates'
        : status === 'good' ? 'Spacing QC passed' : `Spacing differs by ${spacingError.toFixed(3)} mm`;
      for (const wavelength of project.deviceProfile.wavelengthsNm) {
        if (pair.shortChannel) shortChannelCount += 1;
        channelRows.push([
          `${code}_CH${pair.channelNumber ?? pair.id}_${wavelength}`,
          project.deviceProfile.measurementType,
          optodeNames.get(`${instance.id}:${pair.sourceId}`) ?? `${code}_${pair.sourceId}`,
          optodeNames.get(`${instance.id}:${pair.detectorId}`) ?? `${code}_${pair.detectorId}`,
          wavelength, project.deviceProfile.units, pair.shortChannel,
          status, statusDescription,
          Number(pair.nominalDistanceMm.toFixed(3)),
          actualScalpSpacing === '' ? 'n/a' : actualScalpSpacing,
          actualCortexSpacing === '' ? 'n/a' : actualCortexSpacing,
        ]);
      }
    }
  }

  if (project.instances.length === 0) warnings.push('No 3D patch instances exist.');
  if (missingCoordinates > 0) {
    warnings.push(`${missingCoordinates} optodes do not have computed scalp coordinates.`);
  }
  if (project.deviceProfile.samplingFrequencyHz == null) {
    warnings.push('Set the sampling frequency from the recording before BIDS validation.');
  }

  const nirsSidecar: Record<string, unknown> = {
    TaskName: settings.taskLabel,
    Manufacturer: project.deviceProfile.manufacturer,
    ManufacturersModelName: project.deviceProfile.model,
    SourceType: project.deviceProfile.sourceType,
    DetectorType: project.deviceProfile.detectorType,
    Wavelengths: project.deviceProfile.wavelengthsNm,
    NIRSChannelCount: channelRows.length - 1,
    NIRSSourceOptodeCount: sourceCount,
    NIRSDetectorOptodeCount: detectorCount,
    ShortChannelCount: shortChannelCount,
    NIRSPlacementScheme: 'n/a',
  };
  if (project.deviceProfile.samplingFrequencyHz != null) {
    nirsSidecar.SamplingFrequency = project.deviceProfile.samplingFrequencyHz;
  }

  const files: Record<string, string> = {
    'dataset_description.json': `${JSON.stringify({
      Name: project.name,
      BIDSVersion: '1.11.1',
      DatasetType: 'raw',
      GeneratedBy: [{ Name: 'CortexLume' }],
    }, null, 2)}\n`,
    [`${nirsDirectory}/${sharedPrefix}_optodes.tsv`]: table(optodeRows, '\t'),
    [`${nirsDirectory}/${sharedPrefix}_optodes.json`]: `${JSON.stringify({
      display_x: { Description: 'Collision-safe CortexLume cortical display sphere centre, right axis', Units: 'mm' },
      display_y: { Description: 'Collision-safe CortexLume cortical display sphere centre, anterior axis', Units: 'mm' },
      display_z: { Description: 'Collision-safe CortexLume cortical display sphere centre, superior axis', Units: 'mm' },
      cortex_x: { Description: 'First gray-matter contact, right axis', Units: 'mm' },
      cortex_y: { Description: 'First gray-matter contact, anterior axis', Units: 'mm' },
      cortex_z: { Description: 'First gray-matter contact, superior axis', Units: 'mm' },
      cortical_region_1: { Description: 'Highest-probability cortical atlas label' },
      cortical_region_1_percent: { Description: 'Atlas probability in percent', Units: '%' },
      cortical_region_2: { Description: 'Second-highest cortical atlas label' },
      cortical_region_2_percent: { Description: 'Atlas probability in percent', Units: '%' },
      cortical_region_3: { Description: 'Third-highest cortical atlas label' },
      cortical_region_3_percent: { Description: 'Atlas probability in percent', Units: '%' },
    }, null, 2)}\n`,
    [`${nirsDirectory}/${sharedPrefix}_coordsystem.json`]: `${JSON.stringify({
      NIRSCoordinateSystem: project.template.id,
      NIRSCoordinateUnits: project.template.units,
      NIRSCoordinateProcessingDescription: 'surface_projection',
      NIRSCoordinateSystemDescription:
        `Scalp optode sphere centres in MNI RAS+ space from CortexLume template ${project.template.assetVersion}.`,
    }, null, 2)}\n`,
    [`${nirsDirectory}/${recordingPrefix}_channels.tsv`]: table(channelRows, '\t'),
    [`${nirsDirectory}/${recordingPrefix}_channels.json`]: `${JSON.stringify({
      short_channel: { Description: 'Whether the source-detector pair is designated as short separation' },
      nominal_distance_mm: { Description: 'Distance in the 2D optode design', Units: 'mm' },
      actual_scalp_spacing_mm: { Description: 'Projected source-detector distance on the scalp', Units: 'mm' },
      actual_cortical_contact_spacing_mm: { Description: 'Source-detector distance at cortical contact', Units: 'mm' },
    }, null, 2)}\n`,
    [`${nirsDirectory}/${recordingPrefix}_nirs.json`]: `${JSON.stringify(nirsSidecar, null, 2)}\n`,
    'sourcedata/cortexlume_export.json':
      `${JSON.stringify(exportMetadata(project, 'bids-nirs', warnings), null, 2)}\n`,
    README: `${[
      'CortexLume BIDS-NIRS geometry package.',
      'Add the corresponding SNIRF recording under the generated subject nirs directory.',
      'Scalp MNI (standard optodes.tsv x/y/z) is the physical optode sphere centre: nearest scalp contact plus one outward optode radius.',
      'Display MNI (display_x/y/z extension columns) is the collision-safe sphere centre reached by sweeping the finite optode inward against the CortexLume cortical mesh; it is an intermediate visualization coordinate.',
      'Cortical contact MNI (cortical_contact_x/y/z extension columns) is the first contact with the correspondence-backed gray-matter surface and is used for cortical atlas lookup.',
      ...warnings,
    ].join('\r\n')}\r\n`,
  };
  return { files, warnings };
}
