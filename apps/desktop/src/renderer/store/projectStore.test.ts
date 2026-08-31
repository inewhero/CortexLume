import { describe, expect, it } from 'vitest';
import type { ProjectionResult } from '@cortexlume/contracts';
import { BUILTIN_PATCH_LAYOUTS, BUILTIN_PATCH_PRESETS } from '@cortexlume/core';
import { getMissingBidsFields } from '../lib/bidsValidation';
import { patchLibraryEntryKey, useProjectStore } from './projectStore';

describe('default optode matrix', () => {
  it('tracks persisted dirty state from project content without revision bookkeeping', () => {
    useProjectStore.getState().newProject();
    expect(useProjectStore.getState().isProjectDirty()).toBe(false);
    const revision = useProjectStore.getState().projectRevision;
    useProjectStore.getState().setProjectName('Changed without revision bookkeeping');
    expect(useProjectStore.getState().projectRevision).toBe(revision);
    expect(useProjectStore.getState().isProjectDirty()).toBe(true);
    const saved = structuredClone(useProjectStore.getState().project);
    useProjectStore.getState().markProjectSaved(saved, 'C:\\saved.cortexlume');
    expect(useProjectStore.getState().isProjectDirty()).toBe(false);
  });
  it('starts with neutral gray- and white-matter materials', () => {
    expect(useProjectStore.getState().anatomyAppearance).toEqual({
      grayMatter: { color: '#e3e3e3', opacity: 1 },
      whiteMatter: { color: '#fffbf0', opacity: 1 },
    });
  });

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

  it('preserves channel numbers and reports a conflict when renumbering would duplicate one', () => {
    useProjectStore.getState().newProject();
    const layout = useProjectStore.getState().project.layouts.find(
      (candidate) => candidate.id === useProjectStore.getState().activeLayoutId,
    )!;
    const first = layout.pairs[0]!;
    const second = layout.pairs[1]!;
    const original = first.channelNumber;

    useProjectStore.getState().updatePairChannelNumber(first.id, second.channelNumber!);

    const state = useProjectStore.getState();
    const updated = state.project.layouts.find((candidate) => candidate.id === layout.id)!;
    expect(updated.pairs.find((pair) => pair.id === first.id)?.channelNumber).toBe(original);
    expect(state.toast).toBe(
      `Channel number conflict: CH${second.channelNumber} is already assigned in this layout. Existing channel numbers were preserved.`,
    );
    expect(new Set(updated.pairs.map((pair) => pair.channelNumber)).size).toBe(updated.pairs.length);

    useProjectStore.getState().updatePairChannelNumber(first.id, 99);
    expect(useProjectStore.getState().toast).toBeNull();
    expect(useProjectStore.getState().project.layouts.find((candidate) => candidate.id === layout.id)
      ?.pairs.find((pair) => pair.id === first.id)?.channelNumber).toBe(99);
  });

  it('does not mutate project geometry when selecting a channel already in group mode', () => {
    useProjectStore.getState().newProject();
    useProjectStore.getState().placeLayout(useProjectStore.getState().activeLayoutId);
    const before = useProjectStore.getState();
    const instance = before.project.instances[0]!;
    const layout = before.project.layouts.find((candidate) => candidate.id === instance.definitionId)!;
    const projectReference = before.project;
    const updatedAt = before.project.updatedAt;
    before.selectChannel(instance.id, layout.pairs[0]!.id);
    const after = useProjectStore.getState();
    expect(after.project).toBe(projectReference);
    expect(after.project.updatedAt).toBe(updatedAt);
    expect(after.selectedHeadPairId).toBe(layout.pairs[0]!.id);
  });

  it('keeps pair depth overrides independent across copied layout instances', () => {
    useProjectStore.getState().newProject();
    const layoutId = useProjectStore.getState().activeLayoutId;
    const firstId = useProjectStore.getState().placeLayout(layoutId)!;
    const secondId = useProjectStore.getState().placeLayout(layoutId)!;
    const state = useProjectStore.getState();
    const first = state.project.instances.find((instance) => instance.id === firstId)!;
    const second = state.project.instances.find((instance) => instance.id === secondId)!;
    const firstLayout = state.project.layouts.find((layout) => layout.id === first.definitionId)!;
    const secondLayout = state.project.layouts.find((layout) => layout.id === second.definitionId)!;
    expect(secondLayout.pairs[0]!.id).toBe(firstLayout.pairs[0]!.id);

    state.setPairDepthOverride(first.id, firstLayout.pairs[0]!.id, 37);
    const updated = useProjectStore.getState().project.instances;
    expect(updated.find((instance) => instance.id === first.id)?.pairDepthOverridesMm)
      .toEqual({ [firstLayout.pairs[0]!.id]: 37 });
    expect(updated.find((instance) => instance.id === second.id)?.pairDepthOverridesMm).toEqual({});
  });

  it('renames the default layout and keeps its reusable library entry in sync', () => {
    useProjectStore.getState().newProject();
    const original = useProjectStore.getState().project.layouts[0]!;

    useProjectStore.getState().renameActiveLayout('Frontal language array');

    const state = useProjectStore.getState();
    expect(state.project.layouts.find((layout) => layout.id === original.id)?.name)
      .toBe('Frontal language array');
    expect(state.library.find((entry) => entry.source === 'project' && entry.layout.id === original.id)?.layout.name)
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

  it('overlays five built-in presets without persisting them or changing dirty state', () => {
    useProjectStore.getState().newProject();
    const state = useProjectStore.getState();
    const projectLayoutIds = new Set(state.project.layouts.map((layout) => layout.id));

    expect(BUILTIN_PATCH_LAYOUTS).toHaveLength(5);
    expect(state.library.slice(0, 5).map((entry) => entry.layout.id))
      .toEqual(BUILTIN_PATCH_LAYOUTS.map((layout) => layout.id));
    expect(BUILTIN_PATCH_LAYOUTS.every((layout) => !projectLayoutIds.has(layout.id))).toBe(true);
    expect(projectLayoutIds.has(state.activeLayoutId)).toBe(true);
    expect(state.isProjectDirty()).toBe(false);
  });

  it('keeps a legacy project layout when its UUID collides with a built-in layout UUID', () => {
    useProjectStore.getState().newProject();
    const colliding = structuredClone(useProjectStore.getState().project);
    colliding.layouts[0]!.id = BUILTIN_PATCH_LAYOUTS[0]!.id;
    colliding.layouts[0]!.name = 'Legacy project collision';

    useProjectStore.getState().loadProject(colliding);

    const state = useProjectStore.getState();
    const matches = state.library.filter((entry) => entry.layout.id === BUILTIN_PATCH_LAYOUTS[0]!.id);
    expect(matches).toHaveLength(2);
    expect(matches.map((entry) => entry.source)).toEqual(['builtin-rule', 'project']);
    expect(state.project.layouts[0]!.name).toBe('Legacy project collision');
    expect(state.activeLayoutId).toBe(colliding.layouts[0]!.id);
    expect(state.isProjectDirty()).toBe(false);

    const builtin = matches.find((entry) => entry.source === 'builtin-rule')!;
    state.copyLayoutToEditor(patchLibraryEntryKey(builtin));
    expect(useProjectStore.getState().project.layouts.some((layout) => layout.name === '1S4D cross 30 mm'))
      .toBe(true);
    expect(useProjectStore.getState().project.layouts.some((layout) => layout.name === 'Legacy project collision'))
      .toBe(true);
  });

  it('loads an older project without injecting built-ins into its graph or marking it dirty', () => {
    useProjectStore.getState().newProject();
    useProjectStore.getState().placeLayout(useProjectStore.getState().activeLayoutId);
    const archived = structuredClone(useProjectStore.getState().project);
    const archivedGraph = JSON.stringify(archived);

    useProjectStore.getState().loadProject(archived);

    const state = useProjectStore.getState();
    expect(JSON.stringify(state.project)).toBe(archivedGraph);
    expect(state.isProjectDirty()).toBe(false);
    expect(state.project.layouts.some((layout) => BUILTIN_PATCH_LAYOUTS
      .some((builtin) => builtin.id === layout.id))).toBe(false);
    expect(state.project.layouts.some((layout) => layout.id === state.activeLayoutId)).toBe(true);
  });

  it('copies a built-in into an editable project layout without mutating the preset', () => {
    useProjectStore.getState().newProject();
    const preset = BUILTIN_PATCH_PRESETS[2]!;
    const frozenGraph = JSON.stringify(preset.layout);
    const entry = useProjectStore.getState().library.find((candidate) => candidate.source === 'builtin-rule'
      && candidate.presetId === preset.id)!;
    const copyId = useProjectStore.getState().copyLayoutToEditor(patchLibraryEntryKey(entry))!;

    expect(copyId).not.toBe(preset.layout.id);
    expect(useProjectStore.getState().activeLayoutId).toBe(copyId);
    expect(useProjectStore.getState().project.layouts.some((layout) => layout.id === copyId)).toBe(true);

    useProjectStore.getState().renameActiveLayout('Editable motor patch');
    const copiedOptode = useProjectStore.getState().project.layouts
      .find((layout) => layout.id === copyId)!.optodes[0]!;
    useProjectStore.getState().moveOptode(copiedOptode.id, [7, 11]);

    expect(useProjectStore.getState().project.layouts.find((layout) => layout.id === copyId))
      .toMatchObject({ name: 'Editable motor patch' });
    expect(JSON.stringify(preset.layout)).toBe(frozenGraph);
    expect(Object.isFrozen(preset.layout)).toBe(true);
    expect(useProjectStore.getState().isProjectDirty()).toBe(true);
  });

  it('keeps the 3x5 preset mapped as three rows by five columns', () => {
    const preset = BUILTIN_PATCH_PRESETS.find((candidate) => candidate.id === 'grid-3x5-30mm')!;
    const xs = new Set(preset.layout.optodes.map((optode) => optode.uvMm[0]));
    const ys = new Set(preset.layout.optodes.map((optode) => optode.uvMm[1]));

    expect(preset).toMatchObject({ rows: 3, columns: 5, pitchMm: 30 });
    expect(xs.size).toBe(5);
    expect(ys.size).toBe(3);
    expect(preset.layout).toMatchObject({ optodes: expect.any(Array), pairs: expect.any(Array) });
    expect(preset.layout.optodes).toHaveLength(15);
    expect(preset.layout.pairs).toHaveLength(22);
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

  it('attaches and removes confirmed digitizer geometry from a patch', () => {
    useProjectStore.getState().newProject();
    useProjectStore.getState().placeLayout(useProjectStore.getState().activeLayoutId);
    const state = useProjectStore.getState();
    const instance = state.project.instances[0]!;
    const layout = state.project.layouts.find((candidate) => candidate.id === instance.definitionId)!;
    const optode = layout.optodes[0]!;
    const pointId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const session = {
      id: sessionId, name: 'digitizer', importedAt: new Date().toISOString(), source: { format: 'TSV', fileName: 'points.tsv', sha256: 'abc' },
      points: [{ id: pointId, label: optode.label, kind: optode.type, rawPosition: [0, 0, 0] }],
      calibratedPoints: [{ pointId, rasMm: [-50, 20, 80] }],
      calibration: { method: 'five-point-similarity', sourceUnit: 'mm', matrix: Array(16).fill(0), scale: 1, rmsResidualMm: 1, maxResidualMm: 2, residuals: [], calibratedAt: new Date().toISOString() },
      optodeMappings: [], visible: true,
    } as never;
    const mappings = [{ pointId, instanceId: instance.id, optodeId: optode.id, distanceMm: 3 }];
    useProjectStore.getState().confirmDigitizerMapping(session, mappings);
    const mappedState = useProjectStore.getState();
    const derived = mappedState.project.instances.find((candidate) => candidate.derivedFromInstanceId === instance.id)!;
    expect(mappedState.project.instances.find((candidate) => candidate.id === instance.id)?.visible).toBe(false);
    expect(derived.digitizerPositions[0]).toMatchObject({ optodeId: optode.id, scalpRasMm: [-50, 20, 80] });
    expect(mappedState.library.find((entry) => entry.source === 'project'
      && entry.layout.id === derived.definitionId)?.layout.name).toBe(`${layout.name}D`);
    useProjectStore.getState().commitPlacement({
      ...derived,
      // The science wire DTO does not carry these desktop-only fields.
      digitizerPositions: [],
      derivedFromInstanceId: null,
      digitizerSessionId: null,
    }, []);
    expect(useProjectStore.getState().project.instances.find((candidate) => candidate.id === derived.id))
      .toMatchObject({
        derivedFromInstanceId: instance.id,
        digitizerSessionId: sessionId,
        digitizerPositions: [{ optodeId: optode.id, digitizerPointId: pointId }],
      });
    useProjectStore.getState().removeDigitizerSession(sessionId);
    const restoredState = useProjectStore.getState();
    expect(restoredState.project.instances).toHaveLength(1);
    expect(restoredState.project.instances[0]).toMatchObject({ id: instance.id, visible: true, digitizerPositions: [] });
  });

  it('creates a derived library patch for five-point-only calibration', () => {
    useProjectStore.getState().newProject();
    useProjectStore.getState().placeLayout(useProjectStore.getState().activeLayoutId);
    const original = useProjectStore.getState().project.instances[0]!;
    const sessionId = crypto.randomUUID();
    const session = {
      id: sessionId, name: 'five-point', importedAt: new Date().toISOString(),
      source: { format: 'MANUAL', fileName: null, sha256: null }, points: [], calibratedPoints: [],
      calibration: { method: 'five-point-similarity', sourceUnit: 'mm', matrix: Array(16).fill(0), scale: 1, rmsResidualMm: 1, maxResidualMm: 2, residuals: [], calibratedAt: new Date().toISOString() },
      optodeMappings: [], visible: true,
    } as never;
    useProjectStore.getState().confirmFivePointCalibration(session, [original.id]);
    const calibrated = useProjectStore.getState();
    const derived = calibrated.project.instances.find((candidate) => candidate.derivedFromInstanceId === original.id)!;
    expect(calibrated.project.instances.find((candidate) => candidate.id === original.id)?.visible).toBe(false);
    expect(derived).toMatchObject({ visible: true, digitizerSessionId: sessionId, digitizerPositions: [] });
    expect(calibrated.library.some((entry) => entry.source === 'project'
      && entry.layout.id === derived.definitionId)).toBe(true);
  });

  it('invalidates only the edited instance when resetting a local offset', () => {
    useProjectStore.getState().newProject();
    const layoutId = useProjectStore.getState().activeLayoutId;
    const firstId = useProjectStore.getState().placeLayout(layoutId)!;
    const secondId = useProjectStore.getState().placeLayout(layoutId)!;
    const state = useProjectStore.getState();
    const first = state.project.instances.find((instance) => instance.id === firstId)!;
    const second = state.project.instances.find((instance) => instance.id === secondId)!;
    const firstLayout = state.project.layouts.find((layout) => layout.id === first.definitionId)!;
    const secondLayout = state.project.layouts.find((layout) => layout.id === second.definitionId)!;
    const firstOptodeId = firstLayout.optodes[0]!.id;
    const secondOptodeId = secondLayout.optodes[0]!.id;
    const fitQc = {
      converged: true,
      iterations: 2,
      meanAbsoluteErrorMm: 0.5,
      maxAbsoluteErrorMm: 1,
      flags: [],
    };
    const verified = (instanceId: string, subjectId: string): ProjectionResult => ({
      instanceId,
      subjectKind: 'optode',
      subjectId,
      scalpRasMm: [0, 0, 0],
      displayRasMm: null,
      corticalRasMm: null,
      depthTargetRasMm: null,
      underlyingCorticalRegions: [],
      deepTargetStructures: [],
      tissueAtTarget: null,
      claimLevel: 'geometric',
      status: 'verified',
      qcFlags: [],
    });

    useProjectStore.getState().commitPlacement({
      ...first,
      overrides: [{ optodeId: firstOptodeId, uvMm: [1, 2] }],
      fitQc,
    }, [verified(first.id, crypto.randomUUID())]);
    useProjectStore.getState().commitPlacement({
      ...second,
      overrides: [{ optodeId: secondOptodeId, uvMm: [3, 4] }],
      fitQc,
    }, [verified(second.id, crypto.randomUUID())]);

    useProjectStore.getState().resetInstanceOverride(first.id, firstOptodeId);

    const after = useProjectStore.getState().project;
    const firstAfter = after.instances.find((instance) => instance.id === first.id)!;
    const secondAfter = after.instances.find((instance) => instance.id === second.id)!;
    expect(firstAfter.overrides).toEqual([]);
    expect(firstAfter.fitQc).toBeUndefined();
    expect(after.verifiedResults.map((result) => result.instanceId)).toEqual([second.id]);
    expect(secondAfter.overrides).toEqual([{ optodeId: secondOptodeId, uvMm: [3, 4] }]);
    expect(secondAfter.fitQc).toEqual(fitQc);
  });
});
