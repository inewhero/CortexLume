import { Html, Line, OrbitControls, useGLTF } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { HeadModel } from '@cortexlume/core';
import type { AnatomicalCoverageAnalysis, CortexLumeProject, DigitizerSession, LayoutDefinition, LayoutInstance, ProjectOperationProgress, Vec3 } from '@cortexlume/contracts';
import { useProjectStore } from '../store/projectStore';
import {
  add3,
  channelSensitivityPath,
  effectiveUv,
  findLayoutOverlaps,
  fittedOptodePositions,
  formatRas,
  projectToCorticalSurface,
  projectToCorticalContact,
  projectScalpSphereCenter,
  projectToScalpSurface,
  rasFromThree,
  registerSurfaceProjectors,
  getSurfaceModelStatus,
  subscribeSurfaceModelStatus,
  type SurfaceModelStatus,
  scale3,
  tangentBasis,
  threeFromRas,
} from '../lib/geometry';
import { getSurfaceGraph, interpolateSurfaceLabels, interpolateSurfaceValues } from '../lib/surfaceInterpolation';
import {
  anatomicalCoverageRegionColors,
  anatomicalCoverageRequestKey,
  anatomicalRegionColor,
  buildAnatomicalCoverageRequest,
  requestAnatomicalCoverage,
  scientificCoverageAttributes,
} from '../lib/anatomicalCoverage';
import {
  applyScreenshotCamera,
  captureScientificScene,
  scientificScreenshotBlockReason,
  screenshotPngToBase64,
  type ScientificScreenshotResult,
} from '../lib/sceneScreenshot';
import type { McpScreenshotWorkerRequest } from '../../shared/mcpScreenshot';

interface LandmarkFile {
  points: Array<{ label: string; rasMm: Vec3; threeMm: Vec3; system: 'five-point' | '10-10' }>;
}

export function ProjectOperationBubble({ progress, onCancel }: {
  progress: ProjectOperationProgress;
  onCancel(): void;
}) {
  const completed = Math.min(progress.completed, progress.total);
  const percentage = Math.max(0, Math.min(100, (completed / progress.total) * 100));
  const operationLabel = progress.operation === 'annotation' ? 'PREPARING SCIENTIFIC EXPORT' : 'EXPORTING PROJECT';
  return (
    <div className="project-operation-bubble" role="status" aria-live="polite">
      <div className="project-operation-copy">
        <strong>{operationLabel}</strong>
        <span>{progress.phase.replaceAll('-', ' ').toUpperCase()} · {completed}/{progress.total}</span>
        <i aria-hidden="true"><b style={{ width: `${percentage}%` }} /></i>
      </div>
      <button type="button" onClick={onCancel}>CANCEL</button>
    </div>
  );
}

export function MessageToast({ message }: { message: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => setCopyState('idle'), [message]);

  const copyMessage = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(message);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  return (
    <button
      type="button"
      className="toast"
      onClick={() => void copyMessage()}
      title="Click to copy this message"
      aria-label={`Copy message: ${message}`}
    >
      <span>{message}</span>
      <b aria-hidden="true">{copyState === 'copied' ? 'COPIED' : copyState === 'failed' ? 'FAILED' : 'COPY'}</b>
    </button>
  );
}

const anatomyUrl = (name: string) => new URL(`./anatomy/${name}`, window.location.href).href;

function AtlasTopRegion({ point, path }: { point?: Vec3; path?: Vec3[] }) {
  const threshold = useProjectStore((state) => state.project.projectionSettings.atlasProbabilityThreshold);
  const [label, setLabel] = useState('NO ATLAS LABEL');
  useEffect(() => {
    let current = true;
    const lookup = path?.length
      ? window.cortexlume?.science.atlasLookupPath(path, threshold)
      : point
        ? window.cortexlume?.science.atlasLookup(point, threshold)
        : undefined;
    setLabel('LOCATING REGION…');
    void lookup?.then((regions) => {
      if (!current) return;
      const top = regions[0];
      setLabel(top ? `${top.labelEn} · ${Math.round(top.probability * 100)}%` : 'NO ATLAS LABEL');
    }).catch(() => { if (current) setLabel('ATLAS UNAVAILABLE'); });
    return () => { current = false; };
  }, [point?.[0], point?.[1], point?.[2], path, threshold]);
  return <span>{label}</span>;
}

const anatomyVertexShader = `
  varying vec3 vNormal;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const anatomyFragmentShader = `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec3 vNormal;
  void main() {
    vec3 lightDirection = normalize(vec3(-0.35, 0.72, 0.58));
    float diffuse = 0.34 + 0.66 * abs(dot(normalize(vNormal), lightDirection));
    gl_FragColor = vec4(uColor * diffuse, uOpacity);
  }
