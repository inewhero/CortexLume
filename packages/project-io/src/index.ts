import { createHash } from 'node:crypto';
import { TextDecoder, TextEncoder } from 'node:util';
import { unzipSync, zipSync } from 'fflate';
import { z } from 'zod';
import {
  CROSS_PROCESS_LIMITS,
  CortexLumeProjectSchema,
  CortexLumeProjectV1Schema,
  CortexLumeProjectV2Schema,
  migrateProjectV1ToV2,
  type CortexLumeProject,
} from '@cortexlume/contracts';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Limits are exported so file-system boundaries can reject oversized files before readFile. */
export const PROJECT_ARCHIVE_LIMITS = Object.freeze({
  compressedBytes: 16 * 1024 * 1024,
  entryCount: 2,
  projectBytes: CROSS_PROCESS_LIMITS.projectJsonBytes,
  manifestBytes: 1024 * 1024,
  totalUncompressedBytes: 9 * 1024 * 1024,
  maximumCompressionRatio: 100,
});

const ALLOWED_ARCHIVE_ENTRIES = new Map<string, number>([
  ['project.json', PROJECT_ARCHIVE_LIMITS.projectBytes],
  ['manifest.json', PROJECT_ARCHIVE_LIMITS.manifestBytes],
]);

function validateArchiveEntrySize(name: string, uncompressedSize: number): void {
  const entryLimit = ALLOWED_ARCHIVE_ENTRIES.get(name);
  if (entryLimit == null) zipError(`unexpected entry ${JSON.stringify(name)}`);
  if (uncompressedSize > entryLimit) {
    zipError(`${name} exceeds its uncompressed size limit (${uncompressedSize} > ${entryLimit} bytes)`);
  }
}

function validateArchiveTotalUncompressedSize(totalUncompressed: number): void {
  if (totalUncompressed > PROJECT_ARCHIVE_LIMITS.totalUncompressedBytes) {
    zipError(
      `total uncompressed size exceeds its limit (${totalUncompressed} > ${PROJECT_ARCHIVE_LIMITS.totalUncompressedBytes} bytes)`,
    );
  }
}

function validateArchiveUncompressedSizes(
  entries: ReadonlyArray<readonly [name: string, bytes: Uint8Array]>,
): void {
  let totalUncompressed = 0;
  for (const [name, bytes] of entries) {
    validateArchiveEntrySize(name, bytes.byteLength);
    totalUncompressed += bytes.byteLength;
  }
  validateArchiveTotalUncompressedSize(totalUncompressed);
}

function readU16(data: Uint8Array, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8);
}

function readU32(data: Uint8Array, offset: number): number {
  return (data[offset]!
    | (data[offset + 1]! << 8)
    | (data[offset + 2]! << 16)
    | (data[offset + 3]! << 24)) >>> 0;
}

function zipError(detail: string): never {
  throw new Error(`Invalid CortexLume project archive: ${detail}`);
}

/**
 * Validates ZIP metadata and declared sizes before fflate allocates output or inflates entries.
 * ZIP64, split archives, encryption, data descriptors, and non-store/deflate methods are not
 * needed by the CortexLume format and are deliberately rejected to keep this boundary small.
 */
