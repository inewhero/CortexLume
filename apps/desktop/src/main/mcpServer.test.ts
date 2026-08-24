import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FunctionalTargetMap } from '@cortexlume/contracts';
import type { ScienceClient } from '@cortexlume/science-client';
import { CortexLumeMcpRuntime } from './mcpServer';

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

describe('CortexLume MCP runtime', () => {
  const clients: Client[] = [];
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  it('handshakes, advertises stable schemas, plans all target kinds and preserves derived files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cortexlume-mcp-'));
    const niftiPath = path.join(root, 'fixture.nii.gz');
    await writeFile(niftiPath, 'mocked NIfTI bytes');
    const openGui = vi.fn();
    const science = {
      request: vi.fn(async (pathname: string) => {
        if (pathname === '/v1/health') return { ok: true, templateVerified: true, atlasVerified: true };
        if (pathname === '/v1/targets/import') return { accepted: true, diagnostics: [], map: fixtureTarget('nifti-import') };
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
      'get_capabilities', 'search_targets', 'list_atlas_regions', 'plan_project',
      'save_project', 'inspect_project', 'open_project',
    ]);
    expect(listed.tools.find((tool) => tool.name === 'plan_project')?.inputSchema.required).toContain('target');

    const capabilities = structured(await client.callTool({ name: 'get_capabilities', arguments: {} }));
    expect(capabilities.projectFormatVersion).toBe(2);
    expect((capabilities.assets as { ready: boolean }).ready).toBe(true);

    const targetRequests = [
      { kind: 'quick-target', id: 'neurosynth:working-memory' },
      { kind: 'harvard-oxford-region', label: 'Left Precentral Gyrus' },
      { kind: 'mni-point', rasMm: [-40, 20, 50], label: 'MNI fixture' },
      { kind: 'nifti', path: niftiPath, declaredSpace: 'MNI152NLin6Asym' },
    ];
    const plans: Record<string, unknown>[] = [];
    for (const target of targetRequests) {
      const result = await client.callTool({
        name: 'plan_project',
        arguments: { target, seed: 'mcp-e2e' },
      });
      if (result.isError) throw new Error(`plan_project failed for ${target.kind}: ${JSON.stringify(result.content)}`);
      const plan = structured(result);
      expect(plan.candidates).toHaveLength(3);
      expect(plan.recommendedCandidateId).toBeTruthy();
      plans.push(plan);
    }

    const selectedPlan = plans[2]!;
    const candidateId = selectedPlan.recommendedCandidateId as string;
    const requestedOutput = path.join(root, 'agent-plan.cortexlume');
    const firstSave = structured(await client.callTool({
      name: 'save_project',
      arguments: { planId: selectedPlan.planId, candidateId, outputPath: requestedOutput, projectName: 'Agent E2E' },
    }));
    const secondSave = structured(await client.callTool({
      name: 'save_project',
      arguments: { planId: selectedPlan.planId, candidateId, outputPath: requestedOutput, projectName: 'Agent E2E' },
    }));
    expect(await realpath(firstSave.path as string)).toBe(await realpath(requestedOutput));
    expect(await realpath(secondSave.path as string)).not.toBe(await realpath(requestedOutput));
    expect(await readFile(firstSave.path as string)).not.toHaveLength(0);

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

    const outside = await client.callTool({ name: 'inspect_project', arguments: { path: path.join(os.homedir(), 'outside.cortexlume') } });
    expect(outside.isError).toBe(true);
    expect(JSON.stringify(outside.content)).toContain('outside MCP authorized roots');
  }, 180_000);
});
