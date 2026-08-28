import { existsSync } from 'node:fs';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  durableAtomicCreateExclusive,
  durableAtomicReplace,
  isAlreadyExistsError,
  nativeSecureFileSystem,
  resolveAuthorizedPath,
  stableReadRegularFile,
  type SecureFileHandle,
  type SecureFileStats,
  type SecureFileSystem,
} from './durableFile';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function decorateHandle(
  handle: SecureFileHandle,
  overrides: Partial<Pick<SecureFileHandle, 'read' | 'writeFile' | 'sync' | 'close'>>,
): SecureFileHandle {
  return {
    stat: handle.stat.bind(handle),
    read: overrides.read ?? handle.read.bind(handle),
    writeFile: overrides.writeFile ?? handle.writeFile.bind(handle),
    sync: overrides.sync ?? handle.sync.bind(handle),
    close: overrides.close ?? handle.close.bind(handle),
  };
}

function fakeStats(
  size: number,
  mtimeMs: number,
  ctimeMs: number,
  file = true,
): SecureFileStats {
  return {
    size,
    mtimeMs,
    ctimeMs,
    dev: 1,
    ino: 2,
    isFile: () => file,
    isDirectory: () => !file,
    isSymbolicLink: () => false,
  };
}

function fakeReadFileSystem(
  snapshots: SecureFileStats[],
  reads: Uint8Array[],
): SecureFileSystem {
  return {
    ...nativeSecureFileSystem,
    open: async () => {
      let statIndex = 0;
      let readIndex = 0;
      const handle: SecureFileHandle = {
        stat: async () => snapshots[Math.min(statIndex++, snapshots.length - 1)]!,
        read: async (buffer, offset, length) => {
          const source = reads[Math.min(readIndex++, reads.length - 1)]!;
          const count = Math.min(length, source.byteLength);
          Buffer.from(source).copy(buffer, offset, 0, count);
          return { bytesRead: count };
        },
        writeFile: async () => undefined,
        sync: async () => undefined,
        close: async () => undefined,
      };
      return handle;
    },
  };
}

async function newRoot(prefix = 'cortexlume-durable-'): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function temporaryFiles(root: string): Promise<string[]> {
  return (await readdir(root)).filter((name) => name.endsWith('.tmp'));
}

describe('stableReadRegularFile', () => {
  it('requires a regular file and accepts a timestamp-only touch after re-reading', async () => {
    const directory = await newRoot();
    await expect(stableReadRegularFile(directory, 1024, { label: 'Archive' }))
      .rejects.toThrow('Archive must be a regular file.');

    const bytes = Buffer.from('same bytes');
    const touched = fakeReadFileSystem([
      fakeStats(bytes.length, 1, 1),
      fakeStats(bytes.length, 2, 2),
      fakeStats(bytes.length, 2, 2),
      fakeStats(bytes.length, 2, 2),
    ], [bytes, bytes]);
    await expect(stableReadRegularFile('ignored', 1024, { fs: touched })).resolves.toEqual(bytes);
  });

  it('rejects a same-size in-place mutation even when identity is unchanged', async () => {
    const bytes = Buffer.from('original');
    const changed = Buffer.from('mutated!');
    const mutated = fakeReadFileSystem([
      fakeStats(bytes.length, 1, 1),
      fakeStats(bytes.length, 2, 2),
      fakeStats(bytes.length, 2, 2),
      fakeStats(bytes.length, 2, 2),
    ], [bytes, changed]);
    await expect(stableReadRegularFile('ignored', 1024, { fs: mutated }))
      .rejects.toThrow('changed while it was being read');
  });

  it('does not reject a real file merely because its mtime was touched before opening', async () => {
    const root = await newRoot();
    const file = path.join(root, 'archive.bin');
    await writeFile(file, 'payload');
    await utimes(file, new Date(1_000), new Date(2_000));
    await expect(stableReadRegularFile(file, 1024)).resolves.toEqual(Buffer.from('payload'));
  });
});

