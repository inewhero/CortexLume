import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readProjectArchiveDetailed } from './index';

const examples = fileURLToPath(new URL('../../../examples', import.meta.url));
const cases = path.join(examples, 'cases');
const readProject = (caseName: string, fileName: string) => readProjectArchiveDetailed(
  readFileSync(path.join(cases, caseName, fileName)),
).project;

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

describe('optional example dataset', () => {
  it('ships five self-contained cases with valid v2 projects', () => {
    const caseDirectories = readdirSync(cases, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    expect(caseDirectories.map((entry) => entry.name)).toEqual([
      '01-quick-start',
      '02-irregular-patch',
      '03-digitizer-five-point',
      '04-digitizer-polhemus',
      '05-nifti-functional-target',
    ]);
    for (const entry of caseDirectories) {
      const directory = path.join(cases, entry.name);
      expect(statSync(path.join(directory, 'README.md')).size).toBeGreaterThan(100);
      expect(statSync(path.join(directory, 'data')).isDirectory()).toBe(true);
      const projectFiles = walk(directory).filter((file) => file.endsWith('.cortexlume'));
      expect(projectFiles.length).toBeGreaterThan(0);
      for (const projectFile of projectFiles) {
        const archive = readProjectArchiveDetailed(readFileSync(projectFile));
        expect(archive.sourceFormatVersion).toBe(2);
        expect(archive.migrated).toBe(false);
        expect(archive.project.template.verified).toBe(true);
      }
    }
  });

  it('exercises the promised geometry, digitizer and NIfTI states', () => {
    const irregular = readProject('02-irregular-patch', 'irregular-patch.cortexlume');
    expect(irregular.layouts[0]?.optodes).toHaveLength(25);
    expect(irregular.layouts[0]?.pairs.length).toBeGreaterThan(25);

    const fivePoint = readProject('03-digitizer-five-point', 'five-point-calibrated.cortexlume');
    expect(fivePoint.digitizerSessions[0]?.points).toHaveLength(5);
    expect(fivePoint.instances.some((instance) => instance.derivedFromInstanceId != null && instance.visible)).toBe(true);

    const polhemus = readProject('04-digitizer-polhemus', 'polhemus-calibrated.cortexlume');
    expect(polhemus.digitizerSessions[0]?.points).toHaveLength(20);
    expect(polhemus.digitizerSessions[0]?.optodeMappings).toHaveLength(15);
    expect(polhemus.instances.find((instance) => instance.visible)?.digitizerPositions).toHaveLength(15);

    const nifti = readProject('05-nifti-functional-target', 'nifti-visual-target.cortexlume');
    expect(nifti.surfaceOverlay).toBe('functional-target');
    expect(nifti.functionalTarget?.vertexCount).toBe(25_000);
    expect(nifti.functionalTarget?.provenance).toMatchObject({
      sourceKind: 'nifti-import',
      sourceSpace: 'NeurosynthMNI152-2mm',
      fileName: 'bilateral_visual_target_z.nii.gz',
    });
  });

  it('records hashes for every distributed source file', () => {
    const manifest = JSON.parse(readFileSync(path.join(examples, 'manifest.json'), 'utf8')) as {
      files: Array<{ path: string; bytes: number; sha256: string }>;
    };
    const actual = walk(examples)
      .filter((file) => path.basename(file) !== 'manifest.json')
      .map((file) => ({
        path: path.relative(examples, file).replaceAll('\\', '/'),
        bytes: statSync(file).size,
        sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
    expect(manifest.files).toEqual(actual);
  });
});
