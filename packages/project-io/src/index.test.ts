import { describe, expect, it } from 'vitest';
import { strToU8, unzipSync, zipSync } from 'fflate';
import type { CortexLumeProject } from '@cortexlume/contracts';
import {
  createProjectArchive,
  readProjectArchive,
  readProjectArchiveDetailed,
  sha256Bytes,
} from './index.js';

function fixtureProject(): CortexLumeProject {
  const timestamp = '2000-01-01T00:00:00.000Z';
  return {
    format: 'cortexlume-project', formatVersion: 2,
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
    projectionSettings: { mode: 'scalp', defaultDepthMm: 25, pairDepthOverridesMm: {}, atlasProbabilityThreshold: 0, optodeRadiusMm: 3.6 },
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
  it('round-trips v2 sparse targets exactly', () => {
    const project = fixtureProject();
    expect(readProjectArchive(createProjectArchive(project))).toEqual(project);
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
    expect(result.project.formatVersion).toBe(2);
    expect(result.project.functionalTarget).toBeNull();
  });

  it('rejects project bytes changed after manifest creation', () => {
    const project = fixtureProject();
    const archive = unzipSync(createProjectArchive(project));
    archive['project.json'] = strToU8(JSON.stringify({ ...project, name: 'Tampered' }, null, 2));
    expect(() => readProjectArchive(zipSync(archive))).toThrow('integrity check failed');
  });

  it('refuses unsupported future versions before parsing', () => {
    const project = { ...fixtureProject(), formatVersion: 3 };
    const projectBytes = strToU8(JSON.stringify(project));
    const archive = zipSync({
      'project.json': projectBytes,
      'manifest.json': strToU8(JSON.stringify({
        format: 'cortexlume-project', formatVersion: 3, projectId: project.id,
        projectSha256: sha256Bytes(projectBytes), template: project.template,
      })),
    });
    expect(() => readProjectArchive(archive)).toThrow();
  });
});
