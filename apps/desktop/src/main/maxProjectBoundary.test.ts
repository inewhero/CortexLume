import { describe, expect, it } from 'vitest';
import { CROSS_PROCESS_LIMITS } from '@cortexlume/contracts';
import { createProjectArchive, readProjectArchive } from '@cortexlume/project-io';
import { annotateProjectAtlas, type ScienceRequestOptions } from './projectAnnotation';
import {
  buildBidsGeometryExportAsync,
  buildBrainNetExportAsync,
  buildCsvExportAsync,
} from './projectExport';
import { maximumVerifiedProject } from '@cortexlume/project-io/src/maxProjectFixture';

describe('maximum verified project integration boundary', () => {
  it('saves, opens, annotates, and exports a complete 8192-result project', async () => {
    const project = maximumVerifiedProject();
    project.deviceProfile.samplingFrequencyHz = 36;
    expect(project.verifiedResults).toHaveLength(CROSS_PROCESS_LIMITS.projectionResults);

    const opened = readProjectArchive(createProjectArchive(project));
    expect(opened.verifiedResults).toHaveLength(CROSS_PROCESS_LIMITS.projectionResults);
    expect(opened.verifiedResults.every((result) => (
      result.status === 'verified' && result.qcFlags.includes('surface_model_verified')
    ))).toBe(true);

    const requestSizes: number[] = [];
    const annotated = await annotateProjectAtlas(opened, {
      request: async <T,>(pathname: string, payload: unknown, _options?: ScienceRequestOptions): Promise<T> => {
        if (pathname === '/v1/atlas/query-batch') {
          const points = (payload as { points: Array<{ id: string }> }).points;
          requestSizes.push(points.length);
          return {
            atlasVerified: true,
            issue: null,
            results: points.map(({ id }) => ({ id, corticalRegions: [], deepStructures: [] })),
          } as T;
        }
        const items = (payload as { items: Array<{ id: string }> }).items;
        requestSizes.push(items.length);
        return {
          atlasVerified: true,
          issue: null,
          results: items.map(({ id }) => ({ id, regions: [] })),
        } as T;
      },
    });
    expect(requestSizes).toContain(512);
    expect(requestSizes).toContain(128);
    expect(annotated.verifiedResults).toHaveLength(CROSS_PROCESS_LIMITS.projectionResults);
    expect(annotated.verifiedResults.every((result) => (
      result.status === 'verified' && result.qcFlags.includes('surface_model_verified')
    ))).toBe(true);

    const progress: string[] = [];
    const options = { onProgress: (_completed: number, _total: number, phase: string) => progress.push(phase) };
    const csv = await buildCsvExportAsync(annotated, options);
    expect(csv.files['cortexlume_export.json']).toBeDefined();
    const bids = await buildBidsGeometryExportAsync(annotated, options);
    expect(bids.files['sourcedata/cortexlume_export.json']).toBeDefined();
    const brainNet = await buildBrainNetExportAsync(annotated, options);
    expect(brainNet.files['cortexlume_brainnet.node']).toBeDefined();
    expect(progress).toContain('export-csv');
    expect(progress).toContain('export-bids');
  }, 60_000);

  it('yields during export construction so cancellation prevents a completed bundle', async () => {
    const project = maximumVerifiedProject();
    const controller = new AbortController();
    const phases: string[] = [];
    const running = buildCsvExportAsync(project, {
      signal: controller.signal,
      onProgress: (_completed, _total, phase) => {
        phases.push(phase);
        if (phase === 'export-csv') controller.abort();
      },
    });
    await expect(running).rejects.toThrow('cancelled');
    expect(phases).toContain('export-csv');
  }, 30_000);
});
