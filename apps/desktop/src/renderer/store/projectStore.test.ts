import { describe, expect, it } from 'vitest';
import { useProjectStore } from './projectStore';

describe('default optode matrix', () => {
  it('numbers optodes down columns and channels across rows', () => {
    const layout = useProjectStore.getState().project.layouts[0]!;
    const byCoordinate = new Map(layout.optodes.map((optode) => [optode.uvMm.join(','), optode]));
    expect([
      [byCoordinate.get('-60,30')?.label, byCoordinate.get('-30,30')?.label, byCoordinate.get('0,30')?.label, byCoordinate.get('30,30')?.label, byCoordinate.get('60,30')?.label],
      [byCoordinate.get('-60,0')?.label, byCoordinate.get('-30,0')?.label, byCoordinate.get('0,0')?.label, byCoordinate.get('30,0')?.label, byCoordinate.get('60,0')?.label],
      [byCoordinate.get('-60,-30')?.label, byCoordinate.get('-30,-30')?.label, byCoordinate.get('0,-30')?.label, byCoordinate.get('30,-30')?.label, byCoordinate.get('60,-30')?.label],
    ]).toEqual([
      ['S1', 'D2', 'S4', 'D5', 'S7'],
      ['D1', 'S3', 'D4', 'S6', 'D7'],
      ['S2', 'D3', 'S5', 'D6', 'S8'],
    ]);

    const byId = new Map(layout.optodes.map((optode) => [optode.id, optode]));
    const midpoints = layout.pairs.map((pair) => {
      const source = byId.get(pair.sourceId)!;
      const detector = byId.get(pair.detectorId)!;
      return [pair.channelNumber, (source.uvMm[0] + detector.uvMm[0]) / 2, (source.uvMm[1] + detector.uvMm[1]) / 2];
    });
    expect(midpoints).toEqual([
      [1, -45, 30], [2, -15, 30], [3, 15, 30], [4, 45, 30],
      [5, -60, 15], [6, -30, 15], [7, 0, 15], [8, 30, 15], [9, 60, 15],
      [10, -45, 0], [11, -15, 0], [12, 15, 0], [13, 45, 0],
      [14, -60, -15], [15, -30, -15], [16, 0, -15], [17, 30, -15], [18, 60, -15],
      [19, -45, -30], [20, -15, -30], [21, 15, -30], [22, 45, -30],
    ]);
  });
});
