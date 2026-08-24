import type { LayoutDefinition, LayoutInstance, Vec3 } from '@cortexlume/contracts';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { add3, effectiveUv, radialTangentBasis, scale3 } from './geometry.js';

export function threeFromRas(point: Vec3): [number, number, number] {
  return [point[0], point[2], -point[1]];
}

export function rasFromThree(point: THREE.Vector3): Vec3 {
  return [point.x, -point.z, point.y];
}

export class HeadModel {
  readonly scalpGeometry: THREE.BufferGeometry;
  readonly cortexGeometry: THREE.BufferGeometry;
  readonly scalpBvh: MeshBVH;
  readonly cortexBvh: MeshBVH;
  readonly surfaceVerticesRasMm: readonly Vec3[];
  readonly vertexAreasMm2: Float32Array;
  private readonly scalpCenter: THREE.Vector3;
  private readonly cortexCenter: THREE.Vector3;
  private surfaceGraph: Array<Array<{ vertex: number; distance: number }>> | null = null;

  constructor(options: {
    scalpGeometry: THREE.BufferGeometry;
    cortexGeometry: THREE.BufferGeometry;
    surfaceVerticesRasMm?: readonly Vec3[];
    vertexAreasMm2?: Float32Array;
  }) {
    this.scalpGeometry = options.scalpGeometry;
    this.cortexGeometry = options.cortexGeometry;
    this.scalpGeometry.computeBoundingSphere();
    this.cortexGeometry.computeBoundingSphere();
    const cortexCount = this.cortexGeometry.getAttribute('position').count;
    if (cortexCount !== 25_000) throw new Error(`HeadModel cortex vertex count is ${cortexCount}; expected 25000.`);
    this.scalpBvh = new MeshBVH(this.scalpGeometry);
    this.cortexBvh = new MeshBVH(this.cortexGeometry);
    this.scalpCenter = this.scalpGeometry.boundingSphere?.center.clone() ?? new THREE.Vector3();
    this.cortexCenter = this.cortexGeometry.boundingSphere?.center.clone() ?? new THREE.Vector3();
    this.surfaceVerticesRasMm = options.surfaceVerticesRasMm ?? Array.from({ length: cortexCount }, (_, index) => {
      const position = this.cortexGeometry.getAttribute('position');
      return rasFromThree(new THREE.Vector3(position.getX(index), position.getY(index), position.getZ(index)));
    });
    if (this.surfaceVerticesRasMm.length !== cortexCount) throw new Error('HeadModel vertex correspondence length mismatch.');
    this.vertexAreasMm2 = options.vertexAreasMm2 ?? this.computeVertexAreas();
    if (this.vertexAreasMm2.length !== cortexCount || [...this.vertexAreasMm2].some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new Error('HeadModel vertex-area asset is invalid.');
    }
  }

  projectScalp(point: Vec3): Vec3 {
    const input = new THREE.Vector3(...threeFromRas(point));
    const nearest = this.scalpBvh.closestPointToPoint(input);
    if (!nearest) throw new Error('Scalp BVH projection failed.');
    return rasFromThree(nearest.point);
  }

  projectScalpSphereCenter(point: Vec3, radiusMm: number): Vec3 {
    const contact = new THREE.Vector3(...threeFromRas(this.projectScalp(point)));
    const outward = contact.clone().sub(this.scalpCenter).normalize();
    return rasFromThree(contact.addScaledVector(outward, Math.max(0, radiusMm)));
  }

