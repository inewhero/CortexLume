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
    formatVersion: 1,
    kind,
    exportedAt: new Date().toISOString(),
    project: {
      id: project.id,
      name: project.name,
      updatedAt: project.updatedAt,
      formatVersion: project.formatVersion,
    },
    template: project.template,
    projectionSettings: project.projectionSettings,
    counts: {
      layouts: project.layouts.length,
      instances: project.instances.length,
      results: project.verifiedResults.length,
    },
    warnings,
  };
}

export function buildCsvExport(project: CortexLumeProject): ExportBundle {
  const warnings: string[] = [];
  const results = resultMap(project);
  const codes = instanceCodes(project);
  const layoutRows: unknown[][] = [[
    'project_id', 'project_name', 'layout_id', 'layout_name', 'layout_version',
    'grid_spacing_mm', 'optode_count', 'channel_count', 'placed_instance_count', 'updated_at',
  ]];
  const instanceRows: unknown[][] = [[
    'project_id', 'instance', 'instance_id', 'layout_id', 'layout_name',
    'anchor_mni_r', 'anchor_mni_a', 'anchor_mni_s',
    'rotation_deg', 'mapping_rotation_deg', 'visible', 'edit_mode', 'local_override_count',
    'fit_converged', 'fit_mean_error_mm', 'fit_max_error_mm', 'fit_qc_flags',
  ]];
  const optodeRows: unknown[][] = [[
    'project_id', 'layout_id', 'layout_name', 'instance', 'instance_id',
    'optode_id', 'optode', 'type', 'u_mm', 'v_mm',
    'scalp_mni_r', 'scalp_mni_a', 'scalp_mni_s',
    'cortex_mni_r', 'cortex_mni_a', 'cortex_mni_s',
    'region_1', 'region_1_percent', 'region_2', 'region_2_percent',
    'region_3', 'region_3_percent',
    'fit_converged', 'fit_mean_error_mm', 'fit_max_error_mm', 'fit_qc_flags',
    'claim_level', 'status', 'qc_flags',
  ]];
  const channelRows: unknown[][] = [[
    'project_id', 'layout_id', 'layout_name', 'instance', 'instance_id',
    'pair_id', 'channel_number', 'source', 'detector',
    'nominal_distance_mm', 'actual_scalp_spacing_mm', 'actual_cortex_spacing_mm',
    'spacing_error_mm', 'spacing_error_percent', 'spacing_qc_pass', 'short_channel',
    'projection_mode', 'depth_mm',
    'scalp_mni_r', 'scalp_mni_a', 'scalp_mni_s',
    'cortex_mni_r', 'cortex_mni_a', 'cortex_mni_s',
    'cortical_region_1', 'cortical_region_1_percent',
    'cortical_region_2', 'cortical_region_2_percent',
    'cortical_region_3', 'cortical_region_3_percent',
    'depth_target_mni_r', 'depth_target_mni_a', 'depth_target_mni_s',
    'deep_region_1', 'deep_region_1_percent', 'deep_region_2', 'deep_region_2_percent',
    'deep_region_3', 'deep_region_3_percent', 'tissue_at_target',
    'fit_converged', 'fit_mean_error_mm', 'fit_max_error_mm', 'fit_qc_flags',
    'claim_level', 'status', 'qc_flags',
  ]];

  for (const layout of project.layouts) {
    const instances = project.instances.filter((instance) => instance.definitionId === layout.id);
    layoutRows.push([
      project.id, project.name, layout.id, layout.name, layout.version,
      layout.gridSpacingMm, layout.optodes.length, layout.pairs.length, instances.length, layout.updatedAt,
    ]);
    const scopes: LayoutInstance[] = instances;
    const byId = new Map(layout.optodes.map((optode) => [optode.id, optode]));

    for (const instance of scopes) {
      const code = codes.get(instance.id) ?? '';
      for (const optode of layout.optodes) {
        const result = results.get(`${instance.id}:${optode.id}`);
        optodeRows.push([
          project.id, layout.id, layout.name, code, instance.id,
          optode.id, optode.label, optode.type, ...optode.uvMm,
          ...vector(result?.scalpRasMm),
          ...vector(result?.corticalRasMm),
          ...topRegions(result?.underlyingCorticalRegions ?? []),
          instance.fitQc?.converged ?? '', instance.fitQc?.meanAbsoluteErrorMm ?? '',
          instance.fitQc?.maxAbsoluteErrorMm ?? '', instance.fitQc?.flags.join('|') ?? '',
          result?.claimLevel ?? '', result?.status ?? '', result?.qcFlags.join('|') ?? '',
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
        const spacingQcPass = spacingError === ''
          ? ''
          : spacingError <= 5 && result?.status !== 'blocked';
        channelRows.push([
          project.id, layout.id, layout.name, code, instance.id,
          pair.id, pair.channelNumber ?? '',
          byId.get(pair.sourceId)?.label ?? pair.sourceId,
          byId.get(pair.detectorId)?.label ?? pair.detectorId,
          Number(pair.nominalDistanceMm.toFixed(3)),
          actualScalpSpacing, actualCortexSpacing,
          spacingError, spacingErrorPercent, spacingQcPass,
          pair.shortChannel, project.projectionSettings.mode,
          project.projectionSettings.pairDepthOverridesMm[pair.id]
            ?? project.projectionSettings.defaultDepthMm ?? '',
          ...vector(result?.scalpRasMm),
          ...vector(result?.corticalRasMm),
          ...topRegions(result?.underlyingCorticalRegions ?? []),
          ...vector(result?.depthTargetRasMm),
          ...topRegions(result?.deepTargetStructures ?? []),
          result?.tissueAtTarget ?? '',
          instance.fitQc?.converged ?? '', instance.fitQc?.meanAbsoluteErrorMm ?? '',
          instance.fitQc?.maxAbsoluteErrorMm ?? '', instance.fitQc?.flags.join('|') ?? '',
          result?.claimLevel ?? '', result?.status ?? '',
          result?.qcFlags.join('|') ?? '',
        ]);
      }
    }
  }

  for (const instance of project.instances) {
    const layout = layoutForInstance(project, instance);
    instanceRows.push([
      project.id, codes.get(instance.id), instance.id, instance.definitionId, layout?.name ?? '',
      ...instance.anchorRasMm,
      Number((instance.rotationRad * 180 / Math.PI).toFixed(3)),
      Number(((instance.mappingRotationRad ?? 0) * 180 / Math.PI).toFixed(3)),
      instance.visible ?? true, instance.locked ? 'patch' : 'optodes', instance.overrides.length,
      instance.fitQc?.converged ?? '', instance.fitQc?.meanAbsoluteErrorMm ?? '',
      instance.fitQc?.maxAbsoluteErrorMm ?? '', instance.fitQc?.flags.join('|') ?? '',
    ]);
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
    'cortexlume_layouts.csv': table(layoutRows, ','),
    'cortexlume_instances.csv': table(instanceRows, ','),
    'cortexlume_optodes.csv': table(optodeRows, ','),
    'cortexlume_channels.csv': table(channelRows, ','),
  };
  files['cortexlume_export.json'] = `${JSON.stringify(exportMetadata(project, 'csv', warnings), null, 2)}\n`;
  if (warnings.length > 0) files['README.txt'] = `${warnings.join('\r\n')}\r\n`;
  return { files, warnings };
}

export function buildBidsGeometryExport(project: CortexLumeProject): ExportBundle {
  const warnings = [
    'This geometry bundle is not a complete BIDS dataset because CortexLume does not create a SNIRF recording.',
  ];
  const results = resultMap(project);
  const codes = instanceCodes(project);
  const optodeRows: unknown[][] = [[
    'name', 'type', 'x', 'y', 'z', 'cortex_x', 'cortex_y', 'cortex_z',
    'cortical_region_1', 'cortical_region_1_percent',
    'cortical_region_2', 'cortical_region_2_percent',
    'cortical_region_3', 'cortical_region_3_percent',
    'claim_level', 'status', 'qc_flags',
  ]];
  const optodeNames = new Map<string, string>();
  let missingCoordinates = 0;

  for (const instance of project.instances) {
    const layout = layoutForInstance(project, instance);
    if (!layout) continue;
    const code = codes.get(instance.id)!;
    for (const optode of layout.optodes) {
      const name = `${code}_${optode.label}`;
      optodeNames.set(`${instance.id}:${optode.id}`, name);
      const result = results.get(`${instance.id}:${optode.id}`);
      if (!result?.scalpRasMm) missingCoordinates += 1;
      optodeRows.push([
        name, optode.type,
        ...vector(result?.scalpRasMm, 'n/a'),
        ...vector(result?.corticalRasMm, 'n/a'),
        ...topRegions(result?.underlyingCorticalRegions ?? []).map((value) => value === '' ? 'n/a' : value),
        result?.claimLevel ?? 'n/a', result?.status ?? 'n/a',
        result?.qcFlags.join('|') || 'n/a',
      ]);
    }
  }

  if (project.instances.length === 0) warnings.push('No 3D patch instances exist.');
  if (missingCoordinates > 0) {
    warnings.push(`${missingCoordinates} optodes do not have computed scalp coordinates.`);
  }
  if (!project.template.verified) {
    warnings.push('The selected template assets are not marked verified; coordinates are geometrical estimates.');
  }

  const files: Record<string, string> = {
    'sub-template_optodes.tsv': table(optodeRows, '\t'),
    'sub-template_coordsystem.json': `${JSON.stringify({
      NIRSCoordinateSystem: 'MNI152NLin6Asym',
      NIRSCoordinateUnits: 'mm',
      NIRSCoordinateSystemDescription:
        `Template-space scalp coordinates generated by CortexLume with asset ${project.template.assetVersion}.`,
      CortexCoordinatesDescription:
        'Additional cortex_x/y/z columns contain the modeled first gray-matter contact in MNI RAS+ millimetres.',
      CorticalRegionDescription:
        'Top three English atlas labels and probabilities reported by CortexLume.',
    }, null, 2)}\n`,
  };

  const geometryChannelRows: unknown[][] = [[
    'name', 'instance', 'channel_number', 'source', 'detector',
    'nominal_distance_mm', 'actual_scalp_spacing_mm', 'actual_cortex_spacing_mm',
    'spacing_error_mm', 'spacing_error_percent', 'spacing_qc_pass', 'short_channel',
    'projection_mode', 'depth_mm',
    'scalp_x', 'scalp_y', 'scalp_z', 'cortex_x', 'cortex_y', 'cortex_z',
    'cortical_region_1', 'cortical_region_1_percent',
    'cortical_region_2', 'cortical_region_2_percent',
    'cortical_region_3', 'cortical_region_3_percent',
    'depth_target_x', 'depth_target_y', 'depth_target_z',
    'deep_structure_1', 'deep_structure_1_percent',
    'deep_structure_2', 'deep_structure_2_percent',
    'deep_structure_3', 'deep_structure_3_percent',
    'tissue_at_target', 'fit_converged', 'fit_mean_error_mm', 'fit_max_error_mm',
    'fit_qc_flags', 'claim_level', 'status', 'qc_flags',
  ]];
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
        ? ''
        : Number(Math.abs(actualScalpSpacing - pair.nominalDistanceMm).toFixed(3));
      const spacingErrorPercent = spacingError === ''
        ? ''
        : Number((spacingError / pair.nominalDistanceMm * 100).toFixed(2));
      geometryChannelRows.push([
        `${code}_CH${pair.channelNumber ?? pair.id}`, code, pair.channelNumber ?? 'n/a',
        optodeNames.get(`${instance.id}:${pair.sourceId}`) ?? `${code}_${pair.sourceId}`,
        optodeNames.get(`${instance.id}:${pair.detectorId}`) ?? `${code}_${pair.detectorId}`,
        Number(pair.nominalDistanceMm.toFixed(3)), actualScalpSpacing || 'n/a',
        actualCortexSpacing || 'n/a', spacingError || 0, spacingErrorPercent || 0,
        spacingError === '' ? 'n/a' : spacingError <= 5 && result?.status !== 'blocked',
        pair.shortChannel, project.projectionSettings.mode,
        project.projectionSettings.pairDepthOverridesMm[pair.id]
          ?? project.projectionSettings.defaultDepthMm ?? 'n/a',
        ...vector(result?.scalpRasMm, 'n/a'),
        ...vector(result?.corticalRasMm, 'n/a'),
        ...topRegions(result?.underlyingCorticalRegions ?? []).map((value) => value === '' ? 'n/a' : value),
        ...vector(result?.depthTargetRasMm, 'n/a'),
        ...topRegions(result?.deepTargetStructures ?? []).map((value) => value === '' ? 'n/a' : value),
        result?.tissueAtTarget ?? 'n/a',
        instance.fitQc?.converged ?? 'n/a', instance.fitQc?.meanAbsoluteErrorMm ?? 'n/a',
        instance.fitQc?.maxAbsoluteErrorMm ?? 'n/a', instance.fitQc?.flags.join('|') || 'n/a',
        result?.claimLevel ?? 'n/a', result?.status ?? 'n/a',
        result?.qcFlags.join('|') || 'n/a',
      ]);
    }
  }
  files['sub-template_channels.tsv'] = table(geometryChannelRows, '\t');

  const profileComplete = project.deviceProfile.wavelengthsNm.length > 0
    && project.deviceProfile.measurementType
    && project.deviceProfile.units;
  if (profileComplete) {
    const channelRows: unknown[][] = [[
      'name', 'type', 'source', 'detector', 'wavelength_nominal', 'units', 'short_channel',
    ]];
    for (const instance of project.instances) {
      const layout = layoutForInstance(project, instance);
      if (!layout) continue;
      const code = codes.get(instance.id)!;
      for (const pair of layout.pairs) {
        for (const wavelength of project.deviceProfile.wavelengthsNm) {
          channelRows.push([
            `${code}_CH${pair.channelNumber ?? pair.id}_${wavelength}`,
            project.deviceProfile.measurementType,
            optodeNames.get(`${instance.id}:${pair.sourceId}`) ?? `${code}_${pair.sourceId}`,
            optodeNames.get(`${instance.id}:${pair.detectorId}`) ?? `${code}_${pair.detectorId}`,
            wavelength, project.deviceProfile.units, pair.shortChannel,
          ]);
        }
      }
    }
    files['sub-template_task-layout_channels.tsv'] = table(channelRows, '\t');
  } else {
    warnings.push('channels.tsv was omitted because wavelengths, measurement type, or units are incomplete.');
  }

  files['cortexlume_export.json'] = `${JSON.stringify(exportMetadata(project, 'bids-geometry', warnings), null, 2)}\n`;
  files.README = `${warnings.join('\r\n')}\r\n`;
  return { files, warnings };
}
