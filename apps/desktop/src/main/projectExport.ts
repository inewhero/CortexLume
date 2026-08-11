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
  const text = value == null ? '' : String(value);
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
    (result) => [`${result.instanceId ?? ''}:${result.subjectId}`, result],
  ));
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

function layoutForInstance(
  project: CortexLumeProject,
  instance: LayoutInstance,
): LayoutDefinition | undefined {
  return project.layouts.find((layout) => layout.id === instance.definitionId);
}

function exportMetadata(project: CortexLumeProject, kind: string, warnings: string[]) {
  return {
    format: 'cortexlume-export',
    formatVersion: 2,
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
    },
    coordinateSystem: {
      space: project.template.id,
      convention: project.template.coordinateConvention,
      units: project.template.units,
      scalp: 'Optode sphere centre on the scalp surface.',
      cortex: 'First cortical-surface contact; this coordinate is used for probability-volume lookup.',
    },
    technical: {
      template: project.template,
      projectionSettings: project.projectionSettings,
      deviceProfile: project.deviceProfile,
      layouts: project.layouts,
      instances: project.instances,
      projectionResults: project.verifiedResults,
    },
    warnings,
  };
}

export function buildCsvExport(project: CortexLumeProject): ExportBundle {
  const warnings: string[] = [];
  const results = resultMap(project);
  const codes = instanceCodes(project);
  const optodeRows: unknown[][] = [[
    'patch', 'optode', 'type',
    'scalp_mni_r', 'scalp_mni_a', 'scalp_mni_s',
    'cortex_mni_r', 'cortex_mni_a', 'cortex_mni_s',
    'cortical_region_1', 'cortical_region_1_percent',
    'cortical_region_2', 'cortical_region_2_percent',
    'cortical_region_3', 'cortical_region_3_percent',
  ]];
  const channelRows: unknown[][] = [[
    'patch', 'channel', 'source', 'detector',
    'nominal_distance_mm', 'actual_scalp_spacing_mm', 'actual_cortex_spacing_mm',
    'spacing_error_mm', 'spacing_error_percent', 'spacing_qc', 'short_channel',
    'scalp_mni_r', 'scalp_mni_a', 'scalp_mni_s',
    'cortex_mni_r', 'cortex_mni_a', 'cortex_mni_s',
    'cortical_region_1', 'cortical_region_1_percent',
    'cortical_region_2', 'cortical_region_2_percent',
    'cortical_region_3', 'cortical_region_3_percent',
  ]];

  for (const instance of project.instances) {
    const layout = layoutForInstance(project, instance);
    if (!layout) continue;
    const code = codes.get(instance.id) ?? '';
    const byId = new Map(layout.optodes.map((optode) => [optode.id, optode]));
    for (const optode of layout.optodes) {
      const result = results.get(`${instance.id}:${optode.id}`);
      optodeRows.push([
        code, optode.label, optode.type,
        ...vector(result?.scalpRasMm),
        ...vector(result?.corticalRasMm),
        ...topRegions(result?.underlyingCorticalRegions ?? []),
      ]);
    }
    for (const pair of layout.pairs) {
      const result = results.get(`${instance.id}:${pair.id}`);
      const sourceResult = results.get(`${instance.id}:${pair.sourceId}`);
      const detectorResult = results.get(`${instance.id}:${pair.detectorId}`);
      const actualScalpSpacing = distance3(sourceResult?.scalpRasMm, detectorResult?.scalpRasMm);
      const actualCortexSpacing = distance3(sourceResult?.corticalRasMm, detectorResult?.corticalRasMm);
      const spacingError = actualScalpSpacing === ''
        ? ''
        : Number(Math.abs(actualScalpSpacing - pair.nominalDistanceMm).toFixed(3));
      const spacingErrorPercent = spacingError === ''
        ? ''
        : Number((spacingError / pair.nominalDistanceMm * 100).toFixed(2));
      const spacingQc = spacingError === ''
        ? ''
        : spacingError <= 5 && result?.status !== 'blocked' ? 'PASS' : 'CHECK';
      channelRows.push([
        code, pair.channelNumber ?? '',
        byId.get(pair.sourceId)?.label ?? pair.sourceId,
        byId.get(pair.detectorId)?.label ?? pair.detectorId,
        Number(pair.nominalDistanceMm.toFixed(3)),
        actualScalpSpacing, actualCortexSpacing,
        spacingError, spacingErrorPercent, spacingQc, pair.shortChannel,
        ...vector(result?.scalpRasMm),
        ...vector(result?.corticalRasMm),
        ...topRegions(result?.underlyingCorticalRegions ?? []),
      ]);
    }
  }

  if (project.instances.length === 0) {
    warnings.push('No 3D patch instances exist; exported coordinate columns are empty.');
  }
  const expectedResults = project.instances.reduce((total, instance) => {
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

export function buildBidsGeometryExport(project: CortexLumeProject): ExportBundle {
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
    'cortex_x', 'cortex_y', 'cortex_z',
    'cortical_region_1', 'cortical_region_1_percent',
    'cortical_region_2', 'cortical_region_2_percent',
    'cortical_region_3', 'cortical_region_3_percent',
  ]];
  const channelRows: unknown[][] = [[
    'name', 'type', 'source', 'detector', 'wavelength_nominal', 'units',
    'short_channel', 'status', 'status_description',
    'nominal_distance_mm', 'actual_scalp_spacing_mm', 'actual_cortex_spacing_mm',
  ]];
  const optodeNames = new Map<string, string>();
  let missingCoordinates = 0;
  let sourceCount = 0;
  let detectorCount = 0;
  let shortChannelCount = 0;

  for (const instance of project.instances) {
    const layout = layoutForInstance(project, instance);
    if (!layout) continue;
    const code = codes.get(instance.id)!;
    for (const optode of layout.optodes) {
      const name = `${code}_${optode.label}`;
      optodeNames.set(`${instance.id}:${optode.id}`, name);
      const result = results.get(`${instance.id}:${optode.id}`);
      if (!result?.scalpRasMm) missingCoordinates += 1;
      if (optode.type === 'source') sourceCount += 1;
      else detectorCount += 1;
      optodeRows.push([
        name, optode.type,
        ...vector(result?.scalpRasMm, 'n/a'),
        ...vector(result?.corticalRasMm, 'n/a'),
        ...topRegions(result?.underlyingCorticalRegions ?? [])
          .map((value) => value === '' ? 'n/a' : value),
      ]);
    }
  }

  for (const instance of project.instances) {
    const layout = layoutForInstance(project, instance);
    if (!layout) continue;
    const code = codes.get(instance.id)!;
    for (const pair of layout.pairs) {
      const result = results.get(`${instance.id}:${pair.id}`);
      const sourceResult = results.get(`${instance.id}:${pair.sourceId}`);
      const detectorResult = results.get(`${instance.id}:${pair.detectorId}`);
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
          actualScalpSpacing || 'n/a', actualCortexSpacing || 'n/a',
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
      actual_cortex_spacing_mm: { Description: 'Source-detector distance at cortical contact', Units: 'mm' },
    }, null, 2)}\n`,
    [`${nirsDirectory}/${recordingPrefix}_nirs.json`]: `${JSON.stringify(nirsSidecar, null, 2)}\n`,
    'sourcedata/cortexlume_export.json':
      `${JSON.stringify(exportMetadata(project, 'bids-nirs', warnings), null, 2)}\n`,
    README: `${[
      'CortexLume BIDS-NIRS geometry scaffold.',
      'Add the corresponding SNIRF recording under the generated subject nirs directory.',
      ...warnings,
    ].join('\r\n')}\r\n`,
  };
  return { files, warnings };
}
