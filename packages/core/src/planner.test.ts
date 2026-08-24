import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FunctionalTargetMap, Vec3 } from '@cortexlume/contracts';
import { distance3 } from './geometry.js';
import { createGridLayout } from './layout.js';
import { loadHeadModelFromAssets } from './nodeAssets.js';
import { planLayouts, summarizeTargetSurfaceComponents } from './planner.js';

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
    expect(first.candidates.every((candidate) => (
      candidate.summary.metrics.targetSupportSpecificity != null
      && candidate.summary.metrics.balancedTargetCoverage != null
      && candidate.summary.metrics.cranialOptodeFraction === 1
      && candidate.summary.metrics.cranialRobustPassFraction != null
      && candidate.summary.metrics.maximumScalpCortexGapMm! <= 40
    ))).toBe(true);
    const components = summarizeTargetSurfaceComponents(loaded.headModel, target);
    expect(components.length).toBeGreaterThan(0);
    expect(components.reduce((sum, component) => sum + component.massFraction, 0)).toBeCloseTo(1, 6);

    const leftVisual = loaded.headModel.geodesicGaussian([-24, -88, 12], 18, 36);
    const rightVisual = loaded.headModel.geodesicGaussian([24, -88, 12], 18, 36);
    const bilateralValues = new Map<number, number>();
    leftVisual.vertexIndices.forEach((vertex, index) => bilateralValues.set(vertex, leftVisual.values[index]!));
    rightVisual.vertexIndices.forEach((vertex, index) => bilateralValues.set(
      vertex,
      Math.max(bilateralValues.get(vertex) ?? 0, rightVisual.values[index]!),
    ));
    const bilateralVertices = [...bilateralValues.keys()].sort((left, right) => left - right);
    const bilateralTarget: FunctionalTargetMap = {
      target: { id: 'bilateral-visual', label: 'Bilateral visual', aliases: [], peakRegions: [] },
      vertexCount: 25_000,
      vertexIndices: bilateralVertices,
      values: bilateralVertices.map((vertex) => bilateralValues.get(vertex)!),
      provenance: {
        sourceKind: 'mni-point', sourceSpace: 'MNI152NLin6Asym', targetSpace: 'MNI152NLin6Asym',
        targetSurface: 'Cedalion-ICBM152-25k', statistic: 'bilateral geodesic Gaussian', mapSha256: 'b'.repeat(64),
      },
    };
    const bilateral = planLayouts(loaded.headModel, {
      target: bilateralTarget,
      seed: 'bilateral-visual-fixture',
      patches: [{ columns: 5, rows: 3, pitchMm: 30 }],
    });
    for (let left = 0; left < bilateral.candidates.length; left += 1) {
      for (let right = left + 1; right < bilateral.candidates.length; right += 1) {
        expect(distance3(
          bilateral.candidates[left]!.instances[0]!.anchorRasMm,
          bilateral.candidates[right]!.instances[0]!.anchorRasMm,
        )).toBeGreaterThanOrEqual(40);
      }
    }
    const bilateralCandidate = bilateral.candidates[0]!;
    const bilateralAnchor = bilateralCandidate.instances[0]!.anchorRasMm;
    expect(Math.abs(bilateralAnchor[0])).toBeLessThan(20);
    expect(bilateralAnchor[1]).toBeLessThan(-90);
    const fittedBilateralPositions = loaded.headModel.fittedOptodePositions(
      bilateralCandidate.layouts[0]!,
      bilateralCandidate.instances[0]!,
    );
    const bilateralPositions = bilateralCandidate.layouts[0]!.optodes.map((optode) => ({
      uv: optode.uvMm,
      point: fittedBilateralPositions.get(optode.id)!,
    }));
    const leftColumn = bilateralPositions.filter(({ uv }) => uv[0] === Math.min(...bilateralPositions.map((item) => item.uv[0])));
    const rightColumn = bilateralPositions.filter(({ uv }) => uv[0] === Math.max(...bilateralPositions.map((item) => item.uv[0])));
    const mean = (points: typeof bilateralPositions) => points.reduce<Vec3>((sum, item) => (
      [sum[0] + item.point[0], sum[1] + item.point[1], sum[2] + item.point[2]]
    ), [0, 0, 0]).map((value) => value / points.length) as Vec3;
    const leftMean = mean(leftColumn);
    const rightMean = mean(rightColumn);
    expect(Math.abs(rightMean[0] - leftMean[0])).toBeGreaterThan(Math.abs(rightMean[2] - leftMean[2]));

    const longLayout = createGridLayout({ columns: 8, rows: 3, pitchMm: 30 }, 'long-strip-fixture', '2000-01-01T00:00:00.000Z');
    for (const [anchorRasMm, rotationRad] of (
      [[-55, -8, 70], [-53, 16, 68]] as [number, number, number][]
    ).flatMap((anchor) => [0, Math.PI / 4, Math.PI / 2].map((rotation) => [anchor, rotation] as const))) {
      const longInstance = {
        id: 'long-strip-instance', definitionId: longLayout.id,
        anchorRasMm, rotationRad, mappingRotationRad: 0,
        visible: true, locked: true, overrides: [], digitizerPositions: [],
        derivedFromInstanceId: null, digitizerSessionId: null,
      };
      const longPositions = loaded.headModel.fittedOptodePositions(longLayout, longInstance);
      const realizedDistances = longLayout.pairs.map((pair) => distance3(longPositions.get(pair.sourceId)!, longPositions.get(pair.detectorId)!));
      expect(Math.min(...realizedDistances)).toBeGreaterThan(22);
      expect(Math.max(...realizedDistances)).toBeLessThan(36);
    }

    const multi = planLayouts(loaded.headModel, {
      target,
      seed: 'multi-patch-fixture',
      patches: [
        { name: 'Anterior', columns: 3, rows: 3 },
        { name: 'Posterior', columns: 3, rows: 3, reverseSourceDetector: true },
      ],
    });
    expect(multi.candidates).toHaveLength(3);
    expect(multi.candidates.some((candidate) => candidate.summary.accepted)).toBe(true);
    expect(new Set(multi.candidates.map((candidate) => candidate.instances
      .map((instance) => instance.anchorRasMm.map((value) => value.toFixed(3)).join(','))
      .sort()
      .join('|'))).size).toBe(3);
    for (const candidate of multi.candidates.filter((item) => item.summary.accepted)) {
      expect(candidate.instances).toHaveLength(2);
      expect(candidate.instances[0]!.id).not.toBe(candidate.instances[1]!.id);
      expect(candidate.summary.metrics.minimumOptodeClearanceMm).toBeGreaterThanOrEqual(12);
      expect(candidate.summary.metrics.cranialOptodeFraction).toBe(1);
      expect(candidate.summary.metrics.cranialRobustPassFraction).toBeGreaterThanOrEqual(0);
      expect(candidate.summary.metrics.maximumScalpCortexGapMm).toBeLessThanOrEqual(40);
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
