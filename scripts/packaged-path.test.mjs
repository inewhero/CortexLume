import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { packagedExecutable } from './packaged-path.mjs';

test('selects platform and architecture layouts', () => {
  assert.equal(packagedExecutable('linux', 'x64'), path.join('apps/desktop/out/CortexLume-linux-x64/CortexLume'));
  assert.equal(packagedExecutable('linux', 'arm64'), path.join('apps/desktop/out/CortexLume-linux-arm64/CortexLume'));
  assert.equal(packagedExecutable('win32', 'x64'), path.join('apps/desktop/out/CortexLume-win32-x64/CortexLume.exe'));
  assert.equal(packagedExecutable('darwin', 'arm64'), path.join('apps/desktop/out/CortexLume-darwin-arm64/CortexLume.app/Contents/MacOS/CortexLume'));
  assert.throws(() => packagedExecutable('freebsd', 'x64'), /No packaged executable layout/);
});
