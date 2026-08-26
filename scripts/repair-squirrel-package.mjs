import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_ROOT, '..');
const VENDOR_ROOT = path.join(REPO_ROOT, 'node_modules', 'electron-winstaller', 'vendor');
const SEVEN_ZIP = path.join(VENDOR_ROOT, '7z.exe');
const WRITE_ZIP_TO_SETUP = path.join(VENDOR_ROOT, 'WriteZipToSetup.exe');
const UPDATE_EXE = path.join(VENDOR_ROOT, 'Squirrel.exe');
const TARGET_ENTRY = 'lib\\net45\\resources\\assets\\templates\\MNI152NLin6Asym\\generated\\quick_targets\\maps.npz';
const FORCE_DEFLATE_SCRIPT = path.join(SCRIPT_ROOT, 'force-deflate-zip-entry.py');

function run(command, args, cwd = REPO_ROOT) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function findPython() {
  const candidates = [
    process.env.CORTEXLUME_PYTHON,
    path.join(REPO_ROOT, '.venv', 'Scripts', 'python.exe'),
    'python',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      run(candidate, ['--version']);
      return candidate;
    } catch {
      // Try the next configured Python runtime.
    }
  }
  throw new Error('Python is required to force-compress the nested Quick Target archive.');
}

function forceDeflate(nupkgPath) {
  run(findPython(), [FORCE_DEFLATE_SCRIPT, nupkgPath, TARGET_ENTRY.replaceAll('\\', '/')]);

  const listing = run(SEVEN_ZIP, ['l', '-slt', nupkgPath]);
  const normalized = listing.replaceAll('/', '\\');
  const entryBlock = normalized
    .split(/\r?\n\r?\n/)
    .find((block) => block.includes(`Path = ${TARGET_ENTRY}`));
  if (!entryBlock || !/^Method = Deflate$/m.test(entryBlock)) {
    throw new Error('Quick Target maps.npz was not force-compressed in the Squirrel package.');
  }
}

function updateReleaseEntry(releasesPath, nupkgPath) {
  const name = path.basename(nupkgPath);
  const sha1 = createHash('sha1').update(readFileSync(nupkgPath)).digest('hex').toUpperCase();
  const size = statSync(nupkgPath).size;
  const lines = readFileSync(releasesPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean);
  let found = false;
  const updated = lines.map((line) => {
    const parts = line.trim().split(/\s+/);
    if (parts[1] !== name) return line;
    found = true;
    return `${sha1} ${name} ${size}`;
  });
  if (!found) throw new Error(`RELEASES does not contain ${name}.`);
  writeFileSync(releasesPath, `${updated.join('\r\n')}\r\n`, 'utf8');
}

function rebuildSetup(setupPath, nupkgPath, releasesPath, loadingGif, setupIcon, workRoot) {
  const payload = path.join(workRoot, 'payload');
  const payloadZip = path.join(workRoot, 'payload.zip');
  mkdirSync(payload, { recursive: true });
  const files = [
    [loadingGif, 'background.gif'],
    [nupkgPath, path.basename(nupkgPath)],
    [releasesPath, 'RELEASES'],
    [setupIcon, 'setupIcon.ico'],
    [UPDATE_EXE, 'Update.exe'],
  ];
  for (const [source, name] of files) {
    const destination = path.join(payload, name);
    copyFileSync(source, destination);
  }
  run(SEVEN_ZIP, ['a', '-tzip', '-mx=1', '-mm=Deflate', payloadZip, '.\\*'], payload);
  run(WRITE_ZIP_TO_SETUP, [setupPath, payloadZip]);
}

function repairDirectory(directory, loadingGif, setupIcon) {
  const files = readdirSync(directory);
  const nupkg = files.find((name) => /-full\.nupkg$/i.test(name));
  const setup = files.find((name) => /Setup\.exe$/i.test(name));
  if (!nupkg || !setup || !files.includes('RELEASES')) return false;

  const workRoot = mkdtempSync(path.join(os.tmpdir(), 'cortexlume-squirrel-'));
  try {
    const nupkgPath = path.join(directory, nupkg);
    const releasesPath = path.join(directory, 'RELEASES');
    forceDeflate(nupkgPath);
    updateReleaseEntry(releasesPath, nupkgPath);
    rebuildSetup(path.join(directory, setup), nupkgPath, releasesPath, loadingGif, setupIcon, workRoot);
    return true;
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

const [squirrelRoot, loadingGif, setupIcon] = process.argv.slice(2).map((value) => path.resolve(value));
if (!squirrelRoot || !loadingGif || !setupIcon) {
  throw new Error('Usage: repair-squirrel-package.mjs <squirrel-root> <loading-gif> <setup-icon>');
}

let repaired = 0;
for (const entry of readdirSync(squirrelRoot, { withFileTypes: true })) {
  if (entry.isDirectory() && repairDirectory(path.join(squirrelRoot, entry.name), loadingGif, setupIcon)) repaired++;
}
if (repaired === 0) throw new Error(`No Squirrel package was found below ${squirrelRoot}.`);
console.log(`Repaired ${repaired} Squirrel package(s) with a force-compressed Quick Target archive.`);
