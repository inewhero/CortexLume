import { z } from 'zod';
import sharedCrossProcessLimits from '../../../config/cross-process-limits.json';

const FiniteNumberSchema = z.number().finite();
const BoundedNameSchema = z.string().min(1).max(256);
const BoundedFlagSchema = z.string().min(1).max(256);

/**
 * Resource budgets for anatomical coverage requests.  The science sidecar
 * carries the same values in its Pydantic boundary; keep the field names and
 * values protocol-stable so every caller rejects the same request first.
 */
export const ANATOMICAL_COVERAGE_LIMITS = Object.freeze({
  maximumChannels: sharedCrossProcessLimits.maximumChannels,
  maximumPathPointsPerChannel: sharedCrossProcessLimits.maximumPathPointsPerChannel,
  maximumTotalPathPoints: sharedCrossProcessLimits.maximumTotalPathPoints,
  maximumTotalSegments: sharedCrossProcessLimits.maximumTotalSegments,
  maximumSerializedRequestBytes: sharedCrossProcessLimits.maximumSerializedRequestBytes,
});

/**
 * Budgets shared by the renderer, Electron main process and science sidecar.
 *
 * Keep these values in the contracts package so a payload cannot be valid in
 * one process and oversized at the next process boundary.  The archive and
 * science-client packages import this object rather than maintaining their
 * own copies of the wire limits.
 */
export const CROSS_PROCESS_LIMITS = Object.freeze({
  projectJsonBytes: sharedCrossProcessLimits.projectJsonBytes,
  projectionResults: sharedCrossProcessLimits.projectionResults,
  atlasBatchPoints: sharedCrossProcessLimits.atlasBatchPoints,
  atlasPathBatchItems: sharedCrossProcessLimits.atlasPathBatchItems,
  scienceRequestBytes: sharedCrossProcessLimits.scienceRequestBytes,
  scienceResponseBytes: sharedCrossProcessLimits.scienceResponseBytes,
  projectOperationTimeoutMs: sharedCrossProcessLimits.projectOperationTimeoutMs,
  ...ANATOMICAL_COVERAGE_LIMITS,
});

export const PROJECT_GRAPH_LIMITS = Object.freeze({
  layouts: 128,
  optodesPerLayout: 100,
  pairsPerLayout: 256,
  instances: 2_048,
  overridesPerInstance: 100,
  digitizerPositionsPerInstance: 100,
  // A compact ProjectionResult is approximately 350-450 bytes.  Keeping the
  // graph bound at 8k leaves room for layouts, settings and provenance under
  // the 8 MiB project.json archive budget.
  verifiedResults: CROSS_PROCESS_LIMITS.projectionResults,
  digitizerSessions: 128,
  digitizerPointsPerSession: 100_000,
  mappingsPerSession: 100_000,
  atlasLabelsPerResult: 512,
  targetVertices: 25_000,
  targetSummaryItems: 256,
  planningRegions: 1_024,
  planningPlacementsPerCandidate: 128,
});

export const Vec2Schema = z.tuple([FiniteNumberSchema, FiniteNumberSchema]);
export const Vec3Schema = z.tuple([FiniteNumberSchema, FiniteNumberSchema, FiniteNumberSchema]);
export type Vec2 = z.infer<typeof Vec2Schema>;
export type Vec3 = z.infer<typeof Vec3Schema>;

export const OptodeTypeSchema = z.enum(['source', 'detector']);
export type OptodeType = z.infer<typeof OptodeTypeSchema>;

export const OptodeSchema = z.object({
  id: z.string().uuid(),
  label: BoundedNameSchema,
  type: OptodeTypeSchema,
  uvMm: Vec2Schema,
});
export type Optode = z.infer<typeof OptodeSchema>;

export const PairSchema = z.object({
  id: z.string().uuid(),
  sourceId: z.string().uuid(),
  detectorId: z.string().uuid(),
  channelNumber: FiniteNumberSchema.int().positive().optional(),
  nominalDistanceMm: FiniteNumberSchema.positive(),
  shortChannel: z.boolean().default(false),
});
export type Pair = z.infer<typeof PairSchema>;

export const LayoutDefinitionSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  name: BoundedNameSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  gridSpacingMm: FiniteNumberSchema.positive(),
  optodes: z.array(OptodeSchema).max(PROJECT_GRAPH_LIMITS.optodesPerLayout),
  pairs: z.array(PairSchema).max(PROJECT_GRAPH_LIMITS.pairsPerLayout),
});
export type LayoutDefinition = z.infer<typeof LayoutDefinitionSchema>;

export const MeshAnchorSchema = z.object({
  meshSha256: z.string(),
  faceIndex: z.number().int().nonnegative(),
  barycentric: z.tuple([FiniteNumberSchema, FiniteNumberSchema, FiniteNumberSchema]),
  rasMm: Vec3Schema,
});
export type MeshAnchor = z.infer<typeof MeshAnchorSchema>;

export const FitQcSchema = z.object({
  converged: z.boolean(),
  iterations: z.number().int().nonnegative(),
  meanAbsoluteErrorMm: FiniteNumberSchema.nonnegative(),
  maxAbsoluteErrorMm: FiniteNumberSchema.nonnegative(),
  flags: z.array(BoundedFlagSchema).max(256),
});
export type FitQc = z.infer<typeof FitQcSchema>;

export const OptodeOverrideSchema = z.object({
  optodeId: z.string().uuid(),
  uvMm: Vec2Schema,
});
export type OptodeOverride = z.infer<typeof OptodeOverrideSchema>;

export const LayoutInstanceSchema = z.object({
  id: z.string().uuid(),
  definitionId: z.string().uuid(),
  anchorRasMm: Vec3Schema,
  rotationRad: FiniteNumberSchema,
  mappingRotationRad: FiniteNumberSchema.default(0),
  visible: z.boolean().default(true),
  locked: z.boolean().default(true),
  overrides: z.array(OptodeOverrideSchema).max(PROJECT_GRAPH_LIMITS.overridesPerInstance),
  digitizerPositions: z.array(z.object({
    optodeId: z.string().uuid(),
    digitizerPointId: z.string().uuid(),
    scalpRasMm: Vec3Schema,
  })).max(PROJECT_GRAPH_LIMITS.digitizerPositionsPerInstance).default([]),
  derivedFromInstanceId: z.string().uuid().nullable().default(null),
  digitizerSessionId: z.string().uuid().nullable().default(null),
  fitQc: FitQcSchema.optional(),
});
export type LayoutInstance = z.infer<typeof LayoutInstanceSchema>;

