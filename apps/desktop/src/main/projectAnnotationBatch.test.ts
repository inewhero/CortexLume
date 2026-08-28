import { beforeEach, describe, expect, it, vi } from 'vitest';
import { materializeProjectionSnapshot } from '../renderer/lib/projectionSnapshot';
import { registerVerifiedTestSurfaceProjectors } from '../renderer/lib/testSurfaceProjectors';
import { useProjectStore } from '../renderer/store/projectStore';
import { annotateProjectAtlas, chunkAtMost, type ScienceRequestOptions } from './projectAnnotation';

describe('project annotation batching', () => {
  beforeEach(() => {
    registerVerifiedTestSurfaceProjectors();
    useProjectStore.getState().newProject();
    useProjectStore.getState().placeLayout(useProjectStore.getState().activeLayoutId);
  });

  it('chunks at the shared boundary without an oversized request', () => {
    const values = Array.from({ length: 513 }, (_, index) => index);
    const chunks = chunkAtMost(values, 512);
    expect(chunks.map((chunk) => chunk.length)).toEqual([512, 1]);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(512);
  });

  it('rejects an invalid chunk boundary', () => {
    expect(() => chunkAtMost([1], 0)).toThrow('positive integer');
  });

  it('uses one bounded path-batch request for all project channels', async () => {
    const project = materializeProjectionSnapshot(structuredClone(useProjectStore.getState().project));
    const requests: Array<{ pathname: string; payload: unknown }> = [];
    const progress: string[] = [];
    const annotated = await annotateProjectAtlas(project, {
      request: async <T,>(pathname: string, payload: unknown, _options?: ScienceRequestOptions): Promise<T> => {
        requests.push({ pathname, payload });
        if (pathname === '/v1/atlas/query-batch') {
          const points = (payload as { points: Array<{ id: string }> }).points;
          return {
            atlasVerified: true,
            issue: null,
            results: points.map(({ id }) => ({ id, corticalRegions: [], deepStructures: [] })),
          } as T;
        }
        const items = (payload as { items: Array<{ id: string }> }).items;
        return {
          atlasVerified: true,
          issue: null,
          results: items.map(({ id }) => ({ id, regions: [] })),
        } as T;
      },
    }, { onProgress: (_completed, _total, phase) => progress.push(phase) });

    const pointRequests = requests.filter(({ pathname }) => pathname === '/v1/atlas/query-batch');
    const pathRequests = requests.filter(({ pathname }) => pathname === '/v1/atlas/query-path-batch');
    expect(pointRequests.length).toBe(1);
    expect(pathRequests.length).toBe(1);
    expect((pathRequests[0]!.payload as { items: unknown[] }).items.length).toBeGreaterThan(0);
    expect(Math.max(...pathRequests.map(({ payload }) => (payload as { items: unknown[] }).items.length))).toBeLessThanOrEqual(128);
    expect(progress).toContain('atlas-points');
    expect(progress).toContain('atlas-paths');
    expect(annotated.verifiedResults.every((result) => result.underlyingCorticalRegions.length === 0)).toBe(true);
  });

  it('does not put results with empty cortical and deep coordinates in a point batch', async () => {
    const materialized = materializeProjectionSnapshot(structuredClone(useProjectStore.getState().project));
    const emptyIndex = materialized.verifiedResults.findIndex((result) => result.subjectKind === 'optode');
    const project = {
      ...materialized,
      verifiedResults: materialized.verifiedResults.map((result, index) => index === emptyIndex
        ? { ...result, corticalRasMm: null, depthTargetRasMm: null }
        : result),
    };
    const pointIds: string[] = [];
    await annotateProjectAtlas(project, {
      request: async <T,>(pathname: string, payload: unknown): Promise<T> => {
        if (pathname === '/v1/atlas/query-batch') {
          const points = (payload as { points: Array<{ id: string; corticalRasMm: unknown; deepTargetRasMm: unknown }> }).points;
          pointIds.push(...points.map(({ id }) => id));
          expect(points.every(({ corticalRasMm, deepTargetRasMm }) => corticalRasMm != null || deepTargetRasMm != null)).toBe(true);
          return {
            atlasVerified: true,
            issue: null,
            results: points.map(({ id }) => ({ id, corticalRegions: [], deepStructures: [] })),
          } as T;
        }
        const items = (payload as { items: Array<{ id: string }> }).items;
        return {
          atlasVerified: true,
          issue: null,
          results: items.map(({ id }) => ({ id, regions: [] })),
        } as T;
      },
    });
    expect(pointIds).not.toContain(String(emptyIndex));
  });

  it('reports an exact zero total and sends no requests for an empty annotation set', async () => {
    const materialized = materializeProjectionSnapshot(structuredClone(useProjectStore.getState().project));
    const project = {
      ...materialized,
      verifiedResults: materialized.verifiedResults.map((result) => ({
        ...result,
        corticalRasMm: null,
        depthTargetRasMm: null,
      })),
    };
    const request = vi.fn();
    const progress: Array<[number, number, string]> = [];

    await annotateProjectAtlas(project, { request }, {
      onProgress: (completed, total, phase) => progress.push([completed, total, phase]),
    });

    expect(request).not.toHaveBeenCalled();
    expect(progress).toEqual([[0, 0, 'atlas-points']]);
  });

  it('ignores out-of-range, malicious, and duplicate point response IDs', async () => {
    const project = materializeProjectionSnapshot(structuredClone(useProjectStore.getState().project));
    const firstPointIndex = project.verifiedResults.findIndex((result) => (
      result.corticalRasMm != null || result.depthTargetRasMm != null
    ));
    const duplicateId = String(firstPointIndex);
    const poisonedRegion = { atlasId: 'poison', labelEn: 'Poison', probability: 1 };

    const annotated = await annotateProjectAtlas(project, {
      request: async <T,>(pathname: string, payload: unknown): Promise<T> => {
        if (pathname === '/v1/atlas/query-batch') {
          const points = (payload as { points: Array<{ id: string }> }).points;
          return {
            atlasVerified: true,
            results: [
              ...points.map(({ id }) => ({ id, corticalRegions: [], deepStructures: [] })),
              { id: duplicateId, corticalRegions: [poisonedRegion], deepStructures: [poisonedRegion] },
              { id: String(project.verifiedResults.length + 10), corticalRegions: [poisonedRegion], deepStructures: [] },
              { id: '__proto__', corticalRegions: [poisonedRegion], deepStructures: [] },
            ],
          } as T;
        }
        const items = (payload as { items: Array<{ id: string }> }).items;
        return { atlasVerified: true, results: items.map(({ id }) => ({ id, regions: [] })) } as T;
      },
    });

    expect(annotated.verifiedResults[firstPointIndex]!.underlyingCorticalRegions).toEqual([]);
    expect(JSON.stringify(annotated)).not.toContain('Poison');
  });

  it('ignores out-of-range, malicious, and duplicate path response IDs', async () => {
    const project = materializeProjectionSnapshot(structuredClone(useProjectStore.getState().project));
    const poisonedRegion = { atlasId: 'poison', labelEn: 'Poison', probability: 1 };
    let duplicatedPathIndex = -1;

    const annotated = await annotateProjectAtlas(project, {
      request: async <T,>(pathname: string, payload: unknown): Promise<T> => {
        if (pathname === '/v1/atlas/query-batch') {
          const points = (payload as { points: Array<{ id: string }> }).points;
          return { atlasVerified: true, results: points.map(({ id }) => ({ id })) } as T;
        }
        const items = (payload as { items: Array<{ id: string }> }).items;
        duplicatedPathIndex = Number(items[0]!.id);
        return {
          atlasVerified: true,
          results: [
            ...items.map(({ id }) => ({ id, regions: [] })),
            { id: items[0]!.id, regions: [poisonedRegion] },
            { id: String(project.verifiedResults.length + 10), regions: [poisonedRegion] },
            { id: 'constructor', regions: [poisonedRegion] },
          ],
        } as T;
      },
    });

    expect(duplicatedPathIndex).toBeGreaterThanOrEqual(0);
    expect(annotated.verifiedResults[duplicatedPathIndex]!.underlyingCorticalRegions).toEqual([]);
    expect(JSON.stringify(annotated)).not.toContain('Poison');
  });

  it('passes one shared signal and the remaining overall deadline to every batch', async () => {
    const project = materializeProjectionSnapshot(structuredClone(useProjectStore.getState().project));
    const controller = new AbortController();
    const deadline = Date.now() + 5_000;
    const optionsSeen: ScienceRequestOptions[] = [];

    await annotateProjectAtlas(project, {
      request: async <T,>(pathname: string, payload: unknown, options?: ScienceRequestOptions): Promise<T> => {
        optionsSeen.push(options ?? {});
        if (pathname === '/v1/atlas/query-batch') {
          const points = (payload as { points: Array<{ id: string }> }).points;
          return { atlasVerified: true, results: points.map(({ id }) => ({ id })) } as T;
        }
        const items = (payload as { items: Array<{ id: string }> }).items;
        return { atlasVerified: true, results: items.map(({ id }) => ({ id, regions: [] })) } as T;
      },
    }, { signal: controller.signal, deadline, timeoutMs: 10_000 });

    expect(optionsSeen.length).toBeGreaterThan(0);
    expect(optionsSeen.every((options) => options.signal === controller.signal)).toBe(true);
    expect(optionsSeen.every((options) => (
      typeof options.timeoutMs === 'number' && options.timeoutMs > 0 && options.timeoutMs <= 5_000
    ))).toBe(true);
  });

  it('stops before the first sidecar request when cancelled', async () => {
    const project = materializeProjectionSnapshot(structuredClone(useProjectStore.getState().project));
    const controller = new AbortController();
    controller.abort();
    let requestCount = 0;
    await expect(annotateProjectAtlas(project, {
      request: async <T,>(): Promise<T> => {
        requestCount += 1;
        return { atlasVerified: true, issue: null, results: [] } as T;
      },
    }, { signal: controller.signal })).rejects.toThrow('cancelled');
    expect(requestCount).toBe(0);
  });

  it('yields between batches so cancellation stops a running annotation', async () => {
    const project = materializeProjectionSnapshot(structuredClone(useProjectStore.getState().project));
    // Abort after the first point response; the next phase must observe it
    // before sending a path request.
    const controller = new AbortController();
    let requestCount = 0;
    await expect(annotateProjectAtlas(project, {
      request: async <T,>(pathname: string, payload: unknown, _options?: ScienceRequestOptions): Promise<T> => {
        requestCount += 1;
        if (pathname === '/v1/atlas/query-batch') {
          const points = (payload as { points: Array<{ id: string }> }).points;
          return {
            atlasVerified: true,
            issue: null,
            results: points.map(({ id }) => ({ id, corticalRegions: [], deepStructures: [] })),
          } as T;
        }
        const items = (payload as { items: Array<{ id: string }> }).items;
        return {
          atlasVerified: true,
          issue: null,
          results: items.map(({ id }) => ({ id, regions: [] })),
        } as T;
      },
    }, {
      signal: controller.signal,
      onProgress: (completed) => {
        if (completed > 0) controller.abort();
      },
    })).rejects.toThrow('cancelled');
    expect(requestCount).toBe(1);
  });
});
