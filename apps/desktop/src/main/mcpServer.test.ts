import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnatomicalCoverageRequest, FunctionalTargetMap } from '@cortexlume/contracts';
import type { PlannerCandidate } from '@cortexlume/core/node';
import type { ScienceClient } from '@cortexlume/science-client';
import {
  BoundedTtlCache,
  CortexLumeMcpRuntime,
  MCP_PLAN_CACHE_MAX_ESTIMATED_BYTES,
  MCP_PLAN_CACHE_MAX_ENTRIES,
  MCP_PLAN_CACHE_TTL_MS,
  MCP_TARGET_ANATOMY_CACHE_MAX_ESTIMATED_BYTES,
  MCP_TARGET_ANATOMY_CACHE_MAX_ENTRIES,
  MCP_TARGET_ANATOMY_CACHE_TTL_MS,
  rerankEnrichedCandidates,
  ScienceLifecycleGate,
} from './mcpServer';

const TEMPLATE_ROOT = path.resolve(process.cwd(), '../../assets/templates/MNI152NLin6Asym');

function fixtureTarget(sourceKind: 'neurosynth-quick' | 'nifti-import' | 'harvard-oxford-region'): FunctionalTargetMap {
  return {
    target: { id: `fixture:${sourceKind}`, label: `${sourceKind} fixture`, aliases: [], peakRegions: [] },
    vertexCount: 25_000,
    vertexIndices: [12_500, 12_501, 12_502],
    values: [1, 0.8, 0.5],
    provenance: {
      sourceKind,
      sourceSpace: sourceKind === 'neurosynth-quick' ? 'NeurosynthMNI152-2mm' : 'MNI152NLin6Asym',
      targetSpace: 'MNI152NLin6Asym', targetSurface: 'Cedalion-ICBM152-25k',
      statistic: sourceKind === 'harvard-oxford-region' ? 'Harvard-Oxford probability' : 'z',
      fileName: sourceKind === 'nifti-import' ? 'fixture.nii.gz' : null,
      mapSha256: sourceKind[0]!.repeat(64),
    },
  };
}

function structured(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  if (result.isError || !result.structuredContent) {
    throw new Error(`MCP tool failed: ${JSON.stringify(result.content)}`);
  }
  return result.structuredContent as Record<string, unknown>;
}

function fixtureCoverage(request: AnatomicalCoverageRequest) {
  return {
    version: 1,
    sourceKind: 'geometric-anatomical-coverage-prior',
    targetSurface: 'Cedalion-ICBM152-25k',
    vertexCount: 25_000,
    channels: request.channels.map((channel) => ({
      stableId: `${channel.instanceId}:${channel.pairId}`,
      instanceId: channel.instanceId,
      pairId: channel.pairId,
      ...(channel.channelNumber == null ? {} : { channelNumber: channel.channelNumber }),
      pathPointCount: channel.pointsRasMm.length,
      pathLengthMm: 30,
      pathSha256: 'a'.repeat(64),
    })),
    parameters: {
      kernelSigmaMm: 12,
      supportRadiusMm: 24,
      minimumAtlasMembership: 0.05,
      distanceMetric: 'euclidean-distance-to-polyline',
      kernel: 'truncated-gaussian',
      channelCombination: 'maximum-kernel-weight',
      mosaicAssignment: 'maximum-harvard-oxford-membership',
      regionAggregation: 'coverage-weighted-atlas-membership',
      atlasMembershipAggregation: 'sum-retained-top3-without-renormalization',
      summarySampling: 'vertex-sampled-not-surface-area-integrated',
    },
    mosaic: {
      geometricVertexIndices: [], geometricCoverageWeights: [], vertexIndices: [], coverageWeights: [],
      opacityWeights: [], regionIndices: [], atlasMemberships: [], dominantChannelIndices: [],
    },
    regions: [{
      regionIndex: 0,
      atlasId: 'Harvard-Oxford fixture',
      labelEn: 'Left Precentral Gyrus',
      colorHex: '#4477AA',
      coveredAtlasMassFraction: 1,
      weightedAtlasMass: 1,
      dominantVertexCount: 0,
      channelShares: request.channels.map((channel, channelIndex) => ({
        channelIndex,
        stableId: `${channel.instanceId}:${channel.pairId}`,
        geometricShare: 1 / request.channels.length,
      })),
    }],
    qc: { geometricCoveredVertexCount: 0, atlasLabeledVertexCount: 0, unlabeledCoveredVertexCount: 0, atlasSupportFraction: 1, flags: [] },
    provenance: {
      templateAssetVersion: 'fixture', coordinateConvention: 'RAS+', units: 'mm',
      surfaceVertexCoordinatesSha256: 'b'.repeat(64), surfaceMeshSha256: 'c'.repeat(64),
      atlasId: 'Harvard-Oxford fixture', atlasIndexSha256: 'd'.repeat(64),
      atlasSampling: 'nearest-voxel-top3-original-membership',
      interpretation: 'Geometric anatomical coverage prior; not photon sensitivity, fluence, or Jacobian.',
    },
  };
}