export const DeviceProfileSchema = z.object({
  manufacturer: BoundedNameSchema.default('Shimadzu'),
  model: BoundedNameSchema.default('LABNIRS'),
  wavelengthsNm: z.preprocess(
    (value) => Array.isArray(value) && value.length === 0 ? undefined : value,
    z.array(FiniteNumberSchema.positive()).min(1).max(32).default([780, 805, 830]),
  ),
  measurementType: z.preprocess(
    (value) => value === 'CW_AMPLITUDE' ? 'NIRSCWAMPLITUDE' : value,
    z.enum([
      'NIRSCWAMPLITUDE',
      'NIRSCWOPTICALDENSITY',
      'NIRSCWHBO',
      'NIRSCWHBR',
      'NIRSCWMUA',
    ]).default('NIRSCWAMPLITUDE'),
  ),
  units: BoundedNameSchema.default('V'),
  sourceType: BoundedNameSchema.default('LASER'),
  detectorType: BoundedNameSchema.default('PMT'),
  samplingFrequencyHz: FiniteNumberSchema.positive().nullable().default(null),
});
export type DeviceProfile = z.infer<typeof DeviceProfileSchema>;

const BidsLabelSchema = z.string().max(64).regex(/^[A-Za-z0-9]+$/);
export const BidsSettingsSchema = z.object({
  subjectLabel: BidsLabelSchema.default('01'),
  sessionLabel: BidsLabelSchema.or(z.literal('')).default(''),
  taskLabel: BidsLabelSchema.default('layout'),
  acquisitionLabel: BidsLabelSchema.or(z.literal('')).default(''),
  runIndex: z.number().int().positive().nullable().default(null),
});
export type BidsSettings = z.infer<typeof BidsSettingsSchema>;

const ProjectionModeValueSchema = z.enum(['scalp', 'cortex']);
export const ProjectionModeSchema = z.preprocess(
  (value) => value === 'surface' ? 'scalp' : value === 'anatomical_depth' ? 'cortex' : value,
  ProjectionModeValueSchema,
);
export type ProjectionMode = z.infer<typeof ProjectionModeSchema>;

export const ProjectionSettingsSchema = z.object({
  mode: ProjectionModeSchema.default('scalp'),
  defaultDepthMm: z.number().min(1).max(100).nullable().default(25),
  pairDepthOverridesMm: z.record(z.string().uuid(), z.number().min(1).max(100)).default({}),
  atlasProbabilityThreshold: z.number().min(0).max(1).default(0),
  optodeRadiusMm: z.number().min(1).max(15).default(3.6),
});
export type ProjectionSettings = z.infer<typeof ProjectionSettingsSchema>;

export const AtlasLabelSchema = z.object({
  atlasId: BoundedNameSchema,
  labelEn: BoundedNameSchema,
  probability: z.number().min(0).max(1),
});
export type AtlasLabel = z.infer<typeof AtlasLabelSchema>;

/** Point and path atlas queries share the same bounded science-sidecar wire contract. */
export const AtlasQueryPointSchema = z.object({
  id: z.string().min(1).max(128),
  corticalRasMm: Vec3Schema.nullable().default(null),
  deepTargetRasMm: Vec3Schema.nullable().default(null),
});
export type AtlasQueryPoint = z.infer<typeof AtlasQueryPointSchema>;

export const AtlasQueryRequestSchema = z.object({
  points: z.array(AtlasQueryPointSchema).min(1).max(CROSS_PROCESS_LIMITS.atlasBatchPoints),
  probabilityThreshold: z.number().finite().min(0).max(1).default(0),
});
export type AtlasQueryRequest = z.infer<typeof AtlasQueryRequestSchema>;

export const AtlasPathQueryRequestSchema = z.object({
  points: z.array(Vec3Schema).min(1).max(ANATOMICAL_COVERAGE_LIMITS.maximumPathPointsPerChannel),
  probabilityThreshold: z.number().finite().min(0).max(1).default(0),
});
export type AtlasPathQueryRequest = z.infer<typeof AtlasPathQueryRequestSchema>;

export const AtlasPathQueryBatchItemSchema = z.object({
  id: z.string().min(1).max(128),
  points: z.array(Vec3Schema).min(1).max(ANATOMICAL_COVERAGE_LIMITS.maximumPathPointsPerChannel),
});
export type AtlasPathQueryBatchItem = z.infer<typeof AtlasPathQueryBatchItemSchema>;

export const AtlasPathQueryBatchRequestSchema = z.preprocess((value) => {
  // Accept the prototype ``paths`` spelling on input, but keep ``items`` as
  // the canonical serialized field used by the Electron and Python clients.
  if (value && typeof value === 'object' && 'items' in value === false && 'paths' in value) {
    const raw = value as { paths?: unknown };
    return { ...value, items: raw.paths };
  }
  return value;
}, z.object({
  items: z.array(AtlasPathQueryBatchItemSchema).min(1).max(CROSS_PROCESS_LIMITS.atlasPathBatchItems),
  probabilityThreshold: z.number().finite().min(0).max(1).default(0),
}));
export type AtlasPathQueryBatchRequest = z.infer<typeof AtlasPathQueryBatchRequestSchema>;

export const ProjectOperationOptionsSchema = z.object({
  /** Optional stable ID used with DesktopApi.operations.cancel/onProgress. */
  operationId: z.string().min(1).max(128).optional(),
  /** Overall budget, capped by CROSS_PROCESS_LIMITS.projectOperationTimeoutMs. */
  timeoutMs: z.number().int().positive().max(CROSS_PROCESS_LIMITS.projectOperationTimeoutMs).optional(),
});
export type ProjectOperationOptions = z.infer<typeof ProjectOperationOptionsSchema>;

export const ProjectOperationProgressSchema = z.object({
  operationId: z.string().min(1).max(128),
  operation: z.enum(['annotation', 'export']),
  phase: z.string().min(1).max(128),
  completed: z.number().int().nonnegative(),
  total: z.number().int().positive(),
});
export type ProjectOperationProgress = z.infer<typeof ProjectOperationProgressSchema>;

export const ProjectionResultSchema = z.object({
  instanceId: z.string().uuid().nullable(),
  subjectKind: z.enum(['optode', 'pair']),
  subjectId: z.string().uuid(),
  scalpRasMm: Vec3Schema.nullable(),
  displayRasMm: Vec3Schema.nullable().default(null),
  corticalRasMm: Vec3Schema.nullable(),
  depthTargetRasMm: Vec3Schema.nullable(),
  underlyingCorticalRegions: z.array(AtlasLabelSchema).max(PROJECT_GRAPH_LIMITS.atlasLabelsPerResult),
  deepTargetStructures: z.array(AtlasLabelSchema).max(PROJECT_GRAPH_LIMITS.atlasLabelsPerResult),
  tissueAtTarget: z.string().max(256).nullable(),
  claimLevel: z.enum(['development_only', 'geometric', 'modeled']),
  status: z.enum(['provisional', 'verified', 'blocked']),
  qcFlags: z.array(BoundedFlagSchema).max(256),
});
export type ProjectionResult = z.infer<typeof ProjectionResultSchema>;

