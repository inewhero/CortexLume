import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { interpolateSurfaceLabels, interpolateSurfaceValues } from './surfaceInterpolation';

function indexedGeometry(positions: number[], indices: number[]) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return geometry;
}

describe('surface interpolation', () => {
  it('fills a zero-valued island through mesh-edge neighbors', () => {
    const geometry = indexedGeometry([
      0, 0, 0,
      -1, 1, 0,
      1, 1, 0,
      1, -1, 0,
      -1, -1, 0,
    ], [
      0, 1, 2,
      0, 2, 3,
      0, 3, 4,
      0, 4, 1,
    ]);

    const result = interpolateSurfaceValues(
      geometry,
      new Float32Array([0, 1, 0.8, 0.9, 0.7]),
      { iterations: 2 },
    );

    expect(result[0]).toBeGreaterThan(0.5);
    expect(Math.max(...result)).toBeCloseTo(1, 5);
  });

  it('does not interpolate between spatially close but disconnected surfaces', () => {
    const geometry = indexedGeometry([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      0, 0, 0.1, 1, 0, 0.1, 0, 1, 0.1,
    ], [0, 1, 2, 3, 4, 5]);

    const result = interpolateSurfaceValues(
      geometry,
      new Float32Array([1, 0.8, 0.6, 0, 0, 0]),
      { iterations: 5 },
    );

    expect([...result.slice(3)]).toEqual([0, 0, 0]);
  });

  it('preserves a large inactive component instead of painting the full surface', () => {
    const geometry = indexedGeometry([
      0, 0, 0,
      -1, 1, 0,
      1, 1, 0,
      1, -1, 0,
      -1, -1, 0,
    ], [
      0, 1, 2,
      0, 2, 3,
      0, 3, 4,
      0, 4, 1,
    ]);

    const result = interpolateSurfaceValues(
      geometry,
      new Float32Array([1, 0, 0, 0, 0]),
      { iterations: 0, maxHoleVertices: 2 },
    );

    expect([...result.slice(1)]).toEqual([0, 0, 0, 0]);
  });

  it('treats invalid correspondence vertices as hard interpolation boundaries', () => {
    const geometry = indexedGeometry([
      0, 0, 0,
      1, 0, 0,
      0.5, 1, 0,
      1.5, 1, 0,
      2, 0, 0,
    ], [0, 1, 2, 2, 3, 4]);

    const result = interpolateSurfaceValues(
      geometry,
      new Float32Array([1, 0, 0, 0, 0]),
      { iterations: 6, maxHoleVertices: 120, validityMask: new Uint8Array([1, 1, 0, 1, 1]) },
    );

    expect(result[2]).toBe(0);
    expect(result[3]).toBe(0);
    expect(result[4]).toBe(0);
  });

  it('rejects scalar fields that do not match the surface', () => {
    const geometry = indexedGeometry([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
    expect(() => interpolateSurfaceValues(geometry, new Float32Array([1, 0])))
      .toThrow(/does not match vertex count/i);
    expect(() => interpolateSurfaceValues(
      geometry,
      new Float32Array([1, 0, 0]),
      { validityMask: new Uint8Array([1, 1]) },
    )).toThrow(/validity count/i);
  });

  it('fills categorical display gaps through mesh edges without crossing disconnected surfaces', () => {
    const geometry = indexedGeometry([
      0, 0, 0,
      -1, 1, 0,
      1, 1, 0,
      1, -1, 0,
      -1, -1, 0,
      0, 0, 0.1,
      1, 0, 0.1,
      0, 1, 0.1,
    ], [
      0, 1, 2,
      0, 2, 3,
      0, 3, 4,
      0, 4, 1,
      5, 6, 7,
    ]);
    const labels = new Int16Array([-1, 2, 2, 4, 4, -1, -1, -1]);
    const activity = new Float32Array([0.8, 1, 1, 0.7, 0.7, 0, 0, 0]);

    const result = interpolateSurfaceLabels(geometry, labels, activity);

    expect([2, 4]).toContain(result[0]);
    expect([...result.slice(5)]).toEqual([-1, -1, -1]);
  });

  it('fills an entire active component rather than stopping after a fixed number of rings', () => {
    const vertexCount = 110;
    const positions = Array.from({ length: vertexCount }, (_, index) => [index, index % 2, 0]).flat();
    const indices: number[] = [];
    for (let index = 0; index < vertexCount - 2; index += 1) {
      indices.push(index, index + 1, index + 2);
    }
    const labels = new Int16Array(vertexCount);
    labels.fill(-1);
    labels[0] = 3;

    const result = interpolateSurfaceLabels(
      indexedGeometry(positions, indices),
      labels,
      new Float32Array(vertexCount).fill(1),
    );

    expect(result[vertexCount - 1]).toBe(3);
  });
});
