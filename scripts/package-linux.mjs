import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

if (process.platform !== 'linux') throw new Error('Build the Linux package on Linux; the Python sidecar is platform-specific.');
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { version } = require('../package.json');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(process.execPath, ['scripts/science.mjs', 'build']);
run('pnpm', ['--filter', '@cortexlume/desktop', 'make', '--platform=linux', `--arch=${process.arch}`]);
const directory = path.join(root, 'apps/desktop/out/make/zip/linux', process.arch);
const original = path.join(directory, `CortexLume-linux-${process.arch}-${version}.zip`);
if (!existsSync(original)) throw new Error(`Forge did not produce ${original}`);
const artifact = path.join(directory, `CortexLume-${version}-linux-${process.arch}-portable.zip`);
copyFileSync(original, artifact);
console.log(`Linux portable package: ${artifact}`);
