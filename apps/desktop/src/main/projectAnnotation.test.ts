import { describe, expect, it } from 'vitest';
import { materializeProjectionSnapshot } from '../renderer/lib/projectionSnapshot';
import { useProjectStore } from '../renderer/store/projectStore';
import { mergeProjectAtlasAnnotations, type PathAtlasAnnotation, type PointAtlasAnnotation } from './projectAnnotation';

describe('science project annotation merge', () => {
  it('uses full channel-path regions while retaining point annotations for optodes', () => {
    useProjectStore.getState().newProject();
    useProjectStore.getState().placeLayout(useProjectStore.getState().activeLayoutId);
    const project = materializeProjectionSnapshot(structuredClone(useProjectStore.getState().project));
    const optodeIndex = project.verifiedResults.findIndex((result) => result.subjectKind === 'optode');
    const channelIndex = project.verifiedResults.findIndex((result) => result.subjectKind === 'pair');
    const pointRegion = { atlasId: 'HarvardOxford-cort-maxprob-thr0-1mm', labelEn: 'Frontal Pole', probability: 0.7 };
    const pathRegion = { atlasId: 'HarvardOxford-cort-prob-1mm', labelEn: 'Precentral Gyrus', probability: 0.6 };
    const points = new Map<number, PointAtlasAnnotation>([
      [optodeIndex, { corticalRegions: [pointRegion], deepStructures: [] }],
      [channelIndex, { corticalRegions: [pointRegion], deepStructures: [] }],
    ]);
    const paths: Array<PathAtlasAnnotation | null> = project.verifiedResults.map(() => null);
    paths[channelIndex] = { corticalRegions: [pathRegion] };

    const annotated = mergeProjectAtlasAnnotations(project, points, paths, true, null);
    expect(annotated.verifiedResults[optodeIndex]!.underlyingCorticalRegions).toEqual([pointRegion]);
    expect(annotated.verifiedResults[channelIndex]!.underlyingCorticalRegions).toEqual([pathRegion]);
  });

  it('marks atlas lookup unavailable without introducing unrelated annotations', () => {
    useProjectStore.getState().newProject();
    const project = materializeProjectionSnapshot(structuredClone(useProjectStore.getState().project));
    const annotated = mergeProjectAtlasAnnotations(project, new Map(), [], false, 'atlas_unavailable');
    expect(annotated.verifiedResults.every((result) => result.qcFlags.includes('atlas_unavailable'))).toBe(true);
  });
});
