import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('renderer workspace package resolution', () => {
  it('serves core from its real source path instead of an immutable node_modules URL', () => {
    const config = readFileSync(
      fileURLToPath(new URL('../../vite.renderer.config.ts', import.meta.url)),
      'utf8',
    );

    expect(config).toContain("../../packages/core/src/index.ts");
    expect(config).toContain("alias: { '@cortexlume/core': coreSourceEntry }");
    expect(config).toContain("optimizeDeps: { exclude: ['@cortexlume/core'] }");
  });
});
