import { z } from 'zod';

export const Vec2Schema = z.tuple([z.number(), z.number()]);
export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
export type Vec2 = z.infer<typeof Vec2Schema>;
export type Vec3 = z.infer<typeof Vec3Schema>;

export const OptodeTypeSchema = z.enum(['source', 'detector']);
export type OptodeType = z.infer<typeof OptodeTypeSchema>;

export const OptodeSchema = z.object({
  id: z.string().uuid(),
  label: z.string().min(1),
  type: OptodeTypeSchema,
  uvMm: Vec2Schema,
});
export type Optode = z.infer<typeof OptodeSchema>;

export const PairSchema = z.object({
  id: z.string().uuid(),
  sourceId: z.string().uuid(),
  detectorId: z.string().uuid(),
  channelNumber: z.number().int().positive().optional(),
  nominalDistanceMm: z.number().positive(),
  shortChannel: z.boolean().default(false),
});
export type Pair = z.infer<typeof PairSchema>;

export const LayoutDefinitionSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  name: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  gridSpacingMm: z.number().positive(),
  optodes: z.array(OptodeSchema),
  pairs: z.array(PairSchema),
});
export type LayoutDefinition = z.infer<typeof LayoutDefinitionSchema>;

export const MeshAnchorSchema = z.object({
  meshSha256: z.string(),
  faceIndex: z.number().int().nonnegative(),
  barycentric: z.tuple([z.number(), z.number(), z.number()]),
  rasMm: Vec3Schema,
});
export type MeshAnchor = z.infer<typeof MeshAnchorSchema>;

export const FitQcSchema = z.object({
  converged: z.boolean(),
  iterations: z.number().int().nonnegative(),
  meanAbsoluteErrorMm: z.number().nonnegative(),
  maxAbsoluteErrorMm: z.number().nonnegative(),
  flags: z.array(z.string()),
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
  rotationRad: z.number(),
  mappingRotationRad: z.number().default(0),
  visible: z.boolean().default(true),
  locked: z.boolean().default(true),
  overrides: z.array(OptodeOverrideSchema),
  digitizerPositions: z.array(z.object({
    optodeId: z.string().uuid(),
    digitizerPointId: z.string().uuid(),
    scalpRasMm: Vec3Schema,
  })).default([]),
  derivedFromInstanceId: z.string().uuid().nullable().default(null),
  digitizerSessionId: z.string().uuid().nullable().default(null),
  fitQc: FitQcSchema.optional(),
});
export type LayoutInstance = z.infer<typeof LayoutInstanceSchema>;

export const DeviceProfileSchema = z.object({
  manufacturer: z.string().min(1).default('Shimadzu'),
  model: z.string().min(1).default('LABNIRS'),
  wavelengthsNm: z.preprocess(
    (value) => Array.isArray(value) && value.length === 0 ? undefined : value,
    z.array(z.number().positive()).min(1).default([780, 805, 830]),
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
  units: z.string().min(1).default('V'),
  sourceType: z.string().min(1).default('LASER'),
  detectorType: z.string().min(1).default('PMT'),
  samplingFrequencyHz: z.number().positive().nullable().default(null),
});
export type DeviceProfile = z.infer<typeof DeviceProfileSchema>;

const BidsLabelSchema = z.string().regex(/^[A-Za-z0-9]+$/);
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
  atlasId: z.string(),
  labelEn: z.string(),
  probability: z.number().min(0).max(1),
});
export type AtlasLabel = z.infer<typeof AtlasLabelSchema>;

export const ProjectionResultSchema = z.object({
  instanceId: z.string().uuid().nullable(),
  subjectKind: z.enum(['optode', 'pair']),
  subjectId: z.string().uuid(),
  scalpRasMm: Vec3Schema.nullable(),
  displayRasMm: Vec3Schema.nullable().default(null),
  corticalRasMm: Vec3Schema.nullable(),
  depthTargetRasMm: Vec3Schema.nullable(),
  underlyingCorticalRegions: z.array(AtlasLabelSchema),
  deepTargetStructures: z.array(AtlasLabelSchema),
  tissueAtTarget: z.string().nullable(),
  claimLevel: z.enum(['development_only', 'geometric', 'modeled']),
  status: z.enum(['provisional', 'verified', 'blocked']),
  qcFlags: z.array(z.string()),
});
export type ProjectionResult = z.infer<typeof ProjectionResultSchema>;

export const TemplateRefSchema = z.object({
  id: z.literal('MNI152NLin6Asym'),
  assetVersion: z.string(),
  coordinateConvention: z.literal('RAS+'),
  units: z.literal('mm'),
  verified: z.boolean(),
  manifestSha256: z.string(),
  scalpMeshSha256: z.string(),
  cortexMeshSha256: z.string(),
  atlasSha256: z.string(),
});
export type TemplateRef = z.infer<typeof TemplateRefSchema>;

export const DigitizerPointKindSchema = z.enum(['source', 'detector', 'landmark', 'headshape', 'unknown']);
export type DigitizerPointKind = z.infer<typeof DigitizerPointKindSchema>;

export const DigitizerPointSchema = z.object({
  id: z.string().uuid(),
  label: z.string().min(1),
  kind: DigitizerPointKindSchema,
  rawPosition: Vec3Schema,
});
export type DigitizerPoint = z.infer<typeof DigitizerPointSchema>;

