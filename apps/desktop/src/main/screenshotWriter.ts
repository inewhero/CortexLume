import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { durableAtomicCreateExclusive, resolveAuthorizedPath } from './durableFile';

export const SCIENTIFIC_SCREENSHOT_DIRECTORY = 'CortexLume_Screenshots';
export const SCIENTIFIC_SCREENSHOT_MAX_PNG_BYTES = 17 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function timestampForFilename(now: Date) {
  return now.toISOString().replaceAll(/[-:]/g, '').replace('.', '-');
}

function assertPng(png: Uint8Array, width: number, height: number) {
  if (png.byteLength < 33 || png.byteLength > SCIENTIFIC_SCREENSHOT_MAX_PNG_BYTES) {
    throw new Error('Scientific screenshot PNG has an invalid byte length.');
  }
  if (!Buffer.from(png.subarray(0, 8)).equals(PNG_SIGNATURE)) throw new Error('Scientific screenshot is not a PNG.');
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (view.getUint32(16) !== width || view.getUint32(20) !== height || png[24] !== 8 || png[25] !== 6) {
    throw new Error('Scientific screenshot PNG must be 8-bit RGBA with the declared dimensions.');
  }
}

function isAlreadyExists(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

export interface SaveScientificScreenshotOptions {
  now?: Date;
}

export async function saveScientificScreenshot(
  projectPath: string,
  png: Uint8Array,
  width: number,
  height: number,
  options: SaveScientificScreenshotOptions = {},
) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width < 1 || height < 1 || width > 3072 || height > 3072 || width * height > 4_194_304) {
    throw new Error('Scientific screenshot dimensions exceed the supported limit.');
  }
  assertPng(png, width, height);
  const resolvedProjectPath = path.resolve(projectPath);
  if (path.extname(resolvedProjectPath).toLowerCase() !== '.cortexlume') {
    throw new Error('Scientific screenshots require a saved .cortexlume project.');
  }
  const projectStats = await lstat(resolvedProjectPath);
  if (!projectStats.isFile() || projectStats.isSymbolicLink()) {
    throw new Error('The saved CortexLume project path must remain a regular file.');
  }
  const projectDirectory = path.dirname(resolvedProjectPath);
  const outputCandidate = path.join(projectDirectory, SCIENTIFIC_SCREENSHOT_DIRECTORY);
  await resolveAuthorizedPath(resolvedProjectPath, [projectDirectory], {
    mustExist: true,
    label: 'the saved project directory',
  });
  try {
    await mkdir(outputCandidate);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  // Fail closed if an existing CortexLume_Screenshots path is a junction,
  // symlink, file, or resolves anywhere outside the saved project's directory.
  const outputDirectory = await resolveAuthorizedPath(outputCandidate, [projectDirectory], {
    mustExist: true,
    label: 'the saved project directory',
  });
  const stem = `CortexLume_3D_${timestampForFilename(options.now ?? new Date())}_${width}x${height}`;
  for (let sequence = 0; sequence < 10_000; sequence += 1) {
    const suffix = sequence === 0 ? '' : `-${String(sequence).padStart(2, '0')}`;
    const fileName = `${stem}${suffix}.png`;
    const candidate = path.join(outputDirectory, fileName);
    const destination = await resolveAuthorizedPath(candidate, [outputDirectory], {
      mustExist: false,
      label: 'the scientific screenshot directory',
    });
    try {
      await durableAtomicCreateExclusive(destination, png, {
        beforePublish: async () => {
          await resolveAuthorizedPath(outputDirectory, [projectDirectory], {
            mustExist: true,
            label: 'the saved project directory',
          });
          await resolveAuthorizedPath(destination, [outputDirectory], {
            mustExist: false,
            label: 'the scientific screenshot directory',
          });
        },
        afterPublish: async () => {
          await resolveAuthorizedPath(destination, [outputDirectory], {
            mustExist: true,
            label: 'the scientific screenshot directory',
          });
        },
      });
      return { path: destination, directory: outputDirectory, fileName, width, height };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  }
  throw new Error('Could not allocate a unique scientific screenshot filename.');
}

export function decodeScientificScreenshotBase64(value: string) {
  if (value.length === 0 || value.length > 24 * 1024 * 1024 || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error('Scientific screenshot has invalid base64 encoding.');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new Error('Scientific screenshot has non-canonical base64 encoding.');
  return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
}
