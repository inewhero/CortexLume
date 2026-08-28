export interface TransmissionDepthActions {
  setDefaultDepth(depthMm: number): void;
  setPairDepthOverride(instanceId: string, pairId: string, depthMm: number): void;
}

/** Route the slider to the selected channel, or to the project default otherwise. */
export function updateTransmissionDepth(
  instanceId: string | null,
  pairId: string | null,
  depthMm: number,
  actions: TransmissionDepthActions,
): void {
  if (instanceId && pairId) actions.setPairDepthOverride(instanceId, pairId, depthMm);
  else actions.setDefaultDepth(depthMm);
}
