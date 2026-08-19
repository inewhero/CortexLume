import * as THREE from 'three';

interface SurfaceGraph {
  offsets: Uint32Array;
  neighbors: Uint32Array;
  weights: Float32Array;
}

export interface SurfaceInterpolationOptions {
  iterations?: number;
  diffusion?: number;
  expansionSupport?: number;
  activationFloor?: number;
  maxHoleVertices?: number;
  validityMask?: Uint8Array;
}

const graphCache = new WeakMap<THREE.BufferGeometry, SurfaceGraph>();

/** Build a weighted adjacency graph strictly from mesh edges. */
export function getSurfaceGraph(geometry: THREE.BufferGeometry): SurfaceGraph {
  const cached = graphCache.get(geometry);
  if (cached) return cached;

  const positions = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const triangleIndices = index?.array;
  const vertexCount = positions.count;
  const degrees = new Uint32Array(vertexCount);

  if (triangleIndices) {
    for (let offset = 0; offset + 2 < triangleIndices.length; offset += 3) {
      const a = triangleIndices[offset]!;
      const b = triangleIndices[offset + 1]!;
      const c = triangleIndices[offset + 2]!;
      degrees[a] = degrees[a]! + 2;
      degrees[b] = degrees[b]! + 2;
      degrees[c] = degrees[c]! + 2;
    }
  }

  const offsets = new Uint32Array(vertexCount + 1);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    offsets[vertex + 1] = offsets[vertex]! + degrees[vertex]!;
  }
  const neighbors = new Uint32Array(offsets[vertexCount]!);
  const edgeWeights = new Float32Array(neighbors.length);
  const cursors = offsets.slice(0, vertexCount);

  const addEdge = (from: number, to: number) => {
    const cursor = cursors[from]!;
    neighbors[cursor] = to;
    const dx = positions.getX(from) - positions.getX(to);
    const dy = positions.getY(from) - positions.getY(to);
    const dz = positions.getZ(from) - positions.getZ(to);
    edgeWeights[cursor] = 1 / Math.max(0.25, Math.hypot(dx, dy, dz));
    cursors[from] = cursor + 1;
  };

  if (triangleIndices) {
    for (let offset = 0; offset + 2 < triangleIndices.length; offset += 3) {
      const a = triangleIndices[offset]!;
      const b = triangleIndices[offset + 1]!;
      const c = triangleIndices[offset + 2]!;
      addEdge(a, b); addEdge(a, c);
      addEdge(b, a); addEdge(b, c);
      addEdge(c, a); addEdge(c, b);
    }
  }

  const graph = { offsets, neighbors, weights: edgeWeights };
  graphCache.set(geometry, graph);
  return graph;
}

/**
 * Interpolate a scalar field along the anatomical surface. Zero-valued
 * vertices are only admitted when a meaningful share of their one-ring
 * neighborhood is active, so small holes close without globally dilating the
 * statistical map. Disconnected surfaces can never exchange values.
 */
export function interpolateSurfaceValues(
  geometry: THREE.BufferGeometry,
  values: Float32Array,
  options: SurfaceInterpolationOptions = {},
): Float32Array {
  const vertexCount = geometry.getAttribute('position').count;
  if (values.length !== vertexCount) {
    throw new Error(`Surface value count ${values.length} does not match vertex count ${vertexCount}.`);
  }
  const validityMask = options.validityMask;
  if (validityMask && validityMask.length !== vertexCount) {
    throw new Error(`Surface validity count ${validityMask.length} does not match vertex count ${vertexCount}.`);
  }
  const graph = getSurfaceGraph(geometry);
  if (graph.neighbors.length === 0) return values.slice();

  const iterations = Math.max(0, Math.round(options.iterations ?? 6));
  const diffusion = Math.max(0, Math.min(1, options.diffusion ?? 0.46));
  const expansionSupport = Math.max(0, Math.min(1, options.expansionSupport ?? 0.18));
  const activationFloor = Math.max(0, options.activationFloor ?? 0.002);
  const maxHoleVertices = Math.max(0, Math.round(options.maxHoleVertices ?? 120));
  let current = values.slice();
  let next = new Float32Array(vertexCount);
  let originalMaximum = 0;
  for (const value of current) originalMaximum = Math.max(originalMaximum, value);

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      if (validityMask && !validityMask[vertex]) {
        next[vertex] = 0;
        continue;
      }
      let weightedSum = 0;
      let totalWeight = 0;
      let activeWeight = 0;
      for (let cursor = graph.offsets[vertex]!; cursor < graph.offsets[vertex + 1]!; cursor += 1) {
        const neighbor = graph.neighbors[cursor]!;
        if (validityMask && !validityMask[neighbor]) continue;
        const edgeWeight = graph.weights[cursor]!;
        const neighborValue = current[neighbor]!;
        weightedSum += neighborValue * edgeWeight;
        totalWeight += edgeWeight;
        if (neighborValue > activationFloor) activeWeight += edgeWeight;
      }
      const currentValue = current[vertex]!;
      if (totalWeight <= 0) {
        next[vertex] = currentValue;
        continue;
      }
      const neighborMean = weightedSum / totalWeight;
      if (currentValue > activationFloor) {
        next[vertex] = currentValue * (1 - diffusion) + neighborMean * diffusion;
      } else if (activeWeight / totalWeight >= expansionSupport) {
        next[vertex] = neighborMean * (0.72 + 0.07 * iteration);
      } else {
        next[vertex] = 0;
      }
    }
    [current, next] = [next, current];
    next.fill(0);
  }

  if (maxHoleVertices > 0) {
    const visited = new Uint8Array(vertexCount);
    const queue = new Uint32Array(vertexCount);
    for (let start = 0; start < vertexCount; start += 1) {
      if (validityMask && !validityMask[start]) {
        visited[start] = 1;
        current[start] = 0;
        continue;
      }
      if (visited[start] || current[start]! > activationFloor) continue;
      let queueStart = 0;
      let queueEnd = 1;
      queue[0] = start;
      visited[start] = 1;
      const component: number[] = [];
      let boundarySum = 0;
      let boundaryWeight = 0;
      while (queueStart < queueEnd) {
        const vertex = queue[queueStart++]!;
        component.push(vertex);
        for (let cursor = graph.offsets[vertex]!; cursor < graph.offsets[vertex + 1]!; cursor += 1) {
          const neighbor = graph.neighbors[cursor]!;
          if (validityMask && !validityMask[neighbor]) continue;
          const edgeWeight = graph.weights[cursor]!;
          if (current[neighbor]! > activationFloor) {
            boundarySum += current[neighbor]! * edgeWeight;
            boundaryWeight += edgeWeight;
          } else if (!visited[neighbor]) {
            visited[neighbor] = 1;
            queue[queueEnd++] = neighbor;
          }
        }
      }
      if (component.length <= maxHoleVertices && boundaryWeight > 0) {
        const fillValue = boundarySum / boundaryWeight;
        for (const vertex of component) current[vertex] = fillValue;
      }
    }
  }

  let interpolatedMaximum = 0;
  for (const value of current) interpolatedMaximum = Math.max(interpolatedMaximum, value);
  if (originalMaximum > 0 && interpolatedMaximum > 0) {
    const peakScale = originalMaximum / interpolatedMaximum;
    for (let vertex = 0; vertex < current.length; vertex += 1) {
      current[vertex] = Math.min(1, current[vertex]! * peakScale);
    }
  }
  return current;
}
