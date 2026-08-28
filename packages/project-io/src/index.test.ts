import { describe, expect, it } from 'vitest';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { CortexLumeProjectSchema, type CortexLumeProject } from '@cortexlume/contracts';
import {
  PROJECT_ARCHIVE_LIMITS,
  createProjectArchive,
  preflightProjectArchive,
  readProjectArchive,
  readProjectArchiveDetailed,
  sha256Bytes,
} from './index.js';

function writeU32(data: Uint8Array, offset: number, value: number): void {
  data[offset] = value & 0xff;
  data[offset + 1] = (value >>> 8) & 0xff;
  data[offset + 2] = (value >>> 16) & 0xff;
  data[offset + 3] = (value >>> 24) & 0xff;
}

function centralEntryOffset(data: Uint8Array, name: string): number {
  for (let offset = 0; offset + 46 <= data.length; offset += 1) {
    if (data[offset] === 0x50 && data[offset + 1] === 0x4b
      && data[offset + 2] === 0x01 && data[offset + 3] === 0x02) {
      const nameLength = data[offset + 28]! | (data[offset + 29]! << 8);
      if (new TextDecoder().decode(data.subarray(offset + 46, offset + 46 + nameLength)) === name) return offset;
    }
  }
  throw new Error(`Missing central entry ${name}`);
}

function fixtureProject(): CortexLumeProject {
  const timestamp = '2000-01-01T00:00:00.000Z';
  return {
    format: 'cortexlume-project', formatVersion: 3,
    id: '00000000-0000-4000-8000-000000000001', name: 'Archive fixture',
    createdAt: timestamp, updatedAt: timestamp,
    template: {
      id: 'MNI152NLin6Asym', assetVersion: 'fixture', coordinateConvention: 'RAS+', units: 'mm', verified: true,
      manifestSha256: 'a'.repeat(64), scalpMeshSha256: 'b'.repeat(64), cortexMeshSha256: 'c'.repeat(64), atlasSha256: 'd'.repeat(64),
    },
    layouts: [], instances: [],
    deviceProfile: {
      manufacturer: 'Shimadzu', model: 'LABNIRS', wavelengthsNm: [780, 805, 830], measurementType: 'NIRSCWAMPLITUDE',
      units: 'V', sourceType: 'LASER', detectorType: 'PMT', samplingFrequencyHz: null,
    },
    bidsSettings: { subjectLabel: '01', sessionLabel: '', taskLabel: 'layout', acquisitionLabel: '', runIndex: null },
    projectionSettings: { mode: 'scalp', defaultDepthMm: 25, atlasProbabilityThreshold: 0, optodeRadiusMm: 3.6 },
    verifiedResults: [], digitizerSessions: [],
    functionalTarget: {
      target: { id: 'fixture', label: 'Fixture target', aliases: [], peakRegions: [] },
      vertexCount: 25_000, vertexIndices: [7, 101, 24_999], values: [0.2, 0.8, 1.1],
      provenance: {
        sourceKind: 'nifti-import', sourceSpace: 'MNI152NLin6Asym', targetSpace: 'MNI152NLin6Asym',
        targetSurface: 'Cedalion-ICBM152-25k', statistic: 'z', fileName: 'fixture.nii.gz', mapSha256: 'e'.repeat(64),
      },
    },
    surfaceOverlay: 'functional-target', coverageRegion: null, planning: null,
  };
}

