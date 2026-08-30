import { describe, expect, it } from 'vitest';
import { useProjectStore } from '../store/projectStore';
import { buildScientificScreenshotMetadata } from './sceneScreenshotMetadata';

describe('scientific screenshot metadata', () => {
  it('records resolved visibility rather than generic layer names', () => {
    useProjectStore.getState().newProject();
    const state = useProjectStore.getState();
    const metadata = buildScientificScreenshotMetadata({
      project: state.project,
      anatomyVisibility: { ...state.anatomyVisibility, grayMatter: false, channelLabels: true },
      anatomyAppearance: state.anatomyAppearance,
      functionalTarget: state.functionalTarget,
      anatomicalCoverageEnabled: true,
      anatomicalCoverageMode: 'region',
      anatomicalCoverageStatus: 'loading',
      selectedCoverageRegionIndex: 4,
    });
    expect(metadata).toMatchObject({
      encoding: 'rgba8-lossless-png', quantized: false, transparent: true,
      anatomy: { grayMatter: false, channelLabels: true },
      anatomicalCoverage: { enabled: true, mode: 'region', status: 'loading', selectedRegionIndex: 4 },
      visibleInstanceIds: [],
    });
  });
});