function rankingCandidate(
  stableId: string,
  nominal: number,
  balanced: number,
  anatomy: number,
): PlannerCandidate {
  return {
    layouts: [],
    instances: [],
    summary: {
      stableId,
      rank: 1,
      accepted: true,
      rejectionReasons: [],
      placements: [],
      metrics: {
        nominalTargetMassCoverage: nominal,
        robustP10TargetMassCoverage: 0.1,
        robustWorstTargetMassCoverage: 0.08,
        minimumOptodeClearanceMm: 25,
        meanSpacingDistortionMm: 0.5,
        balancedTargetCoverage: balanced,
        anatomicalTargetAlignment: anatomy,
        maximumScalpCortexGapMm: 25,
        cranialOptodeFraction: 1,
        cranialRobustPassFraction: 1,
      },
    },
  };
}

describe('CortexLume MCP runtime', () => {
  const clients: Client[] = [];
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  it('bounds plan-like caches with LRU refresh and TTL expiry', () => {
    let now = 10_000;
    const cache = new BoundedTtlCache<string, number>(2, 100, () => now);
    expect(cache.set('a', 1).expiresAtMs).toBe(10_100);
    expect(cache.set('b', 2).expiresAtMs).toBe(10_100);
    expect(cache.stats()).toMatchObject({ size: 2, evictionCount: 0 });
    now += 10;
    expect(cache.getEntry('a')).toMatchObject({ value: 1, expiresAtMs: 10_110 });
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.getEntry('a')).toMatchObject({ value: 1, expiresAtMs: 10_110 });
    expect(cache.get('c')).toBe(3);
    expect(cache.stats().evictionCount).toBe(1);
    now += 101;
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('c')).toBeUndefined();
    expect(cache.stats()).toMatchObject({ size: 0, evictionCount: 3 });
  });

  it('bounds hundreds of cache inserts by both LRU entries and estimated bytes', () => {
    const cache = new BoundedTtlCache<number, string>(
      50, 60_000, Date.now, 1_000, (value) => value.length,
    );
    for (let index = 0; index < 500; index += 1) cache.set(index, 'x'.repeat(30));
    expect(cache.stats()).toMatchObject({
      size: 33,
      estimatedBytes: 990,
      maxEstimatedBytes: 1_000,
      evictionCount: 467,
    });
    expect(cache.get(466)).toBeUndefined();
    expect(cache.get(467)).toHaveLength(30);
    expect(() => cache.set(501, 'x'.repeat(1_001))).toThrow(/estimated-memory budget/);
  });

  it('keeps the plan cache policy within the documented long-running bounds', () => {
    expect(MCP_PLAN_CACHE_MAX_ENTRIES).toBe(32);
    expect(MCP_PLAN_CACHE_TTL_MS).toBe(45 * 60 * 1000);
    expect(MCP_PLAN_CACHE_MAX_ESTIMATED_BYTES).toBe(96 * 1024 * 1024);
    expect(MCP_TARGET_ANATOMY_CACHE_MAX_ENTRIES).toBe(96);
    expect(MCP_TARGET_ANATOMY_CACHE_TTL_MS).toBe(45 * 60 * 1000);
    expect(MCP_TARGET_ANATOMY_CACHE_MAX_ESTIMATED_BYTES).toBe(4 * 1024 * 1024);
  });

  it('drains active science requests before an exclusive planning section', async () => {
    const gate = new ScienceLifecycleGate();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = gate.request(async () => {
      events.push('request-1-start');
      await firstReleased;
      events.push('request-1-end');
      return 1;
    });
    await Promise.resolve();
    const exclusive = gate.withExclusive(async () => {
      events.push('exclusive-start');
      await Promise.resolve();
      events.push('exclusive-end');
      return 2;
    });
    const second = gate.request(async () => {
      events.push('request-2-start');
      return 3;
    });
    await Promise.resolve();
    expect(events).toEqual(['request-1-start']);
    releaseFirst();
    await expect(first).resolves.toBe(1);
    await expect(exclusive).resolves.toBe(2);
    await expect(second).resolves.toBe(3);
    expect(events).toEqual([
      'request-1-start', 'request-1-end', 'exclusive-start', 'exclusive-end', 'request-2-start',
    ]);
  });

  it('keeps concurrent plans and capabilities safe on the shared science client', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cortexlume-mcp-concurrency-'));
    let activeRequests = 0;
    let targetProfileRequests = 0;
    let targetProfileFinished = false;
    const stopActiveCounts: number[] = [];
    const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const science = {
      stop: vi.fn(() => {
        stopActiveCounts.push(activeRequests);
        if (activeRequests !== 0) throw new Error(`stop raced ${activeRequests} active science requests`);
      }),
      request: vi.fn(async (pathname: string) => {
        activeRequests += 1;
        try {
          if (pathname === '/v1/coverage/target-profile') {
            targetProfileRequests += 1;
            await delay(25);
            targetProfileFinished = true;
            return {
              atlasId: 'Harvard-Oxford fixture', atlasSupportFraction: 1,
              regions: [{ atlasId: 'Harvard-Oxford fixture', labelEn: 'Left Precentral Gyrus', massFraction: 1 }],
            };
          }
          if (pathname === '/v1/coverage/anatomical-summary') {
            await delay(1);
            return {
              atlasId: 'Harvard-Oxford fixture', atlasSupportFraction: 1,
              regions: [{ atlasId: 'Harvard-Oxford fixture', labelEn: 'Left Precentral Gyrus', massFraction: 1 }],
            };
          }
          if (pathname === '/v1/health') return { ok: true, templateVerified: true, atlasVerified: true };
          throw new Error(`Unexpected science request: ${pathname}`);
        } finally {
          activeRequests -= 1;
        }
      }),
    } as unknown as ScienceClient;
    const runtime = new CortexLumeMcpRuntime({
      templateRoot: TEMPLATE_ROOT,
      science,
      applicationVersion: 'test',
      authorizedRoots: [root],
      openGui: vi.fn(),
    });
    const server = runtime.createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'cortexlume-concurrency-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(clientTransport);

    const firstPlan = client.callTool({
      name: 'plan_project',
      arguments: { target: { kind: 'mni-point', rasMm: [-40, 20, 50] }, seed: 'concurrent-a' },
    });
    const secondPlan = client.callTool({
      name: 'plan_project',
      arguments: { target: { kind: 'mni-point', rasMm: [-40, 20, 50] }, seed: 'concurrent-b' },
    });
    for (let attempt = 0; attempt < 50 && !targetProfileFinished; attempt += 1) await delay(5);
    expect(targetProfileFinished).toBe(true);
    // Let the plan continuations enqueue their exclusive sections before a
    // regular health request is submitted.
    await Promise.resolve();
    const capabilities = client.callTool({ name: 'get_capabilities', arguments: {} });
    const [firstResult, secondResult] = await Promise.all([firstPlan, secondPlan]);
    expect(firstResult.isError).not.toBe(true);
    expect(secondResult.isError).not.toBe(true);
    expect((await capabilities).isError).not.toBe(true);
    expect(targetProfileRequests).toBe(1);
    expect(stopActiveCounts).toEqual([0, 0]);
    expect(activeRequests).toBe(0);
  }, 180_000);

  it('fails closed when no authorized MCP roots are provided', () => {
    const options = {
      templateRoot: TEMPLATE_ROOT,
      science: { stop: vi.fn(), request: vi.fn() } as unknown as ScienceClient,
      applicationVersion: 'test',
      openGui: vi.fn(),
    };
    expect(() => new CortexLumeMcpRuntime({ ...options, authorizedRoots: [] }))
      .toThrow('requires at least one authorized project root');
    expect(() => new CortexLumeMcpRuntime({ ...options, authorizedRoots: [''] }))
      .toThrow('requires at least one authorized project root');
    expect(() => new CortexLumeMcpRuntime({ ...options, authorizedRoots: ['   '] }))
      .toThrow('requires at least one authorized project root');
    expect(() => new CortexLumeMcpRuntime(options))
      .toThrow('requires at least one authorized project root');
  });

  it('rejects over-limit patches before loading assets or running science', async () => {
    const openGui = vi.fn();
    const science = {
      stop: vi.fn(),
      request: vi.fn(),
    } as unknown as ScienceClient;
    const root = await mkdtemp(path.join(os.tmpdir(), 'cortexlume-mcp-validation-'));
    const runtime = new CortexLumeMcpRuntime({
      templateRoot: path.join(root, 'missing-assets'),
      science,
      applicationVersion: 'test',
      authorizedRoots: [root],
      openGui,
    });
    const server = runtime.createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'cortexlume-validation-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(clientTransport);

    for (const patches of [
      [{ columns: 12, rows: 12 }],
      [{ columns: 10, rows: 10, shortChannelCount: 1 }],
    ]) {
      const result = await client.callTool({
        name: 'plan_project',
        arguments: {
          target: { kind: 'mni-point', rasMm: [0, 0, 0] },
          patches,
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/optodes|pairs|100|256/);
    }
    expect(science.request).not.toHaveBeenCalled();
    expect(science.stop).not.toHaveBeenCalled();
  });

  it('keeps functional specificity ahead of atlas-profile similarity for comparable coverage', () => {
    const candidates = [
      rankingCandidate('atlas-biased', 0.210, 0.18, 0.50),
      rankingCandidate('functionally-focused', 0.206, 0.23, 0.30),
      rankingCandidate('lower-coverage', 0.18, 0.24, 0.60),
    ];
    rerankEnrichedCandidates(candidates);
    expect(candidates.map((candidate) => candidate.summary.stableId)).toEqual([
      'functionally-focused',
      'atlas-biased',
      'lower-coverage',
    ]);
  });

  it('handshakes, advertises stable schemas, plans all target kinds and preserves derived files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cortexlume-mcp-'));
    const niftiPath = path.join(root, 'fixture.nii.gz');
    await writeFile(niftiPath, 'mocked NIfTI bytes');
    const openGui = vi.fn();
    let now = 1_700_000_000_000;
    let niftiImportPayload: Record<string, unknown> | undefined;
    const targetProfileRequests: unknown[] = [];
    let failNextTargetProfile = false;
    const science = {
      stop: vi.fn(),
      request: vi.fn(async (pathname: string, payload?: unknown) => {
        if (pathname === '/v1/health') return { ok: true, templateVerified: true, atlasVerified: true };
        if (pathname === '/v1/targets/import') {
          niftiImportPayload = payload as Record<string, unknown>;
          return { accepted: true, diagnostics: [], map: fixtureTarget('nifti-import') };
        }
        if (pathname === '/v1/targets/catalog') return { count: 1, targets: [{ id: 'neurosynth:fixture', label: 'fixture' }], domains: [], provenance: {} };
        if (pathname === '/v1/coverage/target-profile') {
          targetProfileRequests.push(payload);
          if (failNextTargetProfile) {
            failNextTargetProfile = false;
            await new Promise((resolve) => setTimeout(resolve, 10));
            throw new Error('target profile fixture failure');
          }
          return {
            atlasId: 'Harvard-Oxford fixture', atlasSupportFraction: 1,
            regions: [{ atlasId: 'Harvard-Oxford fixture', labelEn: 'Left Precentral Gyrus', massFraction: 1 }],
          };
        }
        if (pathname === '/v1/coverage/anatomical-summary') {
          const coverage = fixtureCoverage(payload as AnatomicalCoverageRequest);
          return {
            atlasId: coverage.provenance.atlasId,
            atlasSupportFraction: coverage.qc.atlasSupportFraction,
            regions: coverage.regions.map((region) => ({
              atlasId: region.atlasId,
              labelEn: region.labelEn,
              massFraction: region.coveredAtlasMassFraction,
            })),
          };
        }
        if (pathname.startsWith('/v1/targets/')) return fixtureTarget('neurosynth-quick');
        if (pathname === '/v1/atlas/cortical-region-target') return fixtureTarget('harvard-oxford-region');
        if (pathname === '/v1/targets') return { targets: [], provenance: {} };
        if (pathname === '/v1/atlas/cortical-regions') return { atlasId: 'Harvard-Oxford cortical lateralized', regions: ['Left Precentral Gyrus'] };
        throw new Error(`Unexpected science request: ${pathname}`);
      }),
    } as unknown as ScienceClient;
    const runtime = new CortexLumeMcpRuntime({
      templateRoot: TEMPLATE_ROOT,
      science,
      applicationVersion: 'test',
      authorizedRoots: [root],
      clock: () => now,
      openGui,
    });
    const server = runtime.createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'cortexlume-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      'get_capabilities', 'list_targets', 'search_targets', 'list_atlas_regions', 'plan_project',
      'save_project', 'release_plan', 'inspect_project', 'open_project',
    ]);
    expect(listed.tools.find((tool) => tool.name === 'plan_project')?.inputSchema.required).toContain('target');
    expect((listed.tools.find((tool) => tool.name === 'save_project')?.inputSchema.properties as Record<string, { default?: unknown }>).consumePlan?.default).toBe(true);

    const capabilities = structured(await client.callTool({ name: 'get_capabilities', arguments: {} }));
    expect(capabilities.projectFormatVersion).toBe(2);
    expect((capabilities.assets as { ready: boolean }).ready).toBe(true);
    expect(capabilities.cache).toEqual({
      plans: {
        size: 0,
        maxEntries: MCP_PLAN_CACHE_MAX_ENTRIES,
        ttlMs: MCP_PLAN_CACHE_TTL_MS,
        estimatedBytes: 0,
        maxEstimatedBytes: MCP_PLAN_CACHE_MAX_ESTIMATED_BYTES,
        evictionCount: 0,
        evictions: 0,
      },
      targetAnatomy: {
        size: 0,
        maxEntries: MCP_TARGET_ANATOMY_CACHE_MAX_ENTRIES,
        ttlMs: MCP_TARGET_ANATOMY_CACHE_TTL_MS,
        estimatedBytes: 0,
        maxEstimatedBytes: MCP_TARGET_ANATOMY_CACHE_MAX_ESTIMATED_BYTES,
        evictionCount: 0,
        evictions: 0,
      },
    });
    const catalog = structured(await client.callTool({ name: 'list_targets', arguments: {} }));
    expect(catalog.count).toBe(1);

    failNextTargetProfile = true;
    const failedPlans = await Promise.all([
      client.callTool({
        name: 'plan_project',
        arguments: { target: { kind: 'quick-target', id: 'failure-fixture' }, seed: 'failed-dedupe-a' },
      }),
      client.callTool({
        name: 'plan_project',
        arguments: { target: { kind: 'quick-target', id: 'failure-fixture' }, seed: 'failed-dedupe-b' },
      }),
    ]);
    expect(failedPlans.every((result) => result.isError)).toBe(true);
    expect(targetProfileRequests).toHaveLength(1);
    expect((runtime as unknown as { targetAnatomyLoads: Map<string, unknown> }).targetAnatomyLoads.size).toBe(0);

    const targetRequests = [
      { kind: 'quick-target', id: 'neurosynth:working-memory' },
      { kind: 'harvard-oxford-region', label: 'Left Precentral Gyrus' },
      { kind: 'mni-point', rasMm: [-40, 20, 50], label: 'MNI fixture' },
      { kind: 'nifti', path: niftiPath, declaredSpace: 'MNI152NLin6Asym' },
    ];
    const plans: Record<string, unknown>[] = [];
    for (const target of targetRequests) {
      const targetProfileCountBefore = targetProfileRequests.length;
      const result = await client.callTool({
        name: 'plan_project',
        arguments: { target, seed: 'mcp-e2e' },
      });
      if (result.isError) throw new Error(`plan_project failed for ${target.kind}: ${JSON.stringify(result.content)}`);
      const plan = structured(result);
      expect(plan.candidates).toHaveLength(3);
      expect(plan.recommendedCandidateId).toBeTruthy();
      expect((plan.targetAnatomy as { regions: unknown[] }).regions).toHaveLength(1);
      expect((plan.candidates as Array<{ anatomicalCoverage: { regions: unknown[] } }>)[0]!.anatomicalCoverage.regions).toHaveLength(1);
      plans.push(plan);
      if (target.kind === 'quick-target') {
        expect(targetProfileRequests).toHaveLength(targetProfileCountBefore + 1);
        now += 1234;
        const repeatedPlan = structured(await client.callTool({
          name: 'plan_project',
          arguments: { target, seed: 'mcp-e2e' },
        }));
        expect(repeatedPlan.planId).toBe(plan.planId);
        expect(targetProfileRequests).toHaveLength(targetProfileCountBefore + 1);
        expect(repeatedPlan.targetAnatomyExpiresAt).toBe(new Date(now + MCP_TARGET_ANATOMY_CACHE_TTL_MS).toISOString());
      }
    }
    expect(niftiImportPayload).toEqual(expect.objectContaining({
      fileName: 'fixture.nii.gz', declaredSpace: 'MNI152NLin6Asym',
    }));
    expect(niftiImportPayload).not.toHaveProperty('dataBase64');
    const stagedPath = niftiImportPayload?.filePath;
    expect(typeof stagedPath).toBe('string');
    expect(stagedPath).not.toBe(niftiPath);
    expect(existsSync(stagedPath as string)).toBe(false);

    const released = structured(await client.callTool({
      name: 'release_plan', arguments: { planId: plans[0]!.planId },
    }));
    expect(released.released).toBe(true);
    const releasedAgain = structured(await client.callTool({
      name: 'release_plan', arguments: { planId: plans[0]!.planId },
    }));
    expect(releasedAgain.released).toBe(false);

    const selectedPlan = plans[2]!;
    const candidateId = selectedPlan.recommendedCandidateId as string;
    const requestedOutput = path.join(root, 'agent-plan.cortexlume');
    now += 1234;
    const firstSave = structured(await client.callTool({
      name: 'save_project',
      arguments: { planId: selectedPlan.planId, candidateId, outputPath: requestedOutput, projectName: 'Agent E2E', consumePlan: false },
    }));
    expect(firstSave.expiresAt).toBe(new Date(now + MCP_PLAN_CACHE_TTL_MS).toISOString());
    now += 1234;
    const secondSave = structured(await client.callTool({
      name: 'save_project',
      arguments: { planId: selectedPlan.planId, candidateId, outputPath: requestedOutput, projectName: 'Agent E2E', consumePlan: false },
    }));
    expect(await realpath(firstSave.path as string)).toBe(await realpath(requestedOutput));
    expect(await realpath(secondSave.path as string)).not.toBe(await realpath(requestedOutput));
    expect(secondSave.expiresAt).toBe(new Date(now + MCP_PLAN_CACHE_TTL_MS).toISOString());
    expect(await readFile(firstSave.path as string)).not.toHaveLength(0);
    const nestedOutput = path.join(root, 'new', 'nested', 'agent-plan.cortexlume');
    const nestedSave = structured(await client.callTool({
      name: 'save_project',
      arguments: { planId: selectedPlan.planId, candidateId, outputPath: nestedOutput, consumePlan: false },
    }));
    expect(await realpath(nestedSave.path as string)).toBe(await realpath(nestedOutput));

    const inspection = structured(await client.callTool({ name: 'inspect_project', arguments: { path: firstSave.path } }));
    expect(inspection.formatVersion).toBe(2);
    expect((inspection.functionalTarget as FunctionalTargetMap).provenance.sourceKind).toBe('mni-point');
    expect((inspection.planning as { selectedCandidateId: string }).selectedCandidateId).toBe(candidateId);

    const derivedPlan = structured(await client.callTool({
      name: 'plan_project',
      arguments: {
        target: { kind: 'quick-target', id: 'neurosynth:working-memory' },
        seed: 'derived-e2e',
        sourceProjectPath: firstSave.path,
      },
    }));
    const derivedSave = structured(await client.callTool({
      name: 'save_project',
      arguments: {
        planId: derivedPlan.planId,
        candidateId: derivedPlan.recommendedCandidateId,
        outputPath: firstSave.path,
      },
    }));
    expect(derivedSave.path).not.toBe(firstSave.path);
    const derivedInspection = structured(await client.callTool({ name: 'inspect_project', arguments: { path: derivedSave.path } }));
    expect((derivedInspection.planning as { sourceProjectSha256: string }).sourceProjectSha256)
      .toBe(inspection.archiveProjectSha256);

    const opened = structured(await client.callTool({ name: 'open_project', arguments: { path: firstSave.path } }));
    expect(opened.separateProcess).toBe(true);
    expect(openGui).toHaveBeenCalledWith(firstSave.path);

    const consumed = structured(await client.callTool({
      name: 'save_project',
      arguments: {
        planId: selectedPlan.planId,
        candidateId,
        outputPath: path.join(root, 'consumed-plan.cortexlume'),
      },
    }));
    expect(consumed.expiresAt).toBeNull();
    const afterConsume = await client.callTool({
      name: 'save_project',
      arguments: {
        planId: selectedPlan.planId,
        candidateId,
        outputPath: path.join(root, 'consumed-plan-again.cortexlume'),
      },
    });
    expect(afterConsume.isError).toBe(true);
    expect(JSON.stringify(afterConsume.content)).toContain('Unknown or expired planId');

    const outside = await client.callTool({ name: 'inspect_project', arguments: { path: path.join(os.homedir(), 'outside.cortexlume') } });
    expect(outside.isError).toBe(true);
    expect(JSON.stringify(outside.content)).toContain('outside MCP authorized roots');
  }, 180_000);
});
