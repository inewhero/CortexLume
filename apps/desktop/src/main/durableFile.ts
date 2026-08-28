import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * The small subset of a Node file handle needed by this module.  Keeping this
 * interface local makes filesystem operations injectable in unit tests without
 * weakening the production implementation (which uses node:fs/promises).
 */
export interface SecureFileHandle {
  stat(): Promise<SecureFileStats>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  writeFile(data: Uint8Array | string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface SecureFileStats {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev?: number;
  ino?: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface SecureFileSystem {
  open(filePath: string, flags: string): Promise<SecureFileHandle>;
  lstat(filePath: string): Promise<SecureFileStats>;
  realpath(filePath: string): Promise<string>;
  mkdir(directory: string, options: { recursive: true }): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  link(source: string, destination: string): Promise<void>;
  rm(filePath: string, options: { force: true }): Promise<void>;
}

/** Native implementation used by the desktop application. */
export const nativeSecureFileSystem: SecureFileSystem = {
  open: async (filePath, flags) => open(filePath, flags) as unknown as SecureFileHandle,
  lstat: async (filePath) => lstat(filePath) as unknown as SecureFileStats,
  realpath,
  mkdir: async (directory, options) => { await mkdir(directory, options); },
  rename: async (source, destination) => { await rename(source, destination); },
  link: async (source, destination) => { await link(source, destination); },
  rm: async (filePath, options) => { await rm(filePath, options); },
};

export interface ReadStableRegularFileOptions {
  label?: string;
  fs?: SecureFileSystem;
}

function meaningfulIdentity(value: number | undefined): boolean {
  return value != null && Number.isFinite(value) && value !== 0;
}

/**
 * Compare identity fields only when both platforms expose meaningful values.
 * In particular, Windows can report an inode value of zero for a valid file.
 * mtime is deliberately not part of this check: antivirus and backup software
 * may touch timestamps without changing the bytes held by an already-open fd.
 */
export function sameOpenFileIdentity(left: SecureFileStats, right: SecureFileStats): boolean {
  if (left.size !== right.size) return false;
  if (meaningfulIdentity(left.dev) && meaningfulIdentity(right.dev) && left.dev !== right.dev) return false;
  if (meaningfulIdentity(left.ino) && meaningfulIdentity(right.ino) && left.ino !== right.ino) return false;
  return true;
}

function sameFileTimestamps(left: SecureFileStats, right: SecureFileStats): boolean {
  return left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

/**
 * Read through one file handle and reject non-regular or changing files.
 * Opening the handle before checking its metadata avoids trusting a later
 * pathname lookup; the remaining bytes are read from that same handle.
 */
export async function stableReadRegularFile(
  filePath: string,
  maximumBytes: number,
  options: ReadStableRegularFileOptions = {},
): Promise<Buffer> {
  const fs = options.fs ?? nativeSecureFileSystem;
  const label = options.label ?? 'File';
  const handle = await fs.open(filePath, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`${label} must be a regular file.`);
    if (!Number.isSafeInteger(before.size) || before.size < 0) {
      throw new Error(`${label} has an invalid size.`);
    }
    if (before.size > maximumBytes) {
      throw new Error(`${label} exceeds the ${maximumBytes} byte limit.`);
    }
    const readAtCurrentSize = async (size: number): Promise<{ bytes: Buffer; offset: number }> => {
      const bytes = Buffer.alloc(size);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return { bytes, offset };
    };
    const firstRead = await readAtCurrentSize(before.size);
    const after = await handle.stat();
    if (!after.isFile() || firstRead.offset !== firstRead.bytes.byteLength || !sameOpenFileIdentity(before, after)) {
      throw new Error(`${label} changed while it was being read.`);
    }
    if (sameFileTimestamps(before, after)) return firstRead.bytes;

    // Timestamp-only touches from antivirus/backup software are benign, but a
    // same-size in-place mutation must not pass on identity alone. Re-read
    // through the same handle and require identical bytes plus a stable second
    // stat snapshot; a continuing change remains fail-closed.
    const verificationBefore = await handle.stat();
    if (!verificationBefore.isFile() || !sameOpenFileIdentity(before, verificationBefore)) {
      throw new Error(`${label} changed while it was being read.`);
    }
    const verificationRead = await readAtCurrentSize(verificationBefore.size);
    const verificationAfter = await handle.stat();
    if (!verificationAfter.isFile()
      || verificationRead.offset !== verificationRead.bytes.byteLength
      || !sameOpenFileIdentity(verificationBefore, verificationAfter)
      || !sameFileTimestamps(verificationBefore, verificationAfter)
      || !firstRead.bytes.equals(verificationRead.bytes)) {
      throw new Error(`${label} changed while it was being read.`);
    }
    return firstRead.bytes;
  } finally {
    await handle.close();
  }
}

export interface DurableAtomicOptions {
  /** Create the destination parent recursively before writing. */
  ensureParent?: boolean;
  /** Test seam or a caller-side cancellation/deadline check before publication. */
  beforePublish?: () => void | Promise<void>;
  /** Revalidate the destination after publication; failure removes only our own link. */
  afterPublish?: () => void | Promise<void>;
  /** Unix requires directory sync. Windows directory sync is best-effort by default. */
  requireParentSync?: boolean;
  /** Injectable for tests; production callers should use the default. */
  fs?: SecureFileSystem;
  /** Test seam for Windows behavior without needing a Windows runner. */
  platform?: NodeJS.Platform;
}

export type ParentDirectorySyncStatus = 'synced' | 'unsupported';

export interface DurableAtomicWriteResult {
  parentDirectorySync: ParentDirectorySyncStatus;
}

interface CodedError {
  code?: unknown;
}

export function isAlreadyExistsError(error: unknown): boolean {
  return (error as CodedError | null)?.code === 'EEXIST';
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  const code = (error as CodedError | null)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EINVAL' || code === 'ENOTSUP'
    || code === 'EOPNOTSUPP' || code === 'EISDIR' || code === 'EBADF';
}

function hasFullIdentity(stats: SecureFileStats): boolean {
  return meaningfulIdentity(stats.dev) && meaningfulIdentity(stats.ino);
}

async function removePublishedIfOwned(
  destination: string,
  publishedIdentity: SecureFileStats | null,
  fs: SecureFileSystem,
): Promise<void> {
  // Never unlink a path after a failed post-publication check unless lstat
  // proves it is still the inode linked by this invocation. If the platform
  // does not expose dev/ino, leave the file for manual recovery rather than
  // risking deletion of a path that won a concurrent reparse race.
  if (!publishedIdentity || !hasFullIdentity(publishedIdentity)) return;
  let current: SecureFileStats;
  try {
    current = await fs.lstat(destination);
  } catch {
    return;
  }
  if (current.isSymbolicLink() || !hasFullIdentity(current)
    || current.dev !== publishedIdentity.dev || current.ino !== publishedIdentity.ino) return;
  await fs.rm(destination, { force: true }).catch(() => undefined);
}

async function syncParentDirectory(
  parent: string,
  fs: SecureFileSystem,
  platform: NodeJS.Platform,
  requireParentSync: boolean,
): Promise<ParentDirectorySyncStatus> {
  let handle: SecureFileHandle | null = null;
  let failure: unknown = null;
  try {
    // Opening a directory and calling sync is supported by Unix filesystems.
    // Windows' Node implementation commonly rejects one of these operations;
    // that limitation is reported explicitly instead of being mislabelled as
    // a durable directory flush.
    handle = await fs.open(parent, 'r');
    await handle.sync();
  } catch (error) {
    failure = error;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        if (!failure) failure = error;
      }
    }
  }
  if (failure) {
    if (platform === 'win32' && !requireParentSync && isUnsupportedDirectorySyncError(failure)) {
      return 'unsupported';
    }
    throw failure;
  }
  return 'synced';
}

/**
 * Publish a complete file atomically. The temp file is created beside the
 * destination, written and fsynced through its handle, and only then becomes
 * visible. `replace: false` uses hard-link creation, whose EEXIST failure is
 * atomic on POSIX and NTFS and never replaces an existing name. There is no
 * unsafe copy/direct-write fallback.
 *
 * Node's portable path APIs cannot close the narrow race between a canonical
 * string-path check and a later pathname operation. Callers still revalidate
 * before and after publication; eliminating that final race requires Unix
 * openat(2) or a Windows native CreateFile reparse-aware helper.
 */
async function durableAtomicPublish(
  destination: string,
  data: Uint8Array | string,
  replace: boolean,
  options: DurableAtomicOptions = {},
): Promise<DurableAtomicWriteResult> {
  const fs = options.fs ?? nativeSecureFileSystem;
  const platform = options.platform ?? process.platform;
  const requireParentSync = options.requireParentSync ?? platform !== 'win32';
  const resolved = path.resolve(destination);
  const parent = path.dirname(resolved);
  if (options.ensureParent ?? false) await fs.mkdir(parent, { recursive: true });

  const temporary = `${resolved}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryExists = false;
  let handle: SecureFileHandle | null = null;
  let published = false;
  let publishedIdentity: SecureFileStats | null = null;
  try {
    handle = await fs.open(temporary, 'wx');
    temporaryExists = true;
    await handle.writeFile(data);
    await handle.sync();
    const temporaryStats = await handle.stat();
    if (!temporaryStats.isFile()) throw new Error('Atomic write temp must be a regular file.');
    publishedIdentity = temporaryStats;
    await handle.close();
    handle = null;

    await options.beforePublish?.();
    if (replace) {
      await fs.rename(temporary, resolved);
      temporaryExists = false;
    } else {
      await fs.link(temporary, resolved);
      published = true;
      // Keep the destination visible only after the complete temp is linked.
      // Removing the private name before syncing the parent leaves no stale
      // temp on a successful call while retaining atomic publication.
      await fs.rm(temporary, { force: true });
      temporaryExists = false;
    }
    await options.afterPublish?.();
    const parentDirectorySync = await syncParentDirectory(parent, fs, platform, requireParentSync);
    return { parentDirectorySync };
  } catch (error) {
    if (published && !replace) await removePublishedIfOwned(resolved, publishedIdentity, fs);
    throw error;
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    if (temporaryExists) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

/** Atomically replace a destination after fully writing and syncing a sibling temp. */
export function durableAtomicReplace(
  destination: string,
  data: Uint8Array | string,
  options: DurableAtomicOptions = {},
): Promise<DurableAtomicWriteResult> {
  return durableAtomicPublish(destination, data, true, options);
}

/**
 * Atomically create a destination without replacing an existing name. The
 * caller can treat EEXIST as a collision and retry with a unique suffix.
 */
export function durableAtomicCreateExclusive(
  destination: string,
  data: Uint8Array | string,
  options: DurableAtomicOptions = {},
): Promise<DurableAtomicWriteResult> {
  return durableAtomicPublish(destination, data, false, options);
}

export interface AuthorizedPathOptions {
  mustExist: boolean;
  label?: string;
  fs?: SecureFileSystem;
}

function normalizedForComparison(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isContained(candidate: string, root: string): boolean {
  const relative = path.relative(normalizedForComparison(root), normalizedForComparison(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function tryLstat(fs: SecureFileSystem, filePath: string): Promise<SecureFileStats | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if ((error as CodedError | null)?.code === 'ENOENT') return null;
    throw error;
  }
}

async function canonicalRoot(root: string, fs: SecureFileSystem): Promise<string> {
  const absolute = path.resolve(root);
  const stats = await tryLstat(fs, absolute);
  if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Authorized root must be an existing real directory: ${root}`);
  }
  const canonical = await fs.realpath(absolute);
  const canonicalStats = await fs.lstat(canonical);
  if (!canonicalStats.isDirectory() || canonicalStats.isSymbolicLink()) {
    throw new Error(`Authorized root must be an existing real directory: ${root}`);
  }
  return canonical;
}

