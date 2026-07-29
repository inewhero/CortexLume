import { describe, expect, it } from 'vitest';
import { useProjectStore } from '../renderer/store/projectStore';
import { materializeProjectionSnapshot } from '../renderer/lib/projectionSnapshot';
import { buildBidsGeometryExport, buildCsvExport } from './projectExport';

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
    const project = {
      ...structuredClone(useProjectStore.getState().project),
      deviceProfile: {
        wavelengthsNm: [760, 850],
        measurementType: 'CW_AMPLITUDE',
        units: 'V',
      },
    };

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
    expect(bids.files['sub-template_optodes.tsv']).toContain('P01_S1');
    expect(bids.files['sub-template_optodes.tsv']).toContain('P02_S1');
    expect(bids.files['sub-template_task-layout_channels.tsv']).toContain('P01_CH1_760');
    expect(bids.files['sub-template_task-layout_channels.tsv']).toContain('P02_CH1_850');
  });

  it('keeps CSV concise and moves technical details into JSON', () => {
    useProjectStore.getState().newProject();
    const layoutId = useProjectStore.getState().activeLayoutId;
    useProjectStore.getState().placeLayout(layoutId);
    const rawProject = structuredClone(useProjectStore.getState().project);
    const project = materializeProjectionSnapshot(rawProject);

    const csv = buildCsvExport(project);
    const channel = dataRow(csv.files['cortexlume_channels.csv']!, ',');
    expect(Number(channel.actual_scalp_spacing_mm)).toBeGreaterThan(0);
    expect(Number(channel.actual_cortex_spacing_mm)).toBeGreaterThan(0);
    expect(channel.scalp_mni_r).not.toBe('');
    expect(channel.cortex_mni_r).not.toBe('');
    expect(channel.cortical_region_1).not.toBe('');
    expect(Number(channel.cortical_region_1_percent)).toBeGreaterThan(0);
    expect(channel.spacing_qc).toMatch(/PASS|CHECK/);
    expect(csv.files['cortexlume_channels.csv']).not.toContain('depth_target');
    expect(csv.files['cortexlume_channels.csv']).not.toContain('project_id');
    const metadata = JSON.parse(csv.files['cortexlume_export.json']!);
    expect(metadata.formatVersion).toBe(2);
    expect(metadata.technical.instances[0].fitQc.flags).toContain('template_unverified');
    expect(metadata.technical.projectionResults.length).toBeGreaterThan(0);

    const bids = buildBidsGeometryExport(project);
    const bidsChannel = dataRow(bids.files['sub-template_channels.tsv']!, '\t');
    expect(bidsChannel.scalp_x).not.toBe('n/a');
    expect(bidsChannel.cortex_x).not.toBe('n/a');
    expect(bidsChannel.cortical_region_3).not.toBe('n/a');
    expect(bidsChannel.actual_scalp_spacing_mm).not.toBe('n/a');
    expect(bidsChannel.fit_qc_flags).toContain('template_unverified');
    expect(bids.files['sub-template_channels.tsv']).not.toContain('depth_target');
  });
});
