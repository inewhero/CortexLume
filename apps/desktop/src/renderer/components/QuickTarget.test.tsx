// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuickTarget } from './QuickTarget';
import type { QuickTargetSummary } from '@cortexlume/contracts';

const target: QuickTargetSummary = {
  id: 'working-memory', label: 'Working memory', studyCount: 1091,
  aliases: [], domain: 'Memory & Learning', subdomain: 'Working Memory',
  laterality: 'bilateral', peakRegions: ['Middle frontal gyrus'],
  description: 'Positive FDR-corrected Neurosynth association z map.',
};

const setBridge = (science: Record<string, unknown>) => {
  Object.defineProperty(window, 'cortexlume', { configurable: true, value: { science } });
};

describe('QuickTarget', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('starts with discoverable targets and delegates selection by id', async () => {
    const onSelect = vi.fn().mockResolvedValue(undefined);
    setBridge({
      quickTargetSearch: vi.fn().mockResolvedValue([{ id: 'working-memory', label: 'Working memory', studyCount: 1091 }]),
      quickTargetMap: vi.fn(),
    });
    render(<QuickTarget selectedTarget={null} onSelect={onSelect} onClear={vi.fn()} />);

    const toggle = screen.getByRole('button', { name: /functional target/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('searchbox', { hidden: true }).closest('.quick-target-body')).toHaveAttribute('aria-hidden', 'true');
    fireEvent.click(toggle);
    const result = await screen.findByRole('button', { name: /working memory/i });
    fireEvent.click(result);
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('working-memory'));
  });

  it('shows the curated domain and subdomain in search results', async () => {
    setBridge({
      quickTargetSearch: vi.fn().mockResolvedValue([target]),
      quickTargetMap: vi.fn(),
    });
    render(<QuickTarget selectedTarget={null} onSelect={vi.fn()} onClear={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /functional target/i }));
    expect(await screen.findByText('Memory & Learning / Working Memory')).toBeInTheDocument();
  });

  it('summarizes the active target without representing the 2D grid as anatomy', () => {
    const onClear = vi.fn();
    setBridge({ quickTargetSearch: vi.fn(), quickTargetMap: vi.fn() });
    render(<QuickTarget selectedTarget={target} onSelect={vi.fn()} onClear={onClear} />);

    fireEvent.click(screen.getByRole('button', { name: /functional target/i }));
    expect(screen.getByText('HEATMAP ACTIVE IN 3D ALIGN.')).toBeInTheDocument();
    expect(screen.getByText('Memory & Learning / Working Memory')).toBeInTheDocument();
    expect(screen.getByText('Middle frontal gyrus')).toBeInTheDocument();
    expect(document.querySelector('.target-heat-strip')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Neurosynth' })).toHaveAttribute('href', 'https://compose.neurosynth.org/');
    fireEvent.click(screen.getByRole('button', { name: /clear working memory target/i }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it('keeps the current target while opening the replacement search', async () => {
    setBridge({
      quickTargetSearch: vi.fn().mockResolvedValue([{ id: 'language', label: 'Language' }]),
      quickTargetMap: vi.fn(),
    });
    render(<QuickTarget selectedTarget={target} onSelect={vi.fn()} onClear={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /functional target/i }));
    fireEvent.click(screen.getByRole('button', { name: 'QUICK TARGET' }));

    expect(screen.getByText(/current layout will not change/i)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /language/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'CANCEL' }));
    expect(screen.getByText('HEATMAP ACTIVE IN 3D ALIGN.')).toBeInTheDocument();
  });

  it('retries the failed map selection rather than rerunning an unrelated search', async () => {
    const onSelect = vi.fn()
      .mockRejectedValueOnce(new Error('Map pack read failed.'))
      .mockResolvedValueOnce(undefined);
    setBridge({
      quickTargetSearch: vi.fn().mockResolvedValue([{ id: 'motor', label: 'Motor' }]),
      quickTargetMap: vi.fn(),
    });
    render(<QuickTarget selectedTarget={null} onSelect={onSelect} onClear={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /functional target/i }));
    fireEvent.click(await screen.findByRole('button', { name: /motor/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Map pack read failed.');
    fireEvent.click(screen.getByRole('button', { name: 'RETRY' }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(2));
    expect(onSelect).toHaveBeenLastCalledWith('motor');
  });
});