export const DigitizerCalibrationSchema = z.object({
  method: z.literal('five-point-similarity'),
  sourceUnit: z.enum(['mm', 'cm', 'm']),
  matrix: z.array(z.number()).length(16),
  scale: z.number().positive(),
  rmsResidualMm: z.number().nonnegative(),
  maxResidualMm: z.number().nonnegative(),
  residuals: z.array(z.object({
    label: z.enum(['Nz', 'Iz', 'LPA', 'RPA', 'Cz']),
    measuredRasMm: Vec3Schema,
    targetRasMm: Vec3Schema,
    residualMm: z.number().nonnegative(),
  })).length(5),
  calibratedAt: z.string().datetime(),
});
export type DigitizerCalibration = z.infer<typeof DigitizerCalibrationSchema>;

export const DigitizerOptodeMappingSchema = z.object({
  pointId: z.string().uuid(),
  instanceId: z.string().uuid(),
  optodeId: z.string().uuid(),
  distanceMm: z.number().nonnegative(),
});
export type DigitizerOptodeMapping = z.infer<typeof DigitizerOptodeMappingSchema>;

export const DigitizerSessionSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  importedAt: z.string().datetime(),
  source: z.object({
    format: z.string().min(1),
    fileName: z.string().nullable(),
    sha256: z.string().nullable(),
  }),
  points: z.array(DigitizerPointSchema).min(5),
  calibratedPoints: z.array(z.object({ pointId: z.string().uuid(), rasMm: Vec3Schema })),
  calibration: DigitizerCalibrationSchema,
  optodeMappings: z.array(DigitizerOptodeMappingSchema).default([]),
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
  id: z.string().min(1),
  label: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  domain: z.string().min(1).optional(),
  subdomain: z.string().min(1).optional(),
  studyCount: z.number().int().nonnegative().nullable().optional(),
  description: z.string().optional(),
  peakRegions: z.array(z.string()).default([]),
  laterality: z.string().optional(),
});
export type QuickTargetSummary = z.infer<typeof QuickTargetSummarySchema>;

export const FunctionalTargetProvenanceSchema = z.object({
  sourceKind: z.enum(['neurosynth-quick', 'nifti-import']),
  sourceSpace: z.string().min(1),
  targetSpace: z.literal('MNI152NLin6Asym'),
  targetSurface: z.literal('Cedalion-ICBM152-25k'),
  statistic: z.string().min(1),
  mapSha256: z.string().min(1),
  fileName: z.string().nullable().optional(),
  interpolation: z.string().optional(),
  validation: z.record(z.unknown()).optional(),
  packId: z.string().optional(),
  distributionRole: z.string().optional(),
});
export type FunctionalTargetProvenance = z.infer<typeof FunctionalTargetProvenanceSchema>;

export const FunctionalTargetMapSchema = z.object({
  target: QuickTargetSummarySchema,
  vertexCount: z.literal(25_000),
  vertexIndices: z.array(z.number().int().min(0).max(24_999)).min(1),
  values: z.array(z.number().finite().positive()).min(1),
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
  affine: z.array(z.array(z.number())).nullable(),
  units: z.string().nullable(),
  valueMin: z.number().finite().nullable(),
  valueMax: z.number().finite().nullable(),
  nonzeroVoxels: z.number().int().nonnegative().nullable(),
  sha256: z.string().nullable(),
  diagnostics: z.array(TargetImportDiagnosticSchema),
  map: FunctionalTargetMapSchema.nullable(),
});
export type TargetImportResult = z.infer<typeof TargetImportResultSchema>;

export const CortexLumeProjectSchema = z.object({
  format: z.literal('cortexlume-project'),
  formatVersion: z.literal(1),
  id: z.string().uuid(),
  name: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  template: TemplateRefSchema,
  layouts: z.array(LayoutDefinitionSchema),
  instances: z.array(LayoutInstanceSchema),
  deviceProfile: DeviceProfileSchema,
  bidsSettings: BidsSettingsSchema.default({
    subjectLabel: '01',
    sessionLabel: '',
    taskLabel: 'layout',
    acquisitionLabel: '',
    runIndex: null,
  }),
  projectionSettings: ProjectionSettingsSchema,
  verifiedResults: z.array(ProjectionResultSchema),
  digitizerSessions: z.array(DigitizerSessionSchema).default([]),
});
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
  };
  project: {
    open(): Promise<{ project: CortexLumeProject; path: string } | null>;
    save(project: CortexLumeProject, currentPath?: string): Promise<{ path: string } | null>;
  };
  input: {
    digitizer(): Promise<DigitizerImport | null>;
    targetNifti(declaredSpace: TargetImportSpace): Promise<TargetImportResult | null>;
  };
  export: {
    csv(project: CortexLumeProject): Promise<{
      directory: string;
      files: string[];
      warnings: string[];
    } | null>;
    brainNet(project: CortexLumeProject): Promise<{
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
    bidsGeometry(project: CortexLumeProject): Promise<{
      directory: string;
      files: string[];
      warnings: string[];
    } | null>;
  };
  science: {
    health(): Promise<{ ok: boolean; version?: string; templateVerified?: boolean; atlasVerified?: boolean; error?: string }>;
    fitPlacement(request: FitPlacementRequest): Promise<FitPlacementResponse>;
    atlasLookup(point: Vec3, probabilityThreshold?: number): Promise<AtlasLabel[]>;
    atlasLookupPath(points: Vec3[], probabilityThreshold?: number): Promise<AtlasLabel[]>;
    annotateProject(project: CortexLumeProject): Promise<CortexLumeProject>;
    quickTargetSearch(query: string, limit?: number): Promise<{
      targets: QuickTargetSummary[];
      provenance: Record<string, unknown>;
    }>;
    quickTargetMap(targetId: string): Promise<FunctionalTargetMap>;
  };
}
