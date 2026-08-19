import {
  compareStableSemver,
  parseGithubRelease,
  type UpdateCheckResult,
} from '../shared/startup';

const LATEST_RELEASE_API = 'https://api.github.com/repos/inewhero/CortexLume/releases/latest';
const MAX_RELEASE_RESPONSE_BYTES = 512 * 1024;

export async function checkGithubUpdate(
  currentVersion: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 4_500,
): Promise<UpdateCheckResult> {
  if (compareStableSemver(currentVersion, currentVersion) === null) {
    return { status: 'invalid-response', currentVersion, detail: 'The installed version is not a stable semantic version.' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(LATEST_RELEASE_API, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `CortexLume/${currentVersion}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      return { status: 'offline', currentVersion, detail: `GitHub Releases returned HTTP ${response.status}.` };
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RELEASE_RESPONSE_BYTES) {
      return { status: 'invalid-response', currentVersion, detail: 'The release response exceeded the accepted size.' };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { status: 'invalid-response', currentVersion, detail: 'GitHub Releases returned invalid JSON.' };
    }
    const release = parseGithubRelease(raw);
    if (!release) {
      return { status: 'invalid-response', currentVersion, detail: 'The latest release did not pass repository and version checks.' };
    }
    const comparison = compareStableSemver(release.version, currentVersion);
    if (comparison === null) {
      return { status: 'invalid-response', currentVersion, detail: 'The latest release version is invalid.' };
    }
    return {
      status: comparison > 0 ? 'available' : 'up-to-date',
      currentVersion,
      latestVersion: release.version,
      releaseUrl: release.releaseUrl,
      installerAvailable: release.installerAvailable,
      portableAvailable: release.portableAvailable,
    };
  } catch (error) {
    return {
      status: 'offline',
      currentVersion,
      detail: error instanceof Error && error.name === 'AbortError'
        ? 'The update check timed out.'
        : 'GitHub Releases could not be reached.',
    };
  } finally {
    clearTimeout(timeout);
  }
}
