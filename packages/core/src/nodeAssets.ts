import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Vec3 } from '@cortexlume/contracts';
import { HeadModel } from './headModel.js';

interface TemplateManifest {
  verified: boolean;
  atlasGate: { passed: boolean };
  correspondenceGate: { passed: boolean };
  scienceGate: { passed: boolean };
  files: Record<string, { path: string; sha256: string }>;
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

async function readLocked(root: string, record: { path: string; sha256: string }): Promise<Buffer> {
  const data = await readFile(path.join(root, record.path));
  const normalized = /\.(?:json|csv|xml|txt)$/i.test(record.path) ? Buffer.from(data.toString('utf8').replace(/\r\n/g, '\n')) : data;
  if (sha256(normalized) !== record.sha256) throw new Error(`Asset hash mismatch: ${record.path}`);
  return data;
}

function geometryFromGlb(data: Buffer): Promise<THREE.BufferGeometry> {
  return new Promise((resolve, reject) => {
    const array = Uint8Array.from(data).buffer;
    new GLTFLoader().parse(array, '', (gltf) => {
      let geometry: THREE.BufferGeometry | undefined;
      gltf.scene.traverse((object) => { if (!geometry && object instanceof THREE.Mesh) geometry = object.geometry; });
      if (!geometry) return reject(new Error('Anatomical GLB does not contain a mesh.'));
      const prepared = geometry.clone();
      prepared.computeBoundingSphere();
      resolve(prepared);
    }, reject);
  });
}

function parseVertexCoordinates(data: Buffer): Vec3[] {
  const rows = data.toString('utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const headings = rows.shift()!.split(',');
  const vertex = headings.indexOf('vertex');
  const r = headings.indexOf('mni152_r'); const a = headings.indexOf('mni152_a'); const s = headings.indexOf('mni152_s');
  if ([vertex, r, a, s].some((index) => index < 0)) throw new Error('Vertex coordinate asset columns are invalid.');
  return rows.map((row, index): Vec3 => {
    const cells = row.split(',');
    if (Number(cells[vertex]) !== index) throw new Error('Vertex coordinate asset order is invalid.');
    const point: Vec3 = [Number(cells[r]), Number(cells[a]), Number(cells[s])];
    if (point.some((value) => !Number.isFinite(value))) throw new Error('Vertex coordinate asset contains an invalid value.');
    return point;
  });
}

export interface LoadedHeadModel {
  headModel: HeadModel;
  assetHashes: Record<string, string>;
  manifest: TemplateManifest;
}

export async function loadHeadModelFromAssets(templateRoot: string): Promise<LoadedHeadModel> {
  const manifest = JSON.parse(await readFile(path.join(templateRoot, 'manifest.json'), 'utf8')) as TemplateManifest;
  if (!manifest.verified || !manifest.atlasGate?.passed || !manifest.correspondenceGate?.passed || !manifest.scienceGate?.passed) {
    throw new Error('Locked template science gate did not pass.');
  }
  const required = [
    'scalpGlb',
    'brainScientificGlb',
    'brainVertexCoordinates',
    'brainVertexAreas',
    'harvardOxfordIndex',
    'harvardOxfordSurface25k',
    'plannerSurfaceAssets',
  ];
  for (const key of required) if (!manifest.files[key]) throw new Error(`Required HeadModel asset is missing from manifest: ${key}`);
  const [scalpData, cortexData, coordinateData, areaData] = await Promise.all([
    readLocked(templateRoot, manifest.files.scalpGlb!),
    readLocked(templateRoot, manifest.files.brainScientificGlb!),
    readLocked(templateRoot, manifest.files.brainVertexCoordinates!),
    readLocked(templateRoot, manifest.files.brainVertexAreas!),
  ]);
  await Promise.all([
    readLocked(templateRoot, manifest.files.harvardOxfordIndex!),
    readLocked(templateRoot, manifest.files.harvardOxfordSurface25k!),
    readLocked(templateRoot, manifest.files.plannerSurfaceAssets!),
  ]);
  if (areaData.byteLength !== 25_000 * 4) throw new Error('Vertex-area asset length mismatch.');
  const vertexAreas = new Float32Array(areaData.buffer.slice(areaData.byteOffset, areaData.byteOffset + areaData.byteLength));
  const [scalpGeometry, cortexGeometry] = await Promise.all([geometryFromGlb(scalpData), geometryFromGlb(cortexData)]);
  return {
    headModel: new HeadModel({
      scalpGeometry,
      cortexGeometry,
      surfaceVerticesRasMm: parseVertexCoordinates(coordinateData),
      vertexAreasMm2: vertexAreas,
    }),
    assetHashes: Object.fromEntries(required.map((key) => [key, manifest.files[key]!.sha256])),
    manifest,
  };
}