`;

function AnatomyMaterial({ color, opacity = 1, depthWrite = true }: { color: string; opacity?: number; depthWrite?: boolean }) {
  const uniforms = useMemo(() => ({
    uColor: { value: new THREE.Color(color) },
    uOpacity: { value: opacity },
  }), [color, opacity]);
  return <shaderMaterial
    uniforms={uniforms} vertexShader={anatomyVertexShader} fragmentShader={anatomyFragmentShader}
    transparent={opacity < 1} depthWrite={depthWrite} side={THREE.DoubleSide}
  />;
}

const targetVertexShader = `
  attribute float targetWeight;
  varying float vTargetWeight;
  varying vec3 vNormal;
  void main() {
    vTargetWeight = targetWeight;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const targetFragmentShader = `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vTargetWeight;
  varying vec3 vNormal;
  vec3 heat(float value) {
    vec3 violet = vec3(0.26, 0.10, 0.48);
    vec3 coral = vec3(0.92, 0.25, 0.22);
    vec3 amber = vec3(1.00, 0.84, 0.20);
    return value < 0.55
      ? mix(violet, coral, value / 0.55)
      : mix(coral, amber, (value - 0.55) / 0.45);
  }
  void main() {
    vec3 lightDirection = normalize(vec3(-0.35, 0.72, 0.58));
    float diffuse = 0.34 + 0.66 * abs(dot(normalize(vNormal), lightDirection));
    vec3 anatomy = uColor * diffuse;
    float heatMix = vTargetWeight <= 0.002
      ? 0.0
      : 0.34 + 0.64 * smoothstep(0.02, 0.24, vTargetWeight);
    gl_FragColor = vec4(mix(anatomy, heat(vTargetWeight) * diffuse, heatMix), uOpacity);
  }
`;

const coverageVertexShader = `
  attribute float coverageWeight;
  attribute vec3 coverageColor;
  varying float vCoverageWeight;
  varying vec3 vCoverageColor;
  varying vec3 vNormal;
  void main() {
    vCoverageWeight = coverageWeight;
    vCoverageColor = coverageColor;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const coverageFragmentShader = `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uOverlayOnly;
  uniform float uCoverageEdgeWeight;
  varying float vCoverageWeight;
  varying vec3 vCoverageColor;
  varying vec3 vNormal;
  void main() {
    float edgeStart = max(0.0001, uCoverageEdgeWeight * 0.90);
    float edgeEnd = max(edgeStart + 0.0001, min(0.95, uCoverageEdgeWeight * 2.25));
    float edgeAlpha = smoothstep(edgeStart, edgeEnd, vCoverageWeight);
    if (uOverlayOnly > 0.5 && edgeAlpha <= 0.002) discard;
    vec3 lightDirection = normalize(vec3(-0.35, 0.72, 0.58));
    float diffuse = 0.42 + 0.58 * abs(dot(normalize(vNormal), lightDirection));
    vec3 anatomy = uColor * diffuse;
    float coverageMix = vCoverageWeight <= 0.0001
      ? 0.0
      : 0.58 + 0.38 * smoothstep(0.02, 0.72, vCoverageWeight);
    if (uOverlayOnly > 0.5) {
      float overlayDiffuse = 0.68 + 0.32 * abs(dot(normalize(vNormal), lightDirection));
      gl_FragColor = vec4(vCoverageColor * overlayDiffuse, uOpacity * edgeAlpha);
    } else {
      gl_FragColor = vec4(mix(anatomy, vCoverageColor * diffuse, coverageMix * edgeAlpha), uOpacity);
    }
  }
`;

const scientificVertexMapCache = new WeakMap<
  THREE.BufferGeometry,
  WeakMap<THREE.BufferGeometry, ScientificVertexMap>
>();

interface ScientificVertexMap {
  indices: Uint32Array;
  surfaceValidityMask: Uint8Array;
  interiorValidityMask: Uint8Array;
}

// The locked GM mesh is entirely within 5.8 mm of the official Cedalion
// surface. Twelve millimetres retains 90% of the display WM surface while
// rejecting the cerebellum/brainstem, whose median separation is about 28 mm.
const MAX_TARGET_TRANSFER_DISTANCE_MM = 12;
const INTERIOR_OUTWARD_TOLERANCE_MM = 0.5;

function vertexCellKey(x: number, y: number, z: number, cellSize: number) {
  return `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)},${Math.floor(z / cellSize)}`;
}

/**
 * The Cedalion target values are attached to its official 25k vertices, while
 * CortexLume deliberately uses denser meshes for anatomical display. Transfer
 * each display vertex to its nearest official vertex without ever borrowing
 * the scientific mesh topology. This keeps the heatmap coincident with the
 * selected GM/WM surface and preserves the official value correspondence.
 */
function nearestScientificVertexMap(
  scientificGeometry: THREE.BufferGeometry,
  displayGeometry: THREE.BufferGeometry,
  scientificBvh: MeshBVH,
  includeInteriorValidity: boolean,
) {
  let displayCache = scientificVertexMapCache.get(scientificGeometry);
  if (!displayCache) {
    displayCache = new WeakMap<THREE.BufferGeometry, ScientificVertexMap>();
    scientificVertexMapCache.set(scientificGeometry, displayCache);
  }
  const cached = displayCache.get(displayGeometry);
  if (cached) return cached;

  const scientific = scientificGeometry.getAttribute('position');
  const display = displayGeometry.getAttribute('position');
  const cellSize = 6;
  const buckets = new Map<string, number[]>();

  for (let index = 0; index < scientific.count; index += 1) {
    const key = vertexCellKey(scientific.getX(index), scientific.getY(index), scientific.getZ(index), cellSize);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(index);
    else buckets.set(key, [index]);
  }

  const mapping = new Uint32Array(display.count);
  const surfaceValidityMask = new Uint8Array(display.count);
  const interiorValidityMask = new Uint8Array(display.count);
  const scientificIndex = scientificGeometry.getIndex();
  const queryPoint = new THREE.Vector3();
  const faceA = new THREE.Vector3();
  const faceB = new THREE.Vector3();
  const faceC = new THREE.Vector3();
  const faceNormal = new THREE.Vector3();
  const surfaceOffset = new THREE.Vector3();
  for (let displayIndex = 0; displayIndex < display.count; displayIndex += 1) {
    const x = display.getX(displayIndex);
    const y = display.getY(displayIndex);
    const z = display.getZ(displayIndex);
    const cellX = Math.floor(x / cellSize);
    const cellY = Math.floor(y / cellSize);
    const cellZ = Math.floor(z / cellSize);
    let nearestIndex = 0;
    let nearestDistanceSquared = Number.POSITIVE_INFINITY;

    // GM is normally found in the first shell; WM needs at most two for the
    // locked ICBM152 assets. Four shells retain a safe fallback at boundaries.
    for (let shell = 0; shell <= 4; shell += 1) {
      for (let dx = -shell; dx <= shell; dx += 1) {
        for (let dy = -shell; dy <= shell; dy += 1) {
          for (let dz = -shell; dz <= shell; dz += 1) {
            if (shell > 0 && Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== shell) continue;
            const bucket = buckets.get(`${cellX + dx},${cellY + dy},${cellZ + dz}`);
            if (!bucket) continue;
            for (const scientificIndex of bucket) {
              const deltaX = x - scientific.getX(scientificIndex);
              const deltaY = y - scientific.getY(scientificIndex);
              const deltaZ = z - scientific.getZ(scientificIndex);
              const distanceSquared = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
              if (distanceSquared < nearestDistanceSquared) {
                nearestDistanceSquared = distanceSquared;
                nearestIndex = scientificIndex;
              }
            }
          }
        }
      }
      if (nearestDistanceSquared <= (shell * cellSize) ** 2) break;
    }
    mapping[displayIndex] = nearestIndex;
    const closest = includeInteriorValidity
      ? scientificBvh.closestPointToPoint(queryPoint.set(x, y, z))
      : null;
    const withinSurfaceRange = includeInteriorValidity
      ? Boolean(closest && closest.distance <= MAX_TARGET_TRANSFER_DISTANCE_MM)
      : nearestDistanceSquared <= MAX_TARGET_TRANSFER_DISTANCE_MM ** 2;
    surfaceValidityMask[displayIndex] = withinSurfaceRange ? 1 : 0;
    if (withinSurfaceRange && closest && scientificIndex && closest.faceIndex != null) {
      const triangleOffset = closest.faceIndex * 3;
      faceA.fromBufferAttribute(scientific, scientificIndex.getX(triangleOffset));
      faceB.fromBufferAttribute(scientific, scientificIndex.getX(triangleOffset + 1));
      faceC.fromBufferAttribute(scientific, scientificIndex.getX(triangleOffset + 2));
      THREE.Triangle.getNormal(faceA, faceB, faceC, faceNormal);
      const signedSurfaceOffset = surfaceOffset.set(x, y, z).sub(closest.point).dot(faceNormal);
      interiorValidityMask[displayIndex] = signedSurfaceOffset <= INTERIOR_OUTWARD_TOLERANCE_MM ? 1 : 0;
    }
  }
  const result = { indices: mapping, surfaceValidityMask, interiorValidityMask };
  displayCache.set(displayGeometry, result);
  return result;
}

function FunctionalTargetSurface({
  geometry,
  scientificVertexCount,
  scientificVertexMap,
  requireInterior,
  color,
  opacity,
  depthWrite,
  renderOrder,
}: {
  geometry: THREE.BufferGeometry;
  scientificVertexCount: number;
  scientificVertexMap: ScientificVertexMap;
  requireInterior: boolean;
  color: string;
  opacity: number;
  depthWrite: boolean;
  renderOrder: number;
}) {
  const target = useProjectStore((state) => state.functionalTarget);
  const uniforms = useMemo(() => ({
    uColor: { value: new THREE.Color(color) },
    uOpacity: { value: opacity },
  }), [color, opacity]);
  const weightedGeometry = useMemo(() => {
    if (!target || target.vertexCount !== scientificVertexCount
      || geometry.getAttribute('position').count !== scientificVertexMap.indices.length) return null;
    const prepared = geometry.clone();
    const scientificWeights = new Float32Array(target.vertexCount);
    target.vertexIndices.forEach((vertexIndex, index) => {
      scientificWeights[vertexIndex] = target.values[index] ?? 0;
    });
    const sorted = [...target.values].sort((a, b) => a - b);
    const ceiling = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.98))] ?? 1;
    const span = Math.max(ceiling, 1e-6);
    const validityMask = requireInterior
      ? scientificVertexMap.interiorValidityMask
      : scientificVertexMap.surfaceValidityMask;
    const displayWeights = new Float32Array(scientificVertexMap.indices.length);
    for (let index = 0; index < scientificVertexMap.indices.length; index += 1) {
      if (!validityMask[index]) continue;
      const value = scientificWeights[scientificVertexMap.indices[index]!] ?? 0;
      displayWeights[index] = value <= 0 ? 0 : Math.min(1, value / span);
    }
    const interpolatedWeights = interpolateSurfaceValues(geometry, displayWeights, {
      validityMask,
    });
    prepared.setAttribute('targetWeight', new THREE.BufferAttribute(interpolatedWeights, 1));
    return prepared;
  }, [geometry, requireInterior, scientificVertexCount, scientificVertexMap, target]);

  useEffect(() => () => weightedGeometry?.dispose(), [weightedGeometry]);
  if (!weightedGeometry) return null;
  return (
    <mesh geometry={weightedGeometry} renderOrder={renderOrder}>
      <shaderMaterial
        uniforms={uniforms}
        vertexShader={targetVertexShader}
        fragmentShader={targetFragmentShader}
        transparent={opacity < 1}
        depthWrite={depthWrite}
        depthTest
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

function AnatomicalCoverageSurface({
  geometry,
  analysis,
  scientificVertexMap,
  selectedRegionIndex,
  requireInterior,
  color,
  opacity,
  depthWrite,
  overlayOnly = false,
}: {
  geometry: THREE.BufferGeometry;
  analysis: AnatomicalCoverageAnalysis;
  scientificVertexMap: ScientificVertexMap;
  selectedRegionIndex: number | null;
  requireInterior: boolean;
  color: string;
  opacity: number;
  depthWrite: boolean;
  overlayOnly?: boolean;
}) {
  const uniforms = useMemo(() => ({
    uColor: { value: new THREE.Color(color) },
    uOpacity: { value: opacity },
    uOverlayOnly: { value: overlayOnly ? 1 : 0 },
    uCoverageEdgeWeight: { value: Math.exp(
      -0.5 * (analysis.parameters.supportRadiusMm / analysis.parameters.kernelSigmaMm) ** 2,
    ) },
  }), [analysis.parameters.kernelSigmaMm, analysis.parameters.supportRadiusMm, color, opacity, overlayOnly]);
  const weightedGeometry = useMemo(() => {
    if (analysis.vertexCount !== 25_000
      || geometry.getAttribute('position').count !== scientificVertexMap.indices.length) return null;
    const prepared = geometry.clone();
    const scientific = scientificCoverageAttributes(analysis, selectedRegionIndex);
    const validityMask = requireInterior
      ? scientificVertexMap.interiorValidityMask
      : scientificVertexMap.surfaceValidityMask;
    const displayWeights = new Float32Array(scientificVertexMap.indices.length);
    const displayRegionIndices = new Int16Array(scientificVertexMap.indices.length);
    displayRegionIndices.fill(-1);
    for (let displayIndex = 0; displayIndex < scientificVertexMap.indices.length; displayIndex += 1) {
      if (!validityMask[displayIndex]) continue;
      const scientificIndex = scientificVertexMap.indices[displayIndex]!;
      displayWeights[displayIndex] = scientific.geometricWeights[scientificIndex] ?? 0;
      displayRegionIndices[displayIndex] = scientific.regionIndices[scientificIndex] ?? -1;
    }
    const renderedWeights = selectedRegionIndex == null
      ? displayWeights
      : interpolateSurfaceValues(geometry, displayWeights, {
          validityMask,
          iterations: 4,
          diffusion: 0.2,
          expansionSupport: 0.5,
          maxHoleVertices: 900,
        });
    // Extend only the categorical color one mesh ring beyond support. The
    // scientific coverage weights remain unchanged and drive the alpha fade;
    // this prevents boundary interpolation against black RGB vertices.
    const colorActivity = interpolateSurfaceValues(geometry, renderedWeights, {
      validityMask,
      iterations: 1,
      diffusion: 0,
      expansionSupport: 0.001,
      maxHoleVertices: 0,
    });
    const interpolatedRegions = interpolateSurfaceLabels(
      geometry,
      displayRegionIndices,
      colorActivity,
      { validityMask },
    );
    const regionColors = anatomicalCoverageRegionColors(analysis);
    const regionRgb = new Map<number, THREE.Color>();
    for (const [regionIndex, regionColor] of regionColors) {
      regionRgb.set(regionIndex, new THREE.Color(regionColor));
    }
    const displayColors = new Float32Array(scientificVertexMap.indices.length * 3);
    for (let displayIndex = 0; displayIndex < interpolatedRegions.length; displayIndex += 1) {
      const regionIndex = interpolatedRegions[displayIndex]!;
      const region = analysis.regions[regionIndex];
      if (regionIndex < 0 || !region) {
        renderedWeights[displayIndex] = 0;
        continue;
      }
      const color = regionRgb.get(regionIndex)
        ?? new THREE.Color(anatomicalRegionColor(region.atlasId, region.labelEn));
      displayColors[displayIndex * 3] = color.r;
      displayColors[displayIndex * 3 + 1] = color.g;
      displayColors[displayIndex * 3 + 2] = color.b;
    }
    prepared.setAttribute('coverageWeight', new THREE.BufferAttribute(renderedWeights, 1));
    prepared.setAttribute('coverageColor', new THREE.BufferAttribute(displayColors, 3));
    return prepared;
  }, [analysis, geometry, requireInterior, scientificVertexMap, selectedRegionIndex]);
  useEffect(() => () => weightedGeometry?.dispose(), [weightedGeometry]);
  if (!weightedGeometry) return null;
  return <mesh geometry={weightedGeometry} renderOrder={1}>
    <shaderMaterial
      uniforms={uniforms}
      vertexShader={coverageVertexShader}
      fragmentShader={coverageFragmentShader}
      transparent={overlayOnly || opacity < 1}
      depthWrite={overlayOnly ? true : depthWrite}
      depthTest
      side={overlayOnly ? THREE.FrontSide : THREE.DoubleSide}
    />
  </mesh>;
}

function geometryFromScene(scene: THREE.Group): THREE.BufferGeometry {
  let geometry: THREE.BufferGeometry | undefined;
  scene.traverse((object) => {
    if (!geometry && object instanceof THREE.Mesh) geometry = object.geometry;
  });
  if (!geometry) throw new Error('Anatomical GLB does not contain a mesh.');
  const prepared = geometry.clone();
  prepared.computeVertexNormals();
  prepared.computeBoundingSphere();
  return prepared;
}

function midpoint3(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

function ReferenceMarkers({ landmarks }: { landmarks: LandmarkFile['points'] }) {
  const visibility = useProjectStore((state) => state.anatomyVisibility);
  return (
    <group>
      {landmarks.filter((point) => point.system === 'five-point' ? visibility.fivePoint : visibility.tenTen).map((point) => {
        const isFivePoint = point.system === 'five-point';
        return (
          <group
            key={point.label}
            position={point.threeMm}
            userData={(isFivePoint || visibility.pointLabels) ? {
              scientificScreenshotLabel: {
                label: point.label,
                position: point.threeMm,
                accent: isFivePoint,
                compact: !isFivePoint,
              },
            } : {}}
          >
            <mesh>
              <sphereGeometry args={[isFivePoint ? 2.9 : 1.45, 14, 12]} />
              <meshStandardMaterial
                color={isFivePoint ? '#f0c653' : '#dce1e2'}
                emissive={isFivePoint ? '#6d4b08' : '#334147'}
                emissiveIntensity={0.35}
              />
            </mesh>
            {(isFivePoint || visibility.pointLabels) && (
              <>
                <Html position={[3, 3, 0]} zIndexRange={[1200, 200]} style={{ pointerEvents: 'none' }}>
                  <span className={`reference-label ${isFivePoint ? 'landmark-label' : ''}`}>{point.label}</span>
                </Html>
              </>
            )}
          </group>
        );
      })}
    </group>
  );
}

function AnatomicalHead({ landmarks, onReady, onBlank }: {
  landmarks: LandmarkFile['points'];
  onReady(): void;
  onBlank(): void;
}) {
  const visibility = useProjectStore((state) => state.anatomyVisibility);
  const appearance = useProjectStore((state) => state.anatomyAppearance);
  const storedFunctionalTarget = useProjectStore((state) => state.functionalTarget);
  const functionalTargetVisible = useProjectStore((state) => state.project.surfaceOverlay === 'functional-target');
  const functionalTarget = functionalTargetVisible ? storedFunctionalTarget : null;
  const anatomicalCoverage = useProjectStore((state) => state.anatomicalCoverage);
  const anatomicalCoverageEnabled = useProjectStore((state) => state.anatomicalCoverageEnabled);
  const anatomicalCoverageStatus = useProjectStore((state) => state.anatomicalCoverageStatus);
  const anatomicalCoverageMode = useProjectStore((state) => state.anatomicalCoverageMode);
  const selectedCoverageRegionIndex = useProjectStore((state) => state.selectedCoverageRegionIndex);
  const scalp = useGLTF(anatomyUrl('scalp.glb'), false, false);
  const gray = useGLTF(anatomyUrl('gray_matter.glb'), false, false);
  const white = useGLTF(anatomyUrl('white_matter.glb'), false, false);
  const scientificBrain = useGLTF(anatomyUrl('brain_scientific.glb'), false, false);
  const scalpGeometry = useMemo(() => geometryFromScene(scalp.scene), [scalp.scene]);
  const grayGeometry = useMemo(() => geometryFromScene(gray.scene), [gray.scene]);
  const whiteGeometry = useMemo(() => geometryFromScene(white.scene), [white.scene]);
  // This is Cedalion's unsimplified 25k-vertex brain surface. Its vertex order
  // is preserved by brain_vertex_coordinates.csv and voxel_to_vertex_brain.mtx.gz.
  // Keep the denser pial mesh above for display only; all projection contacts
  // must use this correspondence-backed geometry.
  const scientificBrainGeometry = useMemo(
    () => geometryFromScene(scientificBrain.scene),
    [scientificBrain.scene],
  );
  const headModel = useMemo(() => new HeadModel({ scalpGeometry, cortexGeometry: scientificBrainGeometry }), [scalpGeometry, scientificBrainGeometry]);
  const scalpBvh = headModel.scalpBvh;
  const scientificBrainBvh = headModel.cortexBvh;
  const coverageActive = anatomicalCoverageEnabled && anatomicalCoverageStatus === 'ready' && anatomicalCoverage;
  const targetDisplayGeometry = visibility.grayMatter ? grayGeometry : visibility.whiteMatter ? whiteGeometry : null;
  const grayScientificVertexMap = useMemo(() => (
    coverageActive || (visibility.grayMatter && functionalTarget)
      ? nearestScientificVertexMap(
          scientificBrainGeometry,
          grayGeometry,
          scientificBrainBvh,
          false,
        )
      : null
  ), [Boolean(coverageActive), Boolean(functionalTarget), grayGeometry, scientificBrainBvh, scientificBrainGeometry, visibility.grayMatter]);
  const whiteScientificVertexMap = useMemo(() => (
    functionalTarget && targetDisplayGeometry === whiteGeometry
      ? nearestScientificVertexMap(scientificBrainGeometry, whiteGeometry, scientificBrainBvh, true)
      : null
  ), [Boolean(functionalTarget), scientificBrainBvh, scientificBrainGeometry, targetDisplayGeometry, whiteGeometry]);

  useEffect(() => {
    const warmMappings = () => {
      nearestScientificVertexMap(scientificBrainGeometry, grayGeometry, scientificBrainBvh, false);
      nearestScientificVertexMap(scientificBrainGeometry, whiteGeometry, scientificBrainBvh, true);
      getSurfaceGraph(grayGeometry);
      getSurfaceGraph(whiteGeometry);
    };
    const requestId = window.requestIdleCallback(warmMappings, { timeout: 1200 });
    return () => window.cancelIdleCallback(requestId);
  }, [grayGeometry, scientificBrainBvh, scientificBrainGeometry, whiteGeometry]);

  useEffect(() => {
    const unregister = registerSurfaceProjectors({
      scalp: (rasPoint) => headModel.projectScalp(rasPoint),
      scalpSphereCenter: (rasPoint, radiusMm) => headModel.projectScalpSphereCenter(rasPoint, radiusMm),
      cortex: (rasPoint, radiusMm) => headModel.projectCortex(rasPoint, radiusMm),
      scalpOffset: (anchor, rotationRad, uvMm) => headModel.projectScalpOffset(anchor, rotationRad, uvMm),
      verified: true,
      source: 'Cedalion HeadModel scalp and 25k correspondence-backed cortical meshes',
    });
    onReady();
    return unregister;
  }, [headModel]);

  return (
    <group onPointerDown={onBlank}>
      {visibility.whiteMatter && (
        functionalTarget && targetDisplayGeometry === whiteGeometry && whiteScientificVertexMap
          ? <FunctionalTargetSurface
              geometry={whiteGeometry}
              scientificVertexCount={scientificBrainGeometry.getAttribute('position').count}
              scientificVertexMap={whiteScientificVertexMap}
              requireInterior
              color={appearance.whiteMatter.color}
              opacity={appearance.whiteMatter.opacity}
              depthWrite={appearance.whiteMatter.opacity >= 0.98}
              renderOrder={0}
            />
          : <mesh geometry={whiteGeometry} renderOrder={0}>
              <AnatomyMaterial
                color={appearance.whiteMatter.color}
                opacity={appearance.whiteMatter.opacity}
                depthWrite={appearance.whiteMatter.opacity >= 0.98}
              />
            </mesh>
      )}
      {coverageActive && !visibility.grayMatter && visibility.whiteMatter && grayScientificVertexMap && (
        <AnatomicalCoverageSurface
          geometry={grayGeometry}
          analysis={coverageActive}
          scientificVertexMap={grayScientificVertexMap}
          selectedRegionIndex={anatomicalCoverageMode === 'region' ? selectedCoverageRegionIndex : null}
          requireInterior={false}
          color={appearance.grayMatter.color}
          opacity={appearance.grayMatter.opacity}
          depthWrite={false}
          overlayOnly
        />
      )}
      {visibility.grayMatter && (
        coverageActive && grayScientificVertexMap
          ? <AnatomicalCoverageSurface
              geometry={grayGeometry}
              analysis={coverageActive}
              scientificVertexMap={grayScientificVertexMap}
              selectedRegionIndex={anatomicalCoverageMode === 'region' ? selectedCoverageRegionIndex : null}
              requireInterior={false}
              color={appearance.grayMatter.color}
              opacity={appearance.grayMatter.opacity}
              depthWrite={appearance.grayMatter.opacity >= 0.98}
            />
          : functionalTarget && targetDisplayGeometry === grayGeometry && grayScientificVertexMap
          ? <FunctionalTargetSurface
              geometry={grayGeometry}
              scientificVertexCount={scientificBrainGeometry.getAttribute('position').count}
              scientificVertexMap={grayScientificVertexMap}
              requireInterior={false}
              color={appearance.grayMatter.color}
              opacity={appearance.grayMatter.opacity}
              depthWrite={appearance.grayMatter.opacity >= 0.98}
              renderOrder={1}
            />
          : <mesh geometry={grayGeometry} renderOrder={1}>
              <AnatomyMaterial
                color={appearance.grayMatter.color}
                opacity={appearance.grayMatter.opacity}
                depthWrite={appearance.grayMatter.opacity >= 0.98}
              />
            </mesh>
      )}
      {visibility.scalp && (
        <mesh geometry={scalpGeometry} renderOrder={2}>
          <AnatomyMaterial color="#cdb49b" opacity={0.16} depthWrite={false} />
        </mesh>
      )}
      <ReferenceMarkers landmarks={landmarks} />
    </group>
  );
}

function OptodePatch({ layout, instance, patchIndex, surfaceRevision }: {
  layout: LayoutDefinition;
  instance: LayoutInstance;
  patchIndex: number;
  surfaceRevision: number;
}) {
  const projectionMode = useProjectStore((state) => state.project.projectionSettings.mode);
  const optodeRadiusMm = useProjectStore((state) => state.project.projectionSettings.optodeRadiusMm ?? 3.6);
  const defaultDepthMm = useProjectStore((state) => state.project.projectionSettings.defaultDepthMm ?? 25);
  const channelLabels = useProjectStore((state) => state.anatomyVisibility.channelLabels);
  const scalpPositions = useMemo(() => fittedOptodePositions(layout, instance), [layout, instance, surfaceRevision]);
  const positions = useMemo(() => projectionMode === 'scalp'
    ? new Map([...scalpPositions].map(([id, point]) => [id, projectScalpSphereCenter(point, optodeRadiusMm)]))
    : new Map([...scalpPositions].map(([id, point]) => [id, projectToCorticalSurface(point, optodeRadiusMm)])),
  [optodeRadiusMm, projectionMode, scalpPositions, surfaceRevision]);
  const {
    selectedInstanceId, selectedHeadOptodeId, selectedHeadPairId,
    selectInstance, selectChannel,
  } = useProjectStore();
  const selected = selectedInstanceId === instance.id;
  return (
    <group>
      {layout.pairs.map((pair) => {
        const a = positions.get(pair.sourceId);
        const b = positions.get(pair.detectorId);
        if (!a || !b) return null;
        const midpoint: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
        const sourceScalp = scalpPositions.get(pair.sourceId);
        const detectorScalp = scalpPositions.get(pair.detectorId);
        const transmissionDepthMm = instance.pairDepthOverridesMm?.[pair.id] ?? defaultDepthMm;
        const sensitivity = sourceScalp && detectorScalp
          ? channelSensitivityPath(sourceScalp, detectorScalp, optodeRadiusMm, transmissionDepthMm)
          : undefined;
        const channelScalp = sourceScalp && detectorScalp
          ? midpoint3(projectScalpSphereCenter(sourceScalp, optodeRadiusMm), projectScalpSphereCenter(detectorScalp, optodeRadiusMm))
          : undefined;
        const channelSelected = selected && selectedHeadPairId === pair.id;
        return <group
          key={pair.id}
          userData={channelLabels ? {
            scientificScreenshotLabel: {
              label: String(pair.channelNumber ?? '—'),
              position: threeFromRas(midpoint),
              accent: true,
              compact: true,
            },
          } : {}}
        >
          <Line points={[threeFromRas(a), threeFromRas(b)]} color={selected ? '#f0c95b' : '#8c989d'} lineWidth={selected ? 1.8 : 1.05} />
          {channelLabels && <Html center position={threeFromRas(midpoint)} zIndexRange={[2200, 1300]} style={{ pointerEvents: 'auto' }}>
            <button
              className={`channel-index-3d ${channelSelected ? 'active' : ''}`}
              aria-label={`Select channel ${pair.channelNumber ?? 'unassigned'}`}
              onClick={(event) => { event.stopPropagation(); selectChannel(instance.id, pair.id); }}
            >{pair.channelNumber ?? '—'}</button>
          </Html>}
          {channelSelected && sensitivity && <Html
            center
            position={threeFromRas(midpoint)}
            zIndexRange={[2147483000, 2147482000]}
            style={{ pointerEvents: 'none' }}
          >
            <div className="head-tooltip foreground-tooltip">
              <strong>CH{pair.channelNumber ?? '—'}</strong>
              <span>SCALP MNI: {formatRas(channelScalp)}</span>
              <span>CORTICAL CONTACT MNI: {formatRas(sensitivity.corticalContact)}</span>
              <span>DEPTH TARGET MNI: {formatRas(sensitivity.target)}</span>
              <AtlasTopRegion path={sensitivity.points} />
            </div>
          </Html>}
        </group>;
      })}
      {layout.optodes.map((optode) => {
        const position = positions.get(optode.id)!;
        const isSelected = selected && selectedHeadOptodeId === optode.id;
        const scalp = scalpPositions.get(optode.id) ?? position;
        const cortical = projectToCorticalContact(scalp);
        return (
          <mesh
            key={optode.id}
            position={threeFromRas(position)}
            onPointerDown={(event) => { event.stopPropagation(); selectInstance(instance.id, optode.id); }}
          >
            <sphereGeometry args={[isSelected ? optodeRadiusMm * 1.18 : optodeRadiusMm, 18, 16]} />
            <meshStandardMaterial color={optode.type === 'source' ? '#df4b3f' : '#1c83b3'} emissive={isSelected ? '#ffffff' : '#000000'} emissiveIntensity={0.28} />
            {isSelected && (
              <Html position={[5, 4, 0]} zIndexRange={[2147483000, 2147482000]} style={{ pointerEvents: 'none' }}>
                <div className="head-tooltip foreground-tooltip">
                  <strong>P{String(patchIndex + 1).padStart(2, '0')} · {optode.label}</strong>
                  <span>SCALP MNI: {formatRas(projectScalpSphereCenter(scalp, optodeRadiusMm))}</span>
                  <span>CORTEX MNI: {formatRas(cortical)}</span>
                  <AtlasTopRegion point={cortical} />
                </div>
              </Html>
            )}
          </mesh>
        );
      })}
    </group>
  );
}

function DigitizerOverlay({ session, active }: { session: DigitizerSession; active: boolean }) {
  const calibrated = useMemo(() => new Map(session.calibratedPoints.map((point) => [point.pointId, point.rasMm])), [session.calibratedPoints]);
  return <group>
    {session.calibration.residuals.map((residual) => <Line
      key={residual.label}
      points={[threeFromRas(residual.measuredRasMm), threeFromRas(residual.targetRasMm)]}
      color="#f0c653" lineWidth={active ? 1.5 : 0.8} dashed dashSize={1.5} gapSize={1.2}
    />)}
    {session.points.map((point) => {
      const ras = calibrated.get(point.id);
      if (!ras) return null;
      const color = point.kind === 'source' ? '#df4b3f' : point.kind === 'detector' ? '#1c83b3' : point.kind === 'landmark' ? '#f0c653' : point.kind === 'headshape' ? '#d8dfdc' : '#aa8bc2';
      const radius = point.kind === 'headshape' ? 1.1 : point.kind === 'landmark' ? 2.4 : 2;
      const position = threeFromRas(ras);
      return <group
        key={point.id}
        position={position}
        userData={point.kind === 'landmark' ? {
          scientificScreenshotLabel: {
            label: point.label,
            position,
            accent: true,
            compact: false,
          },
        } : {}}
      >
        <mesh renderOrder={5}>
          <sphereGeometry args={[active ? radius * 1.12 : radius, 12, 10]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={active ? 0.32 : 0.12} depthTest />
        </mesh>
        {point.kind === 'landmark' && <>
          <Html position={[2.8, 2.8, 0]} zIndexRange={[1500, 800]} style={{ pointerEvents: 'none' }}><span className="digitizer-label">{point.label}</span></Html>
        </>}
      </group>;
    })}
  </group>;
}

function DigitizerMappingPreview() {
  const { project, digitizerPreview } = useProjectStore();
  if (!digitizerPreview) return null;
  const positionByPoint = new Map(digitizerPreview.session.calibratedPoints.map((point) => [point.pointId, point.rasMm]));
  const radius = project.projectionSettings.optodeRadiusMm ?? 3.6;
  return <group>
    {digitizerPreview.mappings.map((mapping) => {
      const instance = project.instances.find((candidate) => candidate.id === mapping.instanceId);
      const layout = project.layouts.find((candidate) => candidate.id === instance?.definitionId);
      const optode = layout?.optodes.find((candidate) => candidate.id === mapping.optodeId);
      const measured = positionByPoint.get(mapping.pointId);
      const target = instance && layout ? fittedOptodePositions(layout, instance).get(mapping.optodeId) : undefined;
      if (!measured || !target || !optode) return null;
      const measuredCenter = projectScalpSphereCenter(measured, radius);
      const targetCenter = projectScalpSphereCenter(target, radius);
      const targetColor = optode.type === 'source' ? '#ff493d' : '#00a6df';
      const startColor = new THREE.Color('#ffffff');
      const endColor = new THREE.Color(targetColor);
      const gradientSteps = 16;
      const gradientPoints = Array.from({ length: gradientSteps + 1 }, (_, index): Vec3 => {
        const fraction = index / gradientSteps;
        return [
          measuredCenter[0] + (targetCenter[0] - measuredCenter[0]) * fraction,
          measuredCenter[1] + (targetCenter[1] - measuredCenter[1]) * fraction,
          measuredCenter[2] + (targetCenter[2] - measuredCenter[2]) * fraction,
        ];
      });
      const renderKey = [mapping.instanceId, mapping.optodeId, mapping.pointId, ...measuredCenter, ...targetCenter].join(':');
      return <group key={renderKey}>
        {gradientPoints.slice(0, -1).map((point, index) => {
          const fraction = (index + 0.5) / gradientSteps;
          const color = startColor.clone().lerp(endColor, Math.min(1, Math.pow(fraction, 0.55) * 1.15));
          return <Line
            key={`${renderKey}:${index}`}
            points={[threeFromRas(point), threeFromRas(gradientPoints[index + 1]!)]}
            color={`#${color.getHexString()}`}
            lineWidth={2.8}
            depthTest={false}
            renderOrder={30}
          />;
        })}
        <mesh position={threeFromRas(measuredCenter)} renderOrder={20}><sphereGeometry args={[radius, 16, 13]} /><meshStandardMaterial color="#aab1af" emissive="#ffffff" emissiveIntensity={0.16} /></mesh>
        <mesh position={threeFromRas(targetCenter)} renderOrder={19}><sphereGeometry args={[radius * 0.42, 12, 10]} /><meshStandardMaterial color={targetColor} emissive={targetColor} emissiveIntensity={0.25} /></mesh>
      </group>;
    })}
  </group>;
}

