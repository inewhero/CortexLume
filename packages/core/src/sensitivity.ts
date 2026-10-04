import type { ChannelSensitivityKernel, Vec3 } from '@cortexlume/contracts';
import { add3, cross3, distance3, dot3, normalize3, scale3 } from './geometry.js';

/** Default 4-sigma cutoff at the historical 12 mm width setting. */
export const DEFAULT_ADAPTIVE_KERNEL_SUPPORT_RADIUS_MM = 48;

export interface ChannelSensitivityKernelOptions {
  /** Omission selects combined v2; v1 permits exact historical replay. */
  model?: 'sd-adaptive-geometric-v1' | 'sd-adaptive-geometric-v2';
  /** Historical width setting now scales the adaptive axes relative to 12 mm. */
  kernelSigmaMm?: number;
  /** Historical support setting controls the normalized ellipsoid cutoff. */
  supportRadiusMm?: number;
  /** Explicit physical depth from scalp; omission selects separation-driven depth. */
  transmissionDepthMm?: number | undefined;
  /** Upper limit for separation-driven automatic depth; does not cap overrides. */
  maximumDepthMm?: number;
}

/**
 * Versioned geometric approximation, not a photon-transport solution.
 * Separation is the chord between fitted/measured scalp contacts, excluding
 * optode rendering radii. A local closest cortex contact defines the depth
 * direction, preserving the local projection rule at midline/occipital gaps.
 * At 30 mm separation the unscaled tangential sigmas are 10.5 / 6 mm.
 * Larger anatomical gaps attenuate amplitude. V1 also narrows lateral support;
 * v2 removes that shrinkage and doubles the v1 depth sigma (capped at 500 mm).
 * Automatic depth is half separation, bounded to 2–40 mm; an explicit override
 * replaces this absolute scalp depth (bounded to 1–1000 mm for numeric safety).
 * The existing project depth setting caps automatic depth (including 1 mm).
 * For d = separation, g = gap, h = effectiveDepth and s = sigma / 12:
 * longitudinal sigma = clamp(0.35d, 3, 30) s;
 * v1 lateral sigma = clamp(0.20d, 2, 20) s / sqrt(1 + (g/h)^2);
 * v2 lateral sigma = clamp(0.20d, 2, 20) s;
 * v1 depth sigma = max(2, 0.5 sqrt(max(0, h^2 - g^2)));
 * v2 depth sigma = min(500, 2 * v1 depth sigma);
 * cortical amplitude = exp(-0.5 (g/h)^2). Tangential axes are finally bounded
 * to 1e-6–100 mm. Co-located endpoints use isotropic tangential support;
 * zero anatomical gap uses isotropic 3D support because no normal is defined.
 * Support is an ellipsoid at supportRadius/sigma (bounded 0.05–80 sigmas).
 */
