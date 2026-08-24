import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import {
  CortexLumeProjectSchema,
  FunctionalTargetMapSchema,
  type AgentPlanningRecord,
  type CortexLumeProject,
  type FunctionalTargetMap,
  type ProjectionResult,
  type Vec3,
} from '@cortexlume/contracts';
import {
  channelSensitivityPath,
  deterministicUuid,
  distance3,
  loadHeadModelFromAssets,
  planLayouts,
  type LoadedHeadModel,
  type PlannerCandidate,
  type PlannerPatchSpec,
} from '@cortexlume/core/node';
import { createProjectArchive, readProjectArchiveDetailed, sha256Bytes } from '@cortexlume/project-io';
import type { ScienceClient } from '@cortexlume/science-client';

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
}

export interface McpRuntimeOptions {
  templateRoot: string;
  science: ScienceClient;
  applicationVersion: string;
  authorizedRoots?: string[];
  openGui(projectPath: string): Promise<void> | void;
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
        underlyingCorticalRegions: [], deepTargetStructures: [], tissueAtTarget: 'cortical gray matter',
        claimLevel: 'geometric', status: 'verified', qcFlags: ['atlas_lookup_pending'],
      });
    }
    for (const pair of layout.pairs) {
      const source = contacts.get(pair.sourceId)!; const detector = contacts.get(pair.detectorId)!;
      const sourceScalp = scalpCenters.get(pair.sourceId)!; const detectorScalp = scalpCenters.get(pair.detectorId)!;
      const sourceDisplay = displayCenters.get(pair.sourceId)!; const detectorDisplay = displayCenters.get(pair.detectorId)!;
      const midpoint = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      const spacingError = Math.abs(distance3(sourceScalp, detectorScalp) - pair.nominalDistanceMm);
      results.push({
        instanceId: instance.id, subjectKind: 'pair', subjectId: pair.id,
        scalpRasMm: midpoint(sourceScalp, detectorScalp), displayRasMm: midpoint(sourceDisplay, detectorDisplay),
        corticalRasMm: channelSensitivityPath(head, source, detector, radiusMm, depthMm).target, depthTargetRasMm: null,
        underlyingCorticalRegions: [], deepTargetStructures: [], tissueAtTarget: 'cortical gray matter',
        claimLevel: 'geometric', status: 'verified', qcFlags: spacingError > 5 ? ['distance_distortion_gt_5mm', 'atlas_lookup_pending'] : spacingError > 2 ? ['distance_distortion_gt_2mm', 'atlas_lookup_pending'] : ['atlas_lookup_pending'],
      });
    }
  });
  return results;
}

export class CortexLumeMcpRuntime {
  private readonly plans = new Map<string, PlanCacheEntry>();
  private readonly roots: string[];
  private headPromise: Promise<LoadedHeadModel> | null = null;

  constructor(private readonly options: McpRuntimeOptions) {
    const configured = options.authorizedRoots?.length ? options.authorizedRoots : [process.cwd()];
    this.roots = configured.map((root) => path.resolve(root));
  }

  start(): void {
    serveStdio(() => this.createServer());
  }

