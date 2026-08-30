import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { durableAtomicReplace, isAlreadyExistsError, resolveAuthorizedPath } from './durableFile';

export interface WritableExportBundle {
  files: Record<string, string | Uint8Array>;
  warnings: string[];
}

export interface ExportBundleWriteOptions {
  signal?: AbortSignal;
  deadline?: number;
  onProgress?: (completed: number, total: number, phase: string) => void;
}

export interface ExportBundleLimits {
  files: number;
  filenameCharacters: number;
  fileBytes: number;
  bundleBytes: number;
}

export const EXPORT_BUNDLE_LIMITS: Readonly<ExportBundleLimits> = Object.freeze({
  files: 4_096,
  filenameCharacters: 1_024,
  fileBytes: 64 * 1024 * 1024,
  bundleBytes: 128 * 1024 * 1024,
});

const destinationWrites = new Map<string, Promise<void>>();
const exportRootWrites = new Map<string, Promise<unknown>>();

function checkWriteGuard(options: ExportBundleWriteOptions): void {
  if (options.signal?.aborted) throw new Error('Project export cancelled');
  if (options.deadline != null && Date.now() >= options.deadline) {
    throw new Error('Project export exceeded its overall time budget');
  }
}

function contentBytes(content: string | Uint8Array): number {
  return typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.byteLength;
}

export function validatedExportEntries(
  bundle: WritableExportBundle,
  limits: Readonly<ExportBundleLimits> = EXPORT_BUNDLE_LIMITS,
): Array<[string, string | Uint8Array]> {
  const files = Object.entries(bundle.files);
  if (files.length > limits.files) {
    throw new Error(`Export bundle exceeds the ${limits.files} file limit.`);
  }
  let bundleBytes = 0;
  for (const [filename, content] of files) {
    if (filename.length === 0 || filename.length > limits.filenameCharacters || filename.includes('\0')) {
      throw new Error(`Invalid export filename: ${filename || '(empty)'}`);
    }
    const bytes = contentBytes(content);
    if (bytes > limits.fileBytes) {
      throw new Error(`Export file exceeds the 64 MiB limit: ${filename}`);
    }
    bundleBytes += bytes;
    if (!Number.isSafeInteger(bundleBytes) || bundleBytes > limits.bundleBytes) {
      throw new Error('Export bundle exceeds the 128 MiB limit.');
    }
  }
  return files;
}

function comparable(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * Reserve one human-readable child directory without reusing or replacing a
 * previous export. mkdir is the collision arbiter, so concurrent calls cannot
 * both claim the same suffix.
 */
export async function createUniqueExportDirectory(
  selectedDirectory: string,
  baseName: string,
): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,127}$/.test(baseName)) {
    throw new Error(`Invalid export directory name: ${baseName || '(empty)'}`);
  }
  const requestedRoot = path.resolve(selectedDirectory);
  const exportRoot = await resolveAuthorizedPath(requestedRoot, [requestedRoot], {
    mustExist: true,
    label: 'selected export directory',
  });
  if (comparable(exportRoot) !== comparable(requestedRoot)) {
    throw new Error('Selected export directory must not be a symbolic link or reparse point.');
  }
  for (let suffix = 1; suffix <= 10_000; suffix += 1) {
    const directoryName = suffix === 1 ? baseName : `${baseName}-${suffix}`;
    const candidate = path.join(exportRoot, directoryName);
    // Revalidate the parent immediately before the pathname-based mkdir. The
    // shared writer performs the same containment checks again before files.
    const checkedRoot = await resolveAuthorizedPath(requestedRoot, [exportRoot], {
      mustExist: true,
      label: 'selected export directory',
    });
    if (comparable(checkedRoot) !== comparable(exportRoot)) {
      throw new Error('Selected export directory changed before export.');
    }
    try {
      await mkdir(candidate);
    } catch (error) {
      if (isAlreadyExistsError(error)) continue;
      throw error;
    }
    const checkedCandidate = await resolveAuthorizedPath(candidate, [exportRoot], {
      mustExist: true,
      label: 'selected export directory',
    });
    if (comparable(checkedCandidate) !== comparable(candidate)) {
      throw new Error('Created export directory resolved through a symbolic link or reparse point.');
    }
    return checkedCandidate;
  }
  throw new Error('Could not reserve a unique export directory after 10,000 attempts.');
}

