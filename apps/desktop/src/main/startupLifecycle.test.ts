import { describe, expect, it, vi } from 'vitest';
import { checkGithubUpdate, MAX_RELEASE_RESPONSE_BYTES } from './startupLifecycle';

function releaseResponse(tag = 'v1.3.0') {
  return new Response(JSON.stringify({
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/inewhero/CortexLume/releases/tag/${tag}`,
    assets: [
      { name: 'CortexLume-1.3.0-win-x64-Setup.exe', browser_download_url: 'https://github.com/inewhero/CortexLume/releases/download/v1.3.0/setup.exe' },
      { name: 'CortexLume-1.3.0-win-x64-portable.zip', browser_download_url: 'https://github.com/inewhero/CortexLume/releases/download/v1.3.0/portable.zip' },
    ],
  }), { status: 200 });
}

describe('startup lifecycle', () => {
  it('reports a newer stable GitHub release and supported packages', async () => {
    const fetchImpl = vi.fn(async () => releaseResponse());
    await expect(checkGithubUpdate('1.2.0', fetchImpl as typeof fetch)).resolves.toMatchObject({
      status: 'available', latestVersion: '1.3.0', installerAvailable: true, portableAvailable: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.github.com/repos/inewhero/CortexLume/releases/latest',
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    );
  });

  it('does not downgrade when the release is older', async () => {
    await expect(checkGithubUpdate('1.4.0', vi.fn(async () => releaseResponse()) as typeof fetch))
      .resolves.toMatchObject({ status: 'up-to-date', latestVersion: '1.3.0' });
  });

  it('fails closed on invalid releases and continues offline on network failure', async () => {
    await expect(checkGithubUpdate('1.2.0', vi.fn(async () => releaseResponse('v2.0.0-beta.1')) as typeof fetch))
      .resolves.toMatchObject({ status: 'invalid-response' });
    await expect(checkGithubUpdate('1.2.0', vi.fn(async () => { throw new Error('offline'); }) as typeof fetch))
      .resolves.toMatchObject({ status: 'offline' });
  });

  it('aborts a streaming release response as soon as it crosses the byte limit', async () => {
    let cancelled = false;
    let signal: AbortSignal | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_RELEASE_RESPONSE_BYTES + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal as AbortSignal | undefined;
      return new Response(body, { status: 200 });
    });

    await expect(checkGithubUpdate('1.2.0', fetchImpl as typeof fetch)).resolves.toMatchObject({
      status: 'invalid-response', detail: expect.stringContaining('exceeded the accepted size'),
    });
    expect(cancelled).toBe(true);
    expect(signal?.aborted).toBe(true);
  });
});
