import { describe, expect, it } from 'vitest';
import { useProjectStore } from '../renderer/store/projectStore';
import { buildBidsGeometryExport, buildCsvExport } from './projectExport';

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
});