export function createChannelSensitivityKernel(
  head: Pick<import('./headModel.js').HeadModel, 'projectScalp' | 'projectCorticalContact'>,
  sourceScalpPoint: Vec3,
  detectorScalpPoint: Vec3,
  options: ChannelSensitivityKernelOptions = {},
): ChannelSensitivityKernel {
  const sigma = options.kernelSigmaMm ?? 12;
  const model = options.model ?? 'sd-adaptive-geometric-v2';
  const support = options.supportRadiusMm ?? (model === 'sd-adaptive-geometric-v1' ? 24 : DEFAULT_ADAPTIVE_KERNEL_SUPPORT_RADIUS_MM);
  const explicitDepth = options.transmissionDepthMm;
  const maximumDepth = options.maximumDepthMm ?? 40;
  if (!['sd-adaptive-geometric-v1', 'sd-adaptive-geometric-v2'].includes(model)
    || !Number.isFinite(sigma) || sigma <= 0 || !Number.isFinite(support) || support < sigma
    || !Number.isFinite(maximumDepth) || maximumDepth <= 0
    || (explicitDepth !== undefined && (!Number.isFinite(explicitDepth) || explicitDepth <= 0))) {
    throw new Error('Invalid adaptive sensitivity kernel settings.');
  }
  const source = head.projectScalp(sourceScalpPoint);
  const detector = head.projectScalp(detectorScalpPoint);
  const midpoint = head.projectScalp(scale3(add3(source, detector), 0.5));
  const centerRasMm = head.projectCorticalContact(midpoint);
  const separation = distance3(source, detector);
  const gap = distance3(midpoint, centerRasMm);
  if (![...source, ...detector, ...midpoint, ...centerRasMm, separation, gap].every(Number.isFinite)
    || separation > 1000 || gap > 1000) throw new Error('Invalid adaptive sensitivity geometry.');
  const depthAxis = normalize3(add3(centerRasMm, scale3(midpoint, -1)));
  const displacement = add3(detector, scale3(source, -1));
  const tangent = add3(displacement, scale3(depthAxis, -dot3(displacement, depthAxis)));
  const degenerate = Math.hypot(...tangent) < 1e-8;
  const reference: Vec3 = Math.abs(depthAxis[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
  const longitudinalAxis = degenerate ? normalize3(cross3(depthAxis, reference)) : normalize3(tangent);
  const lateralAxis = normalize3(cross3(depthAxis, longitudinalAxis));
  const effectiveDepthMm = explicitDepth === undefined
    ? Math.min(Math.max(1, maximumDepth), Math.max(2, Math.min(40, 0.5 * separation)))
    : Math.max(1, Math.min(1000, explicitDepth));
  const widthScale = sigma / 12;
  const noDepthNormal = gap < 1e-8;
  const longitudinalSigmaMm = Math.max(noDepthNormal ? 2 : 1e-6, Math.min(100, Math.max(3, Math.min(30, 0.35 * separation)) * widthScale));
  // With no measured scalp/cortex gap there is no anatomical depth normal.
  // Use an isotropic fallback, so any chosen basis yields the same field.
  const lateralSigmaMm = degenerate || noDepthNormal ? longitudinalSigmaMm : Math.max(1e-6, Math.min(100,
    model === 'sd-adaptive-geometric-v1'
      ? Math.max(2, Math.min(20, 0.20 * separation)) * widthScale / Math.sqrt(1 + (gap / effectiveDepthMm) ** 2)
      // Keep the evaluated combined recipe's arithmetic order for exact replay.
      : Math.max(2, Math.min(20, 0.20 * separation)) * sigma / 12));
  const v1DepthSigmaMm = Math.max(2, 0.5 * Math.sqrt(Math.max(0, effectiveDepthMm ** 2 - gap ** 2)));
  return {
    model, centerRasMm, longitudinalAxis, lateralAxis, depthAxis,
    depthMode: explicitDepth === undefined ? 'automatic' : 'override',
    maximumDepthMm: Math.max(1, Math.min(40, maximumDepth)),
    sourceDetectorDistanceMm: separation, scalpCortexGapMm: gap, effectiveDepthMm,
    longitudinalSigmaMm, lateralSigmaMm,
    depthSigmaMm: noDepthNormal ? longitudinalSigmaMm
      : model === 'sd-adaptive-geometric-v1' ? v1DepthSigmaMm : Math.min(500, 2 * v1DepthSigmaMm),
    amplitude: Math.exp(-0.5 * (gap / effectiveDepthMm) ** 2),
    supportSigma: Math.max(0.05, Math.min(80, support / sigma)),
  };
}

/** Representative curved centerline paired with the adaptive coverage field. */
export function channelSensitivityProjection(
  head: Pick<import('./headModel.js').HeadModel, 'projectScalp' | 'projectCorticalContact'>,
  sourceScalpPoint: Vec3,
  detectorScalpPoint: Vec3,
  _optodeRadiusMm = 3.6,
  maximumDepthMm = 25,
  transmissionDepthOverrideMm?: number,
  settings: Pick<ChannelSensitivityKernelOptions, 'model' | 'kernelSigmaMm' | 'supportRadiusMm'> = {},
  sampleCount = 33,
): { points: Vec3[]; corticalContact: Vec3; target: Vec3; kernel: ChannelSensitivityKernel } {
  const kernel = createChannelSensitivityKernel(head, sourceScalpPoint, detectorScalpPoint, {
    ...settings, maximumDepthMm, transmissionDepthMm: transmissionDepthOverrideMm,
  });
  const source = head.projectCorticalContact(sourceScalpPoint);
  const detector = head.projectCorticalContact(detectorScalpPoint);
  const target = kernel.scalpCortexGapMm < 1e-8 ? kernel.centerRasMm : add3(kernel.centerRasMm,
    scale3(kernel.depthAxis, Math.max(0, kernel.effectiveDepthMm - kernel.scalpCortexGapMm)));
  const control = add3(scale3(target, 2), scale3(add3(source, detector), -0.5));
  const count = Math.max(3, Math.min(129, Math.round(sampleCount)));
  const points = Array.from({ length: count }, (_, index): Vec3 => {
    const t = index / (count - 1);
    return add3(add3(scale3(source, (1 - t) ** 2), scale3(control, 2 * (1 - t) * t)), scale3(detector, t ** 2));
  });
  return { points, corticalContact: kernel.centerRasMm, target, kernel };
}

/** Evaluate a serialized channel kernel before combining channel coverage. */
export function evaluateChannelSensitivityKernel(kernel: ChannelSensitivityKernel, point: Vec3): number {
  const delta = add3(point, scale3(kernel.centerRasMm, -1));
  const squared = (dot3(delta, kernel.longitudinalAxis) / kernel.longitudinalSigmaMm) ** 2
    + (dot3(delta, kernel.lateralAxis) / kernel.lateralSigmaMm) ** 2
    + (dot3(delta, kernel.depthAxis) / kernel.depthSigmaMm) ** 2;
  return squared <= kernel.supportSigma ** 2 ? kernel.amplitude * Math.exp(-0.5 * squared) : 0;
}
