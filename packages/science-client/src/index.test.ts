import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScienceClient } from './index.js';

describe('ScienceClient', () => {
  it('does not start the sidecar for a request that is already cancelled', async () => {
    let configurationCalls = 0;
    const client = new ScienceClient(() => {
      configurationCalls += 1;
      return {
        command: process.execPath,
        args: [path.resolve(process.cwd(), 'src/fixtures/fake-sidecar.mjs')],
        cwd: process.cwd(),
        assetRoot: process.cwd(),
      };
    });
    const controller = new AbortController();
    controller.abort();

    await expect(client.request('/echo', { value: 7 }, { signal: controller.signal }))
      .rejects.toThrow('request cancelled');
    expect(configurationCalls).toBe(0);
  });

  it('starts a token-authenticated local sidecar and reuses it for requests', async () => {
    const assetRoot = path.resolve(process.cwd(), '../../assets/templates/MNI152NLin6Asym');
    const client = new ScienceClient(() => ({
      command: process.execPath,
      args: [path.resolve(process.cwd(), 'src/fixtures/fake-sidecar.mjs')],
      cwd: process.cwd(),
      assetRoot,
    }));
    try {
      const first = await client.request<{ ok: boolean; method: string; payload: unknown; assetRoot: string }>('/health');
      const second = await client.request<{ ok: boolean; method: string; payload: unknown }>('/echo', { value: 7 });
      expect(first).toEqual({ ok: true, method: 'GET', payload: null, assetRoot });
      expect(second).toEqual({ ok: true, method: 'POST', payload: { value: 7 }, assetRoot });
    } finally {
      client.stop();
    }
  }, 20_000);

  it('does not reuse a server-closed socket after synchronous planning blocks the event loop', async () => {
    const client = new ScienceClient(() => ({
      command: process.execPath,
      args: [
        path.resolve(process.cwd(), 'src/fixtures/fake-sidecar.mjs'),
        '--keep-alive-timeout-ms', '25',
      ],
      cwd: process.cwd(),
      assetRoot: process.cwd(),
    }));
    try {
      await expect(client.request('/health')).resolves.toMatchObject({ ok: true });
      const blockedUntil = performance.now() + 100;
      while (performance.now() < blockedUntil) {
        // Model planLayouts: the synchronous mesh search blocks socket events.
      }
      await expect(client.request('/echo', { value: 8 }))
        .resolves.toMatchObject({ payload: { value: 8 } });
    } finally {
      client.stop();
    }
  }, 20_000);

  it('fails promptly when the sidecar exits or reports an invalid ready event', async () => {
    const fixture = path.resolve(process.cwd(), 'src/fixtures/fake-sidecar.mjs');
    const makeClient = (argument: string) => new ScienceClient(() => ({
      command: process.execPath,
      args: [fixture, argument],
      cwd: process.cwd(),
      assetRoot: process.cwd(),
    }), () => undefined, 2_000);
    const exited = makeClient('--exit');
    const invalid = makeClient('--invalid-ready');
    try {
      await expect(exited.start()).rejects.toThrow('exited before becoming ready');
      await expect(invalid.start()).rejects.toThrow();
    } finally {
      exited.stop();
      invalid.stop();
    }
  });

  it('rejects a response whose declared body exceeds the boundary limit', async () => {
    const client = new ScienceClient(() => ({
      command: process.execPath,
      args: [path.resolve(process.cwd(), 'src/fixtures/fake-sidecar.mjs')],
      cwd: process.cwd(),
      assetRoot: process.cwd(),
    }));
    try {
      await expect(client.request('/oversized')).rejects.toThrow('exceeded the 16 MB limit');
    } finally {
      client.stop();
    }
  });

  it('settles an in-flight startup when stopped and can restart cleanly', async () => {
    const fixture = path.resolve(process.cwd(), 'src/fixtures/fake-sidecar.mjs');
    let delayReady = true;
    const client = new ScienceClient(() => ({
      command: process.execPath,
      args: [fixture, ...(delayReady ? ['--delay-ready'] : [])],
      cwd: process.cwd(),
      assetRoot: process.cwd(),
    }), () => undefined, 20_000);
    const startup = client.start();
    client.stop();
    await expect(startup).rejects.toThrow('startup cancelled');
    delayReady = false;
    try {
      await expect(client.start()).resolves.toBeUndefined();
    } finally {
      client.stop();
    }
  }, 20_000);

  it('does not send HTTP when cancellation wins during sidecar startup', async () => {
    const fixture = path.resolve(process.cwd(), 'src/fixtures/fake-sidecar.mjs');
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'cortexlume-science-client-'));
    const requestMarker = path.join(temporaryDirectory, 'requests.log');
    const client = new ScienceClient(() => ({
      command: process.execPath,
      args: [fixture, '--delay-ready-ms', '120', '--request-marker', requestMarker],
      cwd: process.cwd(),
      assetRoot: process.cwd(),
    }), () => undefined, 2_000);
    const controller = new AbortController();
    try {
      const request = client.request('/echo', { value: 7 }, { signal: controller.signal });
      setTimeout(() => controller.abort(), 10);
      await expect(request).rejects.toThrow('request cancelled');
      await expect(readFile(requestMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      client.stop();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }, 5_000);

  it('does not wait for the startup timeout after cancellation', async () => {
    const fixture = path.resolve(process.cwd(), 'src/fixtures/fake-sidecar.mjs');
    const client = new ScienceClient(() => ({
      command: process.execPath,
      args: [fixture, '--delay-ready-ms', '1_500'],
      cwd: process.cwd(),
      assetRoot: process.cwd(),
    }), () => undefined, 5_000);
    const controller = new AbortController();
    const startedAt = Date.now();
    try {
      const request = client.request('/echo', { value: 7 }, { signal: controller.signal });
      setTimeout(() => controller.abort(), 10);
      await expect(request).rejects.toThrow('request cancelled');
      expect(Date.now() - startedAt).toBeLessThan(500);
    } finally {
      client.stop();
    }
  }, 5_000);

  it('defers stop until an active request settles, then restarts queued work', async () => {
    const fixture = path.resolve(process.cwd(), 'src/fixtures/fake-sidecar.mjs');
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'cortexlume-science-client-'));
    const requestMarker = path.join(temporaryDirectory, 'requests.log');
    const client = new ScienceClient(() => ({
      command: process.execPath,
      args: [fixture, '--delay-response-ms', '100', '--request-marker', requestMarker],
      cwd: process.cwd(),
      assetRoot: process.cwd(),
    }), () => undefined, 2_000);
    try {
      const first = client.request<{ payload: { value: number } }>('/echo', { value: 1 });
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          if ((await readFile(requestMarker, 'utf8')).length > 0) break;
        } catch {
          // The sidecar may still be completing its ready handshake.
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      client.stop();
      await expect(first).resolves.toMatchObject({ payload: { value: 1 } });
      await expect(client.request<{ payload: { value: number } }>('/echo', { value: 2 }))
        .resolves.toMatchObject({ payload: { value: 2 } });
    } finally {
      client.stop();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }, 10_000);

  it('queues requests behind an exclusive lifecycle section', async () => {
    const fixture = path.resolve(process.cwd(), 'src/fixtures/fake-sidecar.mjs');
    const client = new ScienceClient(() => ({
      command: process.execPath,
      args: [fixture],
      cwd: process.cwd(),
      assetRoot: process.cwd(),
    }), () => undefined, 2_000);
    try {
      let sectionFinished = false;
      const exclusive = client.withExclusive(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        client.stop();
        sectionFinished = true;
      });
      const request = client.request<{ payload: { value: number } }>('/echo', { value: 3 });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(sectionFinished).toBe(false);
      await exclusive;
      await expect(request).resolves.toMatchObject({ payload: { value: 3 } });
    } finally {
      client.stop();
    }
  }, 10_000);

  it('drains two active requests before stop and restarts queued work without killing either response', async () => {
    const fixture = path.resolve(process.cwd(), 'src/fixtures/fake-sidecar.mjs');
    const client = new ScienceClient(() => ({
      command: process.execPath,
      args: [fixture, '--delay-response-ms', '80'],
      cwd: process.cwd(),
      assetRoot: process.cwd(),
    }), () => undefined, 2_000);
    try {
      const first = client.request<{ payload: { value: number } }>('/echo', { value: 1 });
      const second = client.request<{ payload: { value: number } }>('/echo', { value: 2 });
      await new Promise((resolve) => setTimeout(resolve, 30));
      client.stop();
      const queued = client.request<{ payload: { value: number } }>('/echo', { value: 3 });
      await expect(Promise.all([first, second])).resolves.toEqual([
        expect.objectContaining({ payload: { value: 1 } }),
        expect.objectContaining({ payload: { value: 2 } }),
      ]);
      await expect(queued).resolves.toMatchObject({ payload: { value: 3 } });
    } finally {
      client.stop();
    }
  }, 10_000);

  it('settles an aborted queued lease and recovers after an exclusive throws', async () => {
    const fixture = path.resolve(process.cwd(), 'src/fixtures/fake-sidecar.mjs');
    const client = new ScienceClient(() => ({
      command: process.execPath,
      args: [fixture],
      cwd: process.cwd(),
      assetRoot: process.cwd(),
    }), () => undefined, 2_000);
    let releaseExclusive!: () => void;
    const exclusiveGate = new Promise<void>((resolve) => { releaseExclusive = resolve; });
    try {
      const exclusive = client.withExclusive(async () => {
        await exclusiveGate;
        throw new Error('exclusive fixture failure');
      });
      const controller = new AbortController();
      const cancelled = client.request('/echo', { value: 4 }, { signal: controller.signal });
      controller.abort();
      await expect(cancelled).rejects.toThrow('request cancelled');
      releaseExclusive();
      await expect(exclusive).rejects.toThrow('exclusive fixture failure');
      await expect(client.request<{ payload: { value: number } }>('/echo', { value: 5 }))
        .resolves.toMatchObject({ payload: { value: 5 } });
    } finally {
      releaseExclusive?.();
      client.stop();
    }
  }, 10_000);
});
