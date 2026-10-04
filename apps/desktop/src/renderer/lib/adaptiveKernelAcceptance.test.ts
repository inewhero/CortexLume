import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ChannelSensitivityKernelSchema, type Vec3 } from '@cortexlume/contracts';
import { channelSensitivityProjection, createChannelSensitivityKernel, evaluateChannelSensitivityKernel } from '@cortexlume/core';

// Independent behavioral acceptance fixtures: a local flat scalp/cortex pair
// lets us isolate separation and anatomical spacing from mesh discretization.
const plane = (gap: number) => ({
  projectScalp: (point: Vec3): Vec3 => [point[0], point[1], 0],
  projectCorticalContact: (point: Vec3): Vec3 => [point[0], point[1], -gap],
});
const channel = (separation: number, gap = 10) => createChannelSensitivityKernel(
  plane(gap), [-separation / 2, 0, 0], [separation / 2, 0, 0],
);
const cosine = Math.cos(0.73);
const sine = Math.sin(0.73);
const transform = ([x, y, z]: Vec3): Vec3 => [z + 83, cosine * x - sine * y - 120, sine * x + cosine * y + 57];
const inverse = ([x, y, z]: Vec3): Vec3 => [cosine * (y + 120) + sine * (z - 57), -sine * (y + 120) + cosine * (z - 57), x - 83];

