import { beforeEach, describe, expect, it } from 'vitest';
import { useProjectStore } from '../renderer/store/projectStore';
import { materializeProjectionSnapshot } from '../renderer/lib/projectionSnapshot';
import { buildBidsGeometryExport, buildBrainNetExport, buildCsvExport } from './projectExport';
import { clearSurfaceProjectors } from '../renderer/lib/geometry';
import { registerVerifiedTestSurfaceProjectors } from '../renderer/lib/testSurfaceProjectors';

function dataRow(table: string, delimiter: ',' | '\t'): Record<string, string> {
  const [header = '', row = ''] = table.trim().split(/\r?\n/);
  const keys = header.replace(/^\uFEFF/, '').split(delimiter);
  const values = row.split(delimiter);
  return Object.fromEntries(keys.map((key, index) => [key, values[index] ?? '']));
}

function brainNetNodeRows(text: string): Array<{
  coordinate: [number, number, number]; color: number; size: number; label: string;
}> {
  return text.trim() ? text.trim().split(/\r?\n/).map((line) => {
    const fields = line.trim().split(/\s+/);
    expect(fields).toHaveLength(6);
    return {
      coordinate: [Number(fields[0]), Number(fields[1]), Number(fields[2])],
      color: Number(fields[3]), size: Number(fields[4]), label: fields[5]!,
    };
  }) : [];
}

