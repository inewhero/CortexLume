import { describe, expect, it } from 'vitest';
import { CortexLumeProjectSchema, CortexLumeProjectV1Schema } from './index.js';

function legacyFixture() {
  return CortexLumeProjectV1Schema.parse({
    format: 'cortexlume-project', formatVersion: 1,
    id: '00000000-0000-4000-8000-000000000001', name: 'Legacy',
    createdAt: '2000-01-01T00:00:00.000Z', updatedAt: '2000-01-01T00:00:00.000Z',
    template: {
      id: 'MNI152NLin6Asym', assetVersion: 'fixture', coordinateConvention: 'RAS+', units: 'mm', verified: true,
      manifestSha256: 'a', scalpMeshSha256: 'b', cortexMeshSha256: 'c', atlasSha256: 'd',
    },
    layouts: [], instances: [],
    deviceProfile: {
      manufacturer: 'Shimadzu', model: 'LABNIRS', wavelengthsNm: [780, 805, 830], measurementType: 'NIRSCWAMPLITUDE',
      units: 'V', sourceType: 'LASER', detectorType: 'PMT', samplingFrequencyHz: null,
    },
    bidsSettings: { subjectLabel: '01', sessionLabel: '', taskLabel: 'layout', acquisitionLabel: '', runIndex: null },
    projectionSettings: { mode: 'scalp', defaultDepthMm: 25, pairDepthOverridesMm: {}, atlasProbabilityThreshold: 0, optodeRadiusMm: 3.6 },
    verifiedResults: [], digitizerSessions: [],
  });
}

describe('project format v2', () => {
  it('migrates v1 without changing its scientific fields', () => {
    const legacy = legacyFixture();
    const migrated = CortexLumeProjectSchema.parse(legacy);
    expect(migrated).toMatchObject({ ...legacy, formatVersion: 2 });
    expect(migrated.functionalTarget).toBeNull();
    expect(migrated.surfaceOverlay).toBe('none');
    expect(migrated.planning).toBeNull();
  });

  it('rejects unknown future versions instead of dropping their fields', () => {
    expect(() => CortexLumeProjectSchema.parse({ ...legacyFixture(), formatVersion: 3 })).toThrow();
  });
});
