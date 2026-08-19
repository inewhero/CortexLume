import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnatomicalCoverageAnalysis } from '@cortexlume/contracts';
import { useProjectStore } from '../store/projectStore';
import {
  anatomicalCoverageRegionColors,
  anatomicalRegionColor,
  anatomicalCoverageDisplayLayer,
  buildAnatomicalCoverageRequest,
  clearAnatomicalCoverageCache,
  requestAnatomicalCoverage,
  scientificCoverageAttributes,
} from './anatomicalCoverage';

const analysis: AnatomicalCoverageAnalysis = {
  version: 1,
  sourceKind: 'geometric-anatomical-coverage-prior',
  targetSurface: 'Cedalion-ICBM152-25k',
  vertexCount: 25_000,
  channels: [{
    stableId: '42a7f8ca-5c2c-4db7-a5ad-1e8ea8ad4137:de4e021c-88fc-4cef-b060-0961c0e0e006',
    instanceId: '42a7f8ca-5c2c-4db7-a5ad-1e8ea8ad4137',
    pairId: 'de4e021c-88fc-4cef-b060-0961c0e0e006',
    channelNumber: 1,
    pathPointCount: 33,
    pathLengthMm: 54,
    pathSha256: 'a'.repeat(64),
  }],
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
    geometricVertexIndices: [2, 5, 7],
    geometricCoverageWeights: [0.8, 0.6, 0.5],
    vertexIndices: [2, 7],
    coverageWeights: [0.8, 0.5],
    atlasMemberships: [0.5, 0.8],
    opacityWeights: [0.4, 0.4],
    regionIndices: [0, 1],
    dominantChannelIndices: [0, 0],
  },
  regions: [
    { regionIndex: 0, atlasId: 'HO', labelEn: 'Region A', colorHex: '#112233', coveredAtlasMassFraction: 0.7, weightedAtlasMass: 7, dominantVertexCount: 1, channelShares: [{ channelIndex: 0, stableId: '42a7f8ca-5c2c-4db7-a5ad-1e8ea8ad4137:de4e021c-88fc-4cef-b060-0961c0e0e006', geometricShare: 1 }] },
    { regionIndex: 1, atlasId: 'HO', labelEn: 'Region B', colorHex: '#AABBCC', coveredAtlasMassFraction: 0.3, weightedAtlasMass: 3, dominantVertexCount: 1, channelShares: [{ channelIndex: 0, stableId: '42a7f8ca-5c2c-4db7-a5ad-1e8ea8ad4137:de4e021c-88fc-4cef-b060-0961c0e0e006', geometricShare: 1 }] },
  ],
  qc: { geometricCoveredVertexCount: 3, atlasLabeledVertexCount: 2, unlabeledCoveredVertexCount: 1, atlasSupportFraction: 1, flags: ['partial_harvard_oxford_support'] },
  provenance: {
    templateAssetVersion: 'fixture', coordinateConvention: 'RAS+', units: 'mm',
    surfaceVertexCoordinatesSha256: 'b'.repeat(64), surfaceMeshSha256: 'c'.repeat(64),
    atlasId: 'HO', atlasIndexSha256: 'd'.repeat(64),
    atlasSampling: 'nearest-voxel-top3-original-membership',
    interpretation: 'Geometric anatomical coverage prior; not photon sensitivity, fluence, or Jacobian.',
  },
};

