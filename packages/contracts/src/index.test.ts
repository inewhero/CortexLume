import { describe, expect, it } from 'vitest';
import {
  BidsSettingsSchema,
  AnatomicalCoverageAnalysisSchema,
  ANATOMICAL_COVERAGE_LIMITS,
  AnatomicalCoverageRequestSchema,
  DeviceProfileSchema,
  FunctionalTargetMapSchema,
  LayoutDefinitionSchema,
  ProjectionSettingsSchema,
} from './index';

function budgetChannel(index: number, pointCount = 2, coordinate?: number) {
  const id = (offset: number) => `00000000-0000-4000-8000-${(offset + index).toString(16).padStart(12, '0')}`;
  return {
    instanceId: id(10_000),
    pairId: id(20_000),
    pointsRasMm: Array.from({ length: pointCount }, (_, point) => (
      coordinate === undefined ? [point, 0, 0] : [coordinate, coordinate, coordinate]
    )),
  };
}

describe('LayoutDefinitionSchema', () => {
  it('rejects non-UUID optode identifiers', () => {
    const parsed = LayoutDefinitionSchema.safeParse({
      id: crypto.randomUUID(),
      version: 1,
      name: 'test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      gridSpacingMm: 5,
      optodes: [{ id: 'S1', label: 'S1', type: 'source', uvMm: [0, 0] }],
      pairs: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('migrates legacy projection modes to scalp and cortex', () => {
    expect(ProjectionSettingsSchema.parse({ mode: 'surface' }).mode).toBe('scalp');
    expect(ProjectionSettingsSchema.parse({ mode: 'anatomical_depth' }).mode).toBe('cortex');
    expect(ProjectionSettingsSchema.parse({ mode: 'scalp' }).optodeRadiusMm).toBe(3.6);
  });

  it('provides a Shimadzu LABNIRS BIDS profile by default', () => {
    expect(DeviceProfileSchema.parse({})).toMatchObject({
      manufacturer: 'Shimadzu',
      model: 'LABNIRS',
      wavelengthsNm: [780, 805, 830],
      measurementType: 'NIRSCWAMPLITUDE',
      units: 'V',
      sourceType: 'LASER',
      detectorType: 'PMT',
    });
    expect(DeviceProfileSchema.parse({ measurementType: 'CW_AMPLITUDE' }).measurementType)
      .toBe('NIRSCWAMPLITUDE');
    expect(DeviceProfileSchema.parse({ wavelengthsNm: [] }).wavelengthsNm)
      .toEqual([780, 805, 830]);
    expect(BidsSettingsSchema.parse({})).toMatchObject({
      subjectLabel: '01',
      taskLabel: 'layout',
    });
  });

  it('accepts only ordered finite positive values on the locked 25k target surface', () => {
    const base = {
      target: { id: 'memory', label: 'Memory' },
      vertexCount: 25_000,
      vertexIndices: [4, 17],
      values: [2.1, 4.8],
      provenance: {
        sourceKind: 'neurosynth-quick',
        sourceSpace: 'MNI152',
        targetSpace: 'MNI152NLin6Asym',
        targetSurface: 'Cedalion-ICBM152-25k',
        statistic: 'association-test z',
        mapSha256: 'fixture',
      },
    };
    expect(FunctionalTargetMapSchema.parse(base).vertexIndices).toEqual([4, 17]);
    expect(FunctionalTargetMapSchema.safeParse({ ...base, vertexIndices: [17, 4] }).success).toBe(false);
    expect(FunctionalTargetMapSchema.safeParse({ ...base, values: [2.1, Number.NaN] }).success).toBe(false);
  });

  it('validates a sparse anatomical coverage mosaic without sensitivity claims', () => {
    const instanceId = crypto.randomUUID();
    const pairId = crypto.randomUUID();
    const request = AnatomicalCoverageRequestSchema.parse({
      channels: [{ instanceId, pairId, pointsRasMm: [[0, 0, 0], [1, 0, 0]] }],
    });
    expect(request.settings).toEqual({
      kernelSigmaMm: 12,
      supportRadiusMm: 24,
      minimumAtlasMembership: 0.05,
    });

    const stableId = `${instanceId}:${pairId}`;
    const base = {
      version: 1,
      sourceKind: 'geometric-anatomical-coverage-prior',
      targetSurface: 'Cedalion-ICBM152-25k',
      vertexCount: 25_000,
      channels: [{
        stableId, instanceId, pairId, pathPointCount: 2, pathLengthMm: 1,
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
        geometricVertexIndices: [4, 17],
        geometricCoverageWeights: [0.8, 0.4],
        vertexIndices: [4, 17],
        coverageWeights: [0.8, 0.4],
        opacityWeights: [0.56, 0.24],
        regionIndices: [0, 0],
        atlasMemberships: [0.7, 0.6],
        dominantChannelIndices: [0, 0],
      },
      regions: [{
        regionIndex: 0,
        atlasId: 'HOCPAL@fixture',
        labelEn: 'Precentral Gyrus',
        colorHex: '#C45A67',
        coveredAtlasMassFraction: 1,
        weightedAtlasMass: 0.8,
        dominantVertexCount: 2,
        channelShares: [{ channelIndex: 0, stableId, geometricShare: 1 }],
      }],
      qc: {
        geometricCoveredVertexCount: 2,
        atlasLabeledVertexCount: 2,
        unlabeledCoveredVertexCount: 0,
        atlasSupportFraction: 0.65,
        flags: [],
      },
      provenance: {
        templateAssetVersion: 'fixture',
        coordinateConvention: 'RAS+',
        units: 'mm',
        surfaceVertexCoordinatesSha256: 'b'.repeat(64),
        surfaceMeshSha256: 'c'.repeat(64),
        atlasId: 'HOCPAL@fixture',
        atlasIndexSha256: 'd'.repeat(64),
        atlasSampling: 'nearest-voxel-top3-original-membership',
        interpretation: 'Geometric anatomical coverage prior; not photon sensitivity, fluence, or Jacobian.',
      },
    };
    const parsed = AnatomicalCoverageAnalysisSchema.parse(base);
    expect(parsed.mosaic.vertexIndices).toEqual([4, 17]);
    expect(parsed.mosaic.geometricVertexIndices).toEqual([4, 17]);
    expect(parsed.provenance.interpretation).not.toContain('probability mesh');
    expect(AnatomicalCoverageAnalysisSchema.safeParse({
      ...base,
      mosaic: { ...base.mosaic, coverageWeights: [0.8] },
    }).success).toBe(false);
    expect(AnatomicalCoverageAnalysisSchema.safeParse({
      ...base,
      mosaic: {
        ...base.mosaic,
        geometricVertexIndices: [4],
        geometricCoverageWeights: [0.8],
      },
    }).success).toBe(false);
  });

  it('enforces anatomical coverage channel, point and segment budgets at boundaries', () => {
    const limits = ANATOMICAL_COVERAGE_LIMITS;
    expect(AnatomicalCoverageRequestSchema.safeParse({ channels: [budgetChannel(1)] }).success).toBe(true);
    expect(AnatomicalCoverageRequestSchema.safeParse({
      channels: Array.from({ length: limits.maximumChannels }, (_, index) => budgetChannel(index)),
    }).success).toBe(true);

    const tooManyChannels = AnatomicalCoverageRequestSchema.safeParse({
      channels: Array.from({ length: limits.maximumChannels + 1 }, (_, index) => budgetChannel(index)),
    });
    expect(tooManyChannels.success).toBe(false);
    if (!tooManyChannels.success) {
      expect(tooManyChannels.error.issues.map((issue) => issue.message)).toContain(
        'coverage_request_limit_exceeded:maximumChannels:129:128',
      );
    }

    const maximumPointCounts = Array.from({ length: limits.maximumChannels }, () => (
      limits.maximumTotalPathPoints / limits.maximumChannels
    ));
    expect(maximumPointCounts.every(Number.isInteger)).toBe(true);
    const maximumPoints = {
      channels: maximumPointCounts.map((pointCount, index) => budgetChannel(index, pointCount)),
    };
    expect(AnatomicalCoverageRequestSchema.safeParse(maximumPoints).success).toBe(true);
    const tooManyPoints = {
      channels: maximumPointCounts.map((pointCount, index) => budgetChannel(index, pointCount + (index === 0 ? 1 : 0))),
    };
    const tooManyPointsResult = AnatomicalCoverageRequestSchema.safeParse(tooManyPoints);
    expect(tooManyPointsResult.success).toBe(false);
    if (!tooManyPointsResult.success) {
      expect(tooManyPointsResult.error.issues.some((issue) => issue.message.startsWith(
        'coverage_request_limit_exceeded:maximumTotalPathPoints:',
      ))).toBe(true);
    }

    const maximumSegments = {
      channels: Array.from({ length: limits.maximumChannels }, (_, index) => budgetChannel(index, 125)),
    };
    expect(AnatomicalCoverageRequestSchema.safeParse(maximumSegments).success).toBe(true);
    const segmentPlusOne = {
      channels: [
        ...Array.from({ length: 124 }, (_, index) => budgetChannel(index, 129)),
        budgetChannel(124, 2),
      ],
    };
    const segmentPlusOneResult = AnatomicalCoverageRequestSchema.safeParse(segmentPlusOne);
    expect(segmentPlusOneResult.success).toBe(false);
    if (!segmentPlusOneResult.success) {
      expect(segmentPlusOneResult.error.issues.some((issue) => issue.message.startsWith(
        'coverage_request_limit_exceeded:maximumTotalSegments:',
      ))).toBe(true);
    }

    // High-precision coordinates exercise the independent UTF-8 serialized
    // request budget without exceeding the point/segment budgets above.
    const ordinaryNumbers = AnatomicalCoverageRequestSchema.safeParse(maximumSegments);
    expect(ordinaryNumbers.success).toBe(true);
    const byteHeavy = AnatomicalCoverageRequestSchema.safeParse({
      channels: Array.from(
        { length: limits.maximumChannels },
        (_, index) => budgetChannel(index, 125, -1.2345678901234567e-123),
      ),
    });
    expect(byteHeavy.success).toBe(false);
    if (!byteHeavy.success) {
      expect(byteHeavy.error.issues.some((issue) => issue.message.startsWith(
        'coverage_request_limit_exceeded:maximumSerializedRequestBytes:',
      ))).toBe(true);
    }
  });
});
