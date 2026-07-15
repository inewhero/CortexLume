import { Html, Line, OrbitControls, useGLTF } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { LayoutDefinition, LayoutInstance, Vec3 } from '@cortexlume/contracts';
import { useProjectStore } from '../store/projectStore';
import {
  add3,
  corticalRegionProbabilities,
  effectiveUv,
  findLayoutOverlaps,
  fittedOptodePositions,
  formatRas,
  projectToCorticalSurface,
  projectScalpSphereCenter,
  projectToScalpSurface,
  rasFromThree,
  registerSurfaceProjectors,
  scale3,
  tangentBasis,
  threeFromRas,
} from '../lib/geometry';

interface LandmarkFile {
  points: Array<{ label: string; rasMm: Vec3; threeMm: Vec3; system: 'five-point' | '10-10' }>;
}

const anatomyUrl = (name: string) => new URL(`./anatomy/${name}`, window.location.href).href;

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

function ReferenceMarkers({ landmarks }: { landmarks: LandmarkFile['points'] }) {
  const visibility = useProjectStore((state) => state.anatomyVisibility);
  return (
    <group>
      {landmarks.filter((point) => point.system === 'five-point' ? visibility.fivePoint : visibility.tenTen).map((point) => {
        const isFivePoint = point.system === 'five-point';
        return (
          <group key={point.label} position={point.threeMm}>
            <mesh>
              <sphereGeometry args={[isFivePoint ? 2.9 : 1.45, 14, 12]} />
              <meshStandardMaterial
                color={isFivePoint ? '#f0c653' : '#dce1e2'}
                emissive={isFivePoint ? '#6d4b08' : '#334147'}
                emissiveIntensity={0.35}
              />
            </mesh>
            {(isFivePoint || visibility.pointLabels) && (
              <Html position={[3, 3, 0]} style={{ pointerEvents: 'none' }}>
                <span className={`reference-label ${isFivePoint ? 'landmark-label' : ''}`}>{point.label}</span>
              </Html>
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
  const scalp = useGLTF(anatomyUrl('scalp.glb'), false, false);
  const gray = useGLTF(anatomyUrl('gray_matter.glb'), false, false);
  const white = useGLTF(anatomyUrl('white_matter.glb'), false, false);
  const scalpGeometry = useMemo(() => geometryFromScene(scalp.scene), [scalp.scene]);
  const grayGeometry = useMemo(() => geometryFromScene(gray.scene), [gray.scene]);
  const whiteGeometry = useMemo(() => geometryFromScene(white.scene), [white.scene]);
  const scalpBvh = useMemo(() => new MeshBVH(scalpGeometry), [scalpGeometry]);
  const grayBvh = useMemo(() => new MeshBVH(grayGeometry), [grayGeometry]);

  useEffect(() => {
    const grayCenter = grayGeometry.boundingSphere?.center.clone() ?? new THREE.Vector3(0, 12, 0);
    const scalpCenter = scalpGeometry.boundingSphere?.center.clone() ?? new THREE.Vector3();
    const scalpContact = (rasPoint: Vec3) => {
      const input = new THREE.Vector3(...threeFromRas(rasPoint));
      return scalpBvh.closestPointToPoint(input)?.point.clone() ?? input;
    };
    const scalpSphereCenter = (rasPoint: Vec3, radiusMm: number) => {
      const contact = scalpContact(rasPoint);
      const outward = contact.clone().sub(scalpCenter).normalize();
      return contact.addScaledVector(outward, radiusMm);
    };
    registerSurfaceProjectors({
      scalp: (rasPoint) => rasFromThree(scalpContact(rasPoint)),
      scalpSphereCenter: (rasPoint, radiusMm) => rasFromThree(scalpSphereCenter(rasPoint, radiusMm)),
      cortex: (rasPoint, radiusMm) => {
        const origin = scalpSphereCenter(rasPoint, radiusMm);
        const direction = grayCenter.clone().sub(origin).normalize();
        if (radiusMm <= 0) {
          const hit = grayBvh.raycastFirst(new THREE.Ray(origin, direction), THREE.DoubleSide, 0.05, 320);
          if (hit?.point) return rasFromThree(hit.point);
        } else {
          const reference = Math.abs(direction.y) < 0.9
            ? new THREE.Vector3(0, 1, 0)
            : new THREE.Vector3(1, 0, 0);
          const u = new THREE.Vector3().crossVectors(direction, reference).normalize();
          const v = new THREE.Vector3().crossVectors(direction, u).normalize();
          const samples: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }];
          for (const fraction of [0.48, 0.82]) {
            for (let index = 0; index < 8; index += 1) {
              const angle = index * Math.PI / 4;
              samples.push({
                x: Math.cos(angle) * radiusMm * fraction,
                y: Math.sin(angle) * radiusMm * fraction,
              });
            }
          }
          let firstCenterDistance = Number.POSITIVE_INFINITY;
          for (const sample of samples) {
            const sampleOrigin = origin.clone()
              .addScaledVector(u, sample.x)
              .addScaledVector(v, sample.y);
            const hit = grayBvh.raycastFirst(new THREE.Ray(sampleOrigin, direction), THREE.DoubleSide, 0.05, 320);
            if (!hit) continue;
            const lateralDistance = Math.hypot(sample.x, sample.y);
            const sphereInset = Math.sqrt(Math.max(0, radiusMm ** 2 - lateralDistance ** 2));
            firstCenterDistance = Math.min(firstCenterDistance, hit.distance - sphereInset);
          }
          if (Number.isFinite(firstCenterDistance)) {
            return rasFromThree(origin.addScaledVector(direction, Math.max(0, firstCenterDistance)));
          }
        }
        const nearest = grayBvh.closestPointToPoint(origin);
        if (nearest) {
          const outward = nearest.point.clone().sub(grayCenter).normalize();
          return rasFromThree(nearest.point.clone().addScaledVector(outward, radiusMm));
        }
        return rasPoint;
      },
    });
    onReady();
  }, [grayBvh, grayGeometry, scalpBvh, scalpGeometry]);

  return (
    <group onPointerDown={onBlank}>
      {visibility.whiteMatter && (
        <mesh geometry={whiteGeometry} renderOrder={0}>
          <AnatomyMaterial
            color={appearance.whiteMatter.color}
            opacity={appearance.whiteMatter.opacity}
            depthWrite={appearance.whiteMatter.opacity >= 0.98}
          />
        </mesh>
      )}
      {visibility.grayMatter && (
        <mesh geometry={grayGeometry} renderOrder={1}>
          <AnatomyMaterial
            color={appearance.grayMatter.color}
            opacity={appearance.grayMatter.opacity}
            depthWrite={appearance.grayMatter.opacity >= 0.98 && !visibility.whiteMatter}
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
        return <group key={pair.id}>
          <Line points={[threeFromRas(a), threeFromRas(b)]} color={selected ? '#f0c95b' : '#8c989d'} lineWidth={selected ? 1.8 : 1.05} />
          {channelLabels && <Html center position={threeFromRas(midpoint)} style={{ pointerEvents: 'auto' }}>
            <button
              className={`channel-index-3d ${selected && selectedHeadPairId === pair.id ? 'active' : ''}`}
              aria-label={`Select channel ${pair.channelNumber ?? 'unassigned'}`}
              onClick={(event) => { event.stopPropagation(); selectChannel(instance.id, pair.id); }}
            >{pair.channelNumber ?? '—'}</button>
          </Html>}
        </group>;
      })}
      {layout.optodes.map((optode) => {
        const position = positions.get(optode.id)!;
        const isSelected = selected && selectedHeadOptodeId === optode.id;
        const scalp = scalpPositions.get(optode.id) ?? position;
        const cortical = projectToCorticalSurface(scalp, optodeRadiusMm);
        return (
          <mesh
            key={optode.id}
            position={threeFromRas(position)}
            onPointerDown={(event) => { event.stopPropagation(); selectInstance(instance.id, optode.id); }}
          >
            <sphereGeometry args={[isSelected ? optodeRadiusMm * 1.18 : optodeRadiusMm, 18, 16]} />
            <meshStandardMaterial color={optode.type === 'source' ? '#df4b3f' : '#1c83b3'} emissive={isSelected ? '#ffffff' : '#000000'} emissiveIntensity={0.28} />
            {isSelected && (
              <Html position={[5, 4, 0]} style={{ pointerEvents: 'none' }}>
                <div className="head-tooltip">
                  <strong>P{String(patchIndex + 1).padStart(2, '0')} · {optode.label}</strong>
                  <span>SCALP MNI: {formatRas(projectScalpSphereCenter(scalp, optodeRadiusMm))}</span>
                  <span>CORTEX MNI: {formatRas(cortical)}</span>
                  <span>{corticalRegionProbabilities(cortical)[0]?.label}</span>
                </div>
              </Html>
            )}
          </mesh>
        );
      })}
    </group>
  );
}

function HeadScene({ landmarks, surfaceRevision, onSurfacesReady }: {
  landmarks: LandmarkFile['points'];
  surfaceRevision: number;
  onSurfacesReady(): void;
}) {
  const { project, selectedInstanceId, selectInstance } = useProjectStore();
  return (
    <>
      <color attach="background" args={['#151b1d']} />
      <fog attach="fog" args={['#151b1d', 330, 520]} />
      <ambientLight intensity={1.8} />
      <hemisphereLight args={['#fffaf2', '#495a60', 2.1]} />
      <directionalLight position={[-150, 220, -180]} intensity={2.4} />
      <directionalLight position={[180, 35, 130]} intensity={1.15} color="#b8cdd2" />
      <AnatomicalHead landmarks={landmarks} onReady={onSurfacesReady} onBlank={() => selectInstance(selectedInstanceId, null)} />
      {project.instances.map((instance, index) => {
        if (instance.visible === false) return null;
        const layout = project.layouts.find((item) => item.id === instance.definitionId);
        return layout ? <OptodePatch key={instance.id} layout={layout} instance={instance} patchIndex={index} surfaceRevision={surfaceRevision} /> : null;
      })}
      <gridHelper args={[360, 18, '#3c484c', '#273135']} position={[0, -145, 0]} />
      <OrbitControls makeDefault minDistance={150} maxDistance={430} target={[0, -12, 3]} enableDamping dampingFactor={0.08} />
    </>
  );
}

export function HeadViewport() {
  const [landmarks, setLandmarks] = useState<LandmarkFile['points']>([]);
  const [surfaceRevision, setSurfaceRevision] = useState(0);
  const {
    project, selectedInstanceId, selectedHeadOptodeId, instanceEditMode,
    placeLayout, selectInstance, setInstanceEditMode, updateInstanceAnchor,
    updateInstanceOverride, rotateMapping, toggleInstanceVisibility, removeInstance,
  } = useProjectStore();
  const selected = project.instances.find((instance) => instance.id === selectedInstanceId);
  const selectedLayout = project.layouts.find((layout) => layout.id === selected?.definitionId);
  const editable = selected && selected.visible !== false;
  const overlaps = useMemo(() => findLayoutOverlaps(
    project.layouts, project.instances.filter((instance) => instance.visible !== false),
  ), [project.layouts, project.instances, surfaceRevision]);

  useEffect(() => {
    void fetch(anatomyUrl('landmarks.json')).then((response) => response.json()).then((data: LandmarkFile) => setLandmarks(data.points));
  }, []);

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

  return (
    <div className="head-viewport" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
      event.preventDefault();
      const layoutId = event.dataTransfer.getData('application/x-cortexlume-layout');
      if (layoutId) placeLayout(layoutId);
    }}>
      <div className="viewport-overlay top-left">
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

      <div className="viewport-overlay bottom-left legend">
        <span><i className="source-dot" /> SOURCE</span><span><i className="detector-dot" /> DETECTOR</span>
        <span>{project.instances.length} PATCH{project.instances.length === 1 ? '' : 'ES'}</span>
      </div>
      <Canvas onPointerMissed={() => selectInstance(selectedInstanceId, null)} camera={{ position: [215, 138, -300], fov: 39 }} dpr={[1, 1.6]} gl={{ antialias: true }}>
        <HeadScene landmarks={landmarks} surfaceRevision={surfaceRevision} onSurfacesReady={() => setSurfaceRevision((value) => value + 1)} />
      </Canvas>
    </div>
  );
}