describe('anatomical coverage renderer data', () => {
  beforeEach(() => clearAnatomicalCoverageCache());

  it('keeps coverage on its cortical surface when only WM anatomy is visible', () => {
    expect(anatomicalCoverageDisplayLayer(true, true)).toBe('grayMatter');
    expect(anatomicalCoverageDisplayLayer(false, true)).toBe('grayMatter');
    expect(anatomicalCoverageDisplayLayer(false, false)).toBeNull();
  });

  it('builds stable paths for every channel in visible patches only', () => {
    useProjectStore.getState().newProject();
    const layoutId = useProjectStore.getState().activeLayoutId;
    useProjectStore.getState().placeLayout(layoutId);
    const request = buildAnatomicalCoverageRequest(useProjectStore.getState().project);
    expect(request?.channels).toHaveLength(22);
    expect(request?.channels.every((channel) => channel.pointsRasMm.length === 33)).toBe(true);
    const instanceId = useProjectStore.getState().project.instances[0]!.id;
    useProjectStore.getState().toggleInstanceVisibility(instanceId);
    expect(buildAnatomicalCoverageRequest(useProjectStore.getState().project)).toBeNull();
  });

  it('keeps atlas region colors stable independently of rank', () => {
    expect(anatomicalRegionColor('HO', 'Left frontal pole')).toBe(anatomicalRegionColor('HO', 'Left frontal pole'));
    expect(anatomicalRegionColor('HO', 'Left frontal pole')).not.toBe(anatomicalRegionColor('HO', 'Right occipital pole'));
  });

  it('gives the eight visible mosaic regions distinct categorical colors', () => {
    const expanded = {
      ...analysis,
      regions: Array.from({ length: 8 }, (_, regionIndex) => ({
        ...analysis.regions[0]!,
        regionIndex,
        labelEn: `Region ${regionIndex}`,
      })),
    } satisfies AnatomicalCoverageAnalysis;
    expect(new Set(anatomicalCoverageRegionColors(expanded).values()).size).toBe(8);
  });

  it('expands the sparse mosaic and isolates one region without boundary interpolation', () => {
    const mosaic = scientificCoverageAttributes(analysis, null);
    expect(mosaic.geometricWeights[5]).toBeCloseTo(0.6);
    expect(mosaic.weights[2]).toBeCloseTo(0.4);
    const stableColor = Number.parseInt(anatomicalRegionColor('HO', 'Region A').slice(1), 16);
    expect(mosaic.colors[6]).toBeCloseTo(((stableColor >> 16) & 255) / 255);
    expect(mosaic.colors[7]).toBeCloseTo(((stableColor >> 8) & 255) / 255);
    expect(mosaic.colors[8]).toBeCloseTo((stableColor & 255) / 255);
    const selected = scientificCoverageAttributes(analysis, 1);
    expect(selected.weights[2]).toBe(0);
    expect(selected.weights[7]).toBeCloseTo(0.4);
    expect(selected.geometricWeights[2]).toBe(0);
    expect(selected.geometricWeights[7]).toBeCloseTo(0.4);
    expect(selected.regionIndices[2]).toBe(-1);
    expect(selected.regionIndices[7]).toBe(1);
  });

  it('deduplicates identical analysis requests', async () => {
    const request = {
      channels: [{
        instanceId: analysis.channels[0]!.instanceId,
        pairId: analysis.channels[0]!.pairId,
        channelNumber: 1,
        pointsRasMm: [[0, 0, 0], [1, 1, 1]] as [[number, number, number], [number, number, number]],
      }],
      settings: { kernelSigmaMm: 12, supportRadiusMm: 24, minimumAtlasMembership: 0.05 },
    };
    const analyze = vi.fn().mockResolvedValue(analysis);
    await Promise.all([
      requestAnatomicalCoverage(request, analyze),
      requestAnatomicalCoverage(request, analyze),
    ]);
    expect(analyze).toHaveBeenCalledOnce();
  });

  it('converts a synchronous analysis bridge failure into a rejected promise', async () => {
    const request = {
      channels: [{
        instanceId: analysis.channels[0]!.instanceId,
        pairId: analysis.channels[0]!.pairId,
        pointsRasMm: [[0, 0, 0], [1, 1, 1]] as [[number, number, number], [number, number, number]],
      }],
      settings: { kernelSigmaMm: 12, supportRadiusMm: 24, minimumAtlasMembership: 0.05 },
    };
    await expect(requestAnatomicalCoverage(request, () => {
      throw new Error('Science bridge unavailable.');
    })).rejects.toThrow('Science bridge unavailable.');
  });
});
