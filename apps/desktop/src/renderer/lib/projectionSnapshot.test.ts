import { beforeEach, describe, expect, it } from 'vitest';
import { registerVerifiedTestSurfaceProjectors } from './testSurfaceProjectors';
import { useProjectStore } from '../store/projectStore';
import { materializeProjectionSnapshot } from './projectionSnapshot';

describe('projection snapshot fit QC', () => {
  beforeEach(() => registerVerifiedTestSurfaceProjectors());

  it('does not report convergence when there are no valid pair-distance samples', () => {
    useProjectStore.getState().newProject();
    useProjectStore.getState().placeLayout(useProjectStore.getState().activeLayoutId);
    const project = structuredClone(useProjectStore.getState().project);
    project.layouts = project.layouts.map((layout) => ({ ...layout, pairs: [] }));

    const materialized = materializeProjectionSnapshot(project);
    expect(materialized.instances).not.toHaveLength(0);
    expect(materialized.instances[0]!.fitQc).toMatchObject({
      converged: false,
      iterations: 0,
      meanAbsoluteErrorMm: 0,
      maxAbsoluteErrorMm: 0,
      flags: expect.arrayContaining(['no_valid_distance_samples']),
    });
  });
});
