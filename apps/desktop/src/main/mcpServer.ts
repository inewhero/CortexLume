import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import {
  AnatomicalCoverageRequestSchema,
  CortexLumeProjectSchema,
  FunctionalTargetMapSchema,
  PlanningAnatomicalProfileSchema,
  type AgentPlanningRecord,
  type AnatomicalCoverageRequest,
  type CortexLumeProject,
  type FunctionalTargetMap,
  type PlanningAnatomicalProfile,
  type ProjectionResult,
  type Vec3,
} from '@cortexlume/contracts';
import {
  BUILTIN_PATCH_CATALOG_VERSION,
  BUILTIN_PATCH_PRESET_IDS,
  BUILTIN_PATCH_PRESETS,
  channelSensitivityPath,
  deterministicUuid,
  distance3,
  loadHeadModelFromAssets,
  planLayouts,
  summarizeTargetSurfaceComponents,
  validatePlannerPatchSpecs,
  type LoadedHeadModel,
  type PlannerCandidate,
  type PlannerPatchSpec,
} from '@cortexlume/core/node';
import {
  createProjectArchive, PROJECT_ARCHIVE_LIMITS, readProjectArchiveDetailed, sha256Bytes,
} from '@cortexlume/project-io';
import { withStagedNiftiFile, type ScienceClient } from '@cortexlume/science-client';
import { MCP_ROOT_CONFIGURATION_ERROR } from './mcpBootstrapConfig';
import { buildAtlasViewerExportAsync } from './atlasViewerExport';
import { createUniqueExportDirectory, writeExportBundle, type WritableExportBundle } from './exportBundleWriter';
import { buildBrainNetExportAsync } from './projectExport';
import type {
  McpScreenshotCameraState,
  McpScreenshotLayerState,
  McpScreenshotPreset,
  McpScreenshotRenderRequest,
  McpScreenshotRenderResult,
} from '../shared/mcpScreenshot';
import {
  durableAtomicCreateExclusive,
  isAlreadyExistsError,
  stableReadRegularFile,
  resolveAuthorizedPath,
} from './durableFile';

interface PlanCacheEntry {
  planId: string;
  requestHash: string;
  canonicalRequest: Record<string, unknown>;
  seed: string;
  target: FunctionalTargetMap;
  candidates: PlannerCandidate[];
  recommendedCandidateId: string;
  sourceProject: CortexLumeProject | null;
  sourceProjectSha256: string | null;
  plannedAt: string;
  optodeRadiusMm: number;
  transmissionDepthMm: number;
  targetAnatomy: PlanningAnatomicalProfile;
  guidance: {
    targetSurfaceComponentCount: number;
    significantTargetComponentCount: number;
    significantTargetRegionCount: number;
    requestedPatchCount: number;
    recommendedPatchCount: number;
    flags: string[];
  };
  /** Absolute expiry retained in the response so clients can refresh plans before use. */
  expiresAt: string;
}

export const MCP_PLAN_CACHE_MAX_ENTRIES = 32;
export const MCP_PLAN_CACHE_TTL_MS = 45 * 60 * 1000;
/** Estimated retained object-graph budget, independent of the entry cap. */
export const MCP_PLAN_CACHE_MAX_ESTIMATED_BYTES = 96 * 1024 * 1024;
export const MCP_TARGET_ANATOMY_CACHE_MAX_ENTRIES = 96;
export const MCP_TARGET_ANATOMY_CACHE_TTL_MS = 45 * 60 * 1000;
export const MCP_TARGET_ANATOMY_CACHE_MAX_ESTIMATED_BYTES = 4 * 1024 * 1024;

export interface BoundedCacheStats {
  size: number;
  maxEntries: number;
  ttlMs: number;
  estimatedBytes: number;
  maxEstimatedBytes: number | null;
  evictionCount: number;
  /** Alias kept concise for telemetry consumers. */
  evictions: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAtMs: number;
  estimatedBytes: number;
}

/**
 * Small insertion-ordered LRU cache with an absolute TTL.  Map iteration order
 * is used deliberately: deleting and re-inserting a hit makes it the newest
 * entry while the first entry remains the least recently used one.  This is
 * shared by plans and target profiles so neither unbounded object graph can
 * accumulate in a long-running stdio MCP process.
 */
export class BoundedTtlCache<K, V> {
  private readonly entries = new Map<K, CacheEntry<V>>();
  private evictions = 0;
  private retainedEstimatedBytes = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxEstimatedBytes: number = Number.POSITIVE_INFINITY,
    private readonly estimateBytes: (value: V) => number = () => 1,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error('Cache maxEntries must be a positive integer');
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('Cache ttlMs must be positive');
    if (!(maxEstimatedBytes > 0)) throw new Error('Cache maxEstimatedBytes must be positive');
  }

  get(key: K): V | undefined {
    const entry = this.getEntry(key);
    return entry?.value;
  }

  getEntry(key: K): { value: V; expiresAtMs: number } | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const now = this.now();
    if (entry.expiresAtMs <= now) {
      this.remove(key, entry);
      this.evictions += 1;
      return undefined;
    }
    // A hit is both an LRU refresh and a TTL refresh.  Refreshing both is
    // important for repeated planning sessions that remain active for hours.
    this.entries.delete(key);
    const refreshed = { ...entry, expiresAtMs: now + this.ttlMs };
    this.entries.set(key, refreshed);
    return refreshed;
  }

  set(key: K, value: V): { value: V; expiresAtMs: number } {
    this.purgeExpired();
    const estimatedBytes = Math.max(0, Math.ceil(this.estimateBytes(value)));
    if (!Number.isFinite(estimatedBytes)) throw new Error('Cache entry byte estimate must be finite');
    if (estimatedBytes > this.maxEstimatedBytes) {
      throw new Error(`Cache entry exceeds its ${this.maxEstimatedBytes}-byte estimated-memory budget`);
    }
    const previous = this.entries.get(key);
    if (previous) this.remove(key, previous);
    const entry = { value, expiresAtMs: this.now() + this.ttlMs, estimatedBytes };
    this.entries.set(key, entry);
    this.retainedEstimatedBytes += estimatedBytes;
    while (this.entries.size > this.maxEntries || this.retainedEstimatedBytes > this.maxEstimatedBytes) {
      const oldest = this.entries.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      const oldestEntry = this.entries.get(oldest);
      if (oldestEntry) this.remove(oldest, oldestEntry);
      this.evictions += 1;
    }
    return entry;
  }

  delete(key: K): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.remove(key, entry);
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.retainedEstimatedBytes = 0;
  }

  get size(): number {
    return this.stats().size;
  }

  get evictionCount(): number {
    return this.evictions;
  }

  stats(): BoundedCacheStats {
    this.purgeExpired();
    return {
      size: this.entries.size,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
      estimatedBytes: this.retainedEstimatedBytes,
      maxEstimatedBytes: Number.isFinite(this.maxEstimatedBytes) ? this.maxEstimatedBytes : null,
      evictionCount: this.evictions,
      evictions: this.evictions,
    };
  }

  private purgeExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs > now) continue;
      this.remove(key, entry);
      this.evictions += 1;
    }
  }

  private remove(key: K, entry: CacheEntry<V>): void {
    if (!this.entries.delete(key)) return;
    this.retainedEstimatedBytes -= entry.estimatedBytes;
  }
}

function estimatedJsonObjectBytes(value: unknown): number {
  // JSON bytes are deterministic to measure. Doubling them is a conservative
  // approximation for retained JS strings/object fields; telemetry labels the
  // result as an estimate rather than claiming to report process RSS.
  return Math.max(64, Buffer.byteLength(JSON.stringify(value), 'utf8') * 2);
}

