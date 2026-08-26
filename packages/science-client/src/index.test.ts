import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScienceClient } from './index.js';

describe('ScienceClient', () => {
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
});
