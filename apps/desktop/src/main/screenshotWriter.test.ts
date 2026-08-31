import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeRgbaPng } from '../renderer/lib/sceneScreenshot';
import { saveScientificScreenshot, SCIENTIFIC_SCREENSHOT_DIRECTORY } from './screenshotWriter';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'cortexlume-screenshot-'));
  roots.push(root);
  const projectPath = path.join(root, 'study.cortexlume');
  await writeFile(projectPath, 'project');
  return { root, projectPath };
}

describe('scientific screenshot writer', () => {
  it('creates the sibling directory and never overwrites a timestamp collision', async () => {
    const { projectPath } = await fixture();
    const png = encodeRgbaPng(1, 1, new Uint8Array([2, 4, 6, 0]));
    const now = new Date('2026-08-30T12:34:56.789Z');
    const first = await saveScientificScreenshot(projectPath, png, 1, 1, { now });
    const second = await saveScientificScreenshot(projectPath, png, 1, 1, { now });
    expect(first.directory).toBe(await realpath(path.join(path.dirname(projectPath), SCIENTIFIC_SCREENSHOT_DIRECTORY)));
    expect(second.fileName).not.toBe(first.fileName);
    expect(await readFile(first.path)).toEqual(Buffer.from(png));
    expect(await readFile(second.path)).toEqual(Buffer.from(png));
  });

  it('fails closed when the screenshot directory is a junction outside the project directory', async () => {
    const { root, projectPath } = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), 'cortexlume-screenshot-outside-'));
    roots.push(outside);
    const output = path.join(root, SCIENTIFIC_SCREENSHOT_DIRECTORY);
    await symlink(outside, output, process.platform === 'win32' ? 'junction' : 'dir');
    const png = encodeRgbaPng(1, 1, new Uint8Array([0, 0, 0, 0]));
    await expect(saveScientificScreenshot(projectPath, png, 1, 1)).rejects.toThrow();
  });

  it('rejects a non-directory collision at CortexLume_Screenshots', async () => {
    const { root, projectPath } = await fixture();
    await writeFile(path.join(root, SCIENTIFIC_SCREENSHOT_DIRECTORY), 'do not replace');
    const png = encodeRgbaPng(1, 1, new Uint8Array([0, 0, 0, 0]));
    await expect(saveScientificScreenshot(projectPath, png, 1, 1)).rejects.toThrow();
  });
});