/**
 * Gate all MCP uses of the shared science sidecar.  Ordinary requests share a
 * sidecar, but once an exclusive planning section is queued, later requests
 * wait for it.  This second (runtime-level) gate is deliberate: tests and
 * embedders may provide a ScienceClient-shaped object rather than the concrete
 * ScienceClient, and `stop()` must still never race an MCP request in flight.
 */
export class ScienceLifecycleGate {
  private activeRequests = 0;
  private exclusiveActive = false;
  private readonly queuedRequests: Array<() => void> = [];
  private readonly queuedExclusives: Array<() => Promise<void>> = [];

  request<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queuedRequests.push(() => {
        this.activeRequests += 1;
        void Promise.resolve().then(operation).then(resolve, reject).finally(() => {
          this.activeRequests -= 1;
          this.pump();
        });
      });
      this.pump();
    });
  }

  withExclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queuedExclusives.push(async () => {
        try {
          resolve(await operation());
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        } finally {
          this.exclusiveActive = false;
          this.pump();
        }
      });
      this.pump();
    });
  }

  private pump(): void {
    if (this.exclusiveActive || this.activeRequests > 0) return;
    const exclusive = this.queuedExclusives.shift();
    if (exclusive) {
      this.exclusiveActive = true;
      void exclusive();
      return;
    }
    // Requests already queued before an exclusive section are intentionally
    // drained together; a later exclusive waits for all of their leases.
    while (this.queuedRequests.length > 0) this.queuedRequests.shift()?.();
  }
}

export interface McpRuntimeOptions {
  templateRoot: string;
  science: ScienceClient;
  applicationVersion: string;
  authorizedRoots?: string[];
  /** Injectable clock keeps runtime timestamps and cache expiry deterministic. */
  clock?: () => number;
  openGui(projectPath: string): Promise<void> | void;
  /**
   * Render a validated project in a real Electron renderer. The callback must
   * create `temporaryPath` exclusively and return metadata for those bytes.
   * Keeping Electron out of this module preserves protocol-only stdio output.
   */
  captureProjectScreenshot?(request: McpScreenshotRenderRequest): Promise<McpScreenshotRenderResult>;
}

export const MCP_SCREENSHOT_LIMITS = Object.freeze({
  minimumLogicalDimension: 256,
  maximumLogicalDimension: 2_048,
  minimumDpr: 1,
  maximumDpr: 1.6,
  maximumPhysicalDimension: 3_072,
  maximumPhysicalPixels: 4_194_304,
  maximumPngBytes: 64 * 1024 * 1024,
});

const SCREENSHOT_CAMERA_PRESETS: Record<McpScreenshotPreset, Omit<McpScreenshotCameraState, 'source' | 'preset'>> = {
  'gui-default': { position: [215, 138, -300], target: [0, -12, 3], up: [0, 1, 0], fov: 39, near: 0.1, far: 2_000 },
  front: { position: [0, -12, -360], target: [0, -12, 3], up: [0, 1, 0], fov: 39, near: 0.1, far: 2_000 },
  left: { position: [-360, -12, 3], target: [0, -12, 3], up: [0, 1, 0], fov: 39, near: 0.1, far: 2_000 },
  right: { position: [360, -12, 3], target: [0, -12, 3], up: [0, 1, 0], fov: 39, near: 0.1, far: 2_000 },
  superior: { position: [0, 360, 3], target: [0, -12, 3], up: [0, 0, 1], fov: 39, near: 0.1, far: 2_000 },
};

function resolveScreenshotCamera(input: {
  kind: 'preset'; preset: McpScreenshotPreset;
} | {
  kind: 'explicit'; position: Vec3; target: Vec3; up: Vec3; fov: number;
}): McpScreenshotCameraState {
  if (input.kind === 'preset') {
    return { source: 'preset', preset: input.preset, ...SCREENSHOT_CAMERA_PRESETS[input.preset] };
  }
  const viewLength = Math.hypot(
    input.position[0] - input.target[0],
    input.position[1] - input.target[1],
    input.position[2] - input.target[2],
  );
  const upLength = Math.hypot(...input.up);
  if (viewLength < 1e-6) throw new Error('Screenshot camera position and target must differ.');
  if (upLength < 1e-6) throw new Error('Screenshot camera up vector must be non-zero.');
  return {
    source: 'explicit', preset: null,
    position: input.position, target: input.target, up: input.up, fov: input.fov,
    near: 0.1, far: 2_000,
  };
}

function validatePngDimensions(bytes: Uint8Array, expectedWidth: number, expectedHeight: number): void {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.byteLength < 24 || signature.some((value, index) => bytes[index] !== value)) {
    throw new Error('Screenshot worker did not produce a valid PNG.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width !== expectedWidth || height !== expectedHeight) {
    throw new Error(`Screenshot PNG dimensions ${width}x${height} do not match requested ${expectedWidth}x${expectedHeight}.`);
  }
  const colorType = bytes[25];
  if (colorType !== 4 && colorType !== 6) {
    throw new Error('Screenshot PNG must contain an alpha channel.');
  }
}

