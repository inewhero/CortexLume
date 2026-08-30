// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from '../store/projectStore';
import { registerSurfaceProjectors, type SurfaceModelStatus } from '../lib/geometry';
import { ProjectedPatches, ProjectOperationBubble, ScientificScreenshotButton } from './HeadViewport';

afterEach(cleanup);

describe('HeadViewport surface readiness', () => {
  it('renders a minimal accessible screenshot action and prevents duplicate capture while pending', () => {
    const onClick = vi.fn();
    const { rerender } = render(<ScientificScreenshotButton pending={false} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save transparent 3D scene screenshot' }));
    expect(onClick).toHaveBeenCalledOnce();
    rerender(<ScientificScreenshotButton pending onClick={onClick} />);
    expect(screen.getByRole('button', { name: 'Save transparent 3D scene screenshot' })).toBeDisabled();
    rerender(<ScientificScreenshotButton pending={false} sceneReady={false} onClick={onClick} />);
    expect(screen.getByRole('button', { name: 'Save transparent 3D scene screenshot' })).toBeDisabled();
    expect(screen.getByRole('button')).toHaveAttribute('title', 'Wait for the scientific 3D scene to finish loading');
  });

  it('renders project operation progress as a cancellable 3D viewport bubble', () => {
    const onCancel = vi.fn();
    render(<ProjectOperationBubble progress={{
      operationId: 'export-1', operation: 'annotation', phase: 'atlas-paths', completed: 7, total: 20,
    }} onCancel={onCancel} />);

    expect(screen.getByRole('status')).toHaveTextContent('PREPARING SCIENTIFIC EXPORT');
    expect(screen.getByRole('status')).toHaveTextContent('ATLAS PATHS · 7/20');
    fireEvent.click(screen.getByRole('button', { name: 'CANCEL' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

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
