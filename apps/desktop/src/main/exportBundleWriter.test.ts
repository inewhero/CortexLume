import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createUniqueExportDirectory,
  enqueueDestinationWrite,
  EXPORT_BUNDLE_LIMITS,
  validatedExportEntries,
  writeExportBundle,
} from './exportBundleWriter';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cortexlume-export-bundle-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('export bundle writer', () => {
  it('reserves collision-safe human-readable export directories under pre-existing and concurrent use', async () => {
    const parent = await temporaryDirectory();
    await mkdir(path.join(parent, 'CortexLume_AtlasViewer_Export'));
    const directories = await Promise.all(Array.from({ length: 4 }, () => (
      createUniqueExportDirectory(parent, 'CortexLume_AtlasViewer_Export')
    )));

    expect(directories.map((directory) => path.basename(directory)).sort()).toEqual([
      'CortexLume_AtlasViewer_Export-2',
      'CortexLume_AtlasViewer_Export-3',
      'CortexLume_AtlasViewer_Export-4',
      'CortexLume_AtlasViewer_Export-5',
    ]);
    expect(new Set(directories).size).toBe(directories.length);
  });

  it('rejects a selected export root that is a symlink or reparse point', async () => {
    const target = await temporaryDirectory();
    const linkParent = await temporaryDirectory();
    const linkedRoot = path.join(linkParent, 'linked-export-root');
    await symlink(target, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(createUniqueExportDirectory(linkedRoot, 'CortexLume_AtlasViewer_Export'))
      .rejects.toThrow(/existing real directory|symbolic link|reparse point/);
    expect(await readdir(target)).toEqual([]);
  });

  it('atomically preserves Uint8Array bytes while encoding strings as UTF-8', async () => {
    const directory = await temporaryDirectory();
    const binary = Uint8Array.from([0x00, 0xff, 0x80, 0x49, 0x4d]);
    const files = await writeExportBundle(directory, {
      files: {
        'probe.SD': binary,
        'nested/说明.txt': 'MNI · mm\n',
      },
      warnings: [],
    });

    expect(files).toEqual(['probe.SD', 'nested/说明.txt']);
    expect([...await readFile(path.join(directory, 'probe.SD'))]).toEqual([...binary]);
    expect(await readFile(path.join(directory, 'nested', '说明.txt'), 'utf8')).toBe('MNI · mm\n');
  });

  it('rejects traversal before creating a file outside the selected directory', async () => {
    const directory = await temporaryDirectory();
    const outside = path.join(path.dirname(directory), `${path.basename(directory)}-outside.SD`);
    await expect(writeExportBundle(directory, {
      files: {
        'would-have-been-written.txt': 'partial export',
        '../outside.SD': Uint8Array.of(1, 2, 3),
      },
      warnings: [],
    })).rejects.toThrow(/Invalid export path/);
    await expect(readFile(outside)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(directory, 'would-have-been-written.txt')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('publishes the explicit byte and file budgets used for every export format', () => {
    expect(EXPORT_BUNDLE_LIMITS).toEqual({
      files: 4_096,
      filenameCharacters: 1_024,
      fileBytes: 64 * 1024 * 1024,
      bundleBytes: 128 * 1024 * 1024,
    });
    const smallLimits = { files: 2, filenameCharacters: 32, fileBytes: 4, bundleBytes: 6 } as const;
    expect(() => validatedExportEntries({ files: { 'too-large.bin': Uint8Array.of(1, 2, 3, 4, 5) }, warnings: [] }, smallLimits))
      .toThrow(/64 MiB/);
    expect(() => validatedExportEntries({ files: { 'first.txt': 'éé', 'second.bin': Uint8Array.of(1, 2, 3) }, warnings: [] }, smallLimits))
      .toThrow(/128 MiB/);
  });

  it('serializes concurrent writes to the same resolved destination', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const destination = path.join(await temporaryDirectory(), 'same.SD');
    const first = enqueueDestinationWrite(destination, async () => {
      order.push('first:start');
      markFirstStarted();
      await firstGate;
      order.push('first:end');
    });
    const second = enqueueDestinationWrite(destination, async () => { order.push('second'); });
    await firstStarted;
    expect(order).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('durably serializes concurrent bundles targeting the same real file', async () => {
    const directory = await temporaryDirectory();
    const firstBytes = new Uint8Array(1024 * 1024).fill(0x11);
    const secondBytes = Uint8Array.from([0x4d, 0x41, 0x54, 0x35, 0x22]);
    const [firstFiles, secondFiles] = await Promise.all([
      writeExportBundle(directory, { files: { 'same.SD': firstBytes }, warnings: [] }),
      writeExportBundle(directory, { files: { 'same.SD': secondBytes }, warnings: [] }),
    ]);

    expect(firstFiles).toEqual(['same.SD']);
    expect(secondFiles).toEqual(['same.SD']);
    expect([...await readFile(path.join(directory, 'same.SD'))]).toEqual([...secondBytes]);
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