describe('adaptive channel kernel acceptance', () => {
  it('matches the shared Python/TypeScript analytical fixture, including the support boundary', () => {
    const fixture = JSON.parse(readFileSync(new URL('../../../../../services/science/tests/fixtures/adaptive_kernel_parity.json', import.meta.url), 'utf8'));
    const kernel = ChannelSensitivityKernelSchema.parse(fixture.kernel);
    for (const testCase of fixture.cases as Array<{ point: Vec3; weight: number }>) {
      expect(evaluateChannelSensitivityKernel(kernel, testCase.point)).toBeCloseTo(testCase.weight, 13);
    }
  });

  it('gives coincident projected centers different length, width, depth and coverage for different separations', () => {
    const short = channel(20);
    const long = channel(40);
    expect(short.centerRasMm).toEqual(long.centerRasMm);
    expect(long.longitudinalSigmaMm).toBeGreaterThan(short.longitudinalSigmaMm);
    expect(long.lateralSigmaMm).toBeGreaterThan(short.lateralSigmaMm);
    expect(long.effectiveDepthMm).toBeGreaterThan(short.effectiveDepthMm);
    expect(long.depthSigmaMm).toBeGreaterThan(short.depthSigmaMm);
    // At four-sigma support, 36 mm is outside the short but inside the long footprint.
    expect(evaluateChannelSensitivityKernel(short, [36, 0, -10])).toBe(0);
    expect(evaluateChannelSensitivityKernel(long, [36, 0, -10])).toBeGreaterThan(0);
    expect(evaluateChannelSensitivityKernel(long, [0, 0, -16]))
      .toBeGreaterThan(evaluateChannelSensitivityKernel(short, [0, 0, -16]));
  });

  it('preserves reduced absolute sensitivity with larger anatomical spacing', () => {
    const near = channel(30, 5);
    const far = channel(30, 25);
    expect(evaluateChannelSensitivityKernel(far, far.centerRasMm))
      .toBeLessThan(evaluateChannelSensitivityKernel(near, near.centerRasMm));
    // Combined v2 separates lateral width from gap-related amplitude attenuation.
    expect(far.lateralSigmaMm).toBe(near.lateralSigmaMm);
    expect(far.depthSigmaMm).toBeLessThan(near.depthSigmaMm);
    expect(evaluateChannelSensitivityKernel(far, [0, 0, -45])).toBe(0);
    expect(evaluateChannelSensitivityKernel(near, [0, 0, -25])).toBeGreaterThan(0);
  });

  it.each([0, 1e-10, 1e-5, 5, 30, 100])('remains finite for separation %s and a gap beyond reach', (separation) => {
    const kernel = channel(separation, 100);
    expect(ChannelSensitivityKernelSchema.safeParse(kernel).success).toBe(true);
    for (const point of [[0, 0, -100], [1, 2, -99], [0, 0, 0]] as Vec3[]) {
      const weight = evaluateChannelSensitivityKernel(kernel, point);
      expect(Number.isFinite(weight)).toBe(true);
      expect(weight).toBeGreaterThanOrEqual(0);
      expect(weight).toBeLessThanOrEqual(1);
    }
    if (separation <= 5) expect(kernel.amplitude).toBeLessThan(1e-20);
  });

  it('is unchanged by swapping source and detector or rotating/translating the entire anatomy', () => {
    const head = plane(12);
    const source: Vec3 = [-15, -4, 0];
    const detector: Vec3 = [15, 4, 0];
    const original = createChannelSensitivityKernel(head, source, detector);
    const reversed = createChannelSensitivityKernel(head, detector, source);
    const movedHead = {
      projectScalp: (point: Vec3) => transform(head.projectScalp(inverse(point))),
      projectCorticalContact: (point: Vec3) => transform(head.projectCorticalContact(inverse(point))),
    };
    const moved = createChannelSensitivityKernel(movedHead, transform(source), transform(detector));
    for (const point of [[0, 0, -12], [10, 2, -12], [0, 5, -17], [30, 30, 30]] as Vec3[]) {
      const expected = evaluateChannelSensitivityKernel(original, point);
      expect(evaluateChannelSensitivityKernel(reversed, point)).toBeCloseTo(expected, 12);
      expect(evaluateChannelSensitivityKernel(moved, transform(point))).toBeCloseTo(expected, 12);
    }
    expect(moved.effectiveDepthMm).toBeCloseTo(original.effectiveDepthMm, 12);
    expect(moved.scalpCortexGapMm).toBeCloseTo(original.scalpCortexGapMm, 12);
  });

  it('does not let optode drawing height change anatomical spacing or kernel size', () => {
    const head = plane(10);
    const baseline = channel(30);
    const elevated = createChannelSensitivityKernel(head, [-15, 0, 8], [15, 0, 8]);
    expect(elevated).toEqual(baseline);
  });

  it('keeps an explicit depth as a controlled override while separation still changes footprint', () => {
    const head = plane(10);
    const options = { transmissionDepthMm: 25 };
    const short = createChannelSensitivityKernel(head, [-10, 0, 0], [10, 0, 0], options);
    const long = createChannelSensitivityKernel(head, [-20, 0, 0], [20, 0, 0], options);
    expect(short.effectiveDepthMm).toBe(25);
    expect(long.effectiveDepthMm).toBe(25);
    expect(long.longitudinalSigmaMm).toBeGreaterThan(short.longitudinalSigmaMm);
    expect(long.lateralSigmaMm).toBeGreaterThan(short.lateralSigmaMm);
  });

  it('applies the project default as an automatic depth cap and respects individual overrides', () => {
    const head = plane(10);
    const short = channelSensitivityProjection(head, [-10, 0, 0], [10, 0, 0], 3.6, 25);
    const medium = channelSensitivityProjection(head, [-20, 0, 0], [20, 0, 0], 3.6, 25);
    const long = channelSensitivityProjection(head, [-40, 0, 0], [40, 0, 0], 3.6, 25);
    const override = channelSensitivityProjection(head, [-10, 0, 0], [10, 0, 0], 3.6, 25, 35);
    expect(short.kernel.effectiveDepthMm).toBe(10);
    expect(medium.kernel.effectiveDepthMm).toBe(20);
    expect(long.kernel.effectiveDepthMm).toBe(25);
    expect(override.kernel.effectiveDepthMm).toBe(35);
    expect(medium.target).toEqual([0, 0, -20]);
    expect(medium.points[16]).toEqual(medium.target);
  });

  it('retains local contact and attenuates channels whose automatic depth cannot reach cortex', () => {
    const result = channelSensitivityProjection(plane(40), [-10, 0, 0], [10, 0, 0]);
    expect(result.target).toEqual(result.corticalContact);
    expect(result.corticalContact).toEqual([0, 0, -40]);
    expect(result.kernel.effectiveDepthMm).toBe(10);
    expect(result.kernel.amplitude).toBeLessThan(0.001);
    expect(result.points[16]).toEqual(result.target);
  });

  it('preserves a 1 mm depth cap or override without silently increasing the requested limit', () => {
    const capped = channelSensitivityProjection(plane(10), [-15, 0, 0], [15, 0, 0], 3.6, 1);
    const overridden = channelSensitivityProjection(plane(10), [-15, 0, 0], [15, 0, 0], 3.6, 25, 1);
    expect(capped.kernel.effectiveDepthMm).toBe(1);
    expect(overridden.kernel.effectiveDepthMm).toBe(1);
    expect(overridden.kernel.depthMode).toBe('override');
    expect(capped.kernel.depthMode).toBe('automatic');
  });

  it('uses a rotationally invariant isotropic field when scalp and cortex coincide', () => {
    const head = plane(0);
    const source: Vec3 = [-15, 0, 0];
    const detector: Vec3 = [15, 0, 0];
    const options = { kernelSigmaMm: 1, supportRadiusMm: 2 };
    const original = createChannelSensitivityKernel(head, source, detector, options);
    const movedHead = {
      projectScalp: (point: Vec3) => transform(head.projectScalp(inverse(point))),
      projectCorticalContact: (point: Vec3) => transform(head.projectCorticalContact(inverse(point))),
    };
    const moved = createChannelSensitivityKernel(movedHead, transform(source), transform(detector), options);
    expect(original.longitudinalSigmaMm).toBe(original.lateralSigmaMm);
    expect(original.depthSigmaMm).toBe(original.lateralSigmaMm);
    for (const point of [[0, 0, 0], [1, 1, 1], [1, 2, 0]] as Vec3[]) {
      expect(evaluateChannelSensitivityKernel(moved, transform(point)))
        .toBeCloseTo(evaluateChannelSensitivityKernel(original, point), 12);
    }
  });
});
