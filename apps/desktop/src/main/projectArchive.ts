import { createHash } from 'node:crypto';
import { TextDecoder, TextEncoder } from 'node:util';
import { unzipSync, zipSync, strToU8 } from 'fflate';
import {
  CortexLumeProjectSchema,
  type CortexLumeProject,
} from '@cortexlume/contracts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface ArchiveManifest {
  format: 'cortexlume-project';
  formatVersion: 1;
  projectId: string;
  projectName?: string;
  savedAt?: string;
  applicationVersion?: string;
  projectSha256?: string;
  template: CortexLumeProject['template'];
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function createProjectArchive(
  project: CortexLumeProject,
  applicationVersion?: string,
): Uint8Array {
  const validated = CortexLumeProjectSchema.parse(project);
  const projectBytes = encoder.encode(JSON.stringify(validated, null, 2));
  const manifest: ArchiveManifest = {
    format: validated.format,
    formatVersion: validated.formatVersion,
    projectId: validated.id,
    projectName: validated.name,
    savedAt: new Date().toISOString(),
    ...(applicationVersion ? { applicationVersion } : {}),
    projectSha256: sha256(projectBytes),
    template: validated.template,
  };
  return zipSync(
    {
      'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
      'project.json': projectBytes,
    },
    { level: 6 },
  );
}

export function readProjectArchive(data: Uint8Array): CortexLumeProject {
  const archive = unzipSync(data);
  const projectBytes = archive['project.json'];
  if (!projectBytes) throw new Error('Project archive does not contain project.json');

  const project = CortexLumeProjectSchema.parse(JSON.parse(decoder.decode(projectBytes)));
  const manifestBytes = archive['manifest.json'];
  if (!manifestBytes) return project;

  const manifest = JSON.parse(decoder.decode(manifestBytes)) as Partial<ArchiveManifest>;
  if (manifest.format && manifest.format !== project.format) {
    throw new Error('Project archive manifest has an unexpected format');
  }
  if (manifest.formatVersion && manifest.formatVersion !== project.formatVersion) {
    throw new Error('Project archive manifest version does not match project.json');
  }
  if (manifest.projectId && manifest.projectId !== project.id) {
    throw new Error('Project archive manifest belongs to a different project');
  }
  if (manifest.projectSha256 && manifest.projectSha256 !== sha256(projectBytes)) {
    throw new Error('Project archive integrity check failed');
  }
  return project;
}
