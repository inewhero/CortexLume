import { describe, expect, it } from 'vitest';
import type { FunctionalTargetMap } from '@cortexlume/contracts';
import { useProjectStore } from './projectStore';

describe('anatomical coverage view state', () => {
  it('makes Quick Target and anatomical coverage explicitly mutually exclusive', () => {
    useProjectStore.getState().newProject();
    useProjectStore.getState().setAnatomyLayer('grayMatter', true);
    useProjectStore.getState().setAnatomyLayer('whiteMatter', false);
    useProjectStore.getState().setFunctionalTarget({} as FunctionalTargetMap);
    useProjectStore.getState().setAnatomicalCoverageEnabled(true);
    expect(useProjectStore.getState().functionalTarget).toBeNull();
    expect(useProjectStore.getState().anatomicalCoverageEnabled).toBe(true);

    useProjectStore.getState().setFunctionalTarget({} as FunctionalTargetMap);
    expect(useProjectStore.getState().anatomicalCoverageEnabled).toBe(false);
    expect(useProjectStore.getState().functionalTarget).not.toBeNull();
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
