// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_PATCH_LAYOUTS } from '@cortexlume/core';
import { useProjectStore } from '../store/projectStore';
import { LayoutLibrary } from './LayoutLibrary';

describe('LayoutLibrary built-in overlay', () => {
  beforeEach(() => useProjectStore.getState().newProject());
  afterEach(cleanup);

  it('shows only the five editable rule presets with consistent actions', () => {
    render(<LayoutLibrary />);

    expect(screen.getAllByText('BUILT-IN')).toHaveLength(5);
    expect(screen.queryByText(/10[–-](?:5|10|20)/)).not.toBeInTheDocument();
    expect(screen.getByText(/3 rows × 5 columns/)).toBeInTheDocument();
    expect(screen.getByText(/Built-in templates use nominal 30 mm spacing/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'EDIT' })).toHaveLength(6);
    expect(screen.getAllByRole('button', { name: 'LOAD TO 3D' })).toHaveLength(6);
    expect(screen.getAllByRole('button', { name: /Remove .* from library/ })).toHaveLength(6);

    const beforeLayouts = useProjectStore.getState().project.layouts.length;
    fireEvent.click(screen.getAllByRole('button', { name: 'EDIT' })[0]!);

    const state = useProjectStore.getState();
    expect(state.project.layouts).toHaveLength(beforeLayouts + 1);
    expect(state.project.layouts.some((layout) => layout.id === state.activeLayoutId)).toBe(true);
    expect(BUILTIN_PATCH_LAYOUTS.some((layout) => layout.id === state.activeLayoutId)).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Remove 2x2 grid 30 mm from library' }));
    expect(screen.queryByText('2x2 grid 30 mm')).not.toBeInTheDocument();
    expect(useProjectStore.getState().project.layouts).toHaveLength(beforeLayouts + 1);
  });
});
