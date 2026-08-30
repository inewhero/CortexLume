import type { CortexLumeProject, FunctionalTargetMap } from '@cortexlume/contracts';
import type { AnatomyAppearance, AnatomyVisibility, AnatomicalCoverageMode, AnatomicalCoverageStatus } from '../store/projectStore';

export interface ScientificScreenshotMetadataSource {
  project: CortexLumeProject;
  anatomyVisibility: AnatomyVisibility;
  anatomyAppearance: AnatomyAppearance;
  functionalTarget: FunctionalTargetMap | null;
  anatomicalCoverageEnabled: boolean;
  anatomicalCoverageMode: AnatomicalCoverageMode;
  anatomicalCoverageStatus: AnatomicalCoverageStatus;
  selectedCoverageRegionIndex: number | null;
}

/** Pure, serializable layer metadata for GUI screenshots and capture workers. */
export function buildScientificScreenshotMetadata(source: ScientificScreenshotMetadataSource) {
  return {
    encoding: 'rgba8-lossless-png' as const,
    quantized: false as const,
    transparent: true as const,
    anatomy: structuredClone(source.anatomyVisibility),
    appearance: structuredClone(source.anatomyAppearance),
    surfaceOverlay: source.project.surfaceOverlay,
    functionalTarget: source.project.surfaceOverlay === 'functional-target' && source.functionalTarget
      ? { id: source.functionalTarget.target.id, label: source.functionalTarget.target.label }
      : null,
    anatomicalCoverage: {
      enabled: source.anatomicalCoverageEnabled,
      mode: source.anatomicalCoverageMode,
      status: source.anatomicalCoverageStatus,
      selectedRegionIndex: source.selectedCoverageRegionIndex,
    },
    visibleInstanceIds: source.project.instances.filter((instance) => instance.visible !== false).map((instance) => instance.id),
    visibleDigitizerSessionIds: source.project.digitizerSessions.filter((session) => session.visible).map((session) => session.id),
  };
}
