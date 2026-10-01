import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ScienceCommand } from '@cortexlume/science-client';

interface ScienceRuntimeOptions {
  packaged: boolean;
  resourcesRoot: string;
  workspaceRoot: string;
  assetRoot: string;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  exists?: (filePath: string) => boolean;
}

/** Resolve the same science runtime for the desktop and its MCP child. */
export function resolveScienceRuntime(options: ScienceRuntimeOptions): ScienceCommand {
  const platform = options.platform ?? process.platform;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const environment = options.environment ?? process.env;
  const exists = options.exists ?? existsSync;
  const executableName = platform === 'win32' ? 'cortexlume-science.exe' : 'cortexlume-science';
  const executableCommand = (command: string): ScienceCommand => ({
    command, args: [], cwd: paths.dirname(command), assetRoot: options.assetRoot,
  });

  // Installed builds always use their bundled runtime, independent of the
  // developer's Python environment and without requiring Python on PATH.
  if (options.packaged) {
    return executableCommand(paths.join(options.resourcesRoot, 'cortexlume-science', executableName));
  }

  const script = paths.join(options.workspaceRoot, 'services', 'science', 'run.py');
  const pythonCommand = (command: string, args: string[] = []): ScienceCommand => ({
    command, args: [...args, script], cwd: paths.dirname(script), assetRoot: options.assetRoot,
  });
  const configuredPython = environment.CORTEXLUME_PYTHON?.trim();
  if (configuredPython) return pythonCommand(configuredPython);

  // Prefer checked-out source over a potentially stale frozen build.
  const workspacePython = paths.join(options.workspaceRoot, '.venv',
    ...(platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
  if (exists(workspacePython)) return pythonCommand(workspacePython);

  const builtExecutable = paths.join(options.workspaceRoot, 'services', 'science', 'dist',
    'cortexlume-science', executableName);
  if (exists(builtExecutable)) return executableCommand(builtExecutable);

  return platform === 'win32' ? pythonCommand('py', ['-3.12']) : pythonCommand('python3');
}

/** Electron's resourcesPath is passed to MCP normally; this covers direct startup. */
export function resolveResourcesRoot(
  executable: string,
  platform: NodeJS.Platform = process.platform,
  override: string | undefined = process.env.CORTEXLUME_RESOURCES_ROOT,
): string {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (override?.trim()) return paths.resolve(override.trim());
  return platform === 'darwin'
    ? paths.resolve(paths.dirname(executable), '..', 'Resources')
    : paths.resolve(paths.dirname(executable), 'resources');
}
