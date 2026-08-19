export type UpdateStatus =
  | 'development'
  | 'up-to-date'
  | 'available'
  | 'offline'
  | 'invalid-response';

export interface UpdateCheckResult {
  status: UpdateStatus;
  currentVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
  installerAvailable?: boolean;
  portableAvailable?: boolean;
  detail?: string;
}

export interface StartupRuntimeApi {
  checkUpdate(): Promise<UpdateCheckResult>;
  openRelease(): Promise<boolean>;
}

export interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface ParsedGithubRelease {
  version: string;
  releaseUrl: string;
  installerAvailable: boolean;
  portableAvailable: boolean;
}

export function parseStableSemver(value: string): [number, number, number] | null {
  const match = value.trim().match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (!match) return null;
  const parts = match.slice(1).map(Number) as [number, number, number];
  return parts.every((part) => Number.isSafeInteger(part)) ? parts : null;
}

export function compareStableSemver(left: string, right: string): number | null {
  const a = parseStableSemver(left);
  const b = parseStableSemver(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! > b[index]! ? 1 : -1;
  }
  return 0;
}

function isTrustedReleaseUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'github.com'
      && url.pathname.startsWith('/inewhero/CortexLume/releases/');
  } catch {
    return false;
  }
}

function isTrustedAssetUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && (url.hostname === 'github.com'
        || url.hostname === 'objects.githubusercontent.com'
        || url.hostname === 'release-assets.githubusercontent.com');
  } catch {
    return false;
  }
}

export function parseGithubRelease(value: unknown): ParsedGithubRelease | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.draft === true || record.prerelease === true) return null;
  const tagName = typeof record.tag_name === 'string' ? record.tag_name : '';
  const parsed = parseStableSemver(tagName);
  if (!parsed || !isTrustedReleaseUrl(record.html_url)) return null;
  const assets = Array.isArray(record.assets) ? record.assets : [];
  const trustedAssets = assets.filter((asset): asset is GithubReleaseAsset => {
    if (!asset || typeof asset !== 'object') return false;
    const item = asset as Record<string, unknown>;
    return typeof item.name === 'string' && isTrustedAssetUrl(item.browser_download_url);
  });
  const version = parsed.join('.');
  return {
    version,
    releaseUrl: record.html_url,
    installerAvailable: trustedAssets.some((asset) => /CortexLume-.*-win-x64-Setup\.exe$/i.test(asset.name)),
    portableAvailable: trustedAssets.some((asset) => /CortexLume-.*-win-x64-portable\.zip$/i.test(asset.name)),
  };
}
