import { describe, expect, it } from 'vitest';
import { FitPlacementRequestSchema } from '@cortexlume/contracts';
import { useProjectStore } from '../renderer/store/projectStore';
import { fitPlacementWireRequest } from './fitPlacementWire';

describe('fit placement science wire DTO', () => {
  it('drops desktop-only instance fields from a real renderer placement', () => {
    useProjectStore.getState().newProject();
    useProjectStore.getState().placeLayout(useProjectStore.getState().activeLayoutId);
    const project = structuredClone(useProjectStore.getState().project);
    const instance = project.instances[0]!;
    instance.derivedFromInstanceId = instance.id;
    instance.digitizerSessionId = crypto.randomUUID();
    instance.digitizerPositions = [{
      optodeId: project.layouts[0]!.optodes[0]!.id,
      digitizerPointId: crypto.randomUUID(),
      scalpRasMm: [1, 2, 3],
    }];
    const request = FitPlacementRequestSchema.parse({
      interactionId: 'wire-test', projectRevision: 1, template: project.template,
      layout: project.layouts[0], instance,
    });

    expect(Object.keys(fitPlacementWireRequest(request).instance).sort()).toEqual([
      'anchorRasMm', 'definitionId', 'id', 'locked', 'mappingRotationRad',
      'overrides', 'rotationRad', 'visible',
    ]);
  });
});
