import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NIFTI_TEMP_DIRECTORY, withStagedNiftiFile } from './index.js';

describe('NIfTI staging', () => {
  it('passes a private staged path to the operation and cleans it afterwards', async () => {
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'cortexlume-nifti-source-'));
    const sourcePath = path.join(sourceRoot, 'target.nii.gz');
    const sourceBytes = Buffer.from('fixture nifti bytes');
    await writeFile(sourcePath, sourceBytes);

    let stagedPath = '';
    let stagedName = '';
    const result = await withStagedNiftiFile(sourcePath, async (pathName, fileName) => {
      stagedPath = pathName;
      stagedName = fileName;
      expect(path.dirname(pathName)).toBe(await realpath(NIFTI_TEMP_DIRECTORY));
      expect(await readFile(pathName)).toEqual(sourceBytes);
      return 'mapped';
    });

    expect(result).toBe('mapped');
    expect(stagedName).toBe('target.nii.gz');
    expect(stagedPath).not.toBe(sourcePath);
    expect(existsSync(stagedPath)).toBe(false);
  });

  it('does not stage unsupported extensions', async () => {
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'cortexlume-nifti-source-'));
    const sourcePath = path.join(sourceRoot, 'target.txt');
    await writeFile(sourcePath, 'not nifti');
    await expect(withStagedNiftiFile(sourcePath, async () => undefined))
      .rejects.toThrow('must end in .nii or .nii.gz');
  });
});
