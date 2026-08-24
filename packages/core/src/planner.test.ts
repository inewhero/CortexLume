import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FunctionalTargetMap } from '@cortexlume/contracts';
import { loadHeadModelFromAssets } from './nodeAssets.js';
import { planLayouts } from './planner.js';

const TEMPLATE_ROOT = path.resolve(process.cwd(), '../../assets/templates/MNI152NLin6Asym');

describe('locked mesh-aware planner', () => {
  it('loads all required locked assets and produces deterministic ranked geometry', async () => {
    const loaded = await loadHeadModelFromAssets(TEMPLATE_ROOT);
    const point = loaded.headModel.surfaceVerticesRasMm[12_500]!;
    const gaussian = loaded.headModel.geodesicGaussian(point, 12, 24);
    const target: FunctionalTargetMap = {
      target: { id: 'test-point', label: 'Test point', aliases: [], peakRegions: [] },
      vertexCount: 25_000,
      ...gaussian,
      provenance: {
        sourceKind: 'mni-point', sourceSpace: 'MNI152NLin6Asym', targetSpace: 'MNI152NLin6Asym',
        targetSurface: 'Cedalion-ICBM152-25k', statistic: 'geodesic Gaussian', mapSha256: 'a'.repeat(64),
      },
    };
    const request = { target, seed: 'determinism-fixture', patches: [{}] };
    const first = planLayouts(loaded.headModel, request);
    const second = planLayouts(loaded.headModel, request);

    expect(first.candidates).toHaveLength(3);
    expect(first.candidates.map((candidate) => candidate.summary)).toEqual(second.candidates.map((candidate) => candidate.summary));
    expect(first.recommendedCandidateId).toBe(second.recommendedCandidateId);
    expect(first.candidates[0]!.layouts[0]!.optodes).toHaveLength(15);
    expect(first.candidates[0]!.layouts[0]!.pairs).toHaveLength(22);

    const multi = planLayouts(loaded.headModel, {
      target,
      seed: 'multi-patch-fixture',
      patches: [{ name: 'Anterior' }, { name: 'Posterior', reverseSourceDetector: true }],
    });
    expect(multi.candidates).toHaveLength(3);
    expect(multi.candidates.some((candidate) => candidate.summary.accepted)).toBe(true);
    for (const candidate of multi.candidates.filter((item) => item.summary.accepted)) {
      expect(candidate.instances).toHaveLength(2);
      expect(candidate.instances[0]!.id).not.toBe(candidate.instances[1]!.id);
      expect(candidate.summary.metrics.minimumOptodeClearanceMm).toBeGreaterThanOrEqual(12);
    }
  }, 180_000);

  it('fails closed when a required asset hash is wrong', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cortexlume-assets-'));
    await writeFile(path.join(root, 'invalid.bin'), 'not a locked asset');
    const files = Object.fromEntries([
      'scalpGlb', 'brainScientificGlb', 'brainVertexCoordinates', 'brainVertexAreas',
      'harvardOxfordIndex', 'harvardOxfordSurface25k', 'plannerSurfaceAssets',
    ].map((key) => [key, { path: 'invalid.bin', sha256: '0'.repeat(64) }]));
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify({
      verified: true, atlasGate: { passed: true }, correspondenceGate: { passed: true }, scienceGate: { passed: true }, files,
    }));
    await expect(loadHeadModelFromAssets(root)).rejects.toThrow('Asset hash mismatch');
  });
});
