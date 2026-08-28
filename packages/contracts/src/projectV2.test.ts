import { describe, expect, it } from 'vitest';
import { CortexLumeProjectSchema, CortexLumeProjectV1Schema, CortexLumeProjectV2Schema } from './index.js';

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
    projectionSettings: { mode: 'scalp', defaultDepthMm: 25, atlasProbabilityThreshold: 0, optodeRadiusMm: 3.6 },
    verifiedResults: [], digitizerSessions: [],
  });
}

describe('project format v3', () => {
  it('migrates v1 without changing its scientific fields', () => {
    const legacy = legacyFixture();
    const migrated = CortexLumeProjectSchema.parse(legacy);
    expect(migrated).toMatchObject({ ...legacy, formatVersion: 3 });
    expect(migrated.functionalTarget).toBeNull();
    expect(migrated.surfaceOverlay).toBe('none');
    expect(migrated.planning).toBeNull();
  });

  it('migrates legacy project-wide pair depths onto every affected instance', () => {
    const project = CortexLumeProjectSchema.parse(legacyFixture());
    const sourceId = '00000000-0000-4000-8000-000000000010';
    const detectorId = '00000000-0000-4000-8000-000000000011';
    const pairId = '00000000-0000-4000-8000-000000000030';
    const layoutId = '00000000-0000-4000-8000-000000000020';
    const layout = {
      id: layoutId, version: 1, name: 'Legacy depths', createdAt: project.createdAt,
      updatedAt: project.updatedAt, gridSpacingMm: 30,
      optodes: [
        { id: sourceId, label: 'S1', type: 'source' as const, uvMm: [0, 0] },
        { id: detectorId, label: 'D1', type: 'detector' as const, uvMm: [30, 0] },
      ],
      pairs: [{ id: pairId, sourceId, detectorId, nominalDistanceMm: 30, shortChannel: false }],
    };
    const instance = (id: string) => ({
      id, definitionId: layoutId, anchorRasMm: [0, 0, 0], rotationRad: 0,
      mappingRotationRad: 0, visible: true, locked: true, overrides: [], digitizerPositions: [],
      derivedFromInstanceId: null, digitizerSessionId: null,
    });
    for (const formatVersion of [1, 2] as const) {
      const migrated = CortexLumeProjectSchema.parse({
        ...project,
        formatVersion,
        layouts: [layout],
        instances: [
          instance('00000000-0000-4000-8000-000000000040'),
          instance('00000000-0000-4000-8000-000000000041'),
        ],
        projectionSettings: { ...project.projectionSettings, pairDepthOverridesMm: { [pairId]: 42 } },
      });

      expect(migrated.instances.map((item) => item.pairDepthOverridesMm)).toEqual([
        { [pairId]: 42 },
        { [pairId]: 42 },
      ]);
      expect(migrated.projectionSettings).not.toHaveProperty('pairDepthOverridesMm');
    }
  });

  it('rejects malformed or unknown legacy project-wide pair depths', () => {
    const project = CortexLumeProjectSchema.parse(legacyFixture());
    const unknownPair = crypto.randomUUID();
    expect(CortexLumeProjectSchema.safeParse({
      ...project,
      projectionSettings: {
        ...project.projectionSettings,
        pairDepthOverridesMm: { [unknownPair]: 42 },
      },
    }).success).toBe(false);
    expect(CortexLumeProjectSchema.safeParse({
      ...project,
      projectionSettings: {
        ...project.projectionSettings,
        pairDepthOverridesMm: { [unknownPair]: 0 },
      },
    }).success).toBe(false);
    expect(CortexLumeProjectSchema.safeParse({
      ...project,
      projectionSettings: {
        ...project.projectionSettings,
        pairDepthOverridesMm: null,
      },
    }).success).toBe(false);
  });

  it('rejects unknown future versions instead of dropping their fields', () => {
    expect(() => CortexLumeProjectSchema.parse({ ...legacyFixture(), formatVersion: 4 })).toThrow();
  });

  it('makes v2 readers reject instance-scoped depth projects by version', () => {
    const current = CortexLumeProjectSchema.parse(legacyFixture());
    expect(current.formatVersion).toBe(3);
    expect(CortexLumeProjectV2Schema.safeParse(current).success).toBe(false);
  });

  it('rejects invalid pair references, endpoint types, and duplicate channel numbers', () => {
    const project = CortexLumeProjectSchema.parse(legacyFixture());
    const sourceId = '00000000-0000-4000-8000-000000000010';
    const detectorId = '00000000-0000-4000-8000-000000000011';
    const layout = {
      id: '00000000-0000-4000-8000-000000000020', version: 1, name: 'Graph',
      createdAt: project.createdAt, updatedAt: project.updatedAt, gridSpacingMm: 30,
      optodes: [
        { id: sourceId, label: 'S1', type: 'source' as const, uvMm: [0, 0] },
        { id: detectorId, label: 'D1', type: 'detector' as const, uvMm: [30, 0] },
      ],
      pairs: [
        { id: '00000000-0000-4000-8000-000000000030', sourceId, detectorId, channelNumber: 1, nominalDistanceMm: 30, shortChannel: false },
        { id: '00000000-0000-4000-8000-000000000031', sourceId, detectorId, channelNumber: 1, nominalDistanceMm: 30, shortChannel: false },
      ],
    };
    expect(CortexLumeProjectSchema.safeParse({ ...project, layouts: [layout] }).success).toBe(false);
    expect(CortexLumeProjectSchema.safeParse({
      ...project,
      layouts: [{
        ...layout,
        pairs: [{ ...layout.pairs[0], sourceId: detectorId, detectorId: crypto.randomUUID(), channelNumber: 2 }],
      }],
    }).success).toBe(false);
    expect(CortexLumeProjectSchema.safeParse({
      ...project,
      layouts: [{
        ...layout,
        optodes: [layout.optodes[0], { ...layout.optodes[1], id: sourceId }],
        pairs: [],
      }],
    }).success).toBe(false);
    expect(CortexLumeProjectSchema.safeParse({
      ...project,
      layouts: [{
        ...layout,
        pairs: [layout.pairs[0]!, { ...layout.pairs[1]!, id: layout.pairs[0]!.id, channelNumber: 2 }],
      }],
    }).success).toBe(false);
  });

  it('rejects broken instance and result references and duplicate result keys', () => {
    const project = CortexLumeProjectSchema.parse(legacyFixture());
    const sourceId = '00000000-0000-4000-8000-000000000010';
    const detectorId = '00000000-0000-4000-8000-000000000011';
    const pairId = '00000000-0000-4000-8000-000000000030';
    const layoutId = '00000000-0000-4000-8000-000000000020';
    const instanceId = '00000000-0000-4000-8000-000000000040';
    const layout = {
      id: layoutId, version: 1, name: 'Graph', createdAt: project.createdAt, updatedAt: project.updatedAt, gridSpacingMm: 30,
      optodes: [
        { id: sourceId, label: 'S1', type: 'source' as const, uvMm: [0, 0] },
        { id: detectorId, label: 'D1', type: 'detector' as const, uvMm: [30, 0] },
      ],
      pairs: [{ id: pairId, sourceId, detectorId, nominalDistanceMm: 30, shortChannel: false }],
    };
    const instance = {
      id: instanceId, definitionId: layoutId, anchorRasMm: [0, 0, 0], rotationRad: 0,
      mappingRotationRad: 0, visible: true, locked: true, overrides: [], digitizerPositions: [],
      derivedFromInstanceId: null, digitizerSessionId: null,
    };
    const result = {
      instanceId, subjectKind: 'pair' as const, subjectId: pairId, scalpRasMm: null,
      displayRasMm: null, corticalRasMm: null, depthTargetRasMm: null,
      underlyingCorticalRegions: [], deepTargetStructures: [], tissueAtTarget: null,
      claimLevel: 'geometric' as const, status: 'blocked' as const, qcFlags: [],
    };
    expect(CortexLumeProjectSchema.safeParse({
      ...project, layouts: [layout], instances: [{ ...instance, definitionId: crypto.randomUUID() }],
    }).success).toBe(false);
    expect(CortexLumeProjectSchema.safeParse({
      ...project, layouts: [layout], instances: [{
        ...instance,
        digitizerPositions: [{ optodeId: sourceId, digitizerPointId: crypto.randomUUID(), scalpRasMm: [0, 0, 0] }],
      }],
    }).success).toBe(false);
    expect(CortexLumeProjectSchema.safeParse({
      ...project, layouts: [layout], instances: [instance],
      verifiedResults: [{ ...result, subjectKind: 'optode' }, result],
    }).success).toBe(false);
    expect(CortexLumeProjectSchema.safeParse({
      ...project, layouts: [layout], instances: [instance], verifiedResults: [result, result],
    }).success).toBe(false);
    expect(CortexLumeProjectSchema.safeParse({
      ...project,
      layouts: [layout],
      instances: [{ ...instance, pairDepthOverridesMm: { [crypto.randomUUID()]: 25 } }],
    }).success).toBe(false);
  });

  it('rejects non-finite project geometry and impractically long names', () => {
    const project = CortexLumeProjectSchema.parse(legacyFixture());
    expect(CortexLumeProjectSchema.safeParse({ ...project, name: 'x'.repeat(257) }).success).toBe(false);
    expect(CortexLumeProjectSchema.safeParse({
      ...project,
      layouts: [{
        id: crypto.randomUUID(), version: 1, name: 'Bad geometry',
        createdAt: project.createdAt, updatedAt: project.updatedAt, gridSpacingMm: 30,
        optodes: [{ id: crypto.randomUUID(), label: 'S1', type: 'source', uvMm: [Number.POSITIVE_INFINITY, 0] }],
        pairs: [],
      }],
    }).success).toBe(false);
  });

  it('accepts valid multi-layout projects that reuse stable optode and pair IDs', () => {
    const project = CortexLumeProjectSchema.parse(legacyFixture());
    const sourceId = '00000000-0000-4000-8000-000000000010';
    const detectorId = '00000000-0000-4000-8000-000000000011';
    const pairId = sourceId; // Optode and pair IDs occupy separate subject-kind namespaces.
    const makeLayout = (id: string, name: string) => ({
      id, version: 1, name, createdAt: project.createdAt, updatedAt: project.updatedAt, gridSpacingMm: 30,
      optodes: [
        { id: sourceId, label: 'S1', type: 'source' as const, uvMm: [0, 0] },
        { id: detectorId, label: 'D1', type: 'detector' as const, uvMm: [30, 0] },
      ],
      pairs: [{ id: pairId, sourceId, detectorId, channelNumber: 1, nominalDistanceMm: 30, shortChannel: false }],
    });
    const layouts = [
      makeLayout('00000000-0000-4000-8000-000000000020', 'A'),
      makeLayout('00000000-0000-4000-8000-000000000021', 'B'),
    ];
    const makeInstance = (id: string, definitionId: string) => ({
      id, definitionId, anchorRasMm: [0, 0, 0], rotationRad: 0, mappingRotationRad: 0,
      visible: true, locked: true, overrides: [], digitizerPositions: [],
      derivedFromInstanceId: null, digitizerSessionId: null,
    });
    const instances = [
      makeInstance('00000000-0000-4000-8000-000000000040', layouts[0]!.id),
      makeInstance('00000000-0000-4000-8000-000000000041', layouts[1]!.id),
    ];
    const result = (instanceId: string, subjectKind: 'optode' | 'pair') => ({
      instanceId, subjectKind, subjectId: sourceId, scalpRasMm: null, displayRasMm: null,
      corticalRasMm: null, depthTargetRasMm: null, underlyingCorticalRegions: [],
      deepTargetStructures: [], tissueAtTarget: null, claimLevel: 'geometric' as const,
      status: 'blocked' as const, qcFlags: [],
    });
    const parsed = CortexLumeProjectSchema.parse({
      ...project,
      layouts,
      instances,
      verifiedResults: instances.flatMap((instance) => [result(instance.id, 'optode'), result(instance.id, 'pair')]),
    });
    expect(parsed.layouts).toHaveLength(2);
    expect(parsed.verifiedResults).toHaveLength(4);
  });

  it('bounds nested project arrays and rejects non-finite rotations and result coordinates', () => {
    const project = CortexLumeProjectSchema.parse(legacyFixture());
    expect(CortexLumeProjectSchema.safeParse({
      ...project,
      functionalTarget: {
        target: { id: 'target', label: 'Target', aliases: Array(257).fill('alias'), peakRegions: [] },
        vertexCount: 25_000,
        vertexIndices: Array.from({ length: 25_001 }, (_, index) => index % 25_000),
        values: Array(25_001).fill(1),
        provenance: {
          sourceKind: 'mni-point', sourceSpace: 'MNI152NLin6Asym', targetSpace: 'MNI152NLin6Asym',
          targetSurface: 'Cedalion-ICBM152-25k', statistic: 'weight', mapSha256: 'fixture',
        },
      },
    }).success).toBe(false);

    const layoutId = crypto.randomUUID();
    const instanceId = crypto.randomUUID();
    const sourceId = crypto.randomUUID();
    const layout = {
      id: layoutId, version: 1, name: 'Finite', createdAt: project.createdAt,
      updatedAt: project.updatedAt, gridSpacingMm: 30,
      optodes: [{ id: sourceId, label: 'S1', type: 'source', uvMm: [0, 0] }], pairs: [],
    };
    const instance = {
      id: instanceId, definitionId: layoutId, anchorRasMm: [0, 0, 0],
      rotationRad: 0, mappingRotationRad: 0, visible: true, locked: true,
      overrides: [], digitizerPositions: [], derivedFromInstanceId: null, digitizerSessionId: null,
    };
    expect(CortexLumeProjectSchema.safeParse({
      ...project,
      layouts: [layout],
      instances: [{ ...instance,
        rotationRad: Number.NaN, mappingRotationRad: Number.POSITIVE_INFINITY,
      }],
    }).success).toBe(false);
    expect(CortexLumeProjectSchema.safeParse({
      ...project,
      layouts: [layout], instances: [instance],
      verifiedResults: [{
        instanceId, subjectKind: 'optode', subjectId: sourceId,
        scalpRasMm: [Number.NEGATIVE_INFINITY, 0, 0], displayRasMm: null,
        corticalRasMm: null, depthTargetRasMm: null, underlyingCorticalRegions: [],
        deepTargetStructures: [], tissueAtTarget: null, claimLevel: 'geometric',
        status: 'blocked', qcFlags: [],
      }],
    }).success).toBe(false);
  });
});
