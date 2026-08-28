import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const releaseDirectory = path.resolve(process.argv[2] ?? path.join(root, 'release'));
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const lockBytes = await readFile(path.join(root, 'pnpm-lock.yaml'));
const lockText = lockBytes.toString('utf8');
const lockSha256 = createHash('sha256').update(lockBytes).digest('hex');
let gitCommit = process.env.GITHUB_SHA?.trim() || '';
if (!gitCommit) {
  try {
    gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    gitCommit = 'unknown';
  }
}
if (!/^[0-9a-f]{40}$/i.test(gitCommit)) gitCommit = 'unknown';

await import('./assert-version-consistency.mjs');
await mkdir(releaseDirectory, { recursive: true });
const artifactNames = (await readdir(releaseDirectory))
  .filter((name) => /\.(?:exe|zip)$/i.test(name))
  .sort((left, right) => left.localeCompare(right));
if (artifactNames.length === 0) {
  throw new Error(`No Windows release artifacts were found in ${releaseDirectory}`);
}
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const artifactNamePattern = new RegExp(
  `^CortexLume-${escapeRegExp(String(packageJson.version))}-(?:win-x64-(?:Setup\\.exe|portable\\.zip)|examples\\.zip)$`,
  'i',
);
// The installer and portable package are required.  Same-version companion
// assets (currently examples.zip) are optional but are included whenever they
// are present in the release directory.
const requiredArtifactNames = [
  `CortexLume-${packageJson.version}-win-x64-Setup.exe`,
  `CortexLume-${packageJson.version}-win-x64-portable.zip`,
];
for (const name of artifactNames) {
  if (!artifactNamePattern.test(name)) {
    throw new Error(
      `Release artifact filename must bind the root product version ${packageJson.version}: ${name}`,
    );
  }
}
for (const name of requiredArtifactNames) {
  if (!artifactNames.includes(name)) {
    throw new Error(`Missing version-bound Windows release artifact: ${name}`);
  }
}

const sha256 = async (filePath) => createHash('sha256').update(await readFile(filePath)).digest('hex');
const artifacts = [];
for (const name of artifactNames) {
  const digest = await sha256(path.join(releaseDirectory, name));
  artifacts.push({ name, sha256: digest });
}
await writeFile(
  path.join(releaseDirectory, 'SHA256SUMS'),
  `${artifacts.map(({ name, sha256: digest }) => `${digest}  ${name}`).join('\n')}\n`,
  'utf8',
);

