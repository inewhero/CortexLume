import { describe, expect, it } from 'vitest';
import {
  BidsSettingsSchema,
  DeviceProfileSchema,
  FunctionalTargetMapSchema,
  LayoutDefinitionSchema,
  ProjectionSettingsSchema,
} from './index';

describe('LayoutDefinitionSchema', () => {
  it('rejects non-UUID optode identifiers', () => {
    const parsed = LayoutDefinitionSchema.safeParse({
      id: crypto.randomUUID(),
      version: 1,
      name: 'test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      gridSpacingMm: 5,
      optodes: [{ id: 'S1', label: 'S1', type: 'source', uvMm: [0, 0] }],
      pairs: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('migrates legacy projection modes to scalp and cortex', () => {
    expect(ProjectionSettingsSchema.parse({ mode: 'surface' }).mode).toBe('scalp');
    expect(ProjectionSettingsSchema.parse({ mode: 'anatomical_depth' }).mode).toBe('cortex');
    expect(ProjectionSettingsSchema.parse({ mode: 'scalp' }).optodeRadiusMm).toBe(3.6);
  });

  it('provides a Shimadzu LABNIRS BIDS profile by default', () => {
    expect(DeviceProfileSchema.parse({})).toMatchObject({
      manufacturer: 'Shimadzu',
      model: 'LABNIRS',
      wavelengthsNm: [780, 805, 830],
      measurementType: 'NIRSCWAMPLITUDE',
      units: 'V',
      sourceType: 'LASER',
      detectorType: 'PMT',
    });
    expect(DeviceProfileSchema.parse({ measurementType: 'CW_AMPLITUDE' }).measurementType)
      .toBe('NIRSCWAMPLITUDE');
    expect(DeviceProfileSchema.parse({ wavelengthsNm: [] }).wavelengthsNm)
      .toEqual([780, 805, 830]);
    expect(BidsSettingsSchema.parse({})).toMatchObject({
      subjectLabel: '01',
      taskLabel: 'layout',
    });
  });

  it('accepts only ordered finite positive values on the locked 25k target surface', () => {
    const base = {
      target: { id: 'memory', label: 'Memory' },
      vertexCount: 25_000,
      vertexIndices: [4, 17],
      values: [2.1, 4.8],
      provenance: {
        sourceKind: 'neurosynth-quick',
        sourceSpace: 'MNI152',
        targetSpace: 'MNI152NLin6Asym',
        targetSurface: 'Cedalion-ICBM152-25k',
        statistic: 'association-test z',
        mapSha256: 'fixture',
      },
    };
    expect(FunctionalTargetMapSchema.parse(base).vertexIndices).toEqual([4, 17]);
    expect(FunctionalTargetMapSchema.safeParse({ ...base, vertexIndices: [17, 4] }).success).toBe(false);
    expect(FunctionalTargetMapSchema.safeParse({ ...base, values: [2.1, Number.NaN] }).success).toBe(false);
  });
});
