import { describe, expect, it } from 'vitest';
import { getMissingBidsFields } from '../lib/bidsValidation';
import { useProjectStore } from './projectStore';

describe('default optode matrix', () => {
  it('numbers optodes down columns and channels across rows', () => {
    const layout = useProjectStore.getState().project.layouts[0]!;
    const byCoordinate = new Map(layout.optodes.map((optode) => [optode.uvMm.join(','), optode]));
    expect([
      [byCoordinate.get('-60,30')?.label, byCoordinate.get('-30,30')?.label, byCoordinate.get('0,30')?.label, byCoordinate.get('30,30')?.label, byCoordinate.get('60,30')?.label],
      [byCoordinate.get('-60,0')?.label, byCoordinate.get('-30,0')?.label, byCoordinate.get('0,0')?.label, byCoordinate.get('30,0')?.label, byCoordinate.get('60,0')?.label],
      [byCoordinate.get('-60,-30')?.label, byCoordinate.get('-30,-30')?.label, byCoordinate.get('0,-30')?.label, byCoordinate.get('30,-30')?.label, byCoordinate.get('60,-30')?.label],
    ]).toEqual([
      ['S1', 'D2', 'S4', 'D5', 'S7'],
      ['D1', 'S3', 'D4', 'S6', 'D7'],
      ['S2', 'D3', 'S5', 'D6', 'S8'],
    ]);

    const byId = new Map(layout.optodes.map((optode) => [optode.id, optode]));
    const midpoints = layout.pairs.map((pair) => {
      const source = byId.get(pair.sourceId)!;
      const detector = byId.get(pair.detectorId)!;
      return [pair.channelNumber, (source.uvMm[0] + detector.uvMm[0]) / 2, (source.uvMm[1] + detector.uvMm[1]) / 2];
    });
    expect(midpoints).toEqual([
      [1, -45, 30], [2, -15, 30], [3, 15, 30], [4, 45, 30],
      [5, -60, 15], [6, -30, 15], [7, 0, 15], [8, 30, 15], [9, 60, 15],
      [10, -45, 0], [11, -15, 0], [12, 15, 0], [13, 45, 0],
      [14, -60, -15], [15, -30, -15], [16, 0, -15], [17, 30, -15], [18, 60, -15],
      [19, -45, -30], [20, -15, -30], [21, 15, -30], [22, 45, -30],
    ]);
  });

  it('renames the default layout and keeps its reusable library entry in sync', () => {
    useProjectStore.getState().newProject();
    const original = useProjectStore.getState().project.layouts[0]!;

    useProjectStore.getState().renameActiveLayout('Frontal language array');

    const state = useProjectStore.getState();
    expect(state.project.layouts.find((layout) => layout.id === original.id)?.name)
      .toBe('Frontal language array');
    expect(state.library.find((layout) => layout.id === original.id)?.name)
      .toBe('Frontal language array');
  });

  it('loads archived instances without cloning their layout definitions again', () => {
    useProjectStore.getState().newProject();
    const layoutId = useProjectStore.getState().activeLayoutId;
    useProjectStore.getState().placeLayout(layoutId);
    const archived = structuredClone(useProjectStore.getState().project);
    const expectedLayouts = archived.layouts.length;

    useProjectStore.getState().loadProject(archived);
    expect(useProjectStore.getState().project.layouts).toHaveLength(expectedLayouts);

    useProjectStore.getState().loadProject(structuredClone(useProjectStore.getState().project));
    expect(useProjectStore.getState().project.layouts).toHaveLength(expectedLayouts);
  });

  it('uses an ASCII-safe name for placed patch layouts', () => {
    useProjectStore.getState().newProject();
    useProjectStore.getState().placeLayout(useProjectStore.getState().activeLayoutId);
    const instance = useProjectStore.getState().project.instances[0]!;
    const layout = useProjectStore.getState().project.layouts
      .find((candidate) => candidate.id === instance.definitionId);
    expect(layout?.name).toBe('default P01');
    expect(layout?.name).not.toContain('·');
  });

  it('starts with an editable Shimadzu LABNIRS BIDS profile', () => {
    useProjectStore.getState().newProject();
    expect(useProjectStore.getState().bidsSettingsExpanded).toBe(false);
    expect(useProjectStore.getState().project.projectionSettings.defaultDepthMm).toBe(25);
    expect(getMissingBidsFields(useProjectStore.getState().project).map((field) => field.key))
      .toEqual(['samplingFrequencyHz']);
    expect(useProjectStore.getState().project.deviceProfile).toMatchObject({
      manufacturer: 'Shimadzu',
      model: 'LABNIRS',
      wavelengthsNm: [780, 805, 830],
      measurementType: 'NIRSCWAMPLITUDE',
    });
    useProjectStore.getState().setBidsSettings({ subjectLabel: '007', taskLabel: 'motor' });
    useProjectStore.getState().setDeviceProfile({ samplingFrequencyHz: 36 });
    expect(useProjectStore.getState().project.bidsSettings.subjectLabel).toBe('007');
    expect(useProjectStore.getState().project.deviceProfile.samplingFrequencyHz).toBe(36);
    expect(getMissingBidsFields(useProjectStore.getState().project)).toEqual([]);
  });
});
