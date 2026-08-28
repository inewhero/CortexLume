import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const releaseDirectory = path.resolve(process.argv[2] ?? path.join(root, 'release'));
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = String(packageJson.version);
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const artifactNamePattern = new RegExp(
  `^CortexLume-${escapeRegExp(version)}-(?:win-x64-(?:Setup\\.exe|portable\\.zip)|examples\\.zip)$`,
  'i',
);
const requiredArtifactNames = new Set([
  `CortexLume-${version}-win-x64-Setup.exe`,
  `CortexLume-${version}-win-x64-portable.zip`,
]);
const checksumText = await readFile(path.join(releaseDirectory, 'SHA256SUMS'), 'utf8');
const lines = checksumText.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
if (lines.length === 0) throw new Error('SHA256SUMS is empty.');
const entries = lines.map((line) => {
  const match = /^([a-f0-9]{64})\s{2}(.+)$/.exec(line);
  if (!match) throw new Error(`Malformed SHA256SUMS line: ${line}`);
  return { digest: match[1], name: match[2] };
});
const names = new Set();
for (const { digest, name } of entries) {
  if (path.basename(name) !== name || name === '.' || name === '..') {
    throw new Error(`SHA256SUMS contains an unsafe artifact name: ${name}`);
  }
  if (names.has(name)) throw new Error(`SHA256SUMS contains a duplicate artifact: ${name}`);
  if (!artifactNamePattern.test(name)) {
    throw new Error(`SHA256SUMS artifact filename is not bound to product version ${version}: ${name}`);
  }
  names.add(name);
  const actual = createHash('sha256').update(await readFile(path.join(releaseDirectory, name))).digest('hex');
  if (actual !== digest) throw new Error(`Checksum mismatch for ${name}: expected ${digest}, got ${actual}`);
}
if ([...requiredArtifactNames].some((name) => !names.has(name))) {
  throw new Error(
    `SHA256SUMS must contain the required version-bound Windows artifacts: ${[...requiredArtifactNames].join(', ')}`,
  );
}
const diskArtifactNames = new Set(
  (await readdir(releaseDirectory)).filter((name) => /\.(?:exe|zip)$/i.test(name)),
);
for (const name of diskArtifactNames) {
  if (!artifactNamePattern.test(name) || !names.has(name)) {
    throw new Error(`Unverified or unversioned Windows release artifact: ${name}`);
  }
}
if (diskArtifactNames.size !== names.size) {
  throw new Error('SHA256SUMS does not cover every Windows release artifact.');
}

const sbom = JSON.parse(await readFile(path.join(releaseDirectory, 'SBOM.spdx.json'), 'utf8'));
if (sbom.spdxVersion !== 'SPDX-2.3') throw new Error('SBOM is not SPDX-2.3.');
if (!String(sbom.name ?? '').includes(version)) {
  throw new Error('SBOM product version does not match package.json.');
}
const sbomFiles = new Map((sbom.files ?? []).map((file) => [file.fileName, file]));
const sbomArtifactNames = new Set(
  [...sbomFiles.keys()].filter((name) => /\.(?:exe|zip)$/i.test(name)),
);
if (sbomArtifactNames.size !== names.size || [...names].some((name) => !sbomArtifactNames.has(name))) {
  throw new Error('SPDX SBOM must contain exactly the version-bound Windows release artifacts listed in SHA256SUMS.');
}
for (const { digest, name } of entries) {
  const file = sbomFiles.get(name);
  const sbomDigest = file?.checksums?.find((checksum) => checksum.algorithm === 'SHA256')?.checksum;
  if (sbomDigest !== digest) throw new Error(`SBOM checksum does not match SHA256SUMS for ${name}`);
}
const lockDigest = createHash('sha256').update(await readFile(path.join(root, 'pnpm-lock.yaml'))).digest('hex');
const annotation = (sbom.annotations ?? []).find((item) => String(item.comment ?? '').includes('pnpm-lock.yaml SHA256:'));
if (!annotation || !String(annotation.comment).includes(lockDigest)) {
  throw new Error('SBOM does not record the current pnpm-lock.yaml SHA256.');
}
console.log(`Verified ${entries.length} release artifact checksum(s) and SPDX SBOM for CortexLume ${packageJson.version}.`);
