import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshBVH } from 'three-mesh-bvh';
import type { Vec3 } from '@cortexlume/contracts';
import { useProjectStore } from '../renderer/store/projectStore';
import { calibrateDigitizer, nearestOptodeMappings, type FivePointLabel } from '../renderer/lib/digitizer';
import {
  fittedOptodePositions,
  rasFromThree,
  registerSurfaceProjectors,
  threeFromRas,
} from '../renderer/lib/geometry';
import { materializeProjectionSnapshot } from '../renderer/lib/projectionSnapshot';
import { createProjectArchive, readProjectArchive } from './projectArchive';
import { buildBrainNetExport } from './projectExport';
import { parseDigitizerFile } from './digitizerImport';

const templateFivePoint: Record<FivePointLabel, Vec3> = {
  Nz: [0, 84, -43],
  Iz: [0, -114, -30],
  LPA: [-75.09, -19.49, -47.98],
  RPA: [76, -19.45, -47.7],
  Cz: [-0.2107, -11.5944, 100.5705],
};

function geometryFromGlb(buffer: Buffer): Promise<THREE.BufferGeometry> {
  return new Promise((resolve, reject) => {
    const data = Uint8Array.from(buffer).buffer;
    new GLTFLoader().parse(data, '', (gltf) => {
      let geometry: THREE.BufferGeometry | undefined;
      gltf.scene.traverse((object) => {
        if (!geometry && object instanceof THREE.Mesh) geometry = object.geometry;
      });
      if (!geometry) {
        reject(new Error('Anatomical GLB does not contain a mesh.'));
        return;
      }
      const prepared = geometry.clone();
      prepared.computeVertexNormals();
      prepared.computeBoundingSphere();
      resolve(prepared);
    }, reject);
  });
}

beforeAll(async () => {
  const [scalpGeometry, brainGeometry] = await Promise.all([
    readFile(new URL('../../public/anatomy/scalp.glb', import.meta.url)).then(geometryFromGlb),
    readFile(new URL('../../public/anatomy/brain_scientific.glb', import.meta.url)).then(geometryFromGlb),
  ]);
  const scalpBvh = new MeshBVH(scalpGeometry);
  const brainBvh = new MeshBVH(brainGeometry);
  const scalpCenter = scalpGeometry.boundingSphere!.center.clone();
  const brainCenter = brainGeometry.boundingSphere!.center.clone();
  const scalpContact = (rasPoint: Vec3) => {
    const input = new THREE.Vector3(...threeFromRas(rasPoint));
    return scalpBvh.closestPointToPoint(input)?.point.clone() ?? input;
  };
  const scalpSphereCenter = (rasPoint: Vec3, radiusMm: number) => {
    const contact = scalpContact(rasPoint);
    return contact.addScaledVector(contact.clone().sub(scalpCenter).normalize(), radiusMm);
  };
  registerSurfaceProjectors({
    verified: true,
    source: 'test anatomical meshes',
    scalp: (point) => rasFromThree(scalpContact(point)),
    scalpSphereCenter: (point, radius) => rasFromThree(scalpSphereCenter(point, radius)),
    cortex: (point, radius) => {
      const origin = scalpSphereCenter(point, radius);
      const direction = origin.clone().multiplyScalar(-1).normalize();
      if (radius <= 0) {
        const hit = brainBvh.raycastFirst(new THREE.Ray(origin, direction), THREE.DoubleSide, 0.05, 320);
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
            samples.push({ x: Math.cos(angle) * radius * fraction, y: Math.sin(angle) * radius * fraction });
          }
        }
        let firstCenterDistance = Number.POSITIVE_INFINITY;
        for (const sample of samples) {
          const sampleOrigin = origin.clone().addScaledVector(u, sample.x).addScaledVector(v, sample.y);
          const hit = brainBvh.raycastFirst(new THREE.Ray(sampleOrigin, direction), THREE.DoubleSide, 0.05, 320);
          if (!hit) continue;
          const sphereInset = Math.sqrt(Math.max(0, radius ** 2 - sample.x ** 2 - sample.y ** 2));
          firstCenterDistance = Math.min(firstCenterDistance, hit.distance - sphereInset);
        }
        if (Number.isFinite(firstCenterDistance)) {
          return rasFromThree(origin.addScaledVector(direction, Math.max(0, firstCenterDistance)));
        }
      }
      const nearest = brainBvh.closestPointToPoint(origin);
      if (!nearest) return point;
      const outward = nearest.point.clone().sub(brainCenter).normalize();
      return rasFromThree(nearest.point.clone().addScaledVector(outward, radius));
    },
  });
});