export function preflightProjectArchive(data: Uint8Array): void {
  if (data.byteLength > PROJECT_ARCHIVE_LIMITS.compressedBytes) {
    zipError(`compressed size exceeds ${PROJECT_ARCHIVE_LIMITS.compressedBytes} bytes`);
  }
  if (data.byteLength < 22) zipError('ZIP end record is missing');

  const earliestEocd = Math.max(0, data.byteLength - 22 - 0xffff);
  let eocdOffset = -1;
  for (let offset = data.byteLength - 22; offset >= earliestEocd; offset -= 1) {
    if (readU32(data, offset) === 0x06054b50
      && offset + 22 + readU16(data, offset + 20) === data.byteLength) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) zipError('ZIP end record is missing or malformed');

  const diskNumber = readU16(data, eocdOffset + 4);
  const centralDisk = readU16(data, eocdOffset + 6);
  const diskEntryCount = readU16(data, eocdOffset + 8);
  const entryCount = readU16(data, eocdOffset + 10);
  const centralSize = readU32(data, eocdOffset + 12);
  const centralOffset = readU32(data, eocdOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntryCount !== entryCount) {
    zipError('split ZIP archives are not supported');
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    zipError('ZIP64 archives are not supported');
  }
  if (entryCount !== PROJECT_ARCHIVE_LIMITS.entryCount) {
    zipError(`archive must contain exactly ${PROJECT_ARCHIVE_LIMITS.entryCount} entries`);
  }
  const centralEnd = centralOffset + centralSize;
  if (!Number.isSafeInteger(centralEnd) || centralEnd !== eocdOffset) {
    zipError('central directory bounds are invalid');
  }

  const names = new Set<string>();
  let totalCompressed = 0;
  let totalUncompressed = 0;
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > centralEnd || readU32(data, offset) !== 0x02014b50) {
      zipError('central directory entry is malformed');
    }
    const flags = readU16(data, offset + 8);
    const compressionMethod = readU16(data, offset + 10);
    const compressedSize = readU32(data, offset + 20);
    const uncompressedSize = readU32(data, offset + 24);
    const nameLength = readU16(data, offset + 28);
    const extraLength = readU16(data, offset + 30);
    const commentLength = readU16(data, offset + 32);
    const startDisk = readU16(data, offset + 34);
    const localOffset = readU32(data, offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > centralEnd) zipError('central directory entry exceeds its bounds');
    if ((flags & 0x0001) !== 0) zipError('encrypted entries are not supported');
    if ((flags & 0x0008) !== 0) zipError('data-descriptor entries are not supported');
    if (compressionMethod !== 0 && compressionMethod !== 8) zipError('unsupported compression method');
    if (startDisk !== 0 || localOffset === 0xffffffff
      || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      zipError('ZIP64 or split entries are not supported');
    }

    let name: string;
    try {
      name = decoder.decode(data.subarray(offset + 46, offset + 46 + nameLength));
    } catch {
      zipError('entry name is not valid UTF-8');
    }
    validateArchiveEntrySize(name, uncompressedSize);
    if (names.has(name)) zipError(`duplicate entry ${JSON.stringify(name)}`);
    names.add(name);
    if (uncompressedSize > 0 && compressedSize === 0) zipError(`${name} has an invalid compression ratio`);
    if (uncompressedSize / Math.max(1, compressedSize) > PROJECT_ARCHIVE_LIMITS.maximumCompressionRatio) {
      zipError(`${name} exceeds the maximum compression ratio`);
    }

    if (localOffset + 30 > centralOffset || readU32(data, localOffset) !== 0x04034b50) {
      zipError(`${name} has an invalid local header`);
    }
    const localFlags = readU16(data, localOffset + 6);
    const localMethod = readU16(data, localOffset + 8);
    const localCompressedSize = readU32(data, localOffset + 18);
    const localUncompressedSize = readU32(data, localOffset + 22);
    const localNameLength = readU16(data, localOffset + 26);
    const localExtraLength = readU16(data, localOffset + 28);
    const localDataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (localFlags !== flags || localMethod !== compressionMethod
      || localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize
      || localDataOffset + compressedSize > centralOffset) {
      zipError(`${name} has inconsistent local metadata`);
    }
    let localName: string;
    try {
      localName = decoder.decode(data.subarray(localOffset + 30, localOffset + 30 + localNameLength));
    } catch {
      zipError('local entry name is not valid UTF-8');
    }
    if (localName !== name) zipError(`${name} does not match its local header`);

    totalCompressed += compressedSize;
    totalUncompressed += uncompressedSize;
    offset = nextOffset;
  }
  if (offset !== centralEnd || names.size !== ALLOWED_ARCHIVE_ENTRIES.size
    || [...ALLOWED_ARCHIVE_ENTRIES.keys()].some((name) => !names.has(name))) {
    zipError('archive entry set is incomplete or malformed');
  }
  validateArchiveTotalUncompressedSize(totalUncompressed);
  if (totalUncompressed / Math.max(1, totalCompressed) > PROJECT_ARCHIVE_LIMITS.maximumCompressionRatio) {
    zipError('archive exceeds the maximum aggregate compression ratio');
  }
}