export function ProjectedPatches({ project, surfaceRevision, surfaceStatus }: {
  project: CortexLumeProject;
  surfaceRevision: number;
  surfaceStatus: SurfaceModelStatus;
}) {
  if (surfaceStatus.state !== 'verified') return null;
  return project.instances.map((instance, index) => {
    if (instance.visible === false) return null;
    const layout = project.layouts.find((item) => item.id === instance.definitionId);
    return layout ? <OptodePatch key={instance.id} layout={layout} instance={instance} patchIndex={index} surfaceRevision={surfaceRevision} /> : null;
  });
}

function HeadScene({ landmarks, surfaceRevision, onSurfacesReady }: {
  landmarks: LandmarkFile['points'];
  surfaceRevision: number;
  onSurfacesReady(): void;
}) {
  const { project, selectedInstanceId, selectInstance, activeDigitizerSessionId } = useProjectStore();
  const surfaceStatus = useSyncExternalStore(
    subscribeSurfaceModelStatus, getSurfaceModelStatus, getSurfaceModelStatus,
  );
  return (
    <>
      <color attach="background" args={['#151b1d']} />
      <fog attach="fog" args={['#151b1d', 330, 520]} />
      <ambientLight intensity={1.8} />
      <hemisphereLight args={['#fffaf2', '#495a60', 2.1]} />
      <directionalLight position={[-150, 220, -180]} intensity={2.4} />
      <directionalLight position={[180, 35, 130]} intensity={1.15} color="#b8cdd2" />
      <AnatomicalHead landmarks={landmarks} onReady={onSurfacesReady} onBlank={() => selectInstance(selectedInstanceId, null)} />
      <ProjectedPatches project={project} surfaceRevision={surfaceRevision} surfaceStatus={surfaceStatus} />
      {project.digitizerSessions.filter((session) => session.visible && session.optodeMappings.length === 0).map((session) => <DigitizerOverlay key={session.id} session={session} active={session.id === activeDigitizerSessionId} />)}
      {surfaceStatus.state === 'verified' && <DigitizerMappingPreview />}
      <gridHelper
        args={[360, 18, '#3c484c', '#273135']}
        position={[0, -145, 0]}
        userData={{ excludeFromScientificScreenshot: true }}
      />
      <OrbitControls makeDefault minDistance={150} maxDistance={430} target={[0, -12, 3]} enableDamping dampingFactor={0.08} />
    </>
  );
}

