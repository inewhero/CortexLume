import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('project reveal IPC wiring', () => {
  it('reveals only an authorized saved project through the trusted boundary', () => {
    const source = readFileSync(fileURLToPath(new URL('./main.ts', import.meta.url)), 'utf8');
    const start = source.indexOf("trustedHandle('project:reveal'");
    const end = source.indexOf("trustedHandle('screenshot:save'", start);
    const handler = source.slice(start, end);

    expect(start).toBeGreaterThan(0);
    expect(handler).toContain('authorizedProjectPaths.has(resolvedPath)');
    expect(handler).toContain('existsSync(resolvedPath)');
    expect(handler).toContain('shell.showItemInFolder(resolvedPath)');
    expect(handler).toContain('maxPayloadBytes: IPC_SMALL_MAX_PAYLOAD_BYTES');
  });
});
