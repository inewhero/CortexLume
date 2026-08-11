import { describe, expect, it } from 'vitest';
import { useProjectStore } from '../renderer/store/projectStore';
import { materializeProjectionSnapshot } from '../renderer/lib/projectionSnapshot';
import { buildBidsGeometryExport, buildBrainNetExport, buildCsvExport } from './projectExport';

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

    const bids = buildBidsGeometryExport(project);
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
    expect(Number(channel.actual_cortex_spacing_mm)).toBeGreaterThan(0);
    expect(channel.scalp_mni_r).not.toBe('');
    expect(channel.display_mni_r).not.toBe('');
    expect(channel.cortex_mni_r).not.toBe('');
    expect(channel.cortical_region_1).not.toBe('');
    expect(Number(channel.cortical_region_1_percent)).toBeGreaterThan(0);
    expect(channel.spacing_qc).toBeUndefined();
    expect(csv.files['cortexlume_channels.csv']).not.toContain('spacing_error');
    expect(csv.files['cortexlume_channels.csv']).not.toContain('spacing_qc');
    expect(csv.files['cortexlume_channels.csv']).not.toContain('depth_target');
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
    expect(bids.files['sub-01/nirs/sub-01_task-layout_channels.tsv']).not.toContain('depth_target');
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
});