async function resolveSafeDestination(exportRoot: string, filename: string): Promise<string> {
  if (path.isAbsolute(filename)) throw new Error(`Invalid export path: ${filename}`);
  const candidate = path.resolve(exportRoot, filename);
  const relative = path.relative(exportRoot, candidate);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Invalid export path: ${filename}`);
  }
  const authorized = await resolveAuthorizedPath(candidate, [exportRoot], {
    mustExist: false,
    label: 'selected export directory',
  });
  // Do not follow pre-existing reparse points or symlinks in a bundle path.
  // A selected real root plus literal descendants gives the user an auditable
  // destination and keeps the final rename on the path that was validated.
  if (comparable(authorized) !== comparable(candidate)) {
    throw new Error(`Export path contains a symbolic link or reparse point: ${filename}`);
  }
  return authorized;
}

export async function enqueueDestinationWrite(
  destination: string,
  task: () => Promise<void>,
): Promise<void> {
  const key = comparable(path.resolve(destination));
  const previous = destinationWrites.get(key) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(task);
  destinationWrites.set(key, write);
  try {
    await write;
  } finally {
    if (destinationWrites.get(key) === write) destinationWrites.delete(key);
  }
}

async function writeValidatedExportBundle(
  directory: string,
  files: Array<[string, string | Uint8Array]>,
  options: ExportBundleWriteOptions = {},
): Promise<string[]> {
  checkWriteGuard(options);
  await mkdir(directory, { recursive: true });
  const requestedRoot = path.resolve(directory);
  const exportRoot = await resolveAuthorizedPath(requestedRoot, [requestedRoot], {
    mustExist: true,
    label: 'selected export directory',
  });
  if (comparable(exportRoot) !== comparable(requestedRoot)) {
    throw new Error('Selected export directory must not be a symbolic link or reparse point.');
  }

  // Resolve every name before publishing any entry. A malicious or malformed
  // late entry must fail the entire bundle without leaving an earlier prefix.
  const destinations = await Promise.all(files.map(([filename]) => (
    resolveSafeDestination(exportRoot, filename)
  )));

  for (const [index, [filename, content]] of files.entries()) {
    checkWriteGuard(options);
    let destination = destinations[index]!;
    await mkdir(path.dirname(destination), { recursive: true });
    destination = await resolveSafeDestination(exportRoot, filename);
    checkWriteGuard(options);
    await enqueueDestinationWrite(destination, async () => {
      checkWriteGuard(options);
      await durableAtomicReplace(destination, content, {
        beforePublish: async () => {
          checkWriteGuard(options);
          const checked = await resolveSafeDestination(exportRoot, filename);
          if (comparable(checked) !== comparable(destination)) throw new Error(`Export path changed: ${filename}`);
        },
        afterPublish: async () => {
          checkWriteGuard(options);
          const checked = await resolveAuthorizedPath(destination, [exportRoot], {
            mustExist: true,
            label: 'selected export directory',
          });
          if (comparable(checked) !== comparable(destination)) throw new Error(`Export path changed: ${filename}`);
        },
      });
    });
    checkWriteGuard(options);
    options.onProgress?.(index + 1, Math.max(1, files.length), 'export-write');
  }
  return files.map(([filename]) => filename);
}

export async function writeExportBundle(
  directory: string,
  bundle: WritableExportBundle,
  options: ExportBundleWriteOptions = {},
): Promise<string[]> {
  const files = validatedExportEntries(bundle);
  const key = comparable(path.resolve(directory));
  const previous = exportRootWrites.get(key) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(() => (
    writeValidatedExportBundle(directory, files, options)
  ));
  exportRootWrites.set(key, write);
  try {
    return await write;
  } finally {
    if (exportRootWrites.get(key) === write) exportRootWrites.delete(key);
  }
}