export const TemplateRefSchema = z.object({
  id: z.literal('MNI152NLin6Asym'),
  assetVersion: z.string().max(256),
  coordinateConvention: z.literal('RAS+'),
  units: z.literal('mm'),
  verified: z.boolean(),
  manifestSha256: z.string().max(256),
  scalpMeshSha256: z.string().max(256),
  cortexMeshSha256: z.string().max(256),
  atlasSha256: z.string().max(256),
});
export type TemplateRef = z.infer<typeof TemplateRefSchema>;

export const DigitizerPointKindSchema = z.enum(['source', 'detector', 'landmark', 'headshape', 'unknown']);
export type DigitizerPointKind = z.infer<typeof DigitizerPointKindSchema>;

export const DigitizerPointSchema = z.object({
  id: z.string().uuid(),
  label: BoundedNameSchema,
  kind: DigitizerPointKindSchema,
  rawPosition: Vec3Schema,
});
export type DigitizerPoint = z.infer<typeof DigitizerPointSchema>;

export const DigitizerCalibrationSchema = z.object({
  method: z.literal('five-point-similarity'),
  sourceUnit: z.enum(['mm', 'cm', 'm']),
  matrix: z.array(FiniteNumberSchema).length(16),
  scale: FiniteNumberSchema.positive(),
  rmsResidualMm: FiniteNumberSchema.nonnegative(),
  maxResidualMm: FiniteNumberSchema.nonnegative(),
  residuals: z.array(z.object({
    label: z.enum(['Nz', 'Iz', 'LPA', 'RPA', 'Cz']),
    measuredRasMm: Vec3Schema,
    targetRasMm: Vec3Schema,
    residualMm: FiniteNumberSchema.nonnegative(),
  })).length(5),
  calibratedAt: z.string().datetime(),
});
export type DigitizerCalibration = z.infer<typeof DigitizerCalibrationSchema>;

export const DigitizerOptodeMappingSchema = z.object({
  pointId: z.string().uuid(),
  instanceId: z.string().uuid(),
  optodeId: z.string().uuid(),
  distanceMm: FiniteNumberSchema.nonnegative(),
});
export type DigitizerOptodeMapping = z.infer<typeof DigitizerOptodeMappingSchema>;

export const DigitizerSessionSchema = z.object({
  id: z.string().uuid(),
  name: BoundedNameSchema,
  importedAt: z.string().datetime(),
  source: z.object({
    format: BoundedNameSchema,
    fileName: z.string().max(1_024).nullable(),
    sha256: z.string().max(256).nullable(),
  }),
  points: z.array(DigitizerPointSchema).min(5).max(PROJECT_GRAPH_LIMITS.digitizerPointsPerSession),
  calibratedPoints: z.array(z.object({ pointId: z.string().uuid(), rasMm: Vec3Schema }))
    .max(PROJECT_GRAPH_LIMITS.digitizerPointsPerSession),
  calibration: DigitizerCalibrationSchema,
  optodeMappings: z.array(DigitizerOptodeMappingSchema).max(PROJECT_GRAPH_LIMITS.mappingsPerSession).default([]),
  visible: z.boolean().default(true),
});
export type DigitizerSession = z.infer<typeof DigitizerSessionSchema>;

export const DigitizerImportSchema = z.object({
  fileName: z.string(),
  format: z.string(),
  sha256: z.string(),
  suggestedUnit: z.enum(['mm', 'cm', 'm']),
  points: z.array(DigitizerPointSchema),
});
export type DigitizerImport = z.infer<typeof DigitizerImportSchema>;

export const QuickTargetSummarySchema = z.object({
  id: BoundedNameSchema,
  label: BoundedNameSchema,
  aliases: z.array(BoundedNameSchema).max(PROJECT_GRAPH_LIMITS.targetSummaryItems).default([]),
  domain: BoundedNameSchema.optional(),
  subdomain: BoundedNameSchema.optional(),
  studyCount: z.number().int().nonnegative().nullable().optional(),
  description: z.string().max(8_192).optional(),
  peakRegions: z.array(BoundedNameSchema).max(PROJECT_GRAPH_LIMITS.targetSummaryItems).default([]),
  laterality: BoundedNameSchema.optional(),
});
export type QuickTargetSummary = z.infer<typeof QuickTargetSummarySchema>;

export const FunctionalTargetProvenanceSchema = z.object({
  sourceKind: z.enum(['neurosynth-quick', 'nifti-import', 'harvard-oxford-region', 'mni-point']),
  sourceSpace: BoundedNameSchema,
  targetSpace: z.literal('MNI152NLin6Asym'),
  targetSurface: z.literal('Cedalion-ICBM152-25k'),
  statistic: BoundedNameSchema,
  mapSha256: BoundedNameSchema,
  fileName: z.string().max(1_024).nullable().optional(),
  interpolation: z.string().max(256).optional(),
  validation: z.record(z.unknown()).optional(),
  packId: z.string().max(256).optional(),
  distributionRole: z.string().max(256).optional(),
});
export type FunctionalTargetProvenance = z.infer<typeof FunctionalTargetProvenanceSchema>;

export const FunctionalTargetMapSchema = z.object({
  target: QuickTargetSummarySchema,
  vertexCount: z.literal(25_000),
  vertexIndices: z.array(z.number().int().min(0).max(24_999)).min(1).max(PROJECT_GRAPH_LIMITS.targetVertices),
  values: z.array(z.number().finite().positive()).min(1).max(PROJECT_GRAPH_LIMITS.targetVertices),
  provenance: FunctionalTargetProvenanceSchema,
}).superRefine((value, context) => {
  if (value.vertexIndices.length !== value.values.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Target vertex indices and values must have equal length.' });
  }
  for (let index = 1; index < value.vertexIndices.length; index += 1) {
    if (value.vertexIndices[index]! <= value.vertexIndices[index - 1]!) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Target vertex indices must be unique and strictly increasing.' });
      break;
    }
  }
});
export type FunctionalTargetMap = z.infer<typeof FunctionalTargetMapSchema>;

export const TargetImportSpaceSchema = z.enum([
  'MNI152NLin6Asym',
  'NeurosynthMNI152-2mm',
]);
export type TargetImportSpace = z.infer<typeof TargetImportSpaceSchema>;

