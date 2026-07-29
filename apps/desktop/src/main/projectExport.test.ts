import { describe, expect, it } from 'vitest';
import { useProjectStore } from '../renderer/store/projectStore';
import { materializeProjectionSnapshot } from '../renderer/lib/projectionSnapshot';
import { buildBidsGeometryExport, buildCsvExport } from './projectExport';

function dataRow(table: string, delimiter: ',' | '\t'): Record<string, string> {
  const [header = '', row = ''] = table.trim().split(/\r?\n/);
  const keys = header.split(delimiter);
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

    const csv = buildCsvExport(project);
    expect(csv.files['cortexlume_channels.csv']).toContain(',P01,');
    expect(csv.files['cortexlume_channels.csv']).toContain(',P02,');
    expect(Object.keys(csv.files)).toEqual(expect.arrayContaining([
      'cortexlume_layouts.csv',
      'cortexlume_instances.csv',
      'cortexlume_optodes.csv',
      'cortexlume_channels.csv',
      'cortexlume_export.json',
    ]));

    const bids = buildBidsGeometryExport(project);
    expect(bids.files['sub-template_optodes.tsv']).toContain('P01_S1');
    expect(bids.files['sub-template_optodes.tsv']).toContain('P02_S1');
    expect(bids.files['sub-template_task-layout_channels.tsv']).toContain('P01_CH1_760');
    expect(bids.files['sub-template_task-layout_channels.tsv']).toContain('P02_CH1_850');
  });

  it('exports complete channel geometry, anatomy, QC, and realized spacing', () => {
    useProjectStore.getState().newProject();
    const layoutId = useProjectStore.getState().activeLayoutId;
    useProjectStore.getState().placeLayout(layoutId);
    const rawProject = structuredClone(useProjectStore.getState().project);
    rawProject.projectionSettings.defaultDepthMm = 18;
    const project = materializeProjectionSnapshot(rawProject);

    const csv = buildCsvExport(project);
    const channel = dataRow(csv.files['cortexlume_channels.csv']!, ',');
    expect(Number(channel.actual_scalp_spacing_mm)).toBeGreaterThan(0);
    expect(Number(channel.actual_cortex_spacing_mm)).toBeGreaterThan(0);
    expect(channel.scalp_mni_r).not.toBe('');
    expect(channel.cortex_mni_r).not.toBe('');
    expect(channel.cortical_region_1).not.toBe('');
    expect(Number(channel.cortical_region_1_percent)).toBeGreaterThan(0);
    expect(channel.deep_region_1).not.toBe('');
    expect(Number(channel.deep_region_1_percent)).toBeGreaterThan(0);
    expect(channel.depth_target_mni_r).not.toBe('');
    expect(channel.tissue_at_target).toBe('deep target estimate');
    expect(channel.fit_converged).toBe('true');
    expect(channel.fit_mean_error_mm).not.toBe('');
    expect(channel.spacing_qc_pass).not.toBe('');
    expect(channel.qc_flags).toContain('template_unverified');

    const bids = buildBidsGeometryExport(project);
    const bidsChannel = dataRow(bids.files['sub-template_channels.tsv']!, '\t');
    expect(bidsChannel.scalp_x).not.toBe('n/a');
    expect(bidsChannel.cortex_x).not.toBe('n/a');
    expect(bidsChannel.cortical_region_3).not.toBe('n/a');
    expect(bidsChannel.deep_structure_3).not.toBe('n/a');
    expect(bidsChannel.actual_scalp_spacing_mm).not.toBe('n/a');
    expect(bidsChannel.fit_qc_flags).toContain('template_unverified');
  });
});