describe('shared project IO', () => {
  it('round-trips v3 sparse targets exactly without migration', () => {
    const project = fixtureProject();
    const restored = readProjectArchiveDetailed(createProjectArchive(project));
    expect(restored.project).toEqual(project);
    expect(restored.sourceFormatVersion).toBe(3);
    expect(restored.migrated).toBe(false);
  });

  it('rejects a schema-valid project that exceeds the project entry limit before zipping', () => {
    const project = fixtureProject();
    const target = project.functionalTarget;
    if (!target) throw new Error('fixture must include a functional target');
    const oversized = {
      ...project,
      functionalTarget: {
        ...target,
        provenance: {
          ...target.provenance,
          validation: { payload: 'x'.repeat(PROJECT_ARCHIVE_LIMITS.projectBytes) },
        },
      },
    };

    expect(CortexLumeProjectSchema.safeParse(oversized).success).toBe(true);
    expect(() => createProjectArchive(oversized)).toThrow(
      'project.json exceeds its uncompressed size limit',
    );
  });

  it('migrates a hash-verified v1 archive in memory', () => {
    const project = fixtureProject();
    const { functionalTarget: _target, surfaceOverlay: _overlay, coverageRegion: _region, planning: _planning, ...base } = project;
    const v1 = { ...base, formatVersion: 1 as const };
    const projectBytes = strToU8(JSON.stringify(v1, null, 2));
    const archive = zipSync({
      'project.json': projectBytes,
      'manifest.json': strToU8(JSON.stringify({
        format: 'cortexlume-project', formatVersion: 1, projectId: project.id,
        projectSha256: sha256Bytes(projectBytes), template: project.template,
      })),
    });
    const result = readProjectArchiveDetailed(archive);
    expect(result.migrated).toBe(true);
    expect(result.project.formatVersion).toBe(3);
    expect(result.project.functionalTarget).toBeNull();
  });

  it('rejects project bytes changed after manifest creation', () => {
    const project = fixtureProject();
    const archive = unzipSync(createProjectArchive(project));
    archive['project.json'] = strToU8(JSON.stringify({ ...project, name: 'Tampered' }, null, 2));
    expect(() => readProjectArchive(zipSync(archive))).toThrow('integrity check failed');
  });

  it('rejects a manifest project name that disagrees with project.json', () => {
    const archive = unzipSync(createProjectArchive(fixtureProject()));
    const manifest = JSON.parse(new TextDecoder().decode(archive['manifest.json'])) as Record<string, unknown>;
    archive['manifest.json'] = strToU8(JSON.stringify({ ...manifest, projectName: 'Different project' }));
    expect(() => readProjectArchive(zipSync(archive))).toThrow('manifest name does not match project.json');
  });

  it('rejects a manifest template that disagrees with project.json', () => {
    const archive = unzipSync(createProjectArchive(fixtureProject()));
    const manifest = JSON.parse(new TextDecoder().decode(archive['manifest.json'])) as Record<string, unknown>;
    archive['manifest.json'] = strToU8(JSON.stringify({
      ...manifest,
      template: { ...(manifest.template as Record<string, unknown>), assetVersion: 'different-template' },
    }));
    expect(() => readProjectArchive(zipSync(archive))).toThrow('manifest template does not match project.json');
  });

  it('accepts a manifest template whose keys use a different order', () => {
    const project = fixtureProject();
    const archive = unzipSync(createProjectArchive(project));
    const manifest = JSON.parse(new TextDecoder().decode(archive['manifest.json'])) as Record<string, unknown>;
    const template = manifest.template as Record<string, unknown>;
    archive['manifest.json'] = strToU8(JSON.stringify({
      ...manifest,
      template: Object.fromEntries(Object.entries(template).reverse()),
    }));
    expect(readProjectArchive(zipSync(archive))).toEqual(project);
  });

  it('refuses unsupported future versions before parsing', () => {
    const project = { ...fixtureProject(), formatVersion: 4 };
    const projectBytes = strToU8(JSON.stringify(project));
    const archive = zipSync({
      'project.json': projectBytes,
      'manifest.json': strToU8(JSON.stringify({
        format: 'cortexlume-project', formatVersion: 4, projectId: project.id,
        projectSha256: sha256Bytes(projectBytes), template: project.template,
      })),
    });
    expect(() => readProjectArchive(archive)).toThrow();
  });

  it('rejects unexpected archive entries before inflation', () => {
    const archive = zipSync({
      'project.json': strToU8('{}'),
      'payload.bin': new Uint8Array([1]),
    });
    expect(() => preflightProjectArchive(archive)).toThrow('unexpected entry');
  });

  it('rejects excessive entry counts before inspecting payloads', () => {
    const archive = zipSync({
      'project.json': strToU8('{}'),
      'manifest.json': strToU8('{}'),
      'extra.json': strToU8('{}'),
    });
    expect(() => preflightProjectArchive(archive)).toThrow('exactly 2 entries');
  });

  it('rejects an allowed-looking archive with an oversized declared entry before inflation', () => {
    const archive = createProjectArchive(fixtureProject()).slice();
    const centralOffset = centralEntryOffset(archive, 'project.json');
    const localOffset = archive[centralOffset + 42]!
      | (archive[centralOffset + 43]! << 8)
      | (archive[centralOffset + 44]! << 16)
      | (archive[centralOffset + 45]! << 24);
    const declaredSize = PROJECT_ARCHIVE_LIMITS.projectBytes + 1;
    writeU32(archive, centralOffset + 24, declaredSize);
    writeU32(archive, localOffset + 22, declaredSize);
    expect(() => preflightProjectArchive(archive)).toThrow('project.json exceeds its uncompressed size limit');
  });

  it('rejects highly compressed entries and oversized compressed buffers', () => {
    const bomb = zipSync({
      'project.json': new Uint8Array(1024 * 1024),
      'manifest.json': strToU8('{}'),
    }, { level: 9 });
    expect(() => preflightProjectArchive(bomb)).toThrow('maximum compression ratio');
    expect(() => preflightProjectArchive(
      new Uint8Array(PROJECT_ARCHIVE_LIMITS.compressedBytes + 1),
    )).toThrow('compressed size exceeds');
  });

  it('rejects central-directory metadata that disagrees with a local header', () => {
    const archive = createProjectArchive(fixtureProject()).slice();
    const centralOffset = centralEntryOffset(archive, 'project.json');
    const localOffset = archive[centralOffset + 42]!
      | (archive[centralOffset + 43]! << 8)
      | (archive[centralOffset + 44]! << 16)
      | (archive[centralOffset + 45]! << 24);
    archive[localOffset + 8] = archive[localOffset + 8] === 0 ? 8 : 0;
    expect(() => preflightProjectArchive(archive)).toThrow('inconsistent local metadata');
  });

});
