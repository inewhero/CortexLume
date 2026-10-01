import { describe, expect, it } from 'vitest';
import {
  compareStableSemver,
  parseGithubRelease,
  parseStableSemver,
} from './startup';

describe('startup policy helpers', () => {
  it('accepts only stable semantic versions and compares them numerically', () => {
    expect(parseStableSemver('v1.12.3')).toEqual([1, 12, 3]);
    expect(parseStableSemver('1.2.0-beta.1')).toBeNull();
    expect(parseStableSemver('01.2.0')).toBeNull();
    expect(compareStableSemver('1.10.0', '1.2.9')).toBe(1);
  });

  it('accepts an authoritative release with the supported Windows assets', () => {
    expect(parseGithubRelease({
      tag_name: 'v1.3.0', draft: false, prerelease: false,
      html_url: 'https://github.com/inewhero/CortexLume/releases/tag/v1.3.0',
      assets: [
        { name: 'CortexLume-1.3.0-win-x64-Setup.exe', browser_download_url: 'https://github.com/inewhero/CortexLume/releases/download/v1.3.0/setup.exe' },
        { name: 'CortexLume-1.3.0-win-x64-portable.zip', browser_download_url: 'https://objects.githubusercontent.com/file' },
      ],
    })).toMatchObject({ version: '1.3.0', installerAvailable: true, portableAvailable: true });
  });

  it('rejects prereleases and release URLs outside the authoritative repository', () => {
    expect(parseGithubRelease({ tag_name: 'v2.0.0-beta.1', html_url: 'https://github.com/inewhero/CortexLume/releases/tag/v2' })).toBeNull();
    expect(parseGithubRelease({ tag_name: 'v2.0.0', html_url: 'https://example.com/release', assets: [] })).toBeNull();
  });

});

describe('platform-aware release packages', () => {
  const release = {
    tag_name: 'v1.3.0',
    html_url: 'https://github.com/inewhero/CortexLume/releases/tag/v1.3.0',
    assets: [
      'CortexLume-1.3.0-win-x64-Setup.exe',
      'CortexLume-1.3.0-win-x64-portable.zip',
      'CortexLume-1.3.0-linux-x64-portable.zip',
    ].map((name) => ({ name, browser_download_url: `https://github.com/inewhero/CortexLume/releases/download/v1.3.0/${name}` })),
  };

  it('advertises only the Linux portable package on Linux', () => {
    expect(parseGithubRelease(release, { platform: 'linux', arch: 'x64' }))
      .toMatchObject({ installerAvailable: false, portableAvailable: true });
  });

  it('does not advertise Windows packages when no Linux package exists', () => {
    expect(parseGithubRelease({ ...release, assets: release.assets.slice(0, 2) }, { platform: 'linux', arch: 'x64' }))
      .toMatchObject({ installerAvailable: false, portableAvailable: false });
  });

  it('requires a matching CPU architecture', () => {
    expect(parseGithubRelease(release, { platform: 'linux', arch: 'arm64' }))
      .toMatchObject({ installerAvailable: false, portableAvailable: false });
    const name = 'CortexLume-1.3.0-linux-arm64-portable.zip';
    const armRelease = { ...release, assets: [{ name, browser_download_url: `https://github.com/inewhero/CortexLume/releases/download/v1.3.0/${name}` }] };
    expect(parseGithubRelease(armRelease, { platform: 'linux', arch: 'arm64' }))
      .toMatchObject({ installerAvailable: false, portableAvailable: true });
    expect(parseGithubRelease(armRelease, { platform: 'linux', arch: 'x64' }))
      .toMatchObject({ installerAvailable: false, portableAvailable: false });
  });

  it.each([
    { platform: 'darwin', arch: 'arm64' },
    { platform: 'win32', arch: 'arm64' },
    { platform: 'linux', arch: 'ia32' },
    { platform: 'freebsd', arch: 'x64' },
  ])('does not claim usable packages for unsupported target $platform/$arch', (target) => {
    expect(parseGithubRelease(release, target))
      .toMatchObject({ installerAvailable: false, portableAvailable: false });
  });

  it('still requires trusted download URLs for a matching Linux asset', () => {
    expect(parseGithubRelease({ ...release, assets: [{
      name: 'CortexLume-1.3.0-linux-x64-portable.zip', browser_download_url: 'https://example.com/download.zip',
    }] }, { platform: 'linux', arch: 'x64' }))
      .toMatchObject({ installerAvailable: false, portableAvailable: false });
  });
});