type WorkerCaptureRequest = Pick<McpScreenshotWorkerRequest,
  'logicalWidth' | 'logicalHeight' | 'dpr' | 'camera' | 'layers'>;
type CaptureScientificScene = (request?: WorkerCaptureRequest) => ScientificScreenshotResult;

function createScientificSceneCapture(
  gl: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): CaptureScientificScene {
  return (request?: WorkerCaptureRequest) => {
    if (!request || !(camera instanceof THREE.PerspectiveCamera)) {
      return captureScientificScene(gl, scene, camera);
    }
    const previous = {
      position: camera.position.clone(), up: camera.up.clone(), quaternion: camera.quaternion.clone(),
      fov: camera.fov, aspect: camera.aspect,
    };
    try {
      applyScreenshotCamera(camera, request.camera);
      camera.aspect = request.logicalWidth / request.logicalHeight;
      camera.updateProjectionMatrix();
      return captureScientificScene(gl, scene, camera, {
        width: Math.round(request.logicalWidth * request.dpr),
        height: Math.round(request.logicalHeight * request.dpr),
      });
    } finally {
      camera.position.copy(previous.position);
      camera.up.copy(previous.up);
      camera.quaternion.copy(previous.quaternion);
      camera.fov = previous.fov;
      camera.aspect = previous.aspect;
      camera.updateMatrixWorld(true);
      camera.updateProjectionMatrix();
    }
  };
}

