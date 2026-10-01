import path from 'node:path';

export function packagedExecutable(platform = process.platform, arch = process.arch) {
  const directory = path.join('apps', 'desktop', 'out', `CortexLume-${platform}-${arch}`);
  if (platform === 'win32') return path.join(directory, 'CortexLume.exe');
  if (platform === 'darwin') return path.join(directory, 'CortexLume.app', 'Contents', 'MacOS', 'CortexLume');
  if (platform === 'linux') return path.join(directory, 'CortexLume');
  throw new Error(`No packaged executable layout is configured for ${platform}`);
}
