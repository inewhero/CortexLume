// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from '../store/projectStore';
import { registerSurfaceProjectors, type SurfaceModelStatus } from '../lib/geometry';
import { ProjectedPatches } from './HeadViewport';

afterEach(cleanup);

describe('HeadViewport surface readiness', () => {
  it('can render an existing instance while loading without invoking a projector', () => {
    useProjectStore.getState().newProject();
    useProjectStore.getState().placeLayout(useProjectStore.getState().activeLayoutId);
    const project = structuredClone(useProjectStore.getState().project);
    const scalp = vi.fn((point) => point);
    const scalpSphereCenter = vi.fn((point) => point);
    const cortex = vi.fn((point) => point);
    const unregister = registerSurfaceProjectors({
      scalp, scalpSphereCenter, cortex,
      verified: true,
      source: 'test projector spies',
    });
    const loading: SurfaceModelStatus = {
      state: 'loading', ready: false, verified: false, source: null,
      issue: 'HeadModel surfaces are loading.',
    };

    expect(() => render(
      <ProjectedPatches project={project} surfaceRevision={0} surfaceStatus={loading} />,
    )).not.toThrow();
    expect(scalp).not.toHaveBeenCalled();
    expect(scalpSphereCenter).not.toHaveBeenCalled();
    expect(cortex).not.toHaveBeenCalled();
    unregister();
  });
});
