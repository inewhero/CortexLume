import path from 'node:path';

/** Windows release icons remain embedded in the executable by Packager. */
export function resolveWindowIcon(
  platform: NodeJS.Platform,
  packaged: boolean,
  appPath: string,
  resourcesPath: string,
): { icon?: string } {
  if (!packaged) return { icon: path.join(appPath, 'assets', 'icon.png') };
  if (platform === 'linux') return { icon: path.join(resourcesPath, 'icon.png') };
  return {};
}