describe('project data exports', () => {
  beforeEach(() => registerVerifiedTestSurfaceProjectors());

  it('fails before producing scientific coordinates when surface projectors are unregistered', () => {
    useProjectStore.getState().newProject();
    useProjectStore.getState().placeLayout(useProjectStore.getState().activeLayoutId);
    clearSurfaceProjectors();
    expect(() => materializeProjectionSnapshot(structuredClone(useProjectStore.getState().project)))
      .toThrow(/Scientific projection unavailable/);
  });

  it('rejects export when results are provisional or lack verified surface provenance', () => {
    useProjectStore.getState().newProject();
    useProjectStore.getState().placeLayout(useProjectStore.getState().activeLayoutId);
    const project = materializeProjectionSnapshot(structuredClone(useProjectStore.getState().project));
    project.verifiedResults[0] = { ...project.verifiedResults[0]!, status: 'provisional' };
    expect(() => buildCsvExport(project)).toThrow(/missing or unverified/);
    project.verifiedResults[0] = {
      ...project.verifiedResults[0]!,
      status: 'verified',
      qcFlags: project.verifiedResults[0]!.qcFlags.filter((flag) => flag !== 'surface_model_verified'),
    };
    expect(() => buildCsvExport(project)).toThrow(/missing or unverified/);
  });

  it('honors the overall export deadline before doing work', () => {
    useProjectStore.getState().newProject();
    useProjectStore.getState().placeLayout(useProjectStore.getState().activeLayoutId);
    const project = materializeProjectionSnapshot(structuredClone(useProjectStore.getState().project));
    expect(() => buildCsvExport(project, { deadline: Date.now() - 1 }))
      .toThrow(/overall time budget/);
  });

  it('cannot create duplicate BIDS channel names through normal channel renumbering', () => {
    useProjectStore.getState().newProject();
    const state = useProjectStore.getState();
    const layout = state.project.layouts.find((candidate) => candidate.id === state.activeLayoutId)!;
    const first = layout.pairs[0]!;
    const second = layout.pairs[1]!;
    state.updatePairChannelNumber(first.id, second.channelNumber!);
    useProjectStore.getState().placeLayout(layout.id);
    const project = materializeProjectionSnapshot(structuredClone(useProjectStore.getState().project));

    const bids = buildBidsGeometryExport(project);
    const tableText = bids.files['sub-01/nirs/sub-01_task-layout_channels.tsv']!;
    const names = tableText.trim().split(/\r?\n/).slice(1).map((row) => row.split('\t')[0]!);
    expect(new Set(names).size).toBe(names.length);
    expect(useProjectStore.getState().toast).toMatch(/Channel number conflict/);
  });

  it('keeps cortical contact separate from the depth target and honors pair depth overrides', () => {
    useProjectStore.getState().newProject();
    useProjectStore.getState().placeLayout(useProjectStore.getState().activeLayoutId);
    const raw = structuredClone(useProjectStore.getState().project);
    const instance = raw.instances[0]!;
    const layout = raw.layouts.find((candidate) => candidate.id === instance.definitionId)!;
    const pair = layout.pairs[0]!;
    const baseline = materializeProjectionSnapshot(raw);
    instance.pairDepthOverridesMm = { [pair.id]: 55 };
    const overridden = materializeProjectionSnapshot(raw);
    const baseResult = baseline.verifiedResults.find((result) => result.subjectId === pair.id)!;
    const overrideResult = overridden.verifiedResults.find((result) => result.subjectId === pair.id)!;
    expect(overrideResult.corticalRasMm).toEqual(baseResult.corticalRasMm);
    expect(overrideResult.depthTargetRasMm).not.toEqual(baseResult.depthTargetRasMm);
    expect(overrideResult.corticalRasMm).not.toEqual(overrideResult.depthTargetRasMm);
    expect(overrideResult.tissueAtTarget).toBeNull();
  });

  it('applies a copied pair depth override only to its owning instance', () => {
    useProjectStore.getState().newProject();
    const layoutId = useProjectStore.getState().activeLayoutId;
    useProjectStore.getState().placeLayout(layoutId);
    useProjectStore.getState().placeLayout(layoutId);
    const raw = structuredClone(useProjectStore.getState().project);
    const [first, second] = raw.instances;
    if (!first || !second) throw new Error('fixture must create two instances');
    const firstLayout = raw.layouts.find((candidate) => candidate.id === first.definitionId)!;
    const secondLayout = raw.layouts.find((candidate) => candidate.id === second.definitionId)!;
    const pairId = firstLayout.pairs[0]!.id;
    expect(secondLayout.pairs[0]!.id).toBe(pairId);
    first.pairDepthOverridesMm = { [pairId]: 55 };

    const materialized = materializeProjectionSnapshot(raw);
    const firstResult = materialized.verifiedResults.find((result) => (
      result.instanceId === first.id && result.subjectKind === 'pair' && result.subjectId === pairId
    ))!;
    const secondResult = materialized.verifiedResults.find((result) => (
      result.instanceId === second.id && result.subjectKind === 'pair' && result.subjectId === pairId
    ))!;
    expect(firstResult.depthTargetRasMm).not.toEqual(secondResult.depthTargetRasMm);
  });

  it('keeps optode and channel projection results distinct when their UUIDs coincide', () => {
    useProjectStore.getState().newProject();
    useProjectStore.getState().placeLayout(useProjectStore.getState().activeLayoutId);
    const raw = structuredClone(useProjectStore.getState().project);
    const instance = raw.instances[0]!;
    const layout = raw.layouts.find((candidate) => candidate.id === instance.definitionId)!;
    const optode = layout.optodes[0]!;
    layout.pairs[0]!.id = optode.id;
    const project = materializeProjectionSnapshot(raw);
    const expected = project.verifiedResults.find((result) => (
      result.instanceId === instance.id && result.subjectKind === 'optode' && result.subjectId === optode.id
    ))!;
    const optodeRow = dataRow(buildCsvExport(project).files['cortexlume_optodes.csv']!, ',');
    expect(Number(optodeRow.scalp_mni_r)).toBeCloseTo(expected.scalpRasMm![0], 6);
    expect(Number(optodeRow.scalp_mni_a)).toBeCloseTo(expected.scalpRasMm![1], 6);
    expect(Number(optodeRow.scalp_mni_s)).toBeCloseTo(expected.scalpRasMm![2], 6);
  });

  it('neutralizes spreadsheet formulas even after leading whitespace or control characters', () => {
    useProjectStore.getState().newProject();
    useProjectStore.getState().placeLayout(useProjectStore.getState().activeLayoutId);
    const project = structuredClone(useProjectStore.getState().project);
    const instance = project.instances[0]!;
    const layout = project.layouts.find((candidate) => candidate.id === instance.definitionId)!;
    layout.optodes[0]!.label = '  =HYPERLINK("https://example.invalid","click")';
    layout.optodes[1]!.label = '\t@SUM(1,1)';
    const csv = buildCsvExport(materializeProjectionSnapshot(project)).files['cortexlume_optodes.csv']!;
    expect(csv).toContain("'  =HYPERLINK");
    expect(csv).toContain("'\t@SUM");
  });

  it('keeps multiple placed patches distinct in CSV and BIDS geometry', () => {
    useProjectStore.getState().newProject();
    const layoutId = useProjectStore.getState().activeLayoutId;
    useProjectStore.getState().placeLayout(layoutId);
    useProjectStore.getState().placeLayout(layoutId);
    const project = structuredClone(useProjectStore.getState().project);
    project.deviceProfile.wavelengthsNm = [760, 850];
    project.deviceProfile.samplingFrequencyHz = 36;

    const csv = buildCsvExport(materializeProjectionSnapshot(project));
    expect(csv.files['cortexlume_channels.csv']).toContain('\r\nP01,');
    expect(csv.files['cortexlume_channels.csv']).toContain('\r\nP02,');
    expect(Object.keys(csv.files).sort()).toEqual([
      'cortexlume_channels.csv',
      'cortexlume_export.json',
      'cortexlume_optodes.csv',
    ]);
    expect(csv.files['cortexlume_channels.csv']?.startsWith('\uFEFF')).toBe(true);
    expect(csv.files['cortexlume_optodes.csv']?.startsWith('\uFEFF')).toBe(true);

    const bids = buildBidsGeometryExport(materializeProjectionSnapshot(project));
    expect(bids.files['sub-01/nirs/sub-01_optodes.tsv']).toContain('P01_S1');
    expect(bids.files['sub-01/nirs/sub-01_optodes.tsv']).toContain('P02_S1');
    expect(bids.files['sub-01/nirs/sub-01_task-layout_channels.tsv']).toContain('P01_CH1_760');
    expect(bids.files['sub-01/nirs/sub-01_task-layout_channels.tsv']).toContain('P02_CH1_850');
    const sidecar = JSON.parse(bids.files['sub-01/nirs/sub-01_task-layout_nirs.json']!);
    expect(sidecar.Manufacturer).toBe('Shimadzu');
    expect(sidecar.NIRSChannelCount).toBe(88);
  });

  it('keeps CSV concise and moves technical details into JSON', () => {
    useProjectStore.getState().newProject();
    const layoutId = useProjectStore.getState().activeLayoutId;
    useProjectStore.getState().placeLayout(layoutId);
    const rawProject = structuredClone(useProjectStore.getState().project);
    const project = materializeProjectionSnapshot(rawProject);
    project.verifiedResults = project.verifiedResults.map((result) => ({
      ...result,
      underlyingCorticalRegions: [{
        atlasId: 'HOCPAL@test-fixture',
        labelEn: 'Right Superior Parietal Lobule',
        probability: 0.45,
      }],
      qcFlags: result.qcFlags.filter((flag) => flag !== 'atlas_lookup_pending'),
    }));

    const csv = buildCsvExport(project);
    const channel = dataRow(csv.files['cortexlume_channels.csv']!, ',');
    expect(Number(channel.actual_scalp_spacing_mm)).toBeGreaterThan(0);
    expect(Number(channel.actual_cortical_contact_spacing_mm)).toBeGreaterThan(0);
    expect(channel.scalp_mni_r).not.toBe('');
    expect(channel.display_mni_r).not.toBe('');
    expect(channel.cortical_contact_mni_r).not.toBe('');
    expect(channel.depth_target_mni_r).not.toBe('');
    expect(channel.cortical_region_1).not.toBe('');
    expect(Number(channel.cortical_region_1_percent)).toBeGreaterThan(0);
    expect(channel.spacing_qc).toBeUndefined();
    expect(csv.files['cortexlume_channels.csv']).not.toContain('spacing_error');
    expect(csv.files['cortexlume_channels.csv']).not.toContain('spacing_qc');
    expect(csv.files['cortexlume_channels.csv']).toContain('depth_target_mni_r');
    expect(csv.files['cortexlume_channels.csv']).not.toContain('project_id');
    const metadata = JSON.parse(csv.files['cortexlume_export.json']!);
    expect(metadata.formatVersion).toBe(4);
    expect(metadata.technical.instances[0].fitQc.flags).not.toContain('template_unverified');
    expect(metadata.technical.projectionResults.length).toBeGreaterThan(0);
    expect(metadata.technical.projectionResults.every((result: { status: string }) => result.status === 'verified')).toBe(true);
    expect(metadata.technical.qualityControl.channelSpacing.thresholdsMm).toEqual({
      passMaximum: 2,
      checkMaximum: 5,
    });
    expect(metadata.technical.qualityControl.channelSpacing.results[0]).toMatchObject({
      patch: 'P01',
      channel: 1,
      status: expect.stringMatching(/pass|check|fail/),
    });

    const bids = buildBidsGeometryExport(project);
    const bidsChannel = dataRow(bids.files['sub-01/nirs/sub-01_task-layout_channels.tsv']!, '\t');
    expect(bidsChannel.type).toBe('NIRSCWAMPLITUDE');
    expect(bidsChannel.source).toBe('P01_S1');
    expect(bidsChannel.detector).toBe('P01_D2');
    expect(bidsChannel.actual_scalp_spacing_mm).not.toBe('n/a');
    expect(bidsChannel.status).toMatch(/good|bad/);
    const bidsTechnical = JSON.parse(bids.files['sourcedata/cortexlume_export.json']!);
    expect(bidsTechnical.technical.instances[0].fitQc.flags).not.toContain('template_unverified');
  });

  it('uses cortical MNI for BrainNet and assigns explicit S/D node classes', () => {
    useProjectStore.getState().newProject();
    useProjectStore.getState().placeLayout(useProjectStore.getState().activeLayoutId);
    const project = materializeProjectionSnapshot(structuredClone(useProjectStore.getState().project));
    const instance = project.instances[0]!;
    const layout = project.layouts.find((candidate) => candidate.id === instance.definitionId)!;
    const source = layout.optodes.find((optode) => optode.type === 'source')!;
    const detector = layout.optodes.find((optode) => optode.type === 'detector')!;
    const knownSource: [number, number, number] = [-37.25, 61.5, 42.75];
    const knownDetector: [number, number, number] = [48.125, -72.625, 19.875];
    project.verifiedResults = project.verifiedResults.map((result) =>
      result.instanceId === instance.id && result.subjectId === source.id
        ? { ...result, displayRasMm: [1, 2, 3], corticalRasMm: knownSource }
        : result.instanceId === instance.id && result.subjectId === detector.id
          ? { ...result, displayRasMm: [4, 5, 6], corticalRasMm: knownDetector }
          : result);
    const bundle = buildBrainNetExport(project);

    expect(Object.keys(bundle.files).sort()).toEqual([
      'README_BRAINNET.txt',
      'cortexlume_brainnet.node',
      'cortexlume_channels.csv',
      'cortexlume_export.json',
      'cortexlume_open_brainnet.m',
      'cortexlume_optodes.csv',
    ]);
    const nodes = brainNetNodeRows(bundle.files['cortexlume_brainnet.node']!);
    expect(nodes).toHaveLength(15);
    expect(nodes.find((node) => node.label === `P01-${source.label}`)).toEqual({
      coordinate: knownSource, color: 1, size: 4, label: `P01-${source.label}`,
    });
    expect(nodes.find((node) => node.label === `P01-${detector.label}`)).toEqual({
      coordinate: knownDetector, color: 2, size: 4, label: `P01-${detector.label}`,
    });
    expect(new Set(nodes.filter((node) => node.label.includes('-S')).map((node) => node.color))).toEqual(new Set([1]));
    expect(new Set(nodes.filter((node) => node.label.includes('-D')).map((node) => node.color))).toEqual(new Set([2]));
    const script = bundle.files['cortexlume_open_brainnet.m']!;
    expect(script).toContain('BrainNet_MapCfg(surfacePath, nodePath)');
    expect(script).toContain('EC.nod.color = 3;');
    expect(script).toContain('EC.nod.CM = [223 75 63; 28 131 179] / 255;');
    expect(script).toContain('EC.lbl = 2;');
    expect(script).toContain('EC.msh.color = [0.82 0.84 0.83];');
    expect(script).toContain('EC.msh.alpha = 1;');
    expect(script).toContain("EC.glb.material = 'dull';");
    expect(script).toContain('BrainNet receives CortexLume cortical MNI coordinates unchanged.');
    expect(script).not.toContain('displayNodePath');
    expect(script).not.toContain('vertexNormal');
    expect(script).toContain('viewAngles = [-90 0; 90 0; 180 0; 0 0; 0 90; -45 25; 45 25; 0 45; optimizedAz optimizedEl];');
    expect(script).not.toContain('ventral');
    expect(script).toContain('for index = 1:9');
    expect(script).toContain("delete(findall(H, 'Type', 'ColorBar'));");
    expect(script).toContain("imwrite(mosaic, fullfile(root, 'cortexlume_brainnet_10_mosaic.png'));");
    expect(script).toContain('mosaic = [viewImages{1} viewImages{5} viewImages{2}; viewImages{6} viewImages{9} viewImages{7}; viewImages{3} viewImages{8} viewImages{4}];');
    expect(script).not.toContain('edgePath');
    expect(script).not.toContain('readtable');
    expect(bundle.files['README_BRAINNET.txt']).toContain('No edge file is generated');
    expect(bundle.files['README_BRAINNET.txt']).toContain('hidden by default');
    expect(bundle.files['README_BRAINNET.txt']).toContain('eight fNIRS-relevant PNG views');
    expect(bundle.files['README_BRAINNET.txt']).toContain('coordinates unchanged');
    expect(bundle.files['README_BRAINNET.txt']).toContain('without colorbars or a ventral view');
  });

  it('keeps nodes from multiple patches distinct without generating an edge matrix', () => {
    useProjectStore.getState().newProject();
    const layoutId = useProjectStore.getState().activeLayoutId;
    useProjectStore.getState().placeLayout(layoutId);
    useProjectStore.getState().placeLayout(layoutId);
    const project = materializeProjectionSnapshot(structuredClone(useProjectStore.getState().project));
    const bundle = buildBrainNetExport(project);
    const nodes = brainNetNodeRows(bundle.files['cortexlume_brainnet.node']!);
    expect(nodes).toHaveLength(30);
    expect(nodes.some((node) => node.label.startsWith('P01-'))).toBe(true);
    expect(nodes.some((node) => node.label.startsWith('P02-'))).toBe(true);
    expect(new Set(nodes.map((node) => node.label)).size).toBe(nodes.length);
    expect(bundle.files['cortexlume_brainnet.edge']).toBeUndefined();
  });

  it('omits unavailable node coordinates and reports an empty BrainNet result', () => {
    useProjectStore.getState().newProject();
    useProjectStore.getState().placeLayout(useProjectStore.getState().activeLayoutId);
    const project = materializeProjectionSnapshot(structuredClone(useProjectStore.getState().project));
    project.verifiedResults = project.verifiedResults.map((result) =>
      result.subjectKind === 'optode' ? { ...result, corticalRasMm: null } : result);
    const bundle = buildBrainNetExport(project);
    expect(brainNetNodeRows(bundle.files['cortexlume_brainnet.node']!)).toEqual([]);
    expect(bundle.warnings).toContain('BrainNet Viewer output contains no finite cortical optode coordinates.');
  });

  it('uses configured BIDS entities in directories and filenames', () => {
    useProjectStore.getState().newProject();
    useProjectStore.getState().placeLayout(useProjectStore.getState().activeLayoutId);
    const rawProject = structuredClone(useProjectStore.getState().project);
    rawProject.bidsSettings = {
      subjectLabel: '007',
      sessionLabel: 'baseline',
      taskLabel: 'motor',
      acquisitionLabel: 'labnirs',
      runIndex: 2,
    };
    const bids = buildBidsGeometryExport(materializeProjectionSnapshot(rawProject));
    const prefix = 'sub-007/ses-baseline/nirs';
    expect(bids.files[`${prefix}/sub-007_ses-baseline_acq-labnirs_optodes.tsv`]).toBeDefined();
    expect(bids.files[
      `${prefix}/sub-007_ses-baseline_task-motor_acq-labnirs_run-02_channels.tsv`
    ]).toBeDefined();
    expect(bids.files[
      `${prefix}/sub-007_ses-baseline_task-motor_acq-labnirs_run-02_nirs.json`
    ]).toBeDefined();
  });

  it('neutralizes spreadsheet formulas and preserves a real zero BIDS spacing', () => {
    useProjectStore.getState().newProject();
    useProjectStore.getState().placeLayout(useProjectStore.getState().activeLayoutId);
    const project = materializeProjectionSnapshot(structuredClone(useProjectStore.getState().project));
    const instance = project.instances[0]!;
    const layout = project.layouts.find((candidate) => candidate.id === instance.definitionId)!;
    layout.optodes[0]!.label = '=HYPERLINK("https://invalid")';
    const pair = layout.pairs[0]!;
    const source = project.verifiedResults.find((item) => item.instanceId === instance.id && item.subjectId === pair.sourceId)!;
    const detector = project.verifiedResults.find((item) => item.instanceId === instance.id && item.subjectId === pair.detectorId)!;
    detector.scalpRasMm = source.scalpRasMm;
    detector.corticalRasMm = source.corticalRasMm;

    const csv = buildCsvExport(project);
    expect(csv.files['cortexlume_optodes.csv']).toContain("'=HYPERLINK");
    const bids = buildBidsGeometryExport(project);
    const channel = dataRow(bids.files['sub-01/nirs/sub-01_task-layout_channels.tsv']!, '\t');
    expect(channel.actual_scalp_spacing_mm).toBe('0');
    expect(channel.actual_cortical_contact_spacing_mm).toBe('0');
  });
});
