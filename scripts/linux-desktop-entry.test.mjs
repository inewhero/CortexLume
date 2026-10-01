import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, chmodSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
function fixture(t, name = 'Cortex Lume', dataName = 'user data') {
  const directory = mkdtempSync(path.join(tmpdir(), 'cortexlume-icon-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const app = path.join(directory, name);
  const data = path.join(directory, dataName);
  mkdirSync(path.join(app, 'resources'), { recursive: true });
  writeFileSync(path.join(app, 'CortexLume'), '#!/bin/sh\nexit 0\n');
  chmodSync(path.join(app, 'CortexLume'), 0o755);
  copyFileSync(path.join(root, 'apps/desktop/assets/icon.png'), path.join(app, 'resources/icon.png'));
  copyFileSync(path.join(root, 'apps/desktop/assets/install-desktop-entry.sh'), path.join(app, 'install-desktop-entry.sh'));
  return { app, data, entry: path.join(data, 'applications/org.cortexlume.CortexLume.desktop'), run: () => spawnSync('sh', [path.join(app, 'install-desktop-entry.sh')], { env: { ...process.env, XDG_DATA_HOME: data }, encoding: 'utf8' }) };
}

test('Linux launcher installs a matching icon and stable identity and can be refreshed', { skip: process.platform !== 'linux' }, (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  assert.equal(f.run().status, 0);
  const entry = readFileSync(f.entry, 'utf8');
  assert.match(entry, /StartupWMClass=CortexLume\n/);
  assert.ok(entry.includes(`Icon=${f.data}/icons/hicolor/512x512/apps/org.cortexlume.CortexLume.png\n`));
  assert.ok(readFileSync(path.join(f.data, 'icons/hicolor/512x512/apps/org.cortexlume.CortexLume.png')).equals(readFileSync(path.join(f.app, 'resources/icon.png'))));
  const validate = spawnSync('desktop-file-validate', [f.entry], { encoding: 'utf8' });
  if (!validate.error) assert.equal(validate.status, 0, validate.stdout + validate.stderr);
});

test('Linux launcher preserves spaces and Exec-reserved characters', { skip: process.platform !== 'linux' }, (t) => {
  const f = fixture(t, 'Cortex "Lume" $HOME `test` \\ %f');
  assert.equal(f.run().status, 0);
  const value = readFileSync(f.entry, 'utf8').split('\n').find((line) => line.startsWith('Exec=')).slice(5);
  // Reverse the desktop string layer, quoted Exec layer, then percent field escaping.
  const decoded = value.replace(/\\\\/g, '\\').slice(1, -1).replace(/\\([\\"`$])/g, '$1').replace(/%%/g, '%');
  assert.equal(decoded, path.join(f.app, 'CortexLume'));
  const validate = spawnSync('desktop-file-validate', [f.entry], { encoding: 'utf8' });
  if (!validate.error) assert.equal(validate.status, 0, validate.stdout + validate.stderr);
});

for (const symlink of [false, true]) test(`Linux launcher refuses unrelated ${symlink ? 'symlink' : 'entry'}`, { skip: process.platform !== 'linux' }, (t) => {
  const f = fixture(t);
  mkdirSync(path.dirname(f.entry), { recursive: true });
  if (symlink) symlinkSync('/missing-target', f.entry);
  else writeFileSync(f.entry, '[Desktop Entry]\nName=Other app\n');
  assert.notEqual(f.run().status, 0);
  if (!symlink) assert.equal(readFileSync(f.entry, 'utf8'), '[Desktop Entry]\nName=Other app\n');
});

test('Linux launcher refuses newline injection in installation paths', { skip: process.platform !== 'linux' }, (t) => {
  const f = fixture(t, 'Cortex\nExec=bad');
  assert.notEqual(f.run().status, 0);
});


test('Linux launcher uses an absolute PNG path without depending on theme lookup', { skip: process.platform !== 'linux' }, (t) => {
  const f = fixture(t, 'Cortex Lume', 'user data \\ literal %f');
  assert.equal(f.run().status, 0);
  const icon = readFileSync(f.entry, 'utf8').split('\n').find((line) => line.startsWith('Icon=')).slice(5);
  assert.equal(icon.replace(/\\\\/g, '\\'), path.join(f.data, 'icons/hicolor/512x512/apps/org.cortexlume.CortexLume.png'));
  const validate = spawnSync('desktop-file-validate', [f.entry], { encoding: 'utf8' });
  if (!validate.error) assert.equal(validate.status, 0, validate.stdout + validate.stderr);
});
