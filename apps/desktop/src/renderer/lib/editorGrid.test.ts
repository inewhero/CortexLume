import { describe, expect, it } from 'vitest';
import {
  COARSE_GRID_MM,
  FINE_GRID_MM,
  screenFromUv,
  snapUvToGrid,
  uvFromScreen,
} from './editorGrid';

describe('2D optode editor grid', () => {
  it('snaps positive and negative coordinates to the 10 mm fine grid', () => {
    expect(FINE_GRID_MM).toBe(10);
    expect(COARSE_GRID_MM).toBe(30);
    expect(snapUvToGrid([14.9, 25.1])).toEqual([10, 30]);
    expect(snapUvToGrid([-14.9, -25.1])).toEqual([-10, -30]);
  });

  it('keeps 30 mm coarse-grid points exact through screen conversion', () => {
    const screen = screenFromUv([60, -30], 400, 360, 2);
    expect(screen).toEqual([320, 240]);
    expect(uvFromScreen(screen, 400, 360, 2)).toEqual([60, -30]);
  });

  it('snaps a screen pointer to the nearest fine-grid intersection', () => {
    expect(uvFromScreen([227, 151], 400, 360, 2)).toEqual([10, 10]);
  });
});