describe('durable atomic publication', () => {
  it('keeps the destination absent until a complete exclusive link is published', async () => {
    const root = await newRoot();
    const destination = path.join(root, 'output.cortexlume');
    let enterPublish!: () => void;
    let releasePublish!: () => void;
    const entered = new Promise<void>((resolve) => { enterPublish = resolve; });
    const release = new Promise<void>((resolve) => { releasePublish = resolve; });
    const writing = durableAtomicCreateExclusive(destination, Buffer.from('complete'), {
      beforePublish: async () => {
        enterPublish();
        await release;
      },
    });
    await entered;
    expect(existsSync(destination)).toBe(false);
    // A reader cannot observe the temp's pre-publication state.
    releasePublish();
    await writing;
    expect(await readFile(destination)).toEqual(Buffer.from('complete'));
    expect(await temporaryFiles(root)).toEqual([]);
  });

  it('replaces an existing destination atomically', async () => {
    const root = await newRoot();
    const destination = path.join(root, 'output.cortexlume');
    await writeFile(destination, 'old');
    await durableAtomicReplace(destination, Buffer.from('new'));
    expect(await readFile(destination)).toEqual(Buffer.from('new'));
    expect(await temporaryFiles(root)).toEqual([]);
  });

  it('never overwrites an existing destination and supports concurrent creators', async () => {
    const root = await newRoot();
    const destination = path.join(root, 'output.cortexlume');
    await writeFile(destination, 'old');
    await expect(durableAtomicCreateExclusive(destination, Buffer.from('new')))
      .rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(destination)).toEqual(Buffer.from('old'));
    expect(await temporaryFiles(root)).toEqual([]);

    await rm(destination);
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => (
      durableAtomicCreateExclusive(destination, Buffer.from(`winner-${index}`))
    )));
    const successes = attempts.filter((attempt) => attempt.status === 'fulfilled');
    const failures = attempts.filter((attempt) => attempt.status === 'rejected');
    expect(successes).toHaveLength(1);
    expect(failures.every((attempt) => isAlreadyExistsError(attempt.reason))).toBe(true);
    expect((await readFile(destination)).toString()).toMatch(/^winner-[0-7]$/);
    expect(await temporaryFiles(root)).toEqual([]);
  });

  it.each([
    ['write', 'writeFile'],
    ['file sync', 'sync'],
    ['link', 'link'],
  ] as const)('cleans temp files after %s failure', async (_label, failurePoint) => {
    const root = await newRoot();
    const destination = path.join(root, 'output.cortexlume');
    const failing: SecureFileSystem = { ...nativeSecureFileSystem };
    if (failurePoint === 'link') {
      failing.link = async () => { throw codedError('EIO'); };
    } else {
      failing.open = async (filePath, flags) => {
        const handle = await nativeSecureFileSystem.open(filePath, flags);
        return flags === 'wx'
          ? decorateHandle(handle, {
            ...(failurePoint === 'writeFile' ? { writeFile: async () => { throw codedError('EIO'); } } : {}),
            ...(failurePoint === 'sync' ? { sync: async () => { throw codedError('EIO'); } } : {}),
          })
          : handle;
      };
    }
    await expect(durableAtomicCreateExclusive(destination, Buffer.from('payload'), { fs: failing }))
      .rejects.toMatchObject({ code: 'EIO' });
    expect(existsSync(destination)).toBe(false);
    expect(await temporaryFiles(root)).toEqual([]);
  });

  it('cleans a just-published exclusive inode when post-publication verification fails', async () => {
    const root = await newRoot();
    const destination = path.join(root, 'output.cortexlume');
    const failing: SecureFileSystem = { ...nativeSecureFileSystem };
    failing.open = async (filePath, flags) => {
      if (filePath === root && flags === 'r') throw codedError('EIO');
      return nativeSecureFileSystem.open(filePath, flags);
    };
    await expect(durableAtomicCreateExclusive(destination, Buffer.from('payload'), {
      fs: failing,
      platform: 'linux',
    })).rejects.toMatchObject({ code: 'EIO' });
    expect(existsSync(destination)).toBe(false);
    expect(await temporaryFiles(root)).toEqual([]);
  });

  it('reports Windows parent-directory sync as unsupported without failing the save', async () => {
    const root = await newRoot();
    const destination = path.join(root, 'output.cortexlume');
    const windowsFs: SecureFileSystem = {
      ...nativeSecureFileSystem,
      open: async (filePath, flags) => {
        if (filePath === root && flags === 'r') throw codedError('EPERM');
        return nativeSecureFileSystem.open(filePath, flags);
      },
    };
    const result = await durableAtomicReplace(destination, Buffer.from('payload'), {
      fs: windowsFs,
      platform: 'win32',
    });
    expect(result.parentDirectorySync).toBe('unsupported');
    expect(await readFile(destination)).toEqual(Buffer.from('payload'));
  });
});

describe('resolveAuthorizedPath', () => {
  it('requires existing real directory roots and supports missing output suffixes', async () => {
    const root = await newRoot();
    const resolved = await resolveAuthorizedPath(path.join(root, 'new', 'output.cortexlume'), [root], { mustExist: false });
    expect(resolved).toBe(path.join(root, 'new', 'output.cortexlume'));
    await expect(resolveAuthorizedPath(path.join(root, 'missing-root', 'output.cortexlume'), [path.join(root, 'missing-root')], { mustExist: false }))
      .rejects.toThrow('existing real directory');
  });

  it('rejects a symlink or junction that resolves outside the authorized root', async () => {
    const root = await newRoot();
    const outside = await newRoot('cortexlume-outside-');
    const outsideFile = path.join(outside, 'secret.bin');
    await writeFile(outsideFile, 'secret');
    const linkPath = path.join(root, 'redirect');
    try {
      await symlink(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) return;
      throw error;
    }
    await expect(resolveAuthorizedPath(path.join(linkPath, 'secret.bin'), [root], { mustExist: true }))
      .rejects.toThrow('outside authorized root');
    await expect(resolveAuthorizedPath(path.join(linkPath, 'new.bin'), [root], { mustExist: false }))
      .rejects.toThrow();
  });
});
