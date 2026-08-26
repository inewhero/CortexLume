// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from '../store/projectStore';
import { LayoutEditor } from './LayoutEditor';

vi.mock('react-konva', () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Circle: Container,
    Group: Container,
    Layer: Container,
    Line: Container,
    Rect: Container,
    Stage: Container,
    Text: Container,
  };
});

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

describe('LayoutEditor channel-number conflicts', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    useProjectStore.getState().newProject();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the store conflict clearly inside the channel editor', () => {
    const state = useProjectStore.getState();
    const layout = state.project.layouts.find((candidate) => candidate.id === state.activeLayoutId)!;
    state.updatePairChannelNumber(layout.pairs[0]!.id, layout.pairs[1]!.channelNumber!);

    render(<LayoutEditor />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      `CH${layout.pairs[1]!.channelNumber} is already assigned in this layout`,
    );
  });
});
