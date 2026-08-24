import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ScienceClient, type ScienceCommand } from '@cortexlume/science-client';
import { CortexLumeMcpRuntime } from './mcpServer';

const appRoot = path.resolve(process.env.CORTEXLUME_APP_ROOT ?? process.cwd());
const resourcesRoot = path.resolve(
  process.env.CORTEXLUME_RESOURCES_ROOT ?? path.join(path.dirname(process.execPath), 'resources'),
);
const packaged = process.env.CORTEXLUME_IS_PACKAGED === '1';
const workspaceRoot = packaged ? null : path.resolve(appRoot, '..', '..');
const templateRoot = packaged
  ? path.join(resourcesRoot, 'assets', 'templates', 'MNI152NLin6Asym')
  : path.join(workspaceRoot!, 'assets', 'templates', 'MNI152NLin6Asym');

function scienceCommand(): ScienceCommand {
  if (packaged) {
    const executable = path.join(resourcesRoot, 'cortexlume-science', 'cortexlume-science.exe');
    return { command: executable, args: [], cwd: path.dirname(executable), assetRoot: templateRoot };
  }
  const script = path.join(workspaceRoot!, 'services', 'science', 'run.py');
  const configuredPython = process.env.CORTEXLUME_PYTHON;
  if (configuredPython) return { command: configuredPython, args: [script], cwd: path.dirname(script), assetRoot: templateRoot };
  const workspacePython = path.join(workspaceRoot!, '.venv', 'Scripts', 'python.exe');
  if (existsSync(workspacePython)) return { command: workspacePython, args: [script], cwd: path.dirname(script), assetRoot: templateRoot };
  return { command: 'py', args: ['-3.12', script], cwd: path.dirname(script), assetRoot: templateRoot };
}

function configuredRoots(): string[] {
  const argumentsRoots = process.argv.flatMap((argument) => (
    argument.startsWith('--mcp-root=') ? [argument.slice('--mcp-root='.length)] : []
  ));
  const environmentRoots = (process.env.CORTEXLUME_MCP_ROOTS ?? '').split(path.delimiter).filter(Boolean);
  return [...argumentsRoots, ...environmentRoots].map((root) => path.resolve(root));
}

function openGui(projectPath: string): void {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.CORTEXLUME_MCP_CHILD;
  const args = packaged ? [projectPath] : [appRoot, projectPath];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: environment,
  });
  child.unref();
}

const science = new ScienceClient(scienceCommand, (message) => console.error(message));
const runtime = new CortexLumeMcpRuntime({
  templateRoot,
  science,
  applicationVersion: process.env.CORTEXLUME_APP_VERSION ?? 'development',
  authorizedRoots: configuredRoots(),
  openGui,
});
const keepAlive = setInterval(() => {}, 0x7fffffff);
runtime.start();
process.stdin.resume();
const shutdown = () => {
  clearInterval(keepAlive);
  science.stop();
};
process.stdin.once('end', shutdown);
process.stdin.once('close', shutdown);
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
