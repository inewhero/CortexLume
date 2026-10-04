import { describe, expect, it } from 'vitest';
import { ChannelSensitivityKernelSchema, type Vec3 } from '@cortexlume/contracts';
import { DEFAULT_ADAPTIVE_KERNEL_SUPPORT_RADIUS_MM, channelSensitivityProjection, createChannelSensitivityKernel,
  evaluateChannelSensitivityKernel } from './sensitivity.js';

const plane = (gap: number) => ({
  projectScalp: (point: Vec3): Vec3 => [point[0], point[1], 0],
  projectCorticalContact: (point: Vec3): Vec3 => [point[0], point[1], -gap],
});

describe('adaptive geometric sensitivity boundaries', () => {
  it('uses 4-sigma support by default and retains explicit historical 2-sigma settings', () => {
    const head = plane(10);
    const source: Vec3 = [-15, 0, 0]; const detector: Vec3 = [15, 0, 0];
    const current = createChannelSensitivityKernel(head, source, detector);
    const historical = createChannelSensitivityKernel(head, source, detector, { model: 'sd-adaptive-geometric-v1' });
    expect(DEFAULT_ADAPTIVE_KERNEL_SUPPORT_RADIUS_MM).toBe(48);
    expect(current.model).toBe('sd-adaptive-geometric-v2');
    expect(current.longitudinalSigmaMm).toBeCloseTo(10.5, 12);
    expect(current.lateralSigmaMm).toBe(6);
    expect(current.depthSigmaMm).toBeCloseTo(Math.sqrt(125), 12);
    expect(current.supportSigma).toBe(4);
    expect(historical.supportSigma).toBe(2);
    expect(channelSensitivityProjection(head, source, detector).kernel.supportSigma).toBe(4);
    expect(channelSensitivityProjection(head, source, detector, 3.6, 25, undefined,
      { supportRadiusMm: 24 }).kernel.supportSigma).toBe(2);
    const point: Vec3 = [3 * current.longitudinalSigmaMm, 0, -10];
    expect(evaluateChannelSensitivityKernel(current, point)).toBeGreaterThan(0);
    expect(evaluateChannelSensitivityKernel(historical, point)).toBe(0);
  });

  it('honors existing 1 mm caps and explicit overrides while auto depth varies with separation', () => {
    const head = plane(10);
    const source: Vec3 = [-15, 0, 0]; const detector: Vec3 = [15, 0, 0];
    const capped = createChannelSensitivityKernel(head, source, detector, { maximumDepthMm: 1 });
    expect(capped.effectiveDepthMm).toBe(1);
    const overridden = createChannelSensitivityKernel(head, source, detector, { maximumDepthMm: 1, transmissionDepthMm: 30 });
    expect(overridden.effectiveDepthMm).toBe(30);
    expect(overridden.depthMode).toBe('override');
    expect(createChannelSensitivityKernel(head, source, detector, { transmissionDepthMm: 1 }).effectiveDepthMm).toBe(1);
    expect(createChannelSensitivityKernel(head, [-5, 0, 0], [5, 0, 0]).effectiveDepthMm).toBe(5);
    expect(createChannelSensitivityKernel(head, source, detector).effectiveDepthMm).toBe(15);
    expect(ChannelSensitivityKernelSchema.safeParse(capped).success).toBe(true);
  });

  it('uses isotropic support when coincident scalp and cortex cannot define a depth normal', () => {
    const kernel = createChannelSensitivityKernel(plane(0), [-15, 0, 0], [15, 0, 0], { kernelSigmaMm: 1 });
    expect(kernel.longitudinalSigmaMm).toBe(kernel.lateralSigmaMm);
    expect(kernel.depthSigmaMm).toBe(kernel.longitudinalSigmaMm);
    expect(evaluateChannelSensitivityKernel(kernel, [1, 0, 0])).toBeCloseTo(evaluateChannelSensitivityKernel(kernel, [0, 0, 1]), 12);
    expect(ChannelSensitivityKernelSchema.safeParse(kernel).success).toBe(true);
    const projection = channelSensitivityProjection(plane(0), [-15, 0, 0], [15, 0, 0]);
    expect(projection.target).toEqual(projection.corticalContact);
  });

  it.each([1, 12, 40])('keeps custom sigma=%s and support fields inside the wire contract', (sigma) => {
    for (const gap of [0, 10, 40, 1000]) for (const separation of [0, 10, 30, 100, 1000]) {
      const kernel = createChannelSensitivityKernel(plane(gap), [-separation / 2, 0, 0], [separation / 2, 0, 0], {
        kernelSigmaMm: sigma, supportRadiusMm: 80,
      });
      expect(ChannelSensitivityKernelSchema.safeParse(kernel).success).toBe(true);
      expect(Number.isFinite(evaluateChannelSensitivityKernel(kernel, [0, 0, -gap]))).toBe(true);
    }
  });
});