  projectCortex(point: Vec3, radiusMm: number): Vec3 {
    const origin = new THREE.Vector3(...threeFromRas(this.projectScalpSphereCenter(point, radiusMm)));
    const direction = origin.clone().multiplyScalar(-1).normalize();
    if (radiusMm <= 0) {
      const hit = this.cortexBvh.raycastFirst(new THREE.Ray(origin, direction), THREE.DoubleSide, 0.05, 320);
      if (hit?.point) return rasFromThree(hit.point);
    } else {
      const reference = Math.abs(direction.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const u = new THREE.Vector3().crossVectors(direction, reference).normalize();
      const v = new THREE.Vector3().crossVectors(direction, u).normalize();
      const samples: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }];
      for (const fraction of [0.48, 0.82]) for (let index = 0; index < 8; index += 1) {
        const angle = index * Math.PI / 4;
        samples.push({ x: Math.cos(angle) * radiusMm * fraction, y: Math.sin(angle) * radiusMm * fraction });
      }
      let firstCenterDistance = Number.POSITIVE_INFINITY;
      for (const sample of samples) {
        const sampleOrigin = origin.clone().addScaledVector(u, sample.x).addScaledVector(v, sample.y);
        const hit = this.cortexBvh.raycastFirst(new THREE.Ray(sampleOrigin, direction), THREE.DoubleSide, 0.05, 320);
        if (!hit) continue;
        const sphereInset = Math.sqrt(Math.max(0, radiusMm ** 2 - sample.x ** 2 - sample.y ** 2));
        firstCenterDistance = Math.min(firstCenterDistance, hit.distance - sphereInset);
      }
      if (Number.isFinite(firstCenterDistance)) return rasFromThree(origin.addScaledVector(direction, Math.max(0, firstCenterDistance)));
    }
    const nearest = this.cortexBvh.closestPointToPoint(origin);
    if (!nearest) throw new Error('Cortex BVH projection failed.');
    return rasFromThree(nearest.point.clone().addScaledVector(nearest.point.clone().sub(this.cortexCenter).normalize(), Math.max(0, radiusMm)));
  }

  projectCorticalContact(point: Vec3): Vec3 {
    return this.projectCortex(point, 0);
  }

  fittedOptodePositions(layout: LayoutDefinition, instance: LayoutInstance): Map<string, Vec3> {
    const anchor = this.projectScalp(instance.anchorRasMm);
    const basis = radialTangentBasis(anchor, instance.rotationRad + (instance.mappingRotationRad ?? 0));
    const digitized = new Map(instance.digitizerPositions.map((position) => [position.optodeId, position.scalpRasMm]));
    return new Map(layout.optodes.map((optode) => {
      const measured = digitized.get(optode.id);
      if (measured) return [optode.id, measured] as const;
      const uv = effectiveUv(layout, instance, optode.id);
      return [optode.id, this.projectScalp(add3(anchor, add3(scale3(basis.u, uv[0]), scale3(basis.v, uv[1]))))] as const;
    }));
  }

  nearestSurfaceVertex(point: Vec3): number {
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < this.surfaceVerticesRasMm.length; index += 1) {
      const vertex = this.surfaceVerticesRasMm[index]!;
      const squared = (vertex[0] - point[0]) ** 2 + (vertex[1] - point[1]) ** 2 + (vertex[2] - point[2]) ** 2;
      if (squared < bestDistance) { bestDistance = squared; best = index; }
    }
    return best;
  }

  geodesicGaussian(point: Vec3, sigmaMm = 12, supportRadiusMm = 24): { vertexIndices: number[]; values: number[] } {
    if (!(sigmaMm > 0) || supportRadiusMm < sigmaMm) throw new Error('Invalid geodesic Gaussian parameters.');
    const graph = this.getSurfaceGraph();
    const source = this.nearestSurfaceVertex(point);
    const distances = new Float64Array(graph.length);
    distances.fill(Number.POSITIVE_INFINITY);
    distances[source] = 0;
    const heap: Array<{ vertex: number; distance: number }> = [{ vertex: source, distance: 0 }];
    const push = (item: { vertex: number; distance: number }) => {
      heap.push(item);
      let index = heap.length - 1;
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (heap[parent]!.distance <= item.distance) break;
        heap[index] = heap[parent]!; index = parent;
      }
      heap[index] = item;
    };
    const pop = () => {
      const result = heap[0]!; const tail = heap.pop()!;
      if (heap.length > 0) {
        let index = 0;
        while (true) {
          const left = index * 2 + 1; const right = left + 1;
          if (left >= heap.length) break;
          const child = right < heap.length && heap[right]!.distance < heap[left]!.distance ? right : left;
          if (heap[child]!.distance >= tail.distance) break;
          heap[index] = heap[child]!; index = child;
        }
        heap[index] = tail;
      }
      return result;
    };
    while (heap.length > 0) {
      const current = pop();
      if (current.distance !== distances[current.vertex] || current.distance > supportRadiusMm) continue;
      for (const edge of graph[current.vertex]!) {
        const next = current.distance + edge.distance;
        if (next <= supportRadiusMm && next < distances[edge.vertex]!) {
          distances[edge.vertex] = next; push({ vertex: edge.vertex, distance: next });
        }
      }
    }
    const vertexIndices: number[] = []; const values: number[] = [];
    for (let index = 0; index < distances.length; index += 1) if (Number.isFinite(distances[index])) {
      vertexIndices.push(index);
      values.push(Math.exp(-0.5 * distances[index]! ** 2 / sigmaMm ** 2));
    }
    return { vertexIndices, values };
  }

  private getSurfaceGraph(): Array<Array<{ vertex: number; distance: number }>> {
    if (this.surfaceGraph) return this.surfaceGraph;
    const graph = Array.from({ length: this.surfaceVerticesRasMm.length }, () => new Map<number, number>());
    const index = this.cortexGeometry.index;
    if (!index) throw new Error('HeadModel cortex mesh has no triangle index.');
    const connect = (a: number, b: number) => {
      const va = this.surfaceVerticesRasMm[a]!; const vb = this.surfaceVerticesRasMm[b]!;
      const distance = Math.hypot(va[0] - vb[0], va[1] - vb[1], va[2] - vb[2]);
      graph[a]!.set(b, Math.min(graph[a]!.get(b) ?? Number.POSITIVE_INFINITY, distance));
      graph[b]!.set(a, Math.min(graph[b]!.get(a) ?? Number.POSITIVE_INFINITY, distance));
    };
    for (let offset = 0; offset < index.count; offset += 3) {
      const a = index.getX(offset); const b = index.getX(offset + 1); const c = index.getX(offset + 2);
      connect(a, b); connect(b, c); connect(c, a);
    }
    this.surfaceGraph = graph.map((edges) => [...edges].map(([vertex, distance]) => ({ vertex, distance })));
    return this.surfaceGraph;
  }

  private computeVertexAreas(): Float32Array {
    const positions = this.cortexGeometry.getAttribute('position');
    const index = this.cortexGeometry.index;
    if (!index) throw new Error('HeadModel cortex mesh has no triangle index.');
    const result = new Float32Array(positions.count);
    const a = new THREE.Vector3(); const b = new THREE.Vector3(); const c = new THREE.Vector3();
    for (let offset = 0; offset < index.count; offset += 3) {
      const ia = index.getX(offset); const ib = index.getX(offset + 1); const ic = index.getX(offset + 2);
      a.fromBufferAttribute(positions, ia); b.fromBufferAttribute(positions, ib); c.fromBufferAttribute(positions, ic);
      const areaThird = new THREE.Triangle(a, b, c).getArea() / 3;
      result[ia]! += areaThird; result[ib]! += areaThird; result[ic]! += areaThird;
    }
    return result;
  }
}
