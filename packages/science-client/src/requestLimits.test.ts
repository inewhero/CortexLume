import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ScienceClient } from './index.js';

describe('ScienceClient payload budgets', () => {
  it('rejects a request body above the shared limit before sending it', async () => {
    const client = new ScienceClient(() => ({
      command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/fake-sidecar.mjs', import.meta.url))],
      cwd: process.cwd(),
      assetRoot: process.cwd(),
    }));
    try {
      await expect(client.request('/echo', { value: 'x'.repeat(8 * 1024 * 1024) }))
        .rejects.toThrow('request exceeds the');
    } finally {
      client.stop();
    }
  });
});
