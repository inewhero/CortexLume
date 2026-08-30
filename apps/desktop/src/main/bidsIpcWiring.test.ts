import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('BIDS main-process IPC wiring', () => {
  it('keeps preload and the trusted handler on the async builder and safe writer path', () => {
    const mainSource = readFileSync(fileURLToPath(new URL('./main.ts', import.meta.url)), 'utf8');
    const start = mainSource.indexOf("trustedHandle('export:bids-geometry'");
    const end = mainSource.indexOf("trustedHandle('science:health'", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const handler = mainSource.slice(start, end);
    expect(handler).toContain("withProjectOperation('export', rawOptions");
    expect(handler).toContain("chooseExportDirectory('Export BIDS-compatible geometry sidecars')");
    expect(handler).toContain('buildBidsGeometryExportAsync(project, runOptions)');
    expect(handler).toContain('writeExportBundle(directory, bundle, runOptions)');
    expect(handler).toContain('maxPayloadBytes: IPC_DEFAULT_MAX_PAYLOAD_BYTES');

    const preloadSource = readFileSync(
      fileURLToPath(new URL('../preload/preload.ts', import.meta.url)),
      'utf8',
    );
    expect(preloadSource).toContain("ipcRenderer.invoke('export:bids-geometry', project, options)");
  });
});
