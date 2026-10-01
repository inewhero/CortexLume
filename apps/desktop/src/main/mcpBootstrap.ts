import { spawn } from 'node:child_process';
import path from 'node:path';
import { ScienceClient, type ScienceCommand } from '@cortexlume/science-client';
import { CortexLumeMcpRuntime } from './mcpServer';
import { requireConfiguredRoots } from './mcpBootstrapConfig';
import { createMcpCaptureProcess } from './mcpCaptureProcess';
import { resolveResourcesRoot, resolveScienceRuntime } from './scienceRuntime';

const appRoot = path.resolve(process.env.CORTEXLUME_APP_ROOT ?? process.cwd());
const resourcesRoot = resolveResourcesRoot(process.execPath);
const packaged = process.env.CORTEXLUME_IS_PACKAGED === '1';
const workspaceRoot = path.resolve(appRoot, '..', '..');
const templateRoot = packaged
  ? path.join(resourcesRoot, 'assets', 'templates', 'MNI152NLin6Asym')
  : path.join(workspaceRoot, 'assets', 'templates', 'MNI152NLin6Asym');

function scienceCommand(): ScienceCommand {
  return resolveScienceRuntime({ packaged, resourcesRoot, workspaceRoot, assetRoot: templateRoot });
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
const authorizedRoots = requireConfiguredRoots();
const runtime = new CortexLumeMcpRuntime({
  templateRoot,
  science,
  applicationVersion: process.env.CORTEXLUME_APP_VERSION ?? 'development',
  authorizedRoots,
  openGui,
  captureProjectScreenshot: createMcpCaptureProcess({
    executable: process.execPath,
    appRoot,
    packaged,
    authorizedRoots,
  }),
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
