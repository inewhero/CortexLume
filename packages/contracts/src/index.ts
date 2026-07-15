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
  fitQc: FitQcSchema.optional(),
});
export type LayoutInstance = z.infer<typeof LayoutInstanceSchema>;

export const DeviceProfileSchema = z.object({
  wavelengthsNm: z.array(z.number().positive()).default([]),
  measurementType: z.string().optional(),
  units: z.string().optional(),
});
export type DeviceProfile = z.infer<typeof DeviceProfileSchema>;

const ProjectionModeValueSchema = z.enum(['scalp', 'cortex']);
export const ProjectionModeSchema = z.preprocess(
  (value) => value === 'surface' ? 'scalp' : value === 'anatomical_depth' ? 'cortex' : value,
  ProjectionModeValueSchema,
);
export type ProjectionMode = z.infer<typeof ProjectionModeSchema>;

export const ProjectionSettingsSchema = z.object({
  mode: ProjectionModeSchema.default('scalp'),
  defaultDepthMm: z.number().min(1).max(100).nullable().default(null),
  pairDepthOverridesMm: z.record(z.string().uuid(), z.number().min(1).max(100)).default({}),
  atlasProbabilityThreshold: z.number().min(0).max(1).default(0.1),
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
  projectionSettings: ProjectionSettingsSchema,
  verifiedResults: z.array(ProjectionResultSchema),
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
    open(): Promise<CortexLumeProject | null>;
    save(project: CortexLumeProject, currentPath?: string): Promise<{ path: string } | null>;
  };
  export: {
    csv(project: CortexLumeProject): Promise<{ directory: string } | null>;
    bidsGeometry(project: CortexLumeProject): Promise<{ directory: string; warnings: string[] } | null>;
  };
  science: {
    health(): Promise<{ ok: boolean; version?: string; templateVerified?: boolean; error?: string }>;
    fitPlacement(request: FitPlacementRequest): Promise<FitPlacementResponse>;
  };
}
