// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadQuickTarget,
  searchQuickTargets,
} from './quickTarget';

const setBridge = (science: Record<string, unknown>) => {
  Object.defineProperty(window, 'cortexlume', { configurable: true, value: { science } });
};

describe('Quick Target renderer adapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes catalog responses without leaking bridge-specific field names', async () => {
    setBridge({
      quickTargetSearch: vi.fn().mockResolvedValue({ results: [
        { slug: 'working-memory', term: 'Working memory', study_count: 1091, aliases: ['memory'], domain: 'Memory & Learning', subdomain: 'Working Memory' },
      ] }),
      quickTargetMap: vi.fn(),
    });

    await expect(searchQuickTargets('working')).resolves.toEqual([{
      id: 'working-memory', label: 'Working memory', studyCount: 1091, aliases: ['memory'],
      domain: 'Memory & Learning', subdomain: 'Working Memory',
      description: undefined, peakRegions: [], laterality: undefined,
    }]);
  });

  it('returns the complete functional map for the shared renderer store', async () => {
    const map = {
      target: { id: 'inhibition', label: 'Response inhibition', aliases: [], peakRegions: [] },
      vertexCount: 25_000 as const,
      vertexIndices: [10, 20], values: [2.1, 6.2],
      provenance: { sourceKind: 'neurosynth-quick' as const, sourceSpace: 'MNI152', targetSpace: 'MNI152NLin6Asym' as const, targetSurface: 'Cedalion-ICBM152-25k' as const, statistic: 'association z', mapSha256: 'abc' },
    };
    setBridge({
      quickTargetSearch: vi.fn(),
      quickTargetMap: vi.fn().mockResolvedValue(map),
    });
    await expect(loadQuickTarget('inhibition')).resolves.toBe(map);
  });
});
