import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { resolvePython } from './science.mjs';

test('honors explicit interpreter, including spaces', () => {
  assert.deepEqual(resolvePython('/repo', 'linux', { CORTEXLUME_PYTHON: '/my python/bin/python' }), { command: '/my python/bin/python', args: [] });
});
for (const platform of ['linux', 'darwin', 'win32']) {
  test(`${platform} uses its workspace venv`, () => {
    const local = path.join('/repo', '.venv', ...(platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
    assert.deepEqual(resolvePython('/repo', platform, {}, (candidate) => candidate === local), { command: local, args: [] });
  });
}
test('preserves Windows launcher and POSIX fallback', () => {
  assert.deepEqual(resolvePython('/repo', 'win32', {}, () => false), { command: 'py', args: ['-3.12'] });
  assert.deepEqual(resolvePython('/repo', 'linux', {}, () => false), { command: 'python3', args: [] });
});
