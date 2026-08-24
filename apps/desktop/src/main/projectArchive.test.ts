import { describe, expect, it } from 'vitest';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { useProjectStore } from '../renderer/store/projectStore';
import { createProjectArchive, readProjectArchive, readProjectArchiveDetailed, sha256Bytes } from './projectArchive';

describe('CortexLume project archive', () => {
  it('round-trips a validated project', () => {
    useProjectStore.getState().newProject();
    const project = structuredClone(useProjectStore.getState().project);
    const restored = readProjectArchive(createProjectArchive(project, '0.1.1'));
    expect(restored).toEqual(project);
  });

  it('rejects a project.json modified after the archive manifest was written', () => {
    useProjectStore.getState().newProject();
    const archive = unzipSync(createProjectArchive(useProjectStore.getState().project, '0.1.1'));
    const modified = {
      ...useProjectStore.getState().project,
      name: 'Modified outside CortexLume',
    };
    const tampered = zipSync({
      ...archive,
      'project.json': strToU8(JSON.stringify(modified, null, 2)),
    });
    expect(() => readProjectArchive(tampered)).toThrow('integrity check failed');
  });

  it('migrates a valid v1 archive to v2 without changing scientific data', () => {
    useProjectStore.getState().newProject();
    const project = structuredClone(useProjectStore.getState().project);
    const { functionalTarget: _functionalTarget, surfaceOverlay: _surfaceOverlay, coverageRegion: _coverageRegion, planning: _planning, ...legacyProject } = project;
    const v1 = { ...legacyProject, formatVersion: 1 as const };
    const projectBytes = strToU8(JSON.stringify(v1, null, 2));
    const legacy = zipSync({
      'manifest.json': strToU8(JSON.stringify({
        format: v1.format,
        formatVersion: 1,
        projectId: v1.id,
        projectSha256: sha256Bytes(projectBytes),
        template: v1.template,
      })),
      'project.json': projectBytes,
    });
    const restored = readProjectArchiveDetailed(legacy);
    expect(restored.migrated).toBe(true);
    expect(restored.sourceFormatVersion).toBe(1);
    expect(restored.project).toEqual(project);
  });

  it('preserves a sparse functional target and overlay exactly', () => {
    useProjectStore.getState().newProject();
    const map = {
      target: { id: 'working-memory', label: 'working memory', aliases: [], peakRegions: [] },
      vertexCount: 25_000 as const,
      vertexIndices: [4, 17, 24_999],
      values: [0.25, 1.5, 3.25],
      provenance: {
        sourceKind: 'neurosynth-quick' as const,
        sourceSpace: 'NeurosynthMNI152-2mm',
        targetSpace: 'MNI152NLin6Asym' as const,
        targetSurface: 'Cedalion-ICBM152-25k' as const,
        statistic: 'association-test z',
        mapSha256: 'a'.repeat(64),
      },
    };
    useProjectStore.getState().setFunctionalTarget(map);
    const project = structuredClone(useProjectStore.getState().project);
    const restored = readProjectArchive(createProjectArchive(project));
    expect(restored.functionalTarget).toEqual(map);
    expect(restored.surfaceOverlay).toBe('functional-target');
  });
});
