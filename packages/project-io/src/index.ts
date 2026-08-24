import { createHash } from 'node:crypto';
import { TextDecoder, TextEncoder } from 'node:util';
import { unzipSync, zipSync, strToU8 } from 'fflate';
import { z } from 'zod';
import {
  CortexLumeProjectSchema,
  CortexLumeProjectV1Schema,
  CortexLumeProjectV2Schema,
  migrateProjectV1ToV2,
  type CortexLumeProject,
} from '@cortexlume/contracts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const ProjectArchiveManifestSchema = z.object({
  format: z.literal('cortexlume-project'),
  formatVersion: z.union([z.literal(1), z.literal(2)]),
  projectId: z.string().uuid(),
  projectName: z.string().optional(),
  savedAt: z.string().datetime().optional(),
  applicationVersion: z.string().optional(),
  projectSha256: z.string().regex(/^[a-f0-9]{64}$/),
  template: z.unknown(),
});
export type ProjectArchiveManifest = z.infer<typeof ProjectArchiveManifestSchema>;

export function sha256Bytes(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function canonicalProjectBytes(project: CortexLumeProject): Uint8Array {
  return encoder.encode(JSON.stringify(CortexLumeProjectV2Schema.parse(project), null, 2));
}

export function createProjectArchive(project: CortexLumeProject, applicationVersion?: string): Uint8Array {
  const validated = CortexLumeProjectV2Schema.parse(project);
  const projectBytes = canonicalProjectBytes(validated);
  const manifest: ProjectArchiveManifest = {
    format: validated.format,
    formatVersion: 2,
    projectId: validated.id,
    projectName: validated.name,
    savedAt: new Date().toISOString(),
    ...(applicationVersion ? { applicationVersion } : {}),
    projectSha256: sha256Bytes(projectBytes),
    template: validated.template,
  };
  return zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'project.json': projectBytes,
  }, { level: 6 });
}

export interface ReadProjectArchiveResult {
  project: CortexLumeProject;
  manifest: ProjectArchiveManifest;
  sourceFormatVersion: 1 | 2;
  migrated: boolean;
  archiveProjectSha256: string;
}

export function readProjectArchiveDetailed(data: Uint8Array): ReadProjectArchiveResult {
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

  const project = rawVersion === 1
    ? migrateProjectV1ToV2(CortexLumeProjectV1Schema.parse(raw))
    : CortexLumeProjectSchema.parse(CortexLumeProjectV2Schema.parse(raw));
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
