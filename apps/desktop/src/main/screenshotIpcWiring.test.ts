import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('scientific screenshot IPC wiring', () => {
  it('uses the trusted boundary, authorized project set, bounded payload, and safe writer', () => {
    const source = readFileSync(fileURLToPath(new URL('./main.ts', import.meta.url)), 'utf8');
    const start = source.indexOf("trustedHandle('screenshot:save'");
    const end = source.indexOf("trustedHandle('input:digitizer'", start);
    const handler = source.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(handler).toContain('authorizedProjectPaths.has(resolvedProjectPath)');
    expect(handler).toContain('decodeScientificScreenshotBase64(pngBase64)');
    expect(handler).toContain('saveScientificScreenshot(');
    expect(handler).toContain('maxPayloadBytes: IPC_SCREENSHOT_MAX_PAYLOAD_BYTES');
  });
});