export const ProjectArchiveManifestSchema = z.object({
  format: z.literal('cortexlume-project'),
  formatVersion: z.union([z.literal(1), z.literal(2)]),
  projectId: z.string().uuid(),
  projectName: z.string().max(256).optional(),
  savedAt: z.string().datetime().optional(),
  applicationVersion: z.string().max(128).optional(),
  projectSha256: z.string().regex(/^[a-f0-9]{64}$/),
  template: z.unknown(),
});
export type ProjectArchiveManifest = z.infer<typeof ProjectArchiveManifestSchema>;

export function sha256Bytes(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function canonicalProjectBytes(project: CortexLumeProject): Uint8Array {
  return encoder.encode(JSON.stringify(CortexLumeProjectSchema.parse(project), null, 2));
}

export function createProjectArchive(project: CortexLumeProject, applicationVersion?: string): Uint8Array {
  const validated = CortexLumeProjectSchema.parse(project);
  const projectBytes = canonicalProjectBytes(validated);
  const manifest = ProjectArchiveManifestSchema.parse({
    format: validated.format,
    formatVersion: 2,
    projectId: validated.id,
    projectName: validated.name,
    savedAt: new Date().toISOString(),
    ...(applicationVersion ? { applicationVersion } : {}),
    projectSha256: sha256Bytes(projectBytes),
    template: validated.template,
  });
  const manifestBytes = encoder.encode(JSON.stringify(manifest, null, 2));
  validateArchiveUncompressedSizes([
    ['project.json', projectBytes],
    ['manifest.json', manifestBytes],
  ]);

  const archive = zipSync({
    'manifest.json': manifestBytes,
    'project.json': projectBytes,
  }, { level: 6 });
  // Keep the writer and reader on the same ZIP metadata, size, and compression invariants.
  preflightProjectArchive(archive);
  return archive;
}

export interface ReadProjectArchiveResult {
  project: CortexLumeProject;
  manifest: ProjectArchiveManifest;
  sourceFormatVersion: 1 | 2;
  migrated: boolean;
  archiveProjectSha256: string;
}

export function readProjectArchiveDetailed(data: Uint8Array): ReadProjectArchiveResult {
  preflightProjectArchive(data);
  const archive = unzipSync(data);
  const projectBytes = archive['project.json'];
  const manifestBytes = archive['manifest.json'];
  if (!projectBytes) throw new Error('Project archive does not contain project.json');
  if (!manifestBytes) throw new Error('Project archive does not contain manifest.json');

  const raw = JSON.parse(decoder.decode(projectBytes)) as unknown;
  const manifest = ProjectArchiveManifestSchema.parse(JSON.parse(decoder.decode(manifestBytes)));
  const rawVersion = raw && typeof raw === 'object' && 'formatVersion' in raw
    ? (raw as { formatVersion?: unknown }).formatVersion
    : null;
  if (rawVersion !== 1 && rawVersion !== 2) throw new Error('Unsupported CortexLume project format version');
  if (manifest.formatVersion !== rawVersion) throw new Error('Project archive manifest version does not match project.json');
  if (manifest.projectSha256 !== sha256Bytes(projectBytes)) throw new Error('Project archive integrity check failed');

  const project = CortexLumeProjectSchema.parse(rawVersion === 1
    ? migrateProjectV1ToV2(CortexLumeProjectV1Schema.parse(raw))
    : CortexLumeProjectV2Schema.parse(raw));
  if (manifest.projectId !== project.id) throw new Error('Project archive manifest belongs to a different project');
  return {
    project,
    manifest,
    sourceFormatVersion: rawVersion,
    migrated: rawVersion === 1,
    archiveProjectSha256: sha256Bytes(projectBytes),
  };
}

export function readProjectArchive(data: Uint8Array): CortexLumeProject {
  return readProjectArchiveDetailed(data).project;
}
