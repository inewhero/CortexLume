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
    expect(channel.cortex_mni_r).not.toBe('');
    expect(channel.cortical_region_1).not.toBe('');
    expect(Number(channel.cortical_region_1_percent)).toBeGreaterThan(0);
    expect(channel.spacing_qc).toBeUndefined();
    expect(csv.files['cortexlume_channels.csv']).not.toContain('spacing_error');
    expect(csv.files['cortexlume_channels.csv']).not.toContain('spacing_qc');
    expect(csv.files['cortexlume_channels.csv']).not.toContain('depth_target');
    expect(csv.files['cortexlume_channels.csv']).not.toContain('project_id');
    const metadata = JSON.parse(csv.files['cortexlume_export.json']!);
    expect(metadata.formatVersion).toBe(3);
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

  it('builds a BrainNet Viewer bundle from cortical optode coordinates', () => {
    useProjectStore.getState().newProject();
    useProjectStore.getState().placeLayout(useProjectStore.getState().activeLayoutId);
    const project = materializeProjectionSnapshot(structuredClone(useProjectStore.getState().project));
    const bundle = buildBrainNetExport(project);

    expect(Object.keys(bundle.files).sort()).toEqual([
      'README_BRAINNET.txt',
      'cortexlume_brainnet.edge',
      'cortexlume_brainnet.node',
      'cortexlume_channels.csv',
      'cortexlume_export.json',
      'cortexlume_open_brainnet.m',
      'cortexlume_optodes.csv',
    ]);
    expect(bundle.files['cortexlume_brainnet.node']!.trim().split(/\r?\n/)).toHaveLength(15);
    const edgeRows = bundle.files['cortexlume_brainnet.edge']!.trim().split(/\r?\n/);
    expect(edgeRows).toHaveLength(15);
    expect(edgeRows.every((row) => row.split('\t').length === 15)).toBe(true);
    expect(bundle.files['cortexlume_open_brainnet.m']).toContain("readtable(optodeCsv)");
    expect(bundle.files['cortexlume_open_brainnet.m']).toContain('BrainNet_MapCfg(surfacePath, nodePath, edgePath)');
    expect(bundle.files['README_BRAINNET.txt']).toContain('designed source-detector channel topology');
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
