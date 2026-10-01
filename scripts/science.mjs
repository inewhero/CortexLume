import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = path.resolve(import.meta.dirname, '..');

export function resolvePython(root = repositoryRoot, platform = process.platform, env = process.env, exists = existsSync) {
  if (env.CORTEXLUME_PYTHON) return { command: env.CORTEXLUME_PYTHON, args: [] };
  const local = path.join(root, '.venv', ...(platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
  if (exists(local)) return { command: local, args: [] };
  return platform === 'win32' ? { command: 'py', args: ['-3.12'] } : { command: 'python3', args: [] };
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, stdio: 'inherit', shell: false });
  if (result.error) throw new Error(`Could not launch ${command}: ${result.error.message}. Create .venv with Python 3.12 or set CORTEXLUME_PYTHON.`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export function main([mode, ...extra]) {
  const modes = {
    dev: ['services/science/run.py'],
    test: ['-m', 'pytest', 'services/science/tests'],
    build: ['-m', 'PyInstaller', '--noconfirm', '--clean', '--distpath', 'services/science/dist', '--workpath', 'services/science/build', 'services/science/cortexlume-science.spec'],
  };
  if (!Object.hasOwn(modes, mode)) throw new Error('Usage: node scripts/science.mjs <dev|test|build> [arguments]');
  const python = resolvePython();
  run(python.command, [...python.args, '-c', 'import sys; assert sys.version_info[:2] == (3, 12), "CortexLume requires Python 3.12"']);
  if (mode !== 'test') {
    run(process.execPath, ['scripts/assert-version-consistency.mjs']);
    run(process.execPath, ['scripts/generate-version-metadata.mjs']);
  }
  run(python.command, [...python.args, ...modes[mode], ...extra]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
