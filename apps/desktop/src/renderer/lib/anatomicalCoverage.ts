import type {
  AnatomicalCoverageAnalysis,
  AnatomicalCoverageRequest,
  AnatomicalCoverageSettings,
  CortexLumeProject,
} from '@cortexlume/contracts';
import { channelSensitivityPath, fittedOptodePositions } from './geometry';

export const DEFAULT_ANATOMICAL_COVERAGE_SETTINGS: AnatomicalCoverageSettings = {
  kernelSigmaMm: 12,
  supportRadiusMm: 24,
  minimumAtlasMembership: 0.05,
};

export type AnatomicalCoverageDisplayLayer = 'grayMatter' | null;

/** Anatomical atlas coverage always belongs to the cortical (pial/GM) surface. */
export function anatomicalCoverageDisplayLayer(
  grayMatterVisible: boolean,
  whiteMatterVisible: boolean,
): AnatomicalCoverageDisplayLayer {
  return grayMatterVisible || whiteMatterVisible ? 'grayMatter' : null;
}

export function buildAnatomicalCoverageRequest(
  project: CortexLumeProject,
  settings: AnatomicalCoverageSettings = DEFAULT_ANATOMICAL_COVERAGE_SETTINGS,
): AnatomicalCoverageRequest | null {
  const radiusMm = project.projectionSettings.optodeRadiusMm ?? 3.6;
  const defaultDepthMm = project.projectionSettings.defaultDepthMm ?? 25;
  const channels = project.instances
    .filter((instance) => instance.visible !== false)
    .flatMap((instance) => {
      const layout = project.layouts.find((candidate) => candidate.id === instance.definitionId);
      if (!layout) return [];
      const positions = fittedOptodePositions(layout, instance);
      return layout.pairs.flatMap((pair) => {
        const source = positions.get(pair.sourceId);
        const detector = positions.get(pair.detectorId);
        if (!source || !detector) return [];
        const transmissionDepthMm = project.projectionSettings.pairDepthOverridesMm[pair.id]
          ?? defaultDepthMm;
        return [{
          instanceId: instance.id,
          pairId: pair.id,
          ...(pair.channelNumber == null ? {} : { channelNumber: pair.channelNumber }),
          pointsRasMm: channelSensitivityPath(
            source,
            detector,
            radiusMm,
            transmissionDepthMm,
          ).points,
        }];
      });
    })
    .sort((left, right) => `${left.instanceId}:${left.pairId}`.localeCompare(`${right.instanceId}:${right.pairId}`));
  return channels.length > 0 ? { channels, settings } : null;
}

export function anatomicalCoverageRequestKey(request: AnatomicalCoverageRequest): string {
  return JSON.stringify(request);
}

const resultCache = new Map<string, Promise<AnatomicalCoverageAnalysis>>();

export function requestAnatomicalCoverage(
  request: AnatomicalCoverageRequest,
  analyze: (request: AnatomicalCoverageRequest) => Promise<AnatomicalCoverageAnalysis>,
): Promise<AnatomicalCoverageAnalysis> {
  const key = anatomicalCoverageRequestKey(request);
  const cached = resultCache.get(key);
  if (cached) return cached;
  const pending = Promise.resolve().then(() => analyze(request)).catch((error) => {
    resultCache.delete(key);
    throw error;
  });
  resultCache.set(key, pending);
  if (resultCache.size > 12) resultCache.delete(resultCache.keys().next().value!);
  return pending;
}

export function clearAnatomicalCoverageCache(): void {
  resultCache.clear();
}

const REGION_PALETTE = [
  '#4477aa', '#ee6677', '#228833', '#cc9f00',
  '#36a9c9', '#aa3377', '#e87539', '#6f4eaf',
] as const;

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function anatomicalRegionColor(atlasId: string, labelEn: string): string {
  return REGION_PALETTE[stableHash(`${atlasId}\u0000${labelEn}`) % REGION_PALETTE.length]!;
}

/** Assign the visible mosaic regions distinct colors while preserving a stable preferred hue. */
export function anatomicalCoverageRegionColors(
  analysis: Pick<AnatomicalCoverageAnalysis, 'regions'>,
): Map<number, string> {
  const colors = new Map<number, string>();
  const usedSlots = new Set<number>();
  for (const region of analysis.regions) {
    const preferredSlot = stableHash(`${region.atlasId}\u0000${region.labelEn}`) % REGION_PALETTE.length;
    let slot = preferredSlot;
    if (usedSlots.size < REGION_PALETTE.length) {
      for (let offset = 0; offset < REGION_PALETTE.length; offset += 1) {
        const candidate = (preferredSlot + offset) % REGION_PALETTE.length;
        if (!usedSlots.has(candidate)) {
          slot = candidate;
          break;
        }
      }
      usedSlots.add(slot);
    }
    colors.set(region.regionIndex, REGION_PALETTE[slot]!);
  }
  return colors;
}

export interface ScientificCoverageAttributes {
  geometricWeights: Float32Array;
  weights: Float32Array;
  colors: Float32Array;
  regionIndices: Int16Array;
}

export const MAX_MOSAIC_REGIONS = 8;

export function scientificCoverageAttributes(
  analysis: AnatomicalCoverageAnalysis,
  selectedRegionIndex: number | null,
): ScientificCoverageAttributes {
  const geometricWeights = new Float32Array(analysis.vertexCount);
  const weights = new Float32Array(analysis.vertexCount);
  const colors = new Float32Array(analysis.vertexCount * 3);
  const regionIndices = new Int16Array(analysis.vertexCount);
  regionIndices.fill(-1);
  const regionColors = anatomicalCoverageRegionColors(analysis);
  for (let sparseIndex = 0; sparseIndex < analysis.mosaic.geometricVertexIndices.length; sparseIndex += 1) {
    geometricWeights[analysis.mosaic.geometricVertexIndices[sparseIndex]!] = analysis.mosaic.geometricCoverageWeights[sparseIndex]!;
  }
  for (let sparseIndex = 0; sparseIndex < analysis.mosaic.vertexIndices.length; sparseIndex += 1) {
    const regionIndex = analysis.mosaic.regionIndices[sparseIndex]!;
    const vertexIndex = analysis.mosaic.vertexIndices[sparseIndex]!;
    if (selectedRegionIndex != null ? regionIndex !== selectedRegionIndex : regionIndex >= MAX_MOSAIC_REGIONS) {
      geometricWeights[vertexIndex] = 0;
      continue;
    }
    weights[vertexIndex] = analysis.mosaic.opacityWeights[sparseIndex]!;
    const region = analysis.regions[regionIndex];
    if (!region) continue;
    regionIndices[vertexIndex] = regionIndex;
    const color = Number.parseInt((regionColors.get(regionIndex) ?? anatomicalRegionColor(region.atlasId, region.labelEn)).slice(1), 16);
    colors[vertexIndex * 3] = ((color >> 16) & 255) / 255;
    colors[vertexIndex * 3 + 1] = ((color >> 8) & 255) / 255;
    colors[vertexIndex * 3 + 2] = (color & 255) / 255;
  }
  if (selectedRegionIndex != null) geometricWeights.set(weights);
  return { geometricWeights, weights, colors, regionIndices };
}
