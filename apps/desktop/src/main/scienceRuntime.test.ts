import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveResourcesRoot, resolveScienceRuntime } from './scienceRuntime';

const platforms = ['linux', 'darwin', 'win32'] as const;

for (const platform of platforms) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const root = platform === 'win32' ? 'C:\\Cortex Lume' : '/opt/Cortex Lume';
  const workspaceRoot = paths.join(root, 'workspace');
  const resourcesRoot = paths.join(root, 'resources');
  const assetRoot = paths.join(resourcesRoot, 'assets', 'templates', 'MNI152NLin6Asym');
  const script = paths.join(workspaceRoot, 'services', 'science', 'run.py');
  const executableName = platform === 'win32' ? 'cortexlume-science.exe' : 'cortexlume-science';
  const workspacePython = paths.join(workspaceRoot, '.venv',
    ...(platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
  const builtExecutable = paths.join(workspaceRoot, 'services', 'science', 'dist',
    'cortexlume-science', executableName);
  const options = { platform, workspaceRoot, resourcesRoot, assetRoot, packaged: false, environment: {} };

  describe(`${platform} science runtime`, () => {
    it('uses the bundled executable in packaged builds, ignoring developer overrides', () => {
      const exists = vi.fn(() => true);
      const command = paths.join(resourcesRoot, 'cortexlume-science', executableName);
      expect(resolveScienceRuntime({ ...options, packaged: true, exists,
        environment: { CORTEXLUME_PYTHON: '/other/python' } })).toEqual({
        command, args: [], cwd: paths.dirname(command), assetRoot,
      });
      expect(exists).not.toHaveBeenCalled();
    });

    it('honors an explicit Python executable, preserving paths with spaces as one command', () => {
      const command = paths.join(root, 'Custom Python', platform === 'win32' ? 'python.exe' : 'python');
      expect(resolveScienceRuntime({ ...options, exists: () => true,
        environment: { CORTEXLUME_PYTHON: `  ${command}  ` } })).toEqual({
        command, args: [script], cwd: paths.dirname(script), assetRoot,
      });
    });

    it('prefers the workspace virtual environment over a stale packaged sidecar', () => {
      expect(resolveScienceRuntime({ ...options, exists: () => true })).toEqual({
        command: workspacePython, args: [script], cwd: paths.dirname(script), assetRoot,
      });
    });

    it('falls back to a built native sidecar when the virtual environment is absent', () => {
      expect(resolveScienceRuntime({ ...options, exists: (candidate) => candidate === builtExecutable })).toEqual({
        command: builtExecutable, args: [], cwd: paths.dirname(builtExecutable), assetRoot,
      });
    });

    it('uses the platform Python launcher as a last resort and ignores blank overrides', () => {
      expect(resolveScienceRuntime({ ...options, exists: () => false,
        environment: { CORTEXLUME_PYTHON: '  ' } })).toEqual({
        command: platform === 'win32' ? 'py' : 'python3',
        args: platform === 'win32' ? ['-3.12', script] : [script],
        cwd: paths.dirname(script), assetRoot,
      });
    });
  });
}

describe('MCP resources root', () => {
  it('uses a sibling resources directory on Linux', () => {
    expect(resolveResourcesRoot('/opt/CortexLume/cortexlume', 'linux', '')).toBe('/opt/CortexLume/resources');
  });
  it('uses a sibling resources directory on Windows', () => {
    expect(resolveResourcesRoot('C:\\CortexLume\\CortexLume.exe', 'win32', '')).toBe('C:\\CortexLume\\resources');
  });
  it('uses the app bundle Resources directory on macOS', () => {
    expect(resolveResourcesRoot('/Applications/CortexLume.app/Contents/MacOS/CortexLume', 'darwin', ''))
      .toBe('/Applications/CortexLume.app/Contents/Resources');
  });
  it('prefers the explicit resources root supplied by the Electron parent', () => {
    expect(resolveResourcesRoot('/usr/bin/node', 'linux', '/opt/Cortex Lume/resources'))
      .toBe('/opt/Cortex Lume/resources');
  });
});