function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalize(child)]));
    return item;
  };
  return JSON.stringify(normalize(value));
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function toolResult(value: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

function defaultDevice() {
  return {
    manufacturer: 'Shimadzu', model: 'LABNIRS', wavelengthsNm: [780, 805, 830],
    measurementType: 'NIRSCWAMPLITUDE' as const, units: 'V', sourceType: 'LASER', detectorType: 'PMT', samplingFrequencyHz: null,
  };
}

const PLANNING_COVERAGE_SETTINGS = {
  kernelSigmaMm: 12,
  supportRadiusMm: 24,
  minimumAtlasMembership: 0.05,
} as const;

function buildCandidateCoverageRequest(
  head: LoadedHeadModel['headModel'],
  candidate: PlannerCandidate,
  radiusMm: number,
  depthMm: number,
): AnatomicalCoverageRequest {
  const channels = candidate.instances.flatMap((instance, index) => {
    const layout = candidate.layouts[index]!;
    const positions = head.fittedOptodePositions(layout, instance);
    return layout.pairs.flatMap((pair) => {
      const source = positions.get(pair.sourceId);
      const detector = positions.get(pair.detectorId);
      if (!source || !detector) return [];
      return [{
        instanceId: instance.id,
        pairId: pair.id,
        ...(pair.channelNumber == null ? {} : { channelNumber: pair.channelNumber }),
        pointsRasMm: channelSensitivityPath(head, source, detector, radiusMm, depthMm).points,
      }];
    });
  }).sort((left, right) => `${left.instanceId}:${left.pairId}`.localeCompare(`${right.instanceId}:${right.pairId}`));
  return AnatomicalCoverageRequestSchema.parse({ channels, settings: PLANNING_COVERAGE_SETTINGS });
}

function anatomicalProfileOverlap(target: PlanningAnatomicalProfile, candidate: PlanningAnatomicalProfile): number {
  const candidateMass = new Map(candidate.regions.map((region) => [`${region.atlasId}\0${region.labelEn}`, region.massFraction]));
  return target.regions.reduce((sum, region) => (
    sum + Math.min(region.massFraction, candidateMass.get(`${region.atlasId}\0${region.labelEn}`) ?? 0)
  ), 0);
}

export function rerankEnrichedCandidates(candidates: PlannerCandidate[]): void {
  candidates.sort((left, right) => {
    if (left.summary.accepted !== right.summary.accepted) return left.summary.accepted ? -1 : 1;
    const lm = left.summary.metrics;
    const rm = right.summary.metrics;
    const nominalDifference = rm.nominalTargetMassCoverage - lm.nominalTargetMassCoverage;
    if (Math.abs(nominalDifference) > 0.005) return nominalDifference;
    return (rm.balancedTargetCoverage ?? 0) - (lm.balancedTargetCoverage ?? 0)
      || (rm.cranialRobustPassFraction ?? 0) - (lm.cranialRobustPassFraction ?? 0)
      || rm.robustP10TargetMassCoverage - lm.robustP10TargetMassCoverage
      || rm.robustWorstTargetMassCoverage - lm.robustWorstTargetMassCoverage
      || (rm.anatomicalTargetAlignment ?? 0) - (lm.anatomicalTargetAlignment ?? 0)
      || (lm.maximumScalpCortexGapMm ?? Number.POSITIVE_INFINITY) - (rm.maximumScalpCortexGapMm ?? Number.POSITIVE_INFINITY)
      || rm.minimumOptodeClearanceMm - lm.minimumOptodeClearanceMm
      || lm.meanSpacingDistortionMm - rm.meanSpacingDistortionMm
      || left.summary.stableId.localeCompare(right.summary.stableId);
  });
  candidates.forEach((candidate, index) => { candidate.summary.rank = index + 1; });
}

function buildProjectionResults(head: LoadedHeadModel['headModel'], candidate: PlannerCandidate, radiusMm: number, depthMm: number): ProjectionResult[] {
  const results: ProjectionResult[] = [];
  candidate.instances.forEach((instance, index) => {
    const layout = candidate.layouts[index]!;
    const contacts = head.fittedOptodePositions(layout, instance);
    const scalpCenters = new Map<string, Vec3>();
    const displayCenters = new Map<string, Vec3>();
    for (const optode of layout.optodes) {
      const contact = contacts.get(optode.id)!;
      const scalp = head.projectScalpSphereCenter(contact, radiusMm);
      const display = head.projectCortex(contact, radiusMm);
      scalpCenters.set(optode.id, scalp); displayCenters.set(optode.id, display);
      results.push({
        instanceId: instance.id, subjectKind: 'optode', subjectId: optode.id,
        scalpRasMm: scalp, displayRasMm: display, corticalRasMm: head.projectCorticalContact(contact), depthTargetRasMm: null,
        underlyingCorticalRegions: [], deepTargetStructures: [], tissueAtTarget: null,
        claimLevel: 'geometric', status: 'verified', qcFlags: ['surface_model_verified', 'atlas_lookup_pending'],
      });
    }
    for (const pair of layout.pairs) {
      const source = contacts.get(pair.sourceId)!; const detector = contacts.get(pair.detectorId)!;
      const sourceScalp = scalpCenters.get(pair.sourceId)!; const detectorScalp = scalpCenters.get(pair.detectorId)!;
      const sourceDisplay = displayCenters.get(pair.sourceId)!; const detectorDisplay = displayCenters.get(pair.detectorId)!;
      const midpoint = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      const spacingError = Math.abs(distance3(sourceScalp, detectorScalp) - pair.nominalDistanceMm);
      const sensitivity = channelSensitivityPath(head, source, detector, radiusMm, depthMm);
      results.push({
        instanceId: instance.id, subjectKind: 'pair', subjectId: pair.id,
        scalpRasMm: midpoint(sourceScalp, detectorScalp), displayRasMm: midpoint(sourceDisplay, detectorDisplay),
        corticalRasMm: sensitivity.corticalContact, depthTargetRasMm: sensitivity.target,
        underlyingCorticalRegions: [], deepTargetStructures: [], tissueAtTarget: null,
        claimLevel: 'geometric', status: 'verified', qcFlags: spacingError > 5 ? ['surface_model_verified', 'distance_distortion_gt_5mm', 'atlas_lookup_pending'] : spacingError > 2 ? ['surface_model_verified', 'distance_distortion_gt_2mm', 'atlas_lookup_pending'] : ['surface_model_verified', 'atlas_lookup_pending'],
      });
    }
  });
  return results;
}

export class CortexLumeMcpRuntime {
  private readonly plans: BoundedTtlCache<string, PlanCacheEntry>;
  private readonly targetAnatomyCache: BoundedTtlCache<string, PlanningAnatomicalProfile>;
  /** Coalesce concurrent misses for the same immutable target map. */
  private readonly targetAnatomyLoads = new Map<string, Promise<{ profile: PlanningAnatomicalProfile; expiresAtMs: number }>>();
  private readonly scienceLifecycle = new ScienceLifecycleGate();
  private readonly roots: string[];
  private readonly clock: () => number;
  private headPromise: Promise<LoadedHeadModel> | null = null;

  constructor(private readonly options: McpRuntimeOptions) {
    this.clock = options.clock ?? Date.now;
    const configured = (options.authorizedRoots ?? [])
      .map((root) => root.trim())
      .filter((root) => root.length > 0);
    if (configured.length === 0) throw new Error(MCP_ROOT_CONFIGURATION_ERROR);
    this.roots = configured.map((root) => path.resolve(root));
    this.plans = new BoundedTtlCache<string, PlanCacheEntry>(
      MCP_PLAN_CACHE_MAX_ENTRIES,
      MCP_PLAN_CACHE_TTL_MS,
      this.clock,
      MCP_PLAN_CACHE_MAX_ESTIMATED_BYTES,
      estimatedJsonObjectBytes,
    );
    this.targetAnatomyCache = new BoundedTtlCache<string, PlanningAnatomicalProfile>(
      MCP_TARGET_ANATOMY_CACHE_MAX_ENTRIES,
      MCP_TARGET_ANATOMY_CACHE_TTL_MS,
      this.clock,
      MCP_TARGET_ANATOMY_CACHE_MAX_ESTIMATED_BYTES,
      estimatedJsonObjectBytes,
    );
  }

  /** Return bounded-cache telemetry for diagnostics and long-running MCP hosts. */
  cacheStats(): { plans: BoundedCacheStats; targetAnatomy: BoundedCacheStats } {
    return { plans: this.plans.stats(), targetAnatomy: this.targetAnatomyCache.stats() };
  }

  start(): void {
    serveStdio(() => this.createServer());
  }

  createServer(): McpServer {
    const server = new McpServer({ name: 'CortexLume', version: this.options.applicationVersion }, {
      instructions: 'Read list_targets before searching or selecting a Quick Target. Use list_patch_library to inspect the nominal 30 mm presets accepted by plan_project. Use search_targets only to narrow the known catalog, and list_atlas_regions for anatomical targets. plan_project returns functional, robustness, specificity, and Harvard–Oxford anatomical summaries for three candidates without writing files. Broad distributed targets may recommend multiple patches. save_project writes a unique derived .cortexlume archive and never overwrites; release_plan releases an unused cached plan early. export_brainnet and export_atlasviewer validate an authorized project and write a unique headless export bundle under an authorized existing output directory; they never launch MATLAB or another application. capture_project_screenshot renders a deterministic preset or explicit camera in a hidden renderer and writes a unique transparent PNG; it is not a current-GUI-view capture. open_project starts a separate desktop window for human review.',
    });

    server.registerTool('get_capabilities', {
      title: 'Get CortexLume capabilities',
      description: 'Report locked template, planning defaults, target sources, authorized filesystem roots, and fail-closed asset state.',
      inputSchema: {},
    }, async () => {
      let assetState: Record<string, unknown>;
      try {
        const assets = await this.head();
        const health = await this.scienceRequest<Record<string, unknown>>('/v1/health');
        assetState = { ready: true, hashes: assets.assetHashes, science: health };
      } catch (error) {
        assetState = { ready: false, error: error instanceof Error ? error.message : String(error) };
      }
      return toolResult({
        projectFormatVersion: 3,
        template: { id: 'MNI152NLin6Asym', surface: 'Cedalion-ICBM152-25k', coordinateConvention: 'RAS+', units: 'mm' },
        targetSources: ['quick-target', 'harvard-oxford-region', 'mni-point', 'nifti'],
        defaultPatch: { presetId: 'grid-3x5-30mm', columns: 5, rows: 3, pitchMm: 30, topLeft: 'source', pattern: 'checkerboard', optodes: 15, channels: 22 },
        patchLibrary: {
          tool: 'list_patch_library',
          ruleCatalogVersion: BUILTIN_PATCH_CATALOG_VERSION,
          rulePresetIds: BUILTIN_PATCH_PRESET_IDS,
        },
        defaults: { longChannelRangeMm: [25, 40], surfaceDistanceToleranceMm: 1.5, maximumScalpCortexGapMm: 40, kernelSigmaMm: 12, supportRadiusMm: 24, transmissionDepthMm: 25, candidateCount: 3, overlapThresholdMm: 12 },
        quickTargetDiscovery: { firstTool: 'list_targets', thenTool: 'search_targets', catalogIsOffline: true },
        authorizedRoots: this.roots,
        screenshots: {
          tool: 'capture_project_screenshot',
          transparent: true,
          cameraSemantics: 'deterministic-preset-or-explicit-state-not-current-gui-view',
          presets: Object.keys(SCREENSHOT_CAMERA_PRESETS),
          limits: MCP_SCREENSHOT_LIMITS,
          defaultDirectory: 'CortexLume_Screenshots beside the input project',
          uniqueNoOverwrite: true,
        },
        exports: {
          brainnet: {
            tool: 'export_brainnet',
            headless: true,
            launchesExternalApplication: false,
            uniqueNoOverwrite: true,
          },
          atlasviewer: {
            tool: 'export_atlasviewer',
            headless: true,
            launchesExternalApplication: false,
            uniqueNoOverwrite: true,
            bridgeScript: 'cortexlume_open_atlasviewer.m',
          },
        },
        cache: this.cacheStats(),
        assets: assetState,
      });
    });

    server.registerTool('list_targets', {
      title: 'List Quick Target catalog',
      description: 'Read the complete compact offline Quick Target catalog, grouped by domain, before choosing search terms or a target ID.',
      inputSchema: {},
    }, async () => toolResult(await this.scienceRequest<Record<string, unknown>>('/v1/targets/catalog')));

    server.registerTool('search_targets', {
      title: 'Search Quick Targets',
      description: 'Narrow the installed offline Quick Target catalog after list_targets has established the available vocabulary.',
      inputSchema: { query: z.string().max(120).default(''), limit: z.number().int().min(1).max(50).default(20) },
    }, async ({ query, limit }) => toolResult(await this.scienceRequest<Record<string, unknown>>(`/v1/targets?q=${encodeURIComponent(query)}&limit=${limit}`)));

    server.registerTool('list_atlas_regions', {
      title: 'List Harvard-Oxford cortical regions',
      description: 'Return exact legal Harvard-Oxford cortical region names accepted by plan_project.',
      inputSchema: {},
    }, async () => toolResult(await this.scienceRequest<Record<string, unknown>>('/v1/atlas/cortical-regions')));

    server.registerTool('list_patch_library', {
      title: 'List built-in patch library',
      description: 'Return the versioned nominal 30 mm patch presets accepted by plan_project.',
      inputSchema: {},
    }, async () => toolResult({
      ruleCatalog: {
        version: BUILTIN_PATCH_CATALOG_VERSION,
        semantics: 'nominal 30 mm local planar measurement patches accepted by plan_project',
        presets: BUILTIN_PATCH_PRESETS,
      },
    }));

    const gridPatchSchema = z.object({
      name: z.string().min(1).max(80).optional(), columns: z.number().int().min(1).max(12).default(5), rows: z.number().int().min(1).max(12).default(3),
      pitchMm: z.number().min(5).max(80).default(30), activeCells: z.array(z.array(z.boolean())).optional(), reverseSourceDetector: z.boolean().default(false), shortChannelCount: z.number().int().min(0).max(16).default(0),
    });
    const patchSchema = z.union([
      z.object({
        presetId: z.enum(BUILTIN_PATCH_PRESET_IDS),
        name: z.string().min(1).max(80).optional(),
      }),
      gridPatchSchema,
    ]);
    const targetSchema = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('quick-target'), id: z.string().min(1) }),
      z.object({ kind: z.literal('harvard-oxford-region'), label: z.string().min(1) }),
      z.object({ kind: z.literal('mni-point'), rasMm: z.tuple([z.number(), z.number(), z.number()]), label: z.string().min(1).max(100).optional() }),
      z.object({ kind: z.literal('nifti'), path: z.string().min(1), declaredSpace: z.enum(['MNI152NLin6Asym', 'NeurosynthMNI152-2mm']) }),
    ]);
    server.registerTool('plan_project', {
      title: 'Plan a CortexLume project',
      description: 'Generate and evaluate exactly three deterministic mesh-aware patch placement candidates without writing a file.',
      inputSchema: {
        target: targetSchema,
        patches: z.array(patchSchema).min(1).max(4).default([{
          columns: 5,
          rows: 3,
          pitchMm: 30,
          reverseSourceDetector: false,
          shortChannelCount: 0,
        }]),
        longChannelRangeMm: z.tuple([z.number().min(5), z.number().max(80)])
          .refine(([minimum, maximum]) => minimum <= maximum, 'Long-channel minimum must not exceed maximum.')
          .default([25, 40]),
        optodeRadiusMm: z.number().min(1).max(15).default(3.6),
        transmissionDepthMm: z.number().min(5).max(40).default(25),
        seed: z.string().min(1).max(200).default('cortexlume'),
        sourceProjectPath: z.string().min(1).optional(),
      },
    }, async (request) => {
      // Reject layouts that cannot satisfy the shared project graph limits
      // before resolving targets, starting science, or running placement.
      validatePlannerPatchSpecs(request.patches as PlannerPatchSpec[]);
      const assets = await this.head();
      const source = request.sourceProjectPath ? await this.readAuthorizedProject(request.sourceProjectPath) : null;
      const target = await this.resolveTarget(request.target, assets);
      const canonicalRequest = {
        target: { ...request.target, ...(request.target.kind === 'nifti' ? { path: path.basename(request.target.path), sha256: target.provenance.mapSha256 } : {}) },
        resolvedTarget: {
          id: target.target.id,
          sourceKind: target.provenance.sourceKind,
          mapSha256: target.provenance.mapSha256,
        },
        patches: request.patches,
        longChannelRangeMm: request.longChannelRangeMm,
        optodeRadiusMm: request.optodeRadiusMm,
        transmissionDepthMm: request.transmissionDepthMm,
        seed: request.seed,
        assetHashes: assets.assetHashes,
        sourceProjectSha256: source?.archiveProjectSha256 ?? null,
      } as Record<string, unknown>;
      const requestHash = sha256Text(canonical(canonicalRequest));
      const targetCacheEntry = this.targetAnatomyCache.getEntry(target.provenance.mapSha256);
      let targetAnatomy = targetCacheEntry?.value;
      let targetAnatomyExpiresAt = targetCacheEntry
        ? new Date(targetCacheEntry.expiresAtMs).toISOString()
        : null;
      if (!targetAnatomy) {
        const targetKey = target.provenance.mapSha256;
        let profileLoad = this.targetAnatomyLoads.get(targetKey);
        if (!profileLoad) {
          profileLoad = (async () => {
            const profile = PlanningAnatomicalProfileSchema.parse(await this.scienceRequest('/v1/coverage/target-profile', {
              vertexIndices: target.vertexIndices,
              vertexMasses: target.vertexIndices.map((vertex, index) => assets.headModel.vertexAreasMm2[vertex]! * target.values[index]!),
              minimumAtlasMembership: PLANNING_COVERAGE_SETTINGS.minimumAtlasMembership,
            }));
            const cachedTarget = this.targetAnatomyCache.set(targetKey, profile);
            return { profile, expiresAtMs: cachedTarget.expiresAtMs };
          })();
          this.targetAnatomyLoads.set(targetKey, profileLoad);
          void profileLoad.finally(() => {
            if (this.targetAnatomyLoads.get(targetKey) === profileLoad) this.targetAnatomyLoads.delete(targetKey);
          }).catch(() => undefined);
        }
        try {
          const loaded = await profileLoad;
          targetAnatomy = loaded.profile;
          targetAnatomyExpiresAt = new Date(loaded.expiresAtMs).toISOString();
        } catch (error) {
          throw new Error(`Target anatomical profile failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // The exclusive gate prevents a science request from racing the
      // synchronous mesh search. Keep this MCP-owned sidecar alive: its locked
      // atlas state is immutable, and retaining it avoids a full process and
      // atlas restart before the first candidate summary. Measured together,
      // the idle sidecar and loaded HeadModel retain about 239 MiB working set.
      const result = await this.scienceLifecycle.withExclusive(() => {
        return planLayouts(assets.headModel, {
          target, patches: request.patches as PlannerPatchSpec[], longChannelRangeMm: request.longChannelRangeMm,
          optodeRadiusMm: request.optodeRadiusMm, transmissionDepthMm: request.transmissionDepthMm, seed: `${request.seed}:${requestHash}`,
        });
      });
      // The local science sidecar intentionally stays single-workload here:
      // three concurrent 25k-surface atlas reductions contend for the same
      // NumPy buffers and can make larger multi-patch plans less predictable.
      for (const [candidateIndex, candidate] of result.candidates.entries()) {
        let fullProfile: PlanningAnatomicalProfile;
        try {
          fullProfile = PlanningAnatomicalProfileSchema.parse(await this.scienceRequest(
            '/v1/coverage/anatomical-summary',
            buildCandidateCoverageRequest(assets.headModel, candidate, request.optodeRadiusMm, request.transmissionDepthMm),
          ));
        } catch (error) {
          throw new Error(`Candidate ${candidateIndex + 1} anatomical summary failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        candidate.summary.anatomicalCoverage = { ...fullProfile, regions: fullProfile.regions.slice(0, 5) };
        candidate.summary.metrics.anatomicalTargetAlignment = anatomicalProfileOverlap(targetAnatomy, fullProfile);
      }
      rerankEnrichedCandidates(result.candidates);
      result.recommendedCandidateId = result.candidates.find((candidate) => candidate.summary.accepted)!.summary.stableId;
      const components = summarizeTargetSurfaceComponents(assets.headModel, target);
      const significantComponents = components.filter((component) => component.massFraction >= 0.05);
      const significantRegionCount = targetAnatomy.regions.filter((region) => region.massFraction >= 0.05).length;
      const recommendedPatchCount = Math.min(3, Math.max(
        1,
        significantComponents.length,
        significantRegionCount >= 6 ? 2 : 1,
      ));
      const guidance = {
        targetSurfaceComponentCount: components.length,
        significantTargetComponentCount: Math.max(1, significantComponents.length),
        significantTargetRegionCount: significantRegionCount,
        requestedPatchCount: request.patches.length,
        recommendedPatchCount,
        flags: request.patches.length < recommendedPatchCount ? ['distributed_target_more_patches_recommended'] : [],
      };
      const planId = `plan_${requestHash.slice(0, 24)}`;
      const entry: PlanCacheEntry = {
        planId, requestHash, canonicalRequest, seed: request.seed, target, candidates: result.candidates,
        recommendedCandidateId: result.recommendedCandidateId,
        sourceProject: source?.project ?? null, sourceProjectSha256: source?.archiveProjectSha256 ?? null,
        plannedAt: new Date(this.clock()).toISOString(),
        optodeRadiusMm: request.optodeRadiusMm,
        transmissionDepthMm: request.transmissionDepthMm,
        targetAnatomy,
        guidance,
        expiresAt: '',
      };
      const cachedEntry = this.plans.set(planId, entry);
      entry.expiresAt = new Date(cachedEntry.expiresAtMs).toISOString();
      return toolResult({
        planId,
        expiresAt: entry.expiresAt,
        targetAnatomyExpiresAt,
        recommendedCandidateId: entry.recommendedCandidateId,
        target: target.target,
        targetAnatomy,
        cache: this.cacheStats(),
        guidance,
        candidates: entry.candidates.map((candidate) => candidate.summary),
      });
    });

    server.registerTool('save_project', {
      title: 'Save a planned CortexLume project',
      description: 'Write the selected candidate as a validated v3 archive under an authorized root; path collisions receive a unique suffix and existing files are never overwritten. A successful save consumes the one-shot plan unless consumePlan is explicitly false.',
      inputSchema: {
        planId: z.string().min(1), candidateId: z.string().min(1), outputPath: z.string().min(1),
        projectName: z.string().min(1).max(120).optional(),
        consumePlan: z.boolean().default(true),
      },
    }, async ({ planId, candidateId, outputPath, projectName, consumePlan }) => {
      const cachedPlan = this.plans.getEntry(planId);
      const entry = cachedPlan?.value;
      if (!entry) throw new Error('Unknown or expired planId. Run plan_project in this MCP session first.');
      entry.expiresAt = new Date(cachedPlan.expiresAtMs).toISOString();
      const candidate = entry.candidates.find((item) => item.summary.stableId === candidateId);
      if (!candidate) throw new Error('candidateId does not belong to this plan.');
      if (!candidate.summary.accepted) throw new Error(`Rejected candidate cannot be saved: ${candidate.summary.rejectionReasons.join(', ')}`);
      await this.head();
      const project = await this.buildProject(entry, candidate, projectName);
      const archive = createProjectArchive(project, this.options.applicationVersion);
      const destination = await this.writeUniqueAuthorizedOutput(outputPath, archive);
      // Hash the exact validated bytes passed to the durable writer. Reopening
      // the published pathname here would reintroduce a needless path race.
      const archiveSha256 = sha256Bytes(archive);
      // Plans are one-shot by default. A caller that deliberately needs more
      // than one derived archive may opt out; idle plans remain TTL/LRU/byte
      // bounded and can also be released explicitly.
      if (consumePlan) this.plans.delete(planId);
      return toolResult({
        path: destination, projectId: project.id, formatVersion: project.formatVersion, selectedCandidateId: candidateId,
        expiresAt: consumePlan ? null : entry.expiresAt,
        sha256: archiveSha256,
      });
    });

    server.registerTool('release_plan', {
      title: 'Release a cached CortexLume plan',
      description: 'Release a plan and its candidate object graph before its normal TTL expires. Releasing an unknown or already expired plan is idempotent.',
      inputSchema: { planId: z.string().min(1) },
    }, async ({ planId }) => toolResult({
      planId,
      released: this.plans.delete(planId),
      cache: this.cacheStats(),
    }));

    server.registerTool('inspect_project', {
      title: 'Inspect a CortexLume project',
      description: 'Validate archive integrity and return project, target, patch, projection, QC, digitizer and Agent planning provenance summaries.',
      inputSchema: { path: z.string().min(1) },
    }, async ({ path: projectPath }) => {
      const detailed = await this.readAuthorizedProject(projectPath);
      const project = detailed.project;
      return toolResult({
        path: await this.authorizedPath(projectPath, true), formatVersion: project.formatVersion,
        sourceFormatVersion: detailed.sourceFormatVersion, migratedFromLegacy: detailed.migrated,
        project: { id: project.id, name: project.name, template: project.template, deviceProfile: project.deviceProfile, projectionSettings: project.projectionSettings },
        functionalTarget: project.functionalTarget,
        surfaceOverlay: project.surfaceOverlay,
        patches: project.instances.map((instance) => ({ instance, layout: project.layouts.find((layout) => layout.id === instance.definitionId) })),
        projections: project.verifiedResults,
        digitizerSessions: project.digitizerSessions,
        planning: project.planning,
        archiveProjectSha256: detailed.archiveProjectSha256,
      });
    });

    const exportInputSchema = {
      projectPath: z.string().min(1),
      outputDirectory: z.string().min(1),
      directoryName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _-]{0,127}$/).optional(),
    };
    server.registerTool('export_brainnet', {
      title: 'Export a project for BrainNet Viewer',
      description: 'Validate an authorized CortexLume project and write a unique BrainNet bundle below an authorized existing output directory. This headless tool never launches MATLAB, BrainNet, a file browser, or a GUI.',
      inputSchema: exportInputSchema,
    }, async ({ projectPath, outputDirectory, directoryName }) => this.exportProjectBundle({
      kind: 'brainnet',
      projectPath,
      outputDirectory,
      directoryName: directoryName ?? 'CortexLume_BrainNet',
      build: buildBrainNetExportAsync,
    }));

    server.registerTool('export_atlasviewer', {
      title: 'Export a project for AtlasViewer',
      description: 'Validate an authorized CortexLume project and write a unique AtlasViewer bundle below an authorized existing output directory. This headless tool only writes the MATLAB bridge and data files; it never opens or executes them.',
      inputSchema: exportInputSchema,
    }, async ({ projectPath, outputDirectory, directoryName }) => this.exportProjectBundle({
      kind: 'atlasviewer',
      projectPath,
      outputDirectory,
      directoryName: directoryName ?? 'CortexLume_AtlasViewer',
      build: buildAtlasViewerExportAsync,
    }));

    const screenshotVectorSchema = z.tuple([
      z.number().finite().min(-10_000).max(10_000),
      z.number().finite().min(-10_000).max(10_000),
      z.number().finite().min(-10_000).max(10_000),
    ]);
    const defaultScreenshotLayers: McpScreenshotLayerState = {
      scalp: true,
      grayMatter: true,
      whiteMatter: false,
      fivePoint: true,
      tenTen: true,
      pointLabels: false,
      fivePointLabelsIncluded: true,
      channelLabels: true,
      surfaceOverlay: 'none',
      functionalMap: false,
      patches: true,
      digitizer: true,
      anatomicalCoverage: false,
      groundGrid: false,
    };
    server.registerTool('capture_project_screenshot', {
      title: 'Capture a transparent CortexLume project screenshot',
      description: 'Render a validated project in a hidden Electron scientific scene and write a unique transparent PNG. Camera state is an explicit preset or exact input; this tool never claims to capture a separate GUI window current view.',
      inputSchema: {
        projectPath: z.string().min(1),
        outputPath: z.string().min(1).optional(),
        width: z.number().int().min(MCP_SCREENSHOT_LIMITS.minimumLogicalDimension)
          .max(MCP_SCREENSHOT_LIMITS.maximumLogicalDimension).default(1200),
        height: z.number().int().min(MCP_SCREENSHOT_LIMITS.minimumLogicalDimension)
          .max(MCP_SCREENSHOT_LIMITS.maximumLogicalDimension).default(900),
        dpr: z.number().min(MCP_SCREENSHOT_LIMITS.minimumDpr)
          .max(MCP_SCREENSHOT_LIMITS.maximumDpr).default(1),
        camera: z.discriminatedUnion('kind', [
          z.object({
            kind: z.literal('preset'),
            preset: z.enum(['gui-default', 'front', 'left', 'right', 'superior']).default('gui-default'),
          }),
          z.object({
            kind: z.literal('explicit'),
            position: screenshotVectorSchema,
            target: screenshotVectorSchema,
            up: screenshotVectorSchema.default([0, 1, 0]),
            fov: z.number().finite().min(10).max(90).default(39),
          }),
        ]).default({ kind: 'preset', preset: 'gui-default' }),
        layers: z.object({
          scalp: z.boolean().default(defaultScreenshotLayers.scalp),
          grayMatter: z.boolean().default(defaultScreenshotLayers.grayMatter),
          whiteMatter: z.boolean().default(defaultScreenshotLayers.whiteMatter),
          fivePoint: z.boolean().default(defaultScreenshotLayers.fivePoint),
          tenTen: z.boolean().default(defaultScreenshotLayers.tenTen),
          pointLabels: z.boolean().default(defaultScreenshotLayers.pointLabels),
          channelLabels: z.boolean().default(defaultScreenshotLayers.channelLabels),
          patches: z.boolean().default(defaultScreenshotLayers.patches),
          digitizer: z.boolean().default(defaultScreenshotLayers.digitizer),
          surfaceOverlay: z.enum([
            'project', 'none', 'functional-target', 'coverage-mosaic', 'coverage-region',
          ]).default('project'),
        }).default({
          scalp: defaultScreenshotLayers.scalp,
          grayMatter: defaultScreenshotLayers.grayMatter,
          whiteMatter: defaultScreenshotLayers.whiteMatter,
          fivePoint: defaultScreenshotLayers.fivePoint,
          tenTen: defaultScreenshotLayers.tenTen,
          pointLabels: defaultScreenshotLayers.pointLabels,
          channelLabels: defaultScreenshotLayers.channelLabels,
          patches: defaultScreenshotLayers.patches,
          digitizer: defaultScreenshotLayers.digitizer,
          surfaceOverlay: 'project',
        }),
      },
    }, async ({ projectPath, outputPath, width, height, dpr, camera: cameraInput, layers: requestedLayers }) => {
      if (!this.options.captureProjectScreenshot) {
        throw new Error('The CortexLume Electron screenshot worker is unavailable in this runtime.');
      }
      const physicalWidth = Math.round(width * dpr);
      const physicalHeight = Math.round(height * dpr);
      if (physicalWidth > MCP_SCREENSHOT_LIMITS.maximumPhysicalDimension
        || physicalHeight > MCP_SCREENSHOT_LIMITS.maximumPhysicalDimension
        || physicalWidth * physicalHeight > MCP_SCREENSHOT_LIMITS.maximumPhysicalPixels) {
        throw new Error(`Screenshot exceeds the ${MCP_SCREENSHOT_LIMITS.maximumPhysicalPixels}-pixel rendering budget.`);
      }
      const resolvedProjectPath = await this.authorizedPath(projectPath, true);
      const detailed = await this.readAuthorizedProject(resolvedProjectPath);
      const camera = resolveScreenshotCamera(cameraInput as Parameters<typeof resolveScreenshotCamera>[0]);
      const surfaceOverlay = requestedLayers.surfaceOverlay === 'project'
        ? detailed.project.surfaceOverlay
        : requestedLayers.surfaceOverlay;
      if (surfaceOverlay === 'functional-target' && !detailed.project.functionalTarget) {
        throw new Error('Functional-target overlay was requested but the project has no functional target map.');
      }
      const layers: McpScreenshotLayerState = {
        scalp: requestedLayers.scalp,
        grayMatter: requestedLayers.grayMatter,
        whiteMatter: requestedLayers.whiteMatter,
        fivePoint: requestedLayers.fivePoint,
        tenTen: requestedLayers.tenTen,
        pointLabels: requestedLayers.pointLabels,
        fivePointLabelsIncluded: requestedLayers.fivePoint,
        channelLabels: requestedLayers.channelLabels,
        patches: requestedLayers.patches,
        digitizer: requestedLayers.digitizer,
        surfaceOverlay,
        functionalMap: surfaceOverlay === 'functional-target',
        anatomicalCoverage: surfaceOverlay === 'coverage-mosaic' || surfaceOverlay === 'coverage-region',
        groundGrid: false,
      };
      const projectBaseName = path.basename(resolvedProjectPath, path.extname(resolvedProjectPath));
      const defaultDestination = path.join(
        path.dirname(resolvedProjectPath),
        'CortexLume_Screenshots',
        `${projectBaseName} - ${camera.preset ?? 'explicit'}.png`,
      );
      const requestedDestination = outputPath ?? defaultDestination;
      const extensionPath = requestedDestination.toLowerCase().endsWith('.png')
        ? requestedDestination
        : `${requestedDestination}.png`;
      const resolvedDestination = await this.authorizedPath(extensionPath, false);
      const outputParent = await this.authorizedPath(path.dirname(resolvedDestination), false);
      await mkdir(outputParent, { recursive: true });
      await this.authorizedPath(outputParent, true);
      const temporaryPath = await this.authorizedPath(
        path.join(outputParent, `.${path.basename(resolvedDestination)}.${randomUUID()}.capture.png`),
        false,
      );
      let renderResult: McpScreenshotRenderResult;
      let pngBytes: Uint8Array;
      try {
        renderResult = await this.options.captureProjectScreenshot({
          project: {
            ...detailed.project,
            surfaceOverlay,
            instances: layers.patches
              ? detailed.project.instances
              : detailed.project.instances.map((instance) => ({ ...instance, visible: false })),
            digitizerSessions: layers.digitizer
              ? detailed.project.digitizerSessions
              : detailed.project.digitizerSessions.map((session) => ({ ...session, visible: false })),
          },
          projectPath: resolvedProjectPath,
          sourceProjectSha256: detailed.archiveProjectSha256,
          temporaryPath,
          logicalWidth: width,
          logicalHeight: height,
          dpr,
          camera,
          layers,
        });
        const verifiedTemporaryPath = await this.authorizedPath(temporaryPath, true);
        pngBytes = await stableReadRegularFile(
          verifiedTemporaryPath,
          MCP_SCREENSHOT_LIMITS.maximumPngBytes,
          { label: 'Screenshot PNG' },
        );
        validatePngDimensions(pngBytes, physicalWidth, physicalHeight);
        if (renderResult.width !== physicalWidth || renderResult.height !== physicalHeight) {
          throw new Error('Screenshot worker metadata dimensions do not match the requested physical resolution.');
        }
        if (canonical(renderResult.camera) !== canonical(camera) || canonical(renderResult.layers) !== canonical(layers)) {
          throw new Error('Screenshot worker metadata does not match the resolved camera and layer request.');
        }
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
      const destination = await this.writeUniqueAuthorizedPng(resolvedDestination, pngBytes);
      return toolResult({
        path: destination,
        width: renderResult.width,
        height: renderResult.height,
        logicalWidth: width,
        logicalHeight: height,
        dpr,
        transparent: true,
        encoding: 'rgba8-lossless-png',
        quantized: false,
        lossless: true,
        backgroundIncluded: false,
        camera: renderResult.camera,
        layers: renderResult.layers,
        project: {
          path: resolvedProjectPath,
          id: detailed.project.id,
          archiveProjectSha256: detailed.archiveProjectSha256,
        },
      });
    });

    server.registerTool('open_project', {
      title: 'Open a CortexLume project',
      description: 'Validate an authorized project archive and launch it in a new independent CortexLume GUI process for human review.',
      inputSchema: { path: z.string().min(1) },
    }, async ({ path: projectPath }) => {
      const resolved = await this.authorizedPath(projectPath, true);
      await this.readAuthorizedProject(resolved);
      await this.options.openGui(resolved);
      return toolResult({ opened: true, path: resolved, separateProcess: true });
    });
    return server;
  }

  private head(): Promise<LoadedHeadModel> {
    this.headPromise ??= loadHeadModelFromAssets(this.options.templateRoot);
    return this.headPromise;
  }

  private scienceRequest<T>(pathname: string, payload?: unknown): Promise<T> {
    return this.scienceLifecycle.request(() => this.options.science.request<T>(pathname, payload));
  }

  private async resolveTarget(target: { kind: string; [key: string]: unknown }, assets: LoadedHeadModel): Promise<FunctionalTargetMap> {
    if (target.kind === 'quick-target') return FunctionalTargetMapSchema.parse(await this.scienceRequest(`/v1/targets/${encodeURIComponent(String(target.id))}`));
    if (target.kind === 'harvard-oxford-region') return FunctionalTargetMapSchema.parse(await this.scienceRequest('/v1/atlas/cortical-region-target', { label: target.label }));
    if (target.kind === 'nifti') {
      const inputPath = await this.authorizedPath(String(target.path), true);
      if (!/\.nii(?:\.gz)?$/i.test(inputPath)) throw new Error('NIfTI target path must end in .nii or .nii.gz.');
      return withStagedNiftiFile(inputPath, async (stagedPath, sourceFileName) => {
        const response = await this.scienceRequest<Record<string, unknown>>('/v1/targets/import', {
          fileName: sourceFileName, declaredSpace: target.declaredSpace, filePath: stagedPath,
        });
        if (!response.accepted || !response.map) throw new Error(`NIfTI target was rejected: ${JSON.stringify(response.diagnostics ?? [])}`);
        return FunctionalTargetMapSchema.parse(response.map);
      });
    }
    if (target.kind === 'mni-point') {
      const rasMm = target.rasMm as Vec3;
      const gaussian = assets.headModel.geodesicGaussian(rasMm, 12, 24);
      const mapSha256 = sha256Text(canonical({ vertexIndices: gaussian.vertexIndices, values: gaussian.values }));
      return FunctionalTargetMapSchema.parse({
        target: { id: `mni:${rasMm.join(',')}`, label: typeof target.label === 'string' ? target.label : `MNI ${rasMm.join(', ')}`, aliases: [], peakRegions: [] },
        vertexCount: 25_000, ...gaussian,
        provenance: {
          sourceKind: 'mni-point', sourceSpace: 'MNI152NLin6Asym', targetSpace: 'MNI152NLin6Asym', targetSurface: 'Cedalion-ICBM152-25k',
          statistic: 'geodesic Gaussian', mapSha256, interpolation: 'surface geodesic sigma=12mm support=24mm', validation: { requestedRasMm: rasMm },
        },
      });
    }
    throw new Error('Unsupported target kind.');
  }

  private async buildProject(entry: PlanCacheEntry, candidate: PlannerCandidate, projectName?: string): Promise<CortexLumeProject> {
    const assets = await this.head();
    const manifestBytes = await readFile(path.join(this.options.templateRoot, 'manifest.json'));
    const templateManifest = JSON.parse(manifestBytes.toString('utf8')) as { assetVersion: string };
    const manifestSha256 = sha256Bytes(Buffer.from(manifestBytes.toString('utf8').replace(/\r\n/g, '\n')));
    const timestamp = new Date(this.clock()).toISOString();
    const selectedId = candidate.summary.stableId;
    const planning: AgentPlanningRecord = {
      version: 1, engine: 'cortexlume-deterministic-planner', engineVersion: this.options.applicationVersion,
      plannedAt: entry.plannedAt, canonicalRequestSha256: entry.requestHash, canonicalRequest: entry.canonicalRequest,
      seed: entry.seed, assetHashes: { ...assets.assetHashes, manifest: manifestSha256 }, sourceProjectSha256: entry.sourceProjectSha256,
      targetAnatomy: entry.targetAnatomy,
      guidance: entry.guidance,
      candidates: entry.candidates.map((item) => item.summary), recommendedCandidateId: entry.recommendedCandidateId, selectedCandidateId: selectedId,
    };
    const source = entry.sourceProject;
    const radius = entry.optodeRadiusMm;
    const depth = entry.transmissionDepthMm;
    const projectionSettings = {
      ...(source?.projectionSettings ?? { mode: 'scalp' as const, defaultDepthMm: 25, atlasProbabilityThreshold: 0, optodeRadiusMm: 3.6 }),
      defaultDepthMm: depth,
      optodeRadiusMm: radius,
    };
    return CortexLumeProjectSchema.parse({
      format: 'cortexlume-project', formatVersion: 3,
      id: deterministicUuid(entry.requestHash, `project:${selectedId}`),
      name: (() => {
        const baseName = projectName?.trim() || source?.name;
        return baseName ? `${baseName} · Agent plan` : 'CortexLume Agent plan';
      })(),
      createdAt: timestamp, updatedAt: timestamp,
      template: {
        id: 'MNI152NLin6Asym', assetVersion: templateManifest.assetVersion, coordinateConvention: 'RAS+', units: 'mm', verified: true,
        manifestSha256, scalpMeshSha256: assets.assetHashes.scalpGlb, cortexMeshSha256: assets.assetHashes.brainScientificGlb, atlasSha256: assets.assetHashes.harvardOxfordIndex,
      },
      layouts: candidate.layouts, instances: candidate.instances,
      deviceProfile: source?.deviceProfile ?? defaultDevice(),
      bidsSettings: source?.bidsSettings ?? { subjectLabel: '01', sessionLabel: '', taskLabel: 'layout', acquisitionLabel: '', runIndex: null },
      projectionSettings,
      verifiedResults: buildProjectionResults(assets.headModel, candidate, radius, depth), digitizerSessions: [],
      functionalTarget: entry.target, surfaceOverlay: 'functional-target', coverageRegion: null, planning,
    });
  }

  private async readAuthorizedProject(projectPath: string) {
    const resolved = await this.authorizedPath(projectPath, true);
    const bytes = await stableReadRegularFile(
      resolved,
      PROJECT_ARCHIVE_LIMITS.compressedBytes,
      { label: 'Project archive' },
    );
    return readProjectArchiveDetailed(bytes);
  }

  private async exportProjectBundle(options: {
    kind: 'brainnet' | 'atlasviewer';
    projectPath: string;
    outputDirectory: string;
    directoryName: string;
    build: (project: CortexLumeProject) => Promise<WritableExportBundle>;
  }) {
    const resolvedProjectPath = await this.authorizedPath(options.projectPath, true);
    const detailed = await this.readAuthorizedProject(resolvedProjectPath);
    const resolvedOutputRoot = await this.authorizedPath(options.outputDirectory, true);
    // Build first so an invalid or incompletely projected project cannot leave
    // an empty output directory behind. Both builders enforce the same
    // verified HeadModel projection invariants used by desktop exports.
    const bundle = await options.build(detailed.project);
    const directory = await createUniqueExportDirectory(resolvedOutputRoot, options.directoryName);
    const authorizedDirectory = await this.authorizedPath(directory, true);
    const fileNames = await writeExportBundle(authorizedDirectory, bundle);
    const files = await Promise.all(fileNames.map(async (name) => ({
      name,
      path: await this.authorizedPath(path.join(authorizedDirectory, name), true),
    })));
    return toolResult({
      exportKind: options.kind,
      directory: authorizedDirectory,
      files,
      warnings: bundle.warnings,
      headless: true,
      project: {
        path: resolvedProjectPath,
        id: detailed.project.id,
        archiveProjectSha256: detailed.archiveProjectSha256,
      },
    });
  }

  private async authorizedPath(candidate: string, mustExist: boolean): Promise<string> {
    return resolveAuthorizedPath(candidate, this.roots, {
      mustExist,
      label: 'MCP authorized roots',
    });
  }

  private async writeUniqueAuthorizedOutput(requested: string, data: Uint8Array): Promise<string> {
    const extensionPath = requested.toLowerCase().endsWith('.cortexlume') ? requested : `${requested}.cortexlume`;
    const resolved = await this.authorizedPath(extensionPath, false);
    const parent = await this.authorizedPath(path.dirname(resolved), false);
    await mkdir(parent, { recursive: true });
    await this.authorizedPath(parent, true);
    const extension = path.extname(resolved); const base = resolved.slice(0, -extension.length);
    for (let suffix = 0; suffix < 10_000; suffix += 1) {
      const candidate = suffix === 0 ? resolved : `${base} (${suffix + 1})${extension}`;
      // Revalidate the canonical parent immediately before each publication.
      // This closes ordinary path changes while documenting the unavoidable
      // narrow string-path race that needs openat/CreateFile for elimination.
      await this.authorizedPath(candidate, false);
      try {
        let verifiedPath: string | undefined;
        await durableAtomicCreateExclusive(candidate, data, {
          ensureParent: false,
          // If canonical revalidation fails after link(), durableFile removes
          // the just-created inode only after proving its dev/ino identity.
          afterPublish: async () => { verifiedPath = await this.authorizedPath(candidate, true); },
        });
        if (!verifiedPath) throw new Error('Published project path could not be verified.');
        return verifiedPath;
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
      }
    }
    throw new Error('Could not allocate a unique project filename.');
  }

  private async writeUniqueAuthorizedPng(requested: string, data: Uint8Array): Promise<string> {
    const extensionPath = requested.toLowerCase().endsWith('.png') ? requested : `${requested}.png`;
    const resolved = await this.authorizedPath(extensionPath, false);
    const parent = await this.authorizedPath(path.dirname(resolved), false);
    await mkdir(parent, { recursive: true });
    await this.authorizedPath(parent, true);
    const extension = path.extname(resolved);
    const base = resolved.slice(0, -extension.length);
    for (let suffix = 0; suffix < 10_000; suffix += 1) {
      const candidate = suffix === 0 ? resolved : `${base} (${suffix + 1})${extension}`;
      await this.authorizedPath(candidate, false);
      try {
        let verifiedPath: string | undefined;
        await durableAtomicCreateExclusive(candidate, data, {
          ensureParent: false,
          afterPublish: async () => { verifiedPath = await this.authorizedPath(candidate, true); },
        });
        if (!verifiedPath) throw new Error('Published screenshot path could not be verified.');
        return verifiedPath;
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
      }
    }
    throw new Error('Could not allocate a unique screenshot filename.');
  }
}