const slug = (value) => value.replaceAll(/[^A-Za-z0-9.-]+/g, '-').replaceAll(/^-+|-+$/g, '') || 'package';
const usedIds = new Set();
const uniqueId = (prefix, value) => {
  const base = `${prefix}-${slug(value)}`;
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) candidate = `${base}-${suffix++}`;
  usedIds.add(candidate);
  return candidate;
};
const manifestPaths = [
  'package.json',
  'apps/desktop/package.json',
  ...(await readdir(path.join(root, 'packages'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join('packages', entry.name, 'package.json')),
];
const workspacePackages = [];
const dependencyRanges = new Map();
for (const relativePath of manifestPaths) {
  const manifest = JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
  const packageName = typeof manifest.name === 'string' ? manifest.name : relativePath;
  const packageId = uniqueId('SPDXRef-Package', packageName);
  workspacePackages.push({
    SPDXID: packageId,
    name: packageName,
    versionInfo: String(manifest.version ?? packageJson.version),
    downloadLocation: 'NOASSERTION',
    filesAnalyzed: false,
    licenseConcluded: 'NOASSERTION',
    licenseDeclared: 'NOASSERTION',
  });
  for (const section of ['dependencies', 'optionalDependencies', 'devDependencies']) {
    for (const [name, range] of Object.entries(manifest[section] ?? {})) {
      if (typeof range !== 'string' || range.startsWith('workspace:')) continue;
      dependencyRanges.set(name, range);
    }
  }
}
const scienceProject = await readFile(path.join(root, 'services/science/pyproject.toml'), 'utf8');
const scienceName = /^name\s*=\s*["']([^"']+)["']/m.exec(scienceProject)?.[1] ?? 'cortexlume-science';
const scienceVersion = /^version\s*=\s*["']([^"']+)["']/m.exec(scienceProject)?.[1] ?? packageJson.version;
workspacePackages.push({
  SPDXID: uniqueId('SPDXRef-Package', scienceName),
  name: scienceName,
  versionInfo: scienceVersion,
  downloadLocation: 'NOASSERTION',
  filesAnalyzed: false,
  licenseConcluded: 'NOASSERTION',
  licenseDeclared: 'NOASSERTION',
});
// The Python package uses a TOML list for runtime dependencies. Keep their
// declared constraints in the same SBOM alongside the exact lock digest.
const dependencyBlock = /dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(scienceProject)?.[1] ?? '';
for (const match of dependencyBlock.matchAll(/^[ \t]*["']([^"']+)["'],?/gm)) {
  const requirement = match[1];
  const name = requirement.split(/[<>=!~]/, 1)[0];
  if (name) dependencyRanges.set(name, requirement.slice(name.length));
}
for (const [name, range] of [...dependencyRanges].sort(([left], [right]) => left.localeCompare(right))) {
  workspacePackages.push({
    SPDXID: uniqueId('SPDXRef-Dependency', name),
    name,
    versionInfo: range,
    downloadLocation: 'NOASSERTION',
    filesAnalyzed: false,
    licenseConcluded: 'NOASSERTION',
    licenseDeclared: 'NOASSERTION',
  });
}
// Include the exact package/version keys from pnpm's resolved package section,
// not only the ranges in package.json.  This keeps the SPDX document useful in
// an air-gapped review while pnpm-lock.yaml remains the authoritative source
// for transitive dependency resolution.
const packageSection = lockText.split(/^snapshots:\s*$/m, 1)[0] ?? lockText;
const resolvedPackages = new Set();
for (const match of packageSection.matchAll(/^  ['"]?((?:@[^/:'"]+\/)?[^@:'"]+)@([^:'"]+)['"]?:\s*$/gm)) {
  const name = match[1];
  const version = match[2];
  if (!name || !version || name === 'packages') continue;
  const key = `${name}@${version}`;
  if (resolvedPackages.has(key)) continue;
  resolvedPackages.add(key);
  workspacePackages.push({
    SPDXID: uniqueId('SPDXRef-LockedDependency', key),
    name,
    versionInfo: version,
    downloadLocation: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`,
    filesAnalyzed: false,
    licenseConcluded: 'NOASSERTION',
    licenseDeclared: 'NOASSERTION',
  });
}

const files = [
  {
    fileName: 'pnpm-lock.yaml',
    SPDXID: 'SPDXRef-File-pnpm-lock',
    checksum: lockSha256,
  },
  ...artifacts.map(({ name, sha256: digest }) => ({ fileName: name, checksum: digest })),
].map(({ fileName, SPDXID, checksum }) => ({
  fileName,
  SPDXID: SPDXID ?? uniqueId('SPDXRef-File', fileName),
  checksums: [{ algorithm: 'SHA256', checksum }],
  licenseConcluded: 'NOASSERTION',
  copyrightText: 'NOASSERTION',
}));
const fileIdByName = new Map(files.map((file) => [file.fileName, file.SPDXID]));
const created = new Date().toISOString();
const sbom = {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: `CortexLume ${packageJson.version} Windows release SBOM`,
  documentNamespace: `https://cortexlume.dev/sbom/${packageJson.version}/${gitCommit}`,
  creationInfo: {
    created,
    creators: ['Tool: CortexLume release metadata generator'],
  },
  packages: workspacePackages,
  files,
  relationships: [
    ...workspacePackages
      .map(({ SPDXID }) => ({ spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: SPDXID })),
    ...artifacts.map(({ name }) => ({
      spdxElementId: 'SPDXRef-DOCUMENT',
      relationshipType: 'CONTAINS',
      relatedSpdxElement: fileIdByName.get(name),
    })),
  ],
  annotations: [{
    annotationDate: created,
    annotationType: 'OTHER',
    annotator: 'Tool: CortexLume release metadata generator',
    comment: `pnpm-lock.yaml SHA256: ${lockSha256}; product version source: package.json`,
  }],
};
await writeFile(path.join(releaseDirectory, 'SBOM.spdx.json'), `${JSON.stringify(sbom, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ releaseDirectory, artifacts, checksumFile: 'SHA256SUMS', sbom: 'SBOM.spdx.json' }));
