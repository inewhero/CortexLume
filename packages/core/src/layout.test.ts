import { describe, expect, it } from 'vitest';
import { createGridLayout } from './layout.js';

const TIMESTAMP = '2000-01-01T00:00:00.000Z';

describe('createGridLayout', () => {
  it('builds the canonical 5 x 3 layout with established numbering', () => {
    const layout = createGridLayout({}, 'canonical-test', TIMESTAMP);

    expect(layout.optodes).toHaveLength(15);
    expect(layout.pairs).toHaveLength(22);
    expect(layout.optodes.map((optode) => optode.label)).toEqual([
      'S1', 'D1', 'S2',
      'D2', 'S3', 'D3',
      'S4', 'D4', 'S5',
      'D5', 'S6', 'D6',
      'S7', 'D7', 'S8',
    ]);
    expect(layout.pairs.map((pair) => pair.channelNumber)).toEqual(Array.from({ length: 22 }, (_, index) => index + 1));
    expect(layout.pairs.map((pair) => pair.nominalDistanceMm)).toEqual(Array(22).fill(30));
    expect(layout.pairs.every((pair) => !pair.shortChannel)).toBe(true);
  });

  it('reverses the checkerboard without changing scan order', () => {
    const layout = createGridLayout({ reverseSourceDetector: true }, 'reverse-test', TIMESTAMP);
    expect(layout.optodes.slice(0, 6).map((optode) => optode.label)).toEqual(['D1', 'S1', 'D2', 'S2', 'D3', 'S3']);
    expect(layout.pairs).toHaveLength(22);
  });

  it('adds only explicitly requested deterministic 10 mm short channels', () => {
    const layout = createGridLayout({ shortChannelCount: 2 }, 'short-test', TIMESTAMP);
    const shortPairs = layout.pairs.filter((pair) => pair.shortChannel);
    expect(layout.optodes).toHaveLength(17);
    expect(layout.pairs).toHaveLength(24);
    expect(shortPairs).toHaveLength(2);
    expect(shortPairs.map((pair) => pair.nominalDistanceMm)).toEqual([10, 10]);
    expect(shortPairs.map((pair) => pair.channelNumber)).toEqual([23, 24]);
  });

  it('rejects an active-cell mask without a connected long channel', () => {
    expect(() => createGridLayout({
      columns: 2,
      rows: 2,
      activeCells: [[true, false], [false, true]],
    }, 'disconnected-test', TIMESTAMP)).toThrow('connected long-channel');
  });
});