export const TargetImportDiagnosticSchema = z.object({
  severity: z.enum(['info', 'warning', 'error']),
  code: z.string().min(1),
  message: z.string().min(1),
  action: z.string().optional(),
});
export type TargetImportDiagnostic = z.infer<typeof TargetImportDiagnosticSchema>;

export const TargetImportResultSchema = z.object({
  accepted: z.boolean(),
  declaredSpace: TargetImportSpaceSchema,
  recognizedSpace: z.string().nullable(),
  shape: z.array(z.number().int().positive()).nullable(),
  affine: z.array(z.array(FiniteNumberSchema).max(16)).max(16).nullable(),
  units: z.string().nullable(),
  valueMin: z.number().finite().nullable(),
  valueMax: z.number().finite().nullable(),
  nonzeroVoxels: z.number().int().nonnegative().nullable(),
  sha256: z.string().nullable(),
  diagnostics: z.array(TargetImportDiagnosticSchema),
  map: FunctionalTargetMapSchema.nullable(),
});
export type TargetImportResult = z.infer<typeof TargetImportResultSchema>;

/**
 * A sampled channel path used only to build a geometric anatomical-coverage
 * prior. The path is not a photon sensitivity, fluence, or Jacobian field.
 */
export const AnatomicalCoverageChannelSchema = z.object({
  instanceId: z.string().uuid(),
  pairId: z.string().uuid(),
  channelNumber: z.number().int().positive().optional(),
  pointsRasMm: z.array(Vec3Schema).min(2).max(ANATOMICAL_COVERAGE_LIMITS.maximumPathPointsPerChannel),
});
export type AnatomicalCoverageChannel = z.infer<typeof AnatomicalCoverageChannelSchema>;

const AnatomicalCoverageSettingsBaseSchema = z.object({
  kernelSigmaMm: z.number().finite().min(1).max(40).default(12),
  supportRadiusMm: z.number().finite().min(2).max(80).default(24),
  minimumAtlasMembership: z.number().finite().min(0).max(1).default(0.05),
});
export const AnatomicalCoverageSettingsSchema = AnatomicalCoverageSettingsBaseSchema.refine((value) => value.supportRadiusMm >= value.kernelSigmaMm, {
  message: 'Coverage support radius must be at least one kernel sigma.',
  path: ['supportRadiusMm'],
});
export type AnatomicalCoverageSettings = z.infer<typeof AnatomicalCoverageSettingsSchema>;

export const AnatomicalCoverageRequestSchema = z.object({
  channels: z.array(AnatomicalCoverageChannelSchema)
    .min(1)
    .max(ANATOMICAL_COVERAGE_LIMITS.maximumChannels),
  settings: AnatomicalCoverageSettingsSchema.default({}),
}).superRefine((value, context) => {
  const channels = value.channels.length;
  const totalPathPoints = value.channels.reduce((sum, channel) => sum + channel.pointsRasMm.length, 0);
  const totalSegments = value.channels.reduce((sum, channel) => sum + channel.pointsRasMm.length - 1, 0);
  const addLimitIssue = (dimension: string, observed: number, maximum: number) => {
    if (observed <= maximum) return;
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `coverage_request_limit_exceeded:${dimension}:${observed}:${maximum}`,
      path: ['channels'],
    });
  };
  addLimitIssue('maximumChannels', channels, ANATOMICAL_COVERAGE_LIMITS.maximumChannels);
  addLimitIssue('maximumTotalPathPoints', totalPathPoints, ANATOMICAL_COVERAGE_LIMITS.maximumTotalPathPoints);
  addLimitIssue('maximumTotalSegments', totalSegments, ANATOMICAL_COVERAGE_LIMITS.maximumTotalSegments);

  // Count UTF-8 bytes, matching the JSON body sent by ScienceClient rather
  // than JavaScript UTF-16 code units.  At this point all defaults and UUIDs
  // have been normalized by Zod, making the calculation deterministic.
  const serializedBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  addLimitIssue(
    'maximumSerializedRequestBytes',
    serializedBytes,
    ANATOMICAL_COVERAGE_LIMITS.maximumSerializedRequestBytes,
  );
});
export type AnatomicalCoverageRequest = z.infer<typeof AnatomicalCoverageRequestSchema>;