async function canonicalMissingPath(
  absolute: string,
  fs: SecureFileSystem,
): Promise<string> {
  let existingAncestor = path.dirname(absolute);
  const missingSegments = [path.basename(absolute)];
  while (true) {
    const stats = await tryLstat(fs, existingAncestor);
    if (stats) {
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(`Path parent is not a real directory: ${existingAncestor}`);
      }
      return path.join(await fs.realpath(existingAncestor), ...missingSegments);
    }
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) throw new Error(`Could not resolve path parent: ${absolute}`);
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }
}

/**
 * Resolve a path against canonical, existing roots. For a new output, only
 * the missing suffix is appended to a real existing directory; callers must
 * re-run this check after mkdir and immediately before/after publication.
 */
export async function resolveAuthorizedPath(
  candidate: string,
  roots: readonly string[],
  options: AuthorizedPathOptions,
): Promise<string> {
  const fs = options.fs ?? nativeSecureFileSystem;
  const label = options.label ?? 'authorized roots';
  const canonicalRoots = await Promise.all(roots.map((root) => canonicalRoot(root, fs)));
  const absolute = path.resolve(candidate);
  const existing = await tryLstat(fs, absolute);
  const canonicalCandidate = existing
    ? await fs.realpath(absolute)
    : await canonicalMissingPath(absolute, fs);
  if (!canonicalRoots.some((root) => isContained(canonicalCandidate, root))) {
    throw new Error(`Path is outside ${label}: ${candidate}`);
  }
  if (options.mustExist && !existing) {
    throw new Error(`Path does not exist: ${candidate}`);
  }
  // For an existing candidate, resolve again after the containment check. This
  // is a deliberate fail-closed revalidation, not a claim of openat semantics.
  const checked = options.mustExist || existing ? await fs.realpath(absolute) : canonicalCandidate;
  if (!canonicalRoots.some((root) => isContained(checked, root))) {
    throw new Error(`Path is outside ${label}: ${candidate}`);
  }
  return checked;
}
