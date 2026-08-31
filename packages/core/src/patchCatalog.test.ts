import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PATCH_CATALOG_VERSION,
  BUILTIN_PATCH_LAYOUTS,
  BUILTIN_PATCH_PRESETS,
  getBuiltinPatchPreset,
  instantiateBuiltinPatchLayout,
  isBuiltinPatchPresetId,
} from './patchCatalog.js';

describe('built-in patch catalog', () => {
  it('publishes the five immutable versioned presets with canonical geometry', () => {
    expect(BUILTIN_PATCH_CATALOG_VERSION).toBe(1);
    expect(BUILTIN_PATCH_PRESETS.map((preset) => preset.id)).toEqual([
      '1s4d-cross-30mm',
      'grid-2x2-30mm',
      'grid-3x3-30mm',
      'grid-3x5-30mm',
      'grid-4x4-30mm',
    ]);
    expect(BUILTIN_PATCH_LAYOUTS).toHaveLength(5);
    expect(Object.isFrozen(BUILTIN_PATCH_PRESETS)).toBe(true);
    expect(Object.isFrozen(BUILTIN_PATCH_PRESETS[0]!.layout.optodes)).toBe(true);

    const expected = {
      '1s4d-cross-30mm': [5, 4],
      'grid-2x2-30mm': [4, 4],
      'grid-3x3-30mm': [9, 12],
      'grid-3x5-30mm': [15, 22],
      'grid-4x4-30mm': [16, 24],
    } as const;
    for (const preset of BUILTIN_PATCH_PRESETS) {
      expect([preset.layout.optodes.length, preset.layout.pairs.length]).toEqual(expected[preset.id]);
      expect(preset.layout.pairs.map((pair) => pair.channelNumber))
        .toEqual(Array.from({ length: preset.layout.pairs.length }, (_, index) => index + 1));
      expect(preset.layout.pairs.every((pair) => pair.nominalDistanceMm === 30 && !pair.shortChannel)).toBe(true);
    }
  });

  it('defines 3x5 as rows by columns with a top-left source checkerboard', () => {
    const preset = getBuiltinPatchPreset('grid-3x5-30mm');
    expect(preset).toMatchObject({ rows: 3, columns: 5, pitchMm: 30 });
    const byCoordinate = new Map(preset.layout.optodes.map((optode) => [optode.uvMm.join(','), optode]));
    expect(byCoordinate.get('-60,30')).toMatchObject({ label: 'S1', type: 'source' });
    expect(byCoordinate.get('60,-30')).toMatchObject({ label: 'S8', type: 'source' });
  });

  it('instantiates stable, independent project layouts by namespace and timestamp', () => {
    const first = instantiateBuiltinPatchLayout(
      'grid-3x5-30mm', 'study:patch:0', '2026-01-01T00:00:00.000Z', { name: 'Visual patch' },
    );
    const repeated = instantiateBuiltinPatchLayout(
      'grid-3x5-30mm', 'study:patch:0', '2026-01-01T00:00:00.000Z', { name: 'Visual patch' },
    );
    const second = instantiateBuiltinPatchLayout(
      'grid-3x5-30mm', 'study:patch:1', '2026-01-01T00:00:00.000Z', { name: 'Visual patch 2' },
    );
    expect(repeated).toEqual(first);
    expect(second.id).not.toBe(first.id);
    expect(second.optodes[0]!.id).not.toBe(first.optodes[0]!.id);
    expect(first.name).toBe('Visual patch');
    expect(first.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(first).not.toBe(getBuiltinPatchPreset('grid-3x5-30mm').layout);
    expect(isBuiltinPatchPresetId('grid-3x5-30mm')).toBe(true);
    expect(isBuiltinPatchPresetId('grid-5x3-30mm')).toBe(false);
  });
});