export const AnatomicalCoverageChannelResultSchema = z.object({
  stableId: z.string().min(1),
  instanceId: z.string().uuid(),
  pairId: z.string().uuid(),
  channelNumber: z.number().int().positive().optional(),
  pathPointCount: z.number().int().min(2).max(ANATOMICAL_COVERAGE_LIMITS.maximumPathPointsPerChannel),
  pathLengthMm: z.number().finite().positive(),
  pathSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type AnatomicalCoverageChannelResult = z.infer<typeof AnatomicalCoverageChannelResultSchema>;

export const AnatomicalCoverageChannelShareSchema = z.object({
  channelIndex: z.number().int().nonnegative(),
  stableId: z.string().min(1),
  geometricShare: z.number().finite().min(0).max(1),
});
export type AnatomicalCoverageChannelShare = z.infer<typeof AnatomicalCoverageChannelShareSchema>;

export const AnatomicalCoverageRegionSchema = z.object({
  regionIndex: z.number().int().nonnegative(),
  atlasId: z.string().min(1),
  labelEn: z.string().min(1),
  colorHex: z.string().regex(/^#[A-Fa-f0-9]{6}$/),
  coveredAtlasMassFraction: z.number().finite().min(0).max(1),
  weightedAtlasMass: z.number().finite().positive(),
  dominantVertexCount: z.number().int().nonnegative(),
  channelShares: z.array(AnatomicalCoverageChannelShareSchema),
});
export type AnatomicalCoverageRegion = z.infer<typeof AnatomicalCoverageRegionSchema>;

export const AnatomicalCoverageMosaicSchema = z.object({
  geometricVertexIndices: z.array(z.number().int().min(0).max(24_999)),
  geometricCoverageWeights: z.array(z.number().finite().min(0).max(1)),
  vertexIndices: z.array(z.number().int().min(0).max(24_999)),
  coverageWeights: z.array(z.number().finite().min(0).max(1)),
  opacityWeights: z.array(z.number().finite().min(0).max(1)),
  regionIndices: z.array(z.number().int().nonnegative()),
  atlasMemberships: z.array(z.number().finite().min(0).max(1)),
  dominantChannelIndices: z.array(z.number().int().nonnegative()),
}).superRefine((value, context) => {
  const length = value.vertexIndices.length;
  for (const [name, values] of Object.entries({
    coverageWeights: value.coverageWeights,
    opacityWeights: value.opacityWeights,
    regionIndices: value.regionIndices,
    atlasMemberships: value.atlasMemberships,
    dominantChannelIndices: value.dominantChannelIndices,
  })) {
    if (values.length !== length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Mosaic ${name} length mismatch.` });
    }
  }
  if (value.geometricCoverageWeights.length !== value.geometricVertexIndices.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Mosaic geometric support length mismatch.' });
  }
  for (let index = 1; index < value.geometricVertexIndices.length; index += 1) {
    if (value.geometricVertexIndices[index]! <= value.geometricVertexIndices[index - 1]!) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Mosaic geometric vertex indices must be unique and strictly increasing.' });
      break;
    }
  }
  for (let index = 1; index < length; index += 1) {
    if (value.vertexIndices[index]! <= value.vertexIndices[index - 1]!) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Mosaic vertex indices must be unique and strictly increasing.' });
      break;
    }
  }
});
export type AnatomicalCoverageMosaic = z.infer<typeof AnatomicalCoverageMosaicSchema>;

export const AnatomicalCoverageAnalysisSchema = z.object({
  version: z.literal(1),
  sourceKind: z.literal('geometric-anatomical-coverage-prior'),
  targetSurface: z.literal('Cedalion-ICBM152-25k'),
  vertexCount: z.literal(25_000),
  channels: z.array(AnatomicalCoverageChannelResultSchema)
    .min(1)
    .max(ANATOMICAL_COVERAGE_LIMITS.maximumChannels),
  parameters: AnatomicalCoverageSettingsBaseSchema.extend({
    distanceMetric: z.literal('euclidean-distance-to-polyline'),
    kernel: z.literal('truncated-gaussian'),
    channelCombination: z.literal('maximum-kernel-weight'),
    mosaicAssignment: z.literal('maximum-harvard-oxford-membership'),
    regionAggregation: z.literal('coverage-weighted-atlas-membership'),
    atlasMembershipAggregation: z.literal('sum-retained-top3-without-renormalization'),
    summarySampling: z.literal('vertex-sampled-not-surface-area-integrated'),
  }),
  mosaic: AnatomicalCoverageMosaicSchema,
  regions: z.array(AnatomicalCoverageRegionSchema),
  qc: z.object({
    geometricCoveredVertexCount: z.number().int().nonnegative(),
    atlasLabeledVertexCount: z.number().int().nonnegative(),
    unlabeledCoveredVertexCount: z.number().int().nonnegative(),
    atlasSupportFraction: z.number().finite().min(0).max(1),
    flags: z.array(z.string()),
  }),
  provenance: z.object({
    templateAssetVersion: z.string().min(1),
    coordinateConvention: z.literal('RAS+'),
    units: z.literal('mm'),
    surfaceVertexCoordinatesSha256: z.string().regex(/^[a-f0-9]{64}$/),
    surfaceMeshSha256: z.string().regex(/^[a-f0-9]{64}$/),
    atlasId: z.string().min(1),
    atlasIndexSha256: z.string().regex(/^[a-f0-9]{64}$/),
    atlasSampling: z.literal('nearest-voxel-top3-original-membership'),
    interpretation: z.literal('Geometric anatomical coverage prior; not photon sensitivity, fluence, or Jacobian.'),
  }),
}).superRefine((value, context) => {
  if (value.parameters.supportRadiusMm < value.parameters.kernelSigmaMm) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Coverage support radius must be at least one kernel sigma.' });
  }
  value.channels.forEach((channel, index) => {
    if (channel.stableId !== `${channel.instanceId}:${channel.pairId}`) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Coverage channel stable ID is not canonical.' });
    }
    if (index > 0 && channel.stableId <= value.channels[index - 1]!.stableId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Coverage channels must have unique, ordered stable IDs.' });
    }
  });
  value.regions.forEach((region, index) => {
    if (region.regionIndex !== index) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Coverage region indices must be contiguous and ordered.' });
    }
    for (const share of region.channelShares) {
      if (share.channelIndex >= value.channels.length || value.channels[share.channelIndex]?.stableId !== share.stableId) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Coverage channel share references an invalid channel.' });
      }
    }
    const channelShareTotal = region.channelShares.reduce((sum, share) => sum + share.geometricShare, 0);
    if (Math.abs(channelShareTotal - 1) > 1e-6) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Coverage region channel shares must sum to one.' });
    }
  });
  if (value.mosaic.regionIndices.some((index) => index >= value.regions.length)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Coverage mosaic references an invalid region.' });
  }
  if (value.mosaic.dominantChannelIndices.some((index) => index >= value.channels.length)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Coverage mosaic references an invalid channel.' });
  }
  value.mosaic.opacityWeights.forEach((opacity, index) => {
    const expected = value.mosaic.coverageWeights[index]! * value.mosaic.atlasMemberships[index]!;
    if (Math.abs(opacity - expected) > 1e-6) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Coverage mosaic opacity is inconsistent.' });
    }
  });
  const geometricWeights = new Map(
    value.mosaic.geometricVertexIndices.map((vertexIndex, index) => (
      [vertexIndex, value.mosaic.geometricCoverageWeights[index]!] as const
    )),
  );
  value.mosaic.vertexIndices.forEach((vertexIndex, index) => {
    const geometricWeight = geometricWeights.get(vertexIndex);
    if (geometricWeight == null || Math.abs(geometricWeight - value.mosaic.coverageWeights[index]!) > 1e-6) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Atlas-labeled coverage must be contained in geometric support.' });
    }
  });
  if (value.qc.atlasLabeledVertexCount !== value.mosaic.vertexIndices.length
    || value.qc.geometricCoveredVertexCount !== value.mosaic.geometricVertexIndices.length
    || value.qc.geometricCoveredVertexCount !== value.qc.atlasLabeledVertexCount + value.qc.unlabeledCoveredVertexCount) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Coverage QC vertex counts are inconsistent.' });
  }
  const regionFractionTotal = value.regions.reduce((sum, region) => sum + region.coveredAtlasMassFraction, 0);
  if (value.regions.length > 0 && Math.abs(regionFractionTotal - 1) > 1e-6) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Coverage region mass fractions must sum to one.' });
  }
});
export type AnatomicalCoverageAnalysis = z.infer<typeof AnatomicalCoverageAnalysisSchema>;

export const SurfaceOverlaySchema = z.enum([
  'none',
  'functional-target',
  'coverage-mosaic',
  'coverage-region',
]);
export type SurfaceOverlay = z.infer<typeof SurfaceOverlaySchema>;

export const PlanningCandidateMetricsSchema = z.object({
  nominalTargetMassCoverage: z.number().finite().min(0).max(1),
  robustP10TargetMassCoverage: z.number().finite().min(0).max(1),
  robustWorstTargetMassCoverage: z.number().finite().min(0).max(1),
  minimumOptodeClearanceMm: z.number().finite().nonnegative(),
  meanSpacingDistortionMm: z.number().finite().nonnegative(),
  /** Fraction of the candidate's geometric surface support that remains inside the target support. */
  targetSupportSpecificity: z.number().finite().min(0).max(1).optional(),
  /** Harmonic mean of target-mass coverage and target-support specificity. */
  balancedTargetCoverage: z.number().finite().min(0).max(1).optional(),
  /** Distribution overlap between candidate and target Harvard–Oxford region profiles. */
  anatomicalTargetAlignment: z.number().finite().min(0).max(1).optional(),
  /** Largest radial scalp-to-cortex gap among placed optodes. */
  maximumScalpCortexGapMm: z.number().finite().nonnegative().optional(),
  /** Fraction of optodes inside the planner's cranial support envelope. */
  cranialOptodeFraction: z.number().finite().min(0).max(1).optional(),
  /** Fraction of fixed ±5 mm/±5° perturbations that remain fully cranially supported. */
  cranialRobustPassFraction: z.number().finite().min(0).max(1).optional(),
});
export type PlanningCandidateMetrics = z.infer<typeof PlanningCandidateMetricsSchema>;

export const PlanningAnatomicalRegionSchema = z.object({
  atlasId: BoundedNameSchema,
  labelEn: BoundedNameSchema,
  massFraction: z.number().finite().min(0).max(1),
});
export type PlanningAnatomicalRegion = z.infer<typeof PlanningAnatomicalRegionSchema>;

export const PlanningAnatomicalProfileSchema = z.object({
  atlasId: BoundedNameSchema,
  atlasSupportFraction: z.number().finite().min(0).max(1),
  regions: z.array(PlanningAnatomicalRegionSchema).max(PROJECT_GRAPH_LIMITS.planningRegions),
});
export type PlanningAnatomicalProfile = z.infer<typeof PlanningAnatomicalProfileSchema>;

export const PlanningCandidateSummarySchema = z.object({
  stableId: BoundedNameSchema,
  rank: z.number().int().positive(),
  accepted: z.boolean(),
  rejectionReasons: z.array(BoundedFlagSchema).max(256),
  metrics: PlanningCandidateMetricsSchema,
  anatomicalCoverage: PlanningAnatomicalProfileSchema.optional(),
  placements: z.array(z.object({
    layoutId: z.string().uuid(),
    instanceId: z.string().uuid(),
    anchorRasMm: Vec3Schema,
    rotationRad: z.number().finite(),
  })).max(PROJECT_GRAPH_LIMITS.planningPlacementsPerCandidate),
});
export type PlanningCandidateSummary = z.infer<typeof PlanningCandidateSummarySchema>;

export const AgentPlanningRecordSchema = z.object({
  version: z.literal(1),
  engine: z.literal('cortexlume-deterministic-planner'),
  engineVersion: BoundedNameSchema,
  plannedAt: z.string().datetime(),
  canonicalRequestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  canonicalRequest: z.record(z.unknown()),
  seed: BoundedNameSchema,
  assetHashes: z.record(z.string().regex(/^[a-f0-9]{64}$/)),
  sourceProjectSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  targetAnatomy: PlanningAnatomicalProfileSchema.optional(),
  guidance: z.object({
    targetSurfaceComponentCount: z.number().int().positive(),
    significantTargetComponentCount: z.number().int().positive(),
    significantTargetRegionCount: z.number().int().nonnegative(),
    requestedPatchCount: z.number().int().positive(),
    recommendedPatchCount: z.number().int().min(1).max(4),
    flags: z.array(BoundedFlagSchema).max(256),
  }).optional(),
  candidates: z.array(PlanningCandidateSummarySchema).length(3),
  recommendedCandidateId: BoundedNameSchema,
  selectedCandidateId: BoundedNameSchema,
}).superRefine((value, context) => {
  const ids = new Set(value.candidates.map((candidate) => candidate.stableId));
  if (ids.size !== value.candidates.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Planning candidate IDs must be unique.' });
  }
  if (!ids.has(value.recommendedCandidateId) || !ids.has(value.selectedCandidateId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Planning record references an unknown candidate.' });
  }
});
export type AgentPlanningRecord = z.infer<typeof AgentPlanningRecordSchema>;

const CortexLumeProjectBaseSchema = z.object({
  format: z.literal('cortexlume-project'),
  id: z.string().uuid(),
  name: BoundedNameSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  template: TemplateRefSchema,
  layouts: z.array(LayoutDefinitionSchema).max(PROJECT_GRAPH_LIMITS.layouts),
  instances: z.array(LayoutInstanceSchema).max(PROJECT_GRAPH_LIMITS.instances),
  deviceProfile: DeviceProfileSchema,
  bidsSettings: BidsSettingsSchema.default({
    subjectLabel: '01',
    sessionLabel: '',
    taskLabel: 'layout',
    acquisitionLabel: '',
    runIndex: null,
  }),
  projectionSettings: ProjectionSettingsSchema,
  verifiedResults: z.array(ProjectionResultSchema).max(PROJECT_GRAPH_LIMITS.verifiedResults),
  digitizerSessions: z.array(DigitizerSessionSchema).max(PROJECT_GRAPH_LIMITS.digitizerSessions).default([]),
});

export const CortexLumeProjectV1Schema = CortexLumeProjectBaseSchema.extend({
  formatVersion: z.literal(1),
});
export type CortexLumeProjectV1 = z.infer<typeof CortexLumeProjectV1Schema>;

export const CortexLumeProjectV2Schema = CortexLumeProjectBaseSchema.extend({
  formatVersion: z.literal(2),
  functionalTarget: FunctionalTargetMapSchema.nullable().default(null),
  surfaceOverlay: SurfaceOverlaySchema.default('none'),
  coverageRegion: z.object({
    atlasId: BoundedNameSchema,
    labelEn: BoundedNameSchema,
  }).nullable().default(null),
  planning: AgentPlanningRecordSchema.nullable().default(null),
});
export type CortexLumeProjectV2 = z.infer<typeof CortexLumeProjectV2Schema>;

/** Validates relationships that individual object schemas cannot check in isolation. */
export function validateProjectGraph(project: CortexLumeProjectV2, context: z.RefinementCtx): void {
  const issue = (message: string, path: (string | number)[] = []) => {
    context.addIssue({ code: z.ZodIssueCode.custom, message, path });
  };
  const rejectDuplicates = (
    values: readonly string[],
    message: string,
    path: (string | number)[],
  ) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value)) issue(message, [...path, index]);
      seen.add(value);
    });
  };

  rejectDuplicates(project.layouts.map((layout) => layout.id), 'Layout IDs must be unique.', ['layouts']);
  rejectDuplicates(project.instances.map((instance) => instance.id), 'Instance IDs must be unique.', ['instances']);
  rejectDuplicates(project.digitizerSessions.map((session) => session.id), 'Digitizer session IDs must be unique.', ['digitizerSessions']);

  const layouts = new Map(project.layouts.map((layout) => [layout.id, layout] as const));
  const allPairIds = new Set<string>();
  project.layouts.forEach((layout, layoutIndex) => {
    rejectDuplicates(layout.optodes.map((optode) => optode.id), 'Optode IDs must be unique within a layout.', ['layouts', layoutIndex, 'optodes']);
    rejectDuplicates(layout.pairs.map((pair) => pair.id), 'Pair IDs must be unique within a layout.', ['layouts', layoutIndex, 'pairs']);
    const optodes = new Map(layout.optodes.map((optode) => [optode.id, optode] as const));
    const channelNumbers = new Set<number>();
    layout.pairs.forEach((pair, pairIndex) => {
      const pairPath = ['layouts', layoutIndex, 'pairs', pairIndex] as (string | number)[];
      allPairIds.add(pair.id);
      const source = optodes.get(pair.sourceId);
      const detector = optodes.get(pair.detectorId);
      if (!source) issue('Pair sourceId must reference an optode in its layout.', [...pairPath, 'sourceId']);
      else if (source.type !== 'source') issue('Pair sourceId must reference a source optode.', [...pairPath, 'sourceId']);
      if (!detector) issue('Pair detectorId must reference an optode in its layout.', [...pairPath, 'detectorId']);
      else if (detector.type !== 'detector') issue('Pair detectorId must reference a detector optode.', [...pairPath, 'detectorId']);
      if (pair.sourceId === pair.detectorId) issue('Pair endpoints must be different optodes.', pairPath);
      if (pair.channelNumber != null) {
        if (channelNumbers.has(pair.channelNumber)) issue('Channel numbers must be unique within a layout.', [...pairPath, 'channelNumber']);
        channelNumbers.add(pair.channelNumber);
      }
    });
  });

  const instances = new Map(project.instances.map((instance) => [instance.id, instance] as const));
  const sessions = new Map(project.digitizerSessions.map((session) => [session.id, session] as const));
  project.instances.forEach((instance, instanceIndex) => {
    const instancePath = ['instances', instanceIndex] as (string | number)[];
    const layout = layouts.get(instance.definitionId);
    if (!layout) issue('Instance definitionId must reference an existing layout.', [...instancePath, 'definitionId']);
    const optodeIds = new Set(layout?.optodes.map((optode) => optode.id) ?? []);
    rejectDuplicates(instance.overrides.map((override) => override.optodeId), 'Instance overrides must reference each optode at most once.', [...instancePath, 'overrides']);
    instance.overrides.forEach((override, overrideIndex) => {
      if (!optodeIds.has(override.optodeId)) issue('Instance override references an unknown optode.', [...instancePath, 'overrides', overrideIndex, 'optodeId']);
    });
    rejectDuplicates(instance.digitizerPositions.map((position) => position.optodeId), 'Digitizer positions must reference each optode at most once.', [...instancePath, 'digitizerPositions']);
    rejectDuplicates(instance.digitizerPositions.map((position) => position.digitizerPointId), 'Digitizer point IDs must be unique within an instance.', [...instancePath, 'digitizerPositions']);
    if (instance.digitizerPositions.length > 0 && instance.digitizerSessionId == null) {
      issue('Digitizer positions require a linked digitizer session.', [...instancePath, 'digitizerSessionId']);
    }
    instance.digitizerPositions.forEach((position, positionIndex) => {
      if (!optodeIds.has(position.optodeId)) issue('Digitizer position references an unknown optode.', [...instancePath, 'digitizerPositions', positionIndex, 'optodeId']);
      const session = instance.digitizerSessionId == null ? undefined : sessions.get(instance.digitizerSessionId);
      if (session && !session.points.some((point) => point.id === position.digitizerPointId)) {
        issue('Digitizer position references a point outside its session.', [...instancePath, 'digitizerPositions', positionIndex, 'digitizerPointId']);
      }
    });
    if (instance.derivedFromInstanceId === instance.id) issue('An instance cannot derive from itself.', [...instancePath, 'derivedFromInstanceId']);
    else if (instance.derivedFromInstanceId != null && !instances.has(instance.derivedFromInstanceId)) {
      issue('derivedFromInstanceId must reference an existing instance.', [...instancePath, 'derivedFromInstanceId']);
    }
    if (instance.digitizerSessionId != null && !sessions.has(instance.digitizerSessionId)) {
      issue('digitizerSessionId must reference an existing digitizer session.', [...instancePath, 'digitizerSessionId']);
    }
    if (instance.fitQc && instance.fitQc.maxAbsoluteErrorMm < instance.fitQc.meanAbsoluteErrorMm) {
      issue('Fit QC maximum error cannot be smaller than its mean error.', [...instancePath, 'fitQc']);
    }
  });

  project.instances.forEach((instance, instanceIndex) => {
    const visited = new Set<string>([instance.id]);
    let parentId = instance.derivedFromInstanceId;
    while (parentId != null) {
      if (visited.has(parentId)) {
        issue('Instance derivation references must not contain a cycle.', ['instances', instanceIndex, 'derivedFromInstanceId']);
        break;
      }
      visited.add(parentId);
      parentId = instances.get(parentId)?.derivedFromInstanceId ?? null;
    }
  });

  project.digitizerSessions.forEach((session, sessionIndex) => {
    const sessionPath = ['digitizerSessions', sessionIndex] as (string | number)[];
    rejectDuplicates(session.points.map((point) => point.id), 'Digitizer point IDs must be unique within a session.', [...sessionPath, 'points']);
    const pointIds = new Set(session.points.map((point) => point.id));
    rejectDuplicates(session.calibratedPoints.map((point) => point.pointId), 'Calibrated point references must be unique.', [...sessionPath, 'calibratedPoints']);
    session.calibratedPoints.forEach((point, pointIndex) => {
      if (!pointIds.has(point.pointId)) issue('Calibrated point references an unknown session point.', [...sessionPath, 'calibratedPoints', pointIndex, 'pointId']);
    });
    const mappingKeys = new Set<string>();
    session.optodeMappings.forEach((mapping, mappingIndex) => {
      const mappingPath = [...sessionPath, 'optodeMappings', mappingIndex];
      const key = `${mapping.instanceId}:${mapping.optodeId}`;
      if (mappingKeys.has(key)) issue('Digitizer mappings must be unique per instance and optode.', mappingPath);
      mappingKeys.add(key);
      if (!pointIds.has(mapping.pointId)) issue('Digitizer mapping references an unknown session point.', [...mappingPath, 'pointId']);
      const instance = instances.get(mapping.instanceId);
      if (!instance) issue('Digitizer mapping references an unknown instance.', [...mappingPath, 'instanceId']);
      else {
        if (instance.digitizerSessionId !== session.id) {
          issue('Digitizer mapping instance must reference this session.', [...mappingPath, 'instanceId']);
        }
        const layout = layouts.get(instance.definitionId);
        if (!layout?.optodes.some((optode) => optode.id === mapping.optodeId)) {
          issue('Digitizer mapping references an optode outside the instance layout.', [...mappingPath, 'optodeId']);
        }
      }
    });
  });

  Object.keys(project.projectionSettings.pairDepthOverridesMm).forEach((pairId) => {
    if (!allPairIds.has(pairId)) issue('Pair depth override references an unknown pair.', ['projectionSettings', 'pairDepthOverridesMm', pairId]);
  });

  const resultKeys = new Set<string>();
  project.verifiedResults.forEach((result, resultIndex) => {
    const resultPath = ['verifiedResults', resultIndex] as (string | number)[];
    const resultKey = `${result.instanceId ?? 'null'}:${result.subjectKind}:${result.subjectId}`;
    if (resultKeys.has(resultKey)) issue('Verified result keys must be unique.', resultPath);
    resultKeys.add(resultKey);
    if (result.instanceId == null) {
      issue('Verified result must reference an instance.', [...resultPath, 'instanceId']);
      return;
    }
    const instance = instances.get(result.instanceId);
    if (!instance) {
      issue('Verified result references an unknown instance.', [...resultPath, 'instanceId']);
      return;
    }
    const layout = layouts.get(instance.definitionId);
    const exists = result.subjectKind === 'optode'
      ? layout?.optodes.some((optode) => optode.id === result.subjectId)
      : layout?.pairs.some((pair) => pair.id === result.subjectId);
    if (!exists) issue(`Verified ${result.subjectKind} result references an unknown subject.`, [...resultPath, 'subjectId']);
  });
}

export function migrateProjectV1ToV2(project: CortexLumeProjectV1): CortexLumeProjectV2 {
  return CortexLumeProjectV2Schema.parse({
    ...project,
    formatVersion: 2,
    functionalTarget: null,
    surfaceOverlay: 'none',
    coverageRegion: null,
    planning: null,
  });
}

/** Parses current projects and explicitly migrates legacy v1 data in memory. */
export const CortexLumeProjectSchema = z.preprocess((value) => {
  if (value && typeof value === 'object' && 'formatVersion' in value
    && (value as { formatVersion?: unknown }).formatVersion === 1) {
    return migrateProjectV1ToV2(CortexLumeProjectV1Schema.parse(value));
  }
  return value;
}, CortexLumeProjectV2Schema).superRefine(validateProjectGraph);
export type CortexLumeProject = z.infer<typeof CortexLumeProjectSchema>;

export const FitPlacementRequestSchema = z.object({
  interactionId: z.string(),
  projectRevision: z.number().int().nonnegative(),
  template: TemplateRefSchema,
  layout: LayoutDefinitionSchema,
  instance: LayoutInstanceSchema,
});
export type FitPlacementRequest = z.infer<typeof FitPlacementRequestSchema>;

export const FitPlacementResponseSchema = z.object({
  interactionId: z.string(),
  projectRevision: z.number().int().nonnegative(),
  instance: LayoutInstanceSchema,
  projections: z.array(ProjectionResultSchema),
  templateVerified: z.boolean(),
});
export type FitPlacementResponse = z.infer<typeof FitPlacementResponseSchema>;

export interface DesktopApi {
  window: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<boolean>;
    close(): Promise<void>;
    onCloseRequested(callback: () => void): () => void;
    finishClose(allow: boolean): Promise<void>;
  };
  project: {
    startup(): Promise<{ project: CortexLumeProject; path: string } | null>;
    open(): Promise<{ project: CortexLumeProject; path: string } | null>;
    save(project: CortexLumeProject, currentPath?: string): Promise<{ path: string } | null>;
    confirmUnsavedChanges(): Promise<'save' | 'discard' | 'cancel'>;
  };
  input: {
    digitizer(): Promise<DigitizerImport | null>;
    targetNifti(declaredSpace: TargetImportSpace): Promise<TargetImportResult | null>;
  };
  operations: {
    cancel(operationId: string): Promise<boolean>;
    onProgress(callback: (progress: ProjectOperationProgress) => void): () => void;
  };
  export: {
    csv(project: CortexLumeProject, options?: ProjectOperationOptions): Promise<{
      directory: string;
      files: string[];
      warnings: string[];
    } | null>;
    brainNet(project: CortexLumeProject, options?: ProjectOperationOptions): Promise<{
      directory: string;
      files: string[];
      warnings: string[];
      brainNet: {
        matlabFound: boolean;
        brainNetFound: boolean;
        launched: boolean;
        detail: string;
      };
    } | null>;
    bidsGeometry(project: CortexLumeProject, options?: ProjectOperationOptions): Promise<{
      directory: string;
      files: string[];
      warnings: string[];
    } | null>;
  };
  science: {
    health(): Promise<{
      ok: boolean;
      /** Legacy alias retained for existing renderer callers. */
      version?: string;
      applicationVersion?: string;
      sidecarPackageVersion?: string;
      scienceApiVersion?: string;
      gitCommit?: string;
      dependencyLockSha256?: string;
      templateVerified?: boolean;
      atlasVerified?: boolean;
      error?: string;
    }>;
    fitPlacement(request: FitPlacementRequest): Promise<FitPlacementResponse>;
    atlasLookup(point: Vec3, probabilityThreshold?: number): Promise<AtlasLabel[]>;
    atlasLookupPath(points: Vec3[], probabilityThreshold?: number): Promise<AtlasLabel[]>;
    annotateProject(project: CortexLumeProject, options?: ProjectOperationOptions): Promise<CortexLumeProject>;
    quickTargetSearch(query: string, limit?: number): Promise<{
      targets: QuickTargetSummary[];
      provenance: Record<string, unknown>;
    }>;
    quickTargetMap(targetId: string): Promise<FunctionalTargetMap>;
    anatomicalCoverage(request: AnatomicalCoverageRequest): Promise<AnatomicalCoverageAnalysis>;
  };
}
