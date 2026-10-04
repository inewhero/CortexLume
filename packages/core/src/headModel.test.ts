import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { loadHeadModelFromAssets } from './nodeAssets.js';
import { HeadModel, threeFromRas } from './headModel.js';
import { channelSensitivityPath, distance3 } from './geometry.js';
import { channelSensitivityProjection } from './sensitivity.js';
import type { Vec3 } from '@cortexlume/contracts';

let head: HeadModel;
beforeAll(async () => {
  head = (await loadHeadModelFromAssets(path.resolve('../../assets/templates/MNI152NLin6Asym'))).headModel;
});

describe('local cortical projection', () => {
  it('does not send a posterior channel through the midline gap into anterior cortex', () => {
    const scalp = head.projectScalp([0, -110, 0]);
    const origin = new THREE.Vector3(...threeFromRas(scalp));
    const oldHit = head.cortexBvh.raycastFirst(
      new THREE.Ray(origin, origin.clone().negate().normalize()), THREE.DoubleSide, 0.05, 320,
    )!;
    expect(oldHit.distance).toBeGreaterThan(100);
    expect(distance3(scalp, head.projectCorticalContact(scalp))).toBeLessThan(20);
    const channel = channelSensitivityPath(head,
      head.projectScalp([-15, -110, 0]), head.projectScalp([15, -110, 0]));
    expect(channel.corticalContact[1]).toBeLessThan(-70);
    expect(channel.target[1]).toBeLessThan(-60);
    expect(channel.points[16]).toEqual(channel.target);
  });

  it.each([-4, 0, 4])('keeps posterior midline contacts local at R=%s', (x) => {
    for (const z of [0, 10, 20, 30, 40, 50, 60, 70]) {
      const scalp = head.projectScalp([x, -110, z]);
      const contact = head.projectCorticalContact(scalp);
      const nearest = head.cortexBvh.closestPointToPoint(new THREE.Vector3(...threeFromRas(scalp)))!;
      expect(distance3(scalp, contact)).toBeCloseTo(nearest.distance, 6);
      expect(contact[1]).toBeLessThan(-50);
      const center = head.projectCortex(scalp, 3.6);
      expect(distance3(center, contact)).toBeCloseTo(3.6, 6);
      expect(distance3(scalp, center)).toBeLessThan(distance3(scalp, contact));
    }
  });

  it('keeps the adaptive posterior field and representative path near local cortex', () => {
    const source = head.projectScalp([-15, -110, 0]);
    const detector = head.projectScalp([15, -110, 0]);
    const channel = channelSensitivityProjection(head, source, detector);
    expect(channel.corticalContact[1]).toBeLessThan(-70);
    expect(channel.target[1]).toBeLessThan(-60);
    expect(distance3(channel.kernel.centerRasMm, channel.corticalContact)).toBe(0);
    expect(channel.kernel.sourceDetectorDistanceMm).toBeCloseTo(distance3(source, detector), 6);
    expect(channel.kernel.scalpCortexGapMm).toBeLessThan(20);
    const largeDisplaySpheres = channelSensitivityProjection(head, source, detector, 12);
    expect(largeDisplaySpheres).toEqual(channel);
    channel.points[16]!.forEach((value, index) => expect(value).toBeCloseTo(channel.target[index]!, 8));
  });

  it('directs channel depth along the local cortical contact, independent of coordinate origin', () => {
    const project = (point: Vec3): Vec3 => [point[0] + 4, point[1] + 12, point[2] - 3];
    const mock = { projectCorticalContact: project, projectScalpSphereCenter: (point: Vec3) => point };
    const source: Vec3 = [-10, -100, 40];
    const detector: Vec3 = [10, -100, 40];
    const result = channelSensitivityPath(mock, source, detector, 0, 0);
    result.target.forEach((value, index) => expect(value).toBeCloseTo(result.corticalContact[index]!, 8));
    const offset: Vec3 = [100, 200, -300];
    const shifted = (point: Vec3) => point.map((value, index) => value + offset[index]!) as Vec3;
    const original = channelSensitivityPath(mock, source, detector, 0, 25);
    const translated = channelSensitivityPath(mock, shifted(source), shifted(detector), 0, 25);
    translated.target.forEach((value, index) => expect(value).toBeCloseTo(original.target[index]! + offset[index]!, 8));
  });
});
