import { randomUUID } from 'node:crypto';
import {
  CROSS_PROCESS_LIMITS,
  CortexLumeProjectSchema,
  type CortexLumeProject,
} from '@cortexlume/contracts';

/**
 * A complete, exportable project at the ProjectionResult contract boundary.
 * Eight subjects per instance divide 8192 exactly, so no final partial
 * instance can hide a missing result in save/open or scientific export.
 */
export function maximumVerifiedProject(): CortexLumeProject {
  const timestamp = '2000-01-01T00:00:00.000Z';
  const uuid = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
  const optodes = [
    [101, 'S1', 'source'], [102, 'D1', 'detector'],
    [103, 'S2', 'source'], [104, 'D2', 'detector'],
  ].map(([id, label, type]) => ({
    id: uuid(Number(id)),
    label: String(label),
    type: type as 'source' | 'detector',
    uvMm: [0, 0] as [number, number],
  }));
  const pairs = Array.from({ length: 4 }, (_, index) => ({
    id: uuid(index + 10),
    sourceId: optodes[index % 2 * 2]!.id,
    detectorId: optodes[index % 2 * 2 + 1]!.id,
    channelNumber: index + 1,
    nominalDistanceMm: 30,
    shortChannel: false,
  }));
  const layout = {
    id: uuid(100),
    version: 1,
    name: 'maximum verified fixture',
    createdAt: timestamp,
    updatedAt: timestamp,
    gridSpacingMm: 30,
    optodes,
    pairs,
  };
  const subjects = [
    ...optodes.map((optode) => ['optode' as const, optode.id] as const),
    ...pairs.map((pair) => ['pair' as const, pair.id] as const),
  ];
  const instances = Array.from({ length: CROSS_PROCESS_LIMITS.projectionResults / subjects.length }, (_, index) => ({
    id: uuid(index + 1_000),
    definitionId: layout.id,
    anchorRasMm: [0, 0, 0] as [number, number, number],
    rotationRad: 0,
    mappingRotationRad: 0,
    visible: true,
    locked: true,
    overrides: [],
    pairDepthOverridesMm: {},
    digitizerPositions: [],
    derivedFromInstanceId: null,
    digitizerSessionId: null,
  }));
  const result = (
    instanceId: string,
    subjectKind: 'optode' | 'pair',
    subjectId: string,
    ordinal: number,
  ) => {
    const coordinate = [
      ordinal % 1000,
      (ordinal * 7) % 1000,
      (ordinal * 13) % 1000,
    ] as [number, number, number];
    return {
      instanceId,
      subjectKind,
      subjectId,
      scalpRasMm: coordinate,
      displayRasMm: coordinate,
      corticalRasMm: coordinate,
      depthTargetRasMm: coordinate,
      underlyingCorticalRegions: [],
      deepTargetStructures: [],
      tissueAtTarget: null,
      claimLevel: 'geometric' as const,
      status: 'verified' as const,
      qcFlags: ['surface_model_verified'],
    };
  };
  const verifiedResults = instances.flatMap((instance, index) => subjects.map(([kind, id], subjectIndex) => (
    result(instance.id, kind, id, index * subjects.length + subjectIndex)
  )));
  return CortexLumeProjectSchema.parse({
    format: 'cortexlume-project',
    formatVersion: 3,
    id: randomUUID(),
    name: 'Maximum verified project fixture',
    createdAt: timestamp,
    updatedAt: timestamp,
    template: {
      id: 'MNI152NLin6Asym',
      assetVersion: 'fixture',
      coordinateConvention: 'RAS+',
      units: 'mm',
      verified: true,
      manifestSha256: 'a'.repeat(64),
      scalpMeshSha256: 'b'.repeat(64),
      cortexMeshSha256: 'c'.repeat(64),
      atlasSha256: 'd'.repeat(64),
    },
    layouts: [layout],
    instances,
    deviceProfile: {
      manufacturer: 'Shimadzu', model: 'LABNIRS', wavelengthsNm: [780],
      measurementType: 'NIRSCWAMPLITUDE', units: 'V', sourceType: 'LASER', detectorType: 'PMT',
      samplingFrequencyHz: null,
    },
    bidsSettings: { subjectLabel: '01', sessionLabel: '', taskLabel: 'layout', acquisitionLabel: '', runIndex: null },
    projectionSettings: { mode: 'scalp', defaultDepthMm: 25, atlasProbabilityThreshold: 0, optodeRadiusMm: 3.6 },
    verifiedResults,
    digitizerSessions: [],
    functionalTarget: null,
    surfaceOverlay: 'none',
    coverageRegion: null,
    planning: null,
  });
}
