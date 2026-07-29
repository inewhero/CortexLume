import { describe, expect, it } from 'vitest';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { useProjectStore } from '../renderer/store/projectStore';
import { createProjectArchive, readProjectArchive } from './projectArchive';

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

  it('opens legacy archives whose manifest predates integrity hashes', () => {
    useProjectStore.getState().newProject();
    const project = structuredClone(useProjectStore.getState().project);
    const legacy = zipSync({
      'manifest.json': strToU8(JSON.stringify({
        format: project.format,
        formatVersion: project.formatVersion,
        projectId: project.id,
        template: project.template,
      })),
      'project.json': strToU8(JSON.stringify(project)),
    });
    expect(readProjectArchive(legacy)).toEqual(project);
  });
});