export function ScientificScreenshotButton({ pending, sceneReady = true, onClick }: {
  pending: boolean;
  sceneReady?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      className="viewport-overlay scientific-screenshot-button"
      aria-label="Save transparent 3D scene screenshot"
      title={sceneReady ? 'Save transparent 3D scene screenshot' : 'Wait for the scientific 3D scene to finish loading'}
      disabled={pending || !sceneReady}
      onClick={onClick}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M8.2 6.5 9.5 4.8h5L15.8 6.5H19a2 2 0 0 1 2 2v8.7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8.5a2 2 0 0 1 2-2h3.2Zm3.8 2.1a4.1 4.1 0 1 0 0 8.2 4.1 4.1 0 0 0 0-8.2Zm0 1.8a2.3 2.3 0 1 1 0 4.6 2.3 2.3 0 0 1 0-4.6Z" />
      </svg>
    </button>
  );
}

export function HeadViewport() {
  const [landmarks, setLandmarks] = useState<LandmarkFile['points']>([]);
  const [surfaceRevision, setSurfaceRevision] = useState(0);
  const [screenshotPending, setScreenshotPending] = useState(false);
  const [workerCaptureRequest, setWorkerCaptureRequest] = useState<WorkerCaptureRequest | null>(null);
  const screenshotCapture = useRef<CaptureScientificScene | null>(null);
  const workerCaptureStarted = useRef(false);
  const {
    project, projectPath, selectedInstanceId, selectedHeadOptodeId, instanceEditMode,
    placeLayout, selectInstance, setInstanceEditMode, updateInstanceAnchor,
    updateInstanceOverride, rotateMapping, toggleInstanceVisibility, removeInstance,
    toast, setToast,
    projectOperation, setProjectOperation,
    functionalTarget,
    anatomicalCoverage, anatomicalCoverageEnabled, anatomicalCoverageMode,
    selectedCoverageRegionIndex, anatomicalCoverageSettings, anatomicalCoverageStatus,
    setAnatomicalCoverageResult, setAnatomicalCoverageStatus, setAnatomyLayer,
  } = useProjectStore();
  const surfaceStatus = useSyncExternalStore(
    subscribeSurfaceModelStatus, getSurfaceModelStatus, getSurfaceModelStatus,
  );
  const functionalTargetVisible = project.surfaceOverlay === 'functional-target';
  const displayedFunctionalTarget = functionalTargetVisible ? functionalTarget : null;
  const selected = project.instances.find((instance) => instance.id === selectedInstanceId);
  const selectedLayout = project.layouts.find((layout) => layout.id === selected?.definitionId);
  const editable = surfaceStatus.state === 'verified' && selected && selected.visible !== false;
  const overlaps = useMemo(() => surfaceStatus.state === 'verified' ? findLayoutOverlaps(
    project.layouts, project.instances.filter((instance) => instance.visible !== false),
  ) : [], [project.layouts, project.instances, surfaceRevision, surfaceStatus.state]);
  const targetDisplayRange = useMemo(() => {
    if (!displayedFunctionalTarget) return null;
    const values = [...displayedFunctionalTarget.values].sort((a, b) => a - b);
    return [values[0]!, values[Math.min(values.length - 1, Math.floor(values.length * 0.98))]!] as const;
  }, [displayedFunctionalTarget]);
  const coverageRegionColors = useMemo(
    () => anatomicalCoverage ? anatomicalCoverageRegionColors(anatomicalCoverage) : new Map<number, string>(),
    [anatomicalCoverage],
  );
  const coverageRequest = useMemo(() => {
    if (!anatomicalCoverageEnabled || surfaceRevision < 1 || surfaceStatus.state !== 'verified') return null;
    return buildAnatomicalCoverageRequest(project, anatomicalCoverageSettings);
  }, [
    anatomicalCoverageEnabled,
    anatomicalCoverageSettings,
    project.instances,
    project.layouts,
    project.projectionSettings,
    surfaceRevision,
    surfaceStatus.state,
  ]);
  const coverageRequestKey = coverageRequest ? anatomicalCoverageRequestKey(coverageRequest) : null;
  const screenshotBlockReason = scientificScreenshotBlockReason({
    projectPath,
    surfaceVerified: surfaceStatus.state === 'verified',
    surfaceRevision,
    anatomicalCoverageEnabled,
    anatomicalCoverageReady: anatomicalCoverageStatus === 'ready',
  });
  // Keep the unsaved-project action clickable so it can explain the required
  // save-first workflow; loading scientific content is disabled fail-closed.
  const screenshotSceneReady = screenshotBlockReason === null || screenshotBlockReason === 'save-project';
  const registerScreenshotRenderer = useCallback((state: {
    gl: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.Camera;
  }) => {
    screenshotCapture.current = createScientificSceneCapture(state.gl, state.scene, state.camera);
  }, []);

  useEffect(() => {
    void fetch(anatomyUrl('landmarks.json')).then((response) => response.json()).then((data: LandmarkFile) => setLandmarks(data.points));
  }, []);

  useEffect(() => {
    const worker = window.cortexlumeMcpScreenshot;
    if (!worker) return;
    let active = true;
    void worker.request().then((request) => {
      if (!active) return;
      setAnatomyLayer('scalp', request.layers.scalp);
      setAnatomyLayer('grayMatter', request.layers.grayMatter);
      setAnatomyLayer('whiteMatter', request.layers.whiteMatter);
      setAnatomyLayer('fivePoint', request.layers.fivePoint);
      setAnatomyLayer('tenTen', request.layers.tenTen);
      setAnatomyLayer('pointLabels', request.layers.pointLabels);
      setAnatomyLayer('channelLabels', request.layers.channelLabels);
      setWorkerCaptureRequest(request);
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('MCP screenshot request failed:', error);
      void worker.fail(message.slice(0, 1000));
    });
    return () => { active = false; };
  }, [setAnatomyLayer]);

  useEffect(() => {
    const worker = window.cortexlumeMcpScreenshot;
    if (!worker || !workerCaptureRequest || !screenshotCapture.current
      || !screenshotSceneReady || workerCaptureStarted.current) return;
    workerCaptureStarted.current = true;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        try {
          const captured = screenshotCapture.current!(workerCaptureRequest);
          void worker.complete({
            pngBase64: screenshotPngToBase64(captured.png),
            width: captured.width,
            height: captured.height,
            camera: workerCaptureRequest.camera,
            layers: workerCaptureRequest.layers,
          }).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error('MCP screenshot completion failed:', error);
            void worker.fail(message.slice(0, 1000));
          });
        } catch (error) {
          console.error('MCP scientific screenshot capture failed:', error);
          const message = error instanceof Error ? error.message : String(error);
          void worker.fail(message.slice(0, 1000));
        }
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [screenshotSceneReady, workerCaptureRequest]);

  useEffect(() => {
    const worker = window.cortexlumeMcpScreenshot;
    if (!worker || !workerCaptureRequest || workerCaptureStarted.current) return;
    const failure = surfaceStatus.state === 'failed'
      ? surfaceStatus.issue ?? 'Scientific surface model failed to load.'
      : workerCaptureRequest.layers.anatomicalCoverage && anatomicalCoverageStatus === 'error'
        ? 'Anatomical coverage failed before screenshot capture.'
        : null;
    if (!failure) return;
    workerCaptureStarted.current = true;
    void worker.fail(failure.slice(0, 1000));
  }, [anatomicalCoverageStatus, surfaceStatus, workerCaptureRequest]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timeout);
  }, [setToast, toast]);

  useEffect(() => {
    const onProgress = window.cortexlume?.operations?.onProgress;
    if (!onProgress) return undefined;
    return onProgress((progress) => {
      setProjectOperation((current) => current?.operationId === progress.operationId ? progress : current);
    });
  }, [setProjectOperation]);

  useEffect(() => {
    if (!anatomicalCoverageEnabled) return;
    if (surfaceRevision < 1 || surfaceStatus.state !== 'verified') return;
    if (!coverageRequest) {
      setAnatomicalCoverageResult(null);
      return;
    }
    let current = true;
    setAnatomicalCoverageStatus('loading');
    const timeout = window.setTimeout(() => {
      void requestAnatomicalCoverage(coverageRequest, (value) => window.cortexlume.science.anatomicalCoverage(value))
        .then((result) => {
          if (current) setAnatomicalCoverageResult(result);
        })
        .catch((error) => {
          if (current) setAnatomicalCoverageStatus(
            'error',
            error instanceof Error ? error.message : String(error),
          );
        });
    }, 180);
    return () => {
      current = false;
      window.clearTimeout(timeout);
    };
  }, [
    anatomicalCoverageEnabled,
    coverageRequestKey,
    setAnatomicalCoverageResult,
    setAnatomicalCoverageStatus,
    surfaceRevision,
    surfaceStatus.state,
  ]);

  const nudge = (uMm: number, vMm: number) => {
    if (!editable) return;
    if (instanceEditMode === 'individual' && selectedHeadOptodeId && selectedLayout) {
      const uv = effectiveUv(selectedLayout, selected, selectedHeadOptodeId);
      updateInstanceOverride(selected.id, selectedHeadOptodeId, [uv[0] + uMm, uv[1] + vMm]);
      return;
    }
    const basis = tangentBasis(selected.anchorRasMm, 0);
    updateInstanceAnchor(selected.id, projectToScalpSurface(add3(selected.anchorRasMm, add3(scale3(basis.u, uMm), scale3(basis.v, vMm)))));
  };

  const takeScientificScreenshot = async () => {
    if (screenshotBlockReason === 'save-project' || !projectPath) {
      setToast('Save the project before taking a 3D screenshot.');
      return;
    }
    if (!screenshotCapture.current) {
      setToast('The 3D scene is not ready for capture yet.');
      return;
    }
    if (screenshotBlockReason) {
      setToast(screenshotBlockReason === 'coverage-loading'
        ? 'Wait for anatomical coverage to finish before taking a screenshot.'
        : 'Wait for the scientific 3D scene to finish loading.');
      return;
    }
    setScreenshotPending(true);
    try {
      const captured = screenshotCapture.current();
      const saved = await window.cortexlume.screenshot.save(
        projectPath,
        screenshotPngToBase64(captured.png),
        captured.width,
        captured.height,
      );
      setToast(`Saved transparent 3D screenshot to ${saved.fileName}.`);
    } catch {
      setToast('Could not save the transparent 3D screenshot.');
    } finally {
      setScreenshotPending(false);
    }
  };

  return (
    <div className="head-viewport" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
      event.preventDefault();
      const layoutId = event.dataTransfer.getData('application/x-cortexlume-layout');
      if (layoutId) placeLayout(layoutId);
    }}>
      <div className="viewport-overlay top-left">
        {surfaceStatus.state !== 'verified' && (
          <div className={`surface-model-status is-${surfaceStatus.state}`} title={surfaceStatus.issue ?? undefined}>
            {surfaceStatus.state === 'loading' ? 'HEAD MODEL LOADING…' : 'HEAD MODEL UNAVAILABLE'}
          </div>
        )}
        <div className="patch-tabs">
          {project.instances.map((instance, index) => (
            <div className={`patch-tab ${instance.id === selectedInstanceId ? 'active' : ''} ${instance.visible === false ? 'is-hidden' : ''}`} key={instance.id}>
              <button className="patch-select" onClick={() => selectInstance(instance.id)}>P{String(index + 1).padStart(2, '0')}</button>
              <button className="patch-visibility" aria-label={`${instance.visible === false ? 'Show' : 'Hide'} P${String(index + 1).padStart(2, '0')}`} title={instance.visible === false ? 'Show patch' : 'Hide patch'} onClick={() => toggleInstanceVisibility(instance.id)}>{instance.visible === false ? '○' : '◉'}</button>
              <button className="patch-remove" aria-label={`Delete P${String(index + 1).padStart(2, '0')}`} title="Delete patch" onClick={() => removeInstance(instance.id)}>×</button>
            </div>
          ))}
          {project.instances.length === 0 && <span>DROP A PATCH TO LOAD</span>}
        </div>
      </div>

      <div className="viewport-overlay top-right mapping-console">
        <div className="mapping-console-title"><span>ARRAY CONTROL</span><code>{instanceEditMode === 'group' ? 'PATCH' : 'OPTODE'}</code></div>
        <div className="segmented full-width">
          <button disabled={!editable} className={instanceEditMode === 'group' ? 'active' : ''} onClick={() => setInstanceEditMode('group')}>PATCH</button>
          <button disabled={!editable} className={instanceEditMode === 'individual' ? 'active' : ''} onClick={() => setInstanceEditMode('individual')}>SINGLE</button>
        </div>
        <div className="position-pad" aria-label="Array position controls">
          <button disabled={!editable} onClick={() => nudge(0, 5)}>A</button>
          <button disabled={!editable} onClick={() => nudge(-5, 0)}>L</button>
          <button disabled={!editable} onClick={() => nudge(5, 0)}>R</button>
          <button disabled={!editable} onClick={() => nudge(0, -5)}>P</button>
        </div>
        <div className="mapping-rotation">
          <span>MAPPING ROTATION</span>
          <div className="rotation-four">
            {[-5, -1, 1, 5].map((degrees) => <button key={degrees} disabled={!editable} onClick={() => selected && rotateMapping(selected.id, -degrees * Math.PI / 180)}>{degrees > 0 ? '+' : '−'}{Math.abs(degrees)}°</button>)}
          </div>
        </div>
      </div>

      {overlaps.length > 0 && (
        <div className="viewport-overlay overlap-warning">
          <strong>LAYOUT OVERLAP</strong>
          <span>{overlaps.length} collision{overlaps.length === 1 ? '' : 's'} · minimum {Math.min(...overlaps.map((item) => item.minimumDistanceMm)).toFixed(1)} mm</span>
        </div>
      )}

      <div className="viewport-overlay bottom-left-stack">
        {toast && <MessageToast key={toast} message={toast} />}
        {displayedFunctionalTarget && (
          <div className="target-map-legend">
            <strong>{displayedFunctionalTarget.target.label}</strong>
            <span>{displayedFunctionalTarget.provenance.statistic.toUpperCase()}</span>
            <i aria-hidden="true" />
            <div className="target-map-range"><small>{targetDisplayRange?.[0].toFixed(2)}</small><small>{targetDisplayRange?.[1].toFixed(2)}</small></div>
          </div>
        )}
        {anatomicalCoverageEnabled && (
          <div className="coverage-map-legend">
            <strong>GEOMETRIC ANATOMICAL COVERAGE</strong>
            <span>{anatomicalCoverageStatus === 'loading'
              ? 'CALCULATING ATLAS OVERLAP…'
              : anatomicalCoverageStatus === 'error'
                ? 'ANALYSIS UNAVAILABLE'
                : anatomicalCoverageMode === 'region'
                  ? anatomicalCoverage?.regions.find((region) => region.regionIndex === selectedCoverageRegionIndex)?.labelEn ?? 'SELECT REGION'
                  : 'OVERALL MOSAIC'}</span>
            {anatomicalCoverageStatus === 'ready' && anatomicalCoverage?.regions.slice(0, 5).map((region) => (
              <div className={`coverage-legend-row ${anatomicalCoverageMode === 'region' && selectedCoverageRegionIndex !== region.regionIndex ? 'is-muted' : ''}`} key={`${region.atlasId}:${region.labelEn}`}>
                <i style={{ backgroundColor: coverageRegionColors.get(region.regionIndex) }} />
                <b>{region.labelEn}</b>
                <code>{Math.round(region.coveredAtlasMassFraction * 100)}%</code>
              </div>
            ))}
          </div>
        )}
        {projectOperation && (
          <ProjectOperationBubble
            progress={projectOperation}
            onCancel={() => { void window.cortexlume.operations.cancel(projectOperation.operationId); }}
          />
        )}
        <div className="legend">
          <span><i className="source-dot" /> SOURCE</span><span><i className="detector-dot" /> DETECTOR</span>
          <span>{project.instances.length} PATCH{project.instances.length === 1 ? '' : 'ES'}</span>
          {project.digitizerSessions.length > 0 && <span>{project.digitizerSessions.reduce((sum, session) => sum + session.points.length, 0)} DIGITIZED PTS</span>}
        </div>
      </div>
      <ScientificScreenshotButton
        pending={screenshotPending}
        sceneReady={screenshotSceneReady}
        onClick={() => { void takeScientificScreenshot(); }}
      />
      {/* WebGL-owning module updates use a full document reload in development. */}
      <Canvas
        onPointerMissed={() => selectInstance(selectedInstanceId, null)}
        onCreated={registerScreenshotRenderer}
        camera={{ position: [215, 138, -300], fov: 39 }}
        dpr={[1, 1.6]}
        gl={{ antialias: true }}
      >
        <HeadScene landmarks={landmarks} surfaceRevision={surfaceRevision} onSurfacesReady={() => setSurfaceRevision((value) => value + 1)} />
      </Canvas>
    </div>
  );
}
