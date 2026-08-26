import type { FitPlacementRequest } from '@cortexlume/contracts';

/** Strict DTO accepted by the Python science service. */
export function fitPlacementWireRequest(request: FitPlacementRequest) {
  const { instance } = request;
  return {
    interactionId: request.interactionId,
    projectRevision: request.projectRevision,
    template: request.template,
    layout: request.layout,
    instance: {
      id: instance.id,
      definitionId: instance.definitionId,
      anchorRasMm: instance.anchorRasMm,
      rotationRad: instance.rotationRad,
      mappingRotationRad: instance.mappingRotationRad,
      visible: instance.visible,
      locked: instance.locked,
      overrides: instance.overrides,
      ...(instance.fitQc ? { fitQc: instance.fitQc } : {}),
    },
  };
}