describe('MNE / Polhemus digitizer workflow', () => {
  it('imports an ISOTRAK .eeg file, maps a patch, archives it, and exports its provenance', async () => {
    const fixture = new Uint8Array(await readFile(new URL('./__fixtures__/mne-polhemus.eeg', import.meta.url)));
    const imported = parseDigitizerFile('mne-polhemus.eeg', fixture);
    expect(imported).toMatchObject({ format: 'EEG', suggestedUnit: 'm' });
    expect(imported.points).toHaveLength(20);
    expect(imported.points.every((point) => point.kind === 'unknown')).toBe(true);

    const assignments = {
      Nz: imported.points[0]!.id,
      Iz: imported.points[1]!.id,
      LPA: imported.points[2]!.id,
      RPA: imported.points[3]!.id,
      Cz: imported.points[4]!.id,
    };
    const session = calibrateDigitizer({
      name: 'MNE Polhemus fixture',
      source: { format: imported.format, fileName: imported.fileName, sha256: imported.sha256 },
      points: imported.points,
    }, assignments, templateFivePoint, imported.suggestedUnit);
    expect(session.calibration.rmsResidualMm).toBeGreaterThan(0.1);
    expect(session.calibration.rmsResidualMm).toBeLessThan(3);

    useProjectStore.getState().newProject();
    useProjectStore.getState().placeLayout(useProjectStore.getState().activeLayoutId);
    const project = useProjectStore.getState().project;
    const instance = project.instances[0]!;
    const layout = project.layouts.find((candidate) => candidate.id === instance.definitionId)!;
    const designed = fittedOptodePositions(layout, instance);
    const targets = layout.optodes.map((optode) => ({
      instanceId: instance.id,
      optodeId: optode.id,
      label: optode.label,
      type: optode.type,
      rasMm: designed.get(optode.id)!,
    }));
    const optodePointIds = imported.points.slice(5).map((point) => point.id);
    const mappings = nearestOptodeMappings(session, optodePointIds, targets);
    expect(mappings).toHaveLength(layout.optodes.length);
    expect(new Set(mappings.map((mapping) => mapping.pointId)).size).toBe(layout.optodes.length);

    useProjectStore.getState().confirmDigitizerMapping(session, mappings);
    const mappedProject = structuredClone(useProjectStore.getState().project);
    const derived = mappedProject.instances.find((candidate) => candidate.derivedFromInstanceId === instance.id)!;
    expect(mappedProject.instances.find((candidate) => candidate.id === instance.id)?.visible).toBe(false);
    expect(derived.digitizerPositions).toHaveLength(15);

    const restored = readProjectArchive(createProjectArchive(mappedProject, 'test'));
    expect(restored.digitizerSessions[0]).toMatchObject({
      name: 'MNE Polhemus fixture',
      source: { format: 'EEG', fileName: 'mne-polhemus.eeg', sha256: imported.sha256 },
    });
    expect(restored.digitizerSessions[0]?.optodeMappings).toHaveLength(15);

    const exported = buildBrainNetExport(materializeProjectionSnapshot(restored));
    const metadata = JSON.parse(exported.files['cortexlume_export.json']!);
    expect(metadata.technical.digitizerSessions[0].source).toEqual({
      format: 'EEG', fileName: 'mne-polhemus.eeg', sha256: imported.sha256,
    });
    expect(metadata.technical.instances.find((candidate: { id: string }) => candidate.id === derived.id).digitizerPositions).toHaveLength(15);
    const optodeRows = exported.files['cortexlume_optodes.csv']!.trim().split(/\r?\n/);
    expect(optodeRows).toHaveLength(16);
    expect(optodeRows.slice(1).every((row) => row.split(',').slice(3, 12).every((value) => value !== ''))).toBe(true);
    const brainNetRows = exported.files['cortexlume_brainnet.node']!.trim().split(/\r?\n/);
    expect(brainNetRows).toHaveLength(15);
    expect(brainNetRows.every((row) => /^[-\d.]+ [-\d.]+ [-\d.]+ [12] 4\.000 P02-[SD]\d+$/.test(row))).toBe(true);
    expect(exported.files['cortexlume_open_brainnet.m']).toContain('BrainNet_MapCfg(surfacePath, nodePath)');

    const outputDirectory = process.env.CORTEXLUME_BRAINNET_E2E_DIR;
    if (outputDirectory) {
      await mkdir(outputDirectory, { recursive: true });
      await Promise.all(Object.entries(exported.files).map(([name, contents]) =>
        writeFile(path.join(outputDirectory, name), contents, 'utf8')));
    }
  });
});
