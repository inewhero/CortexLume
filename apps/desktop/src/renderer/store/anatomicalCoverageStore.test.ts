import { describe, expect, it } from 'vitest';
import type { FunctionalTargetMap } from '@cortexlume/contracts';
import { useProjectStore } from './projectStore';

describe('anatomical coverage view state', () => {
  it('makes Functional Target and anatomical coverage visually exclusive without deleting target data', () => {
    useProjectStore.getState().newProject();
    useProjectStore.getState().setAnatomyLayer('grayMatter', true);
    useProjectStore.getState().setAnatomyLayer('whiteMatter', false);
    useProjectStore.getState().setFunctionalTarget({} as FunctionalTargetMap);
    useProjectStore.getState().setAnatomicalCoverageEnabled(true);
    expect(useProjectStore.getState().functionalTarget).not.toBeNull();
    expect(useProjectStore.getState().anatomicalCoverageEnabled).toBe(true);
    expect(useProjectStore.getState().project.surfaceOverlay).toBe('coverage-mosaic');

    useProjectStore.getState().setFunctionalTarget(null);
    expect(useProjectStore.getState().anatomicalCoverageEnabled).toBe(true);
    expect(useProjectStore.getState().project.surfaceOverlay).toBe('coverage-mosaic');
    useProjectStore.getState().setFunctionalTarget({} as FunctionalTargetMap);

    useProjectStore.getState().setFunctionalTargetVisible(true);
    expect(useProjectStore.getState().anatomicalCoverageEnabled).toBe(false);
    expect(useProjectStore.getState().functionalTarget).not.toBeNull();
    expect(useProjectStore.getState().project.surfaceOverlay).toBe('functional-target');
  });

  it('keeps GM and WM visibility independent while coverage state remains stable', () => {
    useProjectStore.getState().newProject();
    useProjectStore.getState().setAnatomyLayer('grayMatter', true);
    useProjectStore.getState().setAnatomyLayer('whiteMatter', false);
    useProjectStore.getState().setAnatomicalCoverageEnabled(true);
    useProjectStore.getState().setAnatomyLayer('grayMatter', false);
    expect(useProjectStore.getState().anatomyVisibility.grayMatter).toBe(false);
    expect(useProjectStore.getState().anatomyVisibility.whiteMatter).toBe(false);
    expect(useProjectStore.getState().anatomicalCoverageEnabled).toBe(true);

    useProjectStore.getState().setAnatomyLayer('whiteMatter', true);
    expect(useProjectStore.getState().anatomyVisibility.grayMatter).toBe(false);
    expect(useProjectStore.getState().anatomyVisibility.whiteMatter).toBe(true);
    expect(useProjectStore.getState().anatomicalCoverageEnabled).toBe(true);
  });
});