  createServer(): McpServer {
    const server = new McpServer({ name: 'CortexLume', version: this.options.applicationVersion }, {
      instructions: 'Use search_targets or list_atlas_regions before plan_project when target identity is uncertain. plan_project never writes files. save_project writes a unique derived .cortexlume archive and never overwrites. open_project starts a separate desktop window for human review.',
    });

    server.registerTool('get_capabilities', {
      title: 'Get CortexLume capabilities',
      description: 'Report locked template, planning defaults, target sources, authorized filesystem roots, and fail-closed asset state.',
      inputSchema: {},
    }, async () => {
      let assetState: Record<string, unknown>;
      try {
        const assets = await this.head();
        const health = await this.options.science.request<Record<string, unknown>>('/v1/health');
        assetState = { ready: true, hashes: assets.assetHashes, science: health };
      } catch (error) {
        assetState = { ready: false, error: error instanceof Error ? error.message : String(error) };
      }
      return toolResult({
        projectFormatVersion: 2,
        template: { id: 'MNI152NLin6Asym', surface: 'Cedalion-ICBM152-25k', coordinateConvention: 'RAS+', units: 'mm' },
        targetSources: ['quick-target', 'harvard-oxford-region', 'mni-point', 'nifti'],
        defaultPatch: { columns: 5, rows: 3, pitchMm: 30, topLeft: 'source', pattern: 'checkerboard', optodes: 15, channels: 22 },
        defaults: { longChannelRangeMm: [25, 40], surfaceDistanceToleranceMm: 1.5, kernelSigmaMm: 12, supportRadiusMm: 24, transmissionDepthMm: 25, candidateCount: 3, overlapThresholdMm: 12 },
        authorizedRoots: this.roots,
        assets: assetState,
      });
    });

    server.registerTool('search_targets', {
      title: 'Search Quick Targets',
      description: 'Search the installed offline Quick Target catalog.',
      inputSchema: { query: z.string().max(120).default(''), limit: z.number().int().min(1).max(50).default(20) },
    }, async ({ query, limit }) => toolResult(await this.options.science.request<Record<string, unknown>>(`/v1/targets?q=${encodeURIComponent(query)}&limit=${limit}`)));

    server.registerTool('list_atlas_regions', {
      title: 'List Harvard-Oxford cortical regions',
      description: 'Return exact legal Harvard-Oxford cortical region names accepted by plan_project.',
      inputSchema: {},
    }, async () => toolResult(await this.options.science.request<Record<string, unknown>>('/v1/atlas/cortical-regions')));

    const patchSchema = z.object({
      name: z.string().min(1).max(80).optional(), columns: z.number().int().min(1).max(12).default(5), rows: z.number().int().min(1).max(12).default(3),
      pitchMm: z.number().min(5).max(80).default(30), activeCells: z.array(z.array(z.boolean())).optional(), reverseSourceDetector: z.boolean().default(false), shortChannelCount: z.number().int().min(0).max(16).default(0),
    });
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
      const result = planLayouts(assets.headModel, {
        target, patches: request.patches as PlannerPatchSpec[], longChannelRangeMm: request.longChannelRangeMm,
        optodeRadiusMm: request.optodeRadiusMm, transmissionDepthMm: request.transmissionDepthMm, seed: `${request.seed}:${requestHash}`,
      });
      const planId = `plan_${requestHash.slice(0, 24)}`;
      const entry: PlanCacheEntry = {
        planId, requestHash, canonicalRequest, seed: request.seed, target, candidates: result.candidates,
        recommendedCandidateId: result.recommendedCandidateId,
        sourceProject: source?.project ?? null, sourceProjectSha256: source?.archiveProjectSha256 ?? null,
        plannedAt: new Date().toISOString(),
        optodeRadiusMm: request.optodeRadiusMm,
        transmissionDepthMm: request.transmissionDepthMm,
      };
      this.plans.set(planId, entry);
      return toolResult({
        planId,
        recommendedCandidateId: entry.recommendedCandidateId,
        target: target.target,
        candidates: entry.candidates.map((candidate) => candidate.summary),
      });
    });

    server.registerTool('save_project', {
      title: 'Save a planned CortexLume project',
      description: 'Write the selected candidate as a validated v2 archive under an authorized root; path collisions receive a unique suffix and existing files are never overwritten.',
      inputSchema: { planId: z.string().min(1), candidateId: z.string().min(1), outputPath: z.string().min(1), projectName: z.string().min(1).max(120).optional() },
    }, async ({ planId, candidateId, outputPath, projectName }) => {
      const entry = this.plans.get(planId);
      if (!entry) throw new Error('Unknown or expired planId. Run plan_project in this MCP session first.');
      const candidate = entry.candidates.find((item) => item.summary.stableId === candidateId);
      if (!candidate) throw new Error('candidateId does not belong to this plan.');
      if (!candidate.summary.accepted) throw new Error(`Rejected candidate cannot be saved: ${candidate.summary.rejectionReasons.join(', ')}`);
      await this.head();
      const project = await this.buildProject(entry, candidate, projectName);
      const destination = await this.writeUniqueAuthorizedOutput(
        outputPath,
        createProjectArchive(project, this.options.applicationVersion),
      );
      return toolResult({ path: destination, projectId: project.id, formatVersion: 2, selectedCandidateId: candidateId, sha256: sha256Bytes(await readFile(destination)) });
    });

    server.registerTool('inspect_project', {
      title: 'Inspect a CortexLume project',
      description: 'Validate archive integrity and return project, target, patch, projection, QC, digitizer and Agent planning provenance summaries.',
      inputSchema: { path: z.string().min(1) },
    }, async ({ path: projectPath }) => {
      const detailed = await this.readAuthorizedProject(projectPath);
      const project = detailed.project;
      return toolResult({
        path: await this.authorizedPath(projectPath, true), formatVersion: project.formatVersion, migratedFromV1: detailed.migrated,
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

  private async resolveTarget(target: { kind: string; [key: string]: unknown }, assets: LoadedHeadModel): Promise<FunctionalTargetMap> {
    if (target.kind === 'quick-target') return FunctionalTargetMapSchema.parse(await this.options.science.request(`/v1/targets/${encodeURIComponent(String(target.id))}`));
    if (target.kind === 'harvard-oxford-region') return FunctionalTargetMapSchema.parse(await this.options.science.request('/v1/atlas/cortical-region-target', { label: target.label }));
    if (target.kind === 'nifti') {
      const inputPath = await this.authorizedPath(String(target.path), true);
      if (!/\.nii(?:\.gz)?$/i.test(inputPath)) throw new Error('NIfTI target path must end in .nii or .nii.gz.');
      if ((await stat(inputPath)).size > 128 * 1024 * 1024) throw new Error('NIfTI target exceeds 128 MB.');
      const response = await this.options.science.request<Record<string, unknown>>('/v1/targets/import', {
        fileName: path.basename(inputPath), declaredSpace: target.declaredSpace, dataBase64: (await readFile(inputPath)).toString('base64'),
      });
      if (!response.accepted || !response.map) throw new Error(`NIfTI target was rejected: ${JSON.stringify(response.diagnostics ?? [])}`);
      return FunctionalTargetMapSchema.parse(response.map);
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
    const manifestSha256 = sha256Bytes(Buffer.from(manifestBytes.toString('utf8').replace(/\r\n/g, '\n')));
    const timestamp = new Date().toISOString();
    const selectedId = candidate.summary.stableId;
    const planning: AgentPlanningRecord = {
      version: 1, engine: 'cortexlume-deterministic-planner', engineVersion: this.options.applicationVersion,
      plannedAt: entry.plannedAt, canonicalRequestSha256: entry.requestHash, canonicalRequest: entry.canonicalRequest,
      seed: entry.seed, assetHashes: { ...assets.assetHashes, manifest: manifestSha256 }, sourceProjectSha256: entry.sourceProjectSha256,
      candidates: entry.candidates.map((item) => item.summary), recommendedCandidateId: entry.recommendedCandidateId, selectedCandidateId: selectedId,
    };
    const source = entry.sourceProject;
    const radius = entry.optodeRadiusMm;
    const depth = entry.transmissionDepthMm;
    const projectionSettings = {
      ...(source?.projectionSettings ?? { mode: 'scalp' as const, defaultDepthMm: 25, pairDepthOverridesMm: {}, atlasProbabilityThreshold: 0, optodeRadiusMm: 3.6 }),
      defaultDepthMm: depth,
      optodeRadiusMm: radius,
    };
    return CortexLumeProjectSchema.parse({
      format: 'cortexlume-project', formatVersion: 2,
      id: deterministicUuid(entry.requestHash, `project:${selectedId}`),
      name: (() => {
        const baseName = projectName?.trim() || source?.name;
        return baseName ? `${baseName} · Agent plan` : 'CortexLume Agent plan';
      })(),
      createdAt: timestamp, updatedAt: timestamp,
      template: {
        id: 'MNI152NLin6Asym', assetVersion: 'templateflow-c906e8d_cedalion-icbm152-26.5.1', coordinateConvention: 'RAS+', units: 'mm', verified: true,
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
    return readProjectArchiveDetailed(await readFile(resolved));
  }

  private async authorizedPath(candidate: string, mustExist: boolean): Promise<string> {
    const resolved = path.resolve(candidate);
    const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    const within = (value: string, root: string) => {
      const normalized = normalize(value);
      const normalizedRoot = normalize(root);
      return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}${path.sep}`);
    };
    const canonicalRoots = await Promise.all(this.roots.map(async (root) => {
      const realRoot = existsSync(root) ? await realpath(root) : path.resolve(root);
      return realRoot;
    }));
    const canonicalCandidate = path.join(await realpath(path.dirname(resolved)), path.basename(resolved));
    if (!canonicalRoots.some((root) => within(canonicalCandidate, root))) {
      throw new Error(`Path is outside MCP authorized roots: ${candidate}`);
    }
    const checked = mustExist ? await realpath(resolved) : canonicalCandidate;
    if (!canonicalRoots.some((root) => within(checked, root))) {
      throw new Error(`Path is outside MCP authorized roots: ${candidate}`);
    }
    return checked;
  }

  private async writeUniqueAuthorizedOutput(requested: string, data: Uint8Array): Promise<string> {
    const extensionPath = requested.toLowerCase().endsWith('.cortexlume') ? requested : `${requested}.cortexlume`;
    const resolved = await this.authorizedPath(extensionPath, false);
    const parent = await this.authorizedPath(path.dirname(resolved), true);
    await mkdir(parent, { recursive: true });
    const extension = path.extname(resolved); const base = resolved.slice(0, -extension.length);
    for (let suffix = 0; suffix < 10_000; suffix += 1) {
      const candidate = suffix === 0 ? resolved : `${base} (${suffix + 1})${extension}`;
      try {
        await writeFile(candidate, data, { flag: 'wx' });
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    throw new Error('Could not allocate a unique project filename.');
  }
}
