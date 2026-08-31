import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('AtlasViewer main-process IPC wiring', () => {
  it('keeps the trusted handler on the shared operation, chooser, async builder, and safe writer path', () => {
    const sourcePath = fileURLToPath(new URL('./main.ts', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8');
    const start = source.indexOf("trustedHandle('export:atlasviewer'");
    const end = source.indexOf("trustedHandle('science:health'", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const handler = source.slice(start, end);
    expect(handler).toContain("withProjectOperation('export', rawOptions");
    expect(handler).toContain("const selectedDirectory = await chooseExportDirectory('Export AtlasViewer SD probe geometry')");
    expect(handler).toContain('buildAtlasViewerExportAsync(project, runOptions)');
    expect(handler).toContain("createUniqueExportDirectory(");
    expect(handler).toContain("'CortexLume_AtlasViewer_Export'");
    expect(handler).toContain('writeExportBundle(directory, bundle, runOptions)');
    expect(handler).toContain("path.join(directory, 'cortexlume_open_atlasviewer.m')");
    expect(handler).toContain('await shell.openPath(bridgePath)');
    expect(handler).toContain('scriptOpened: true');
    expect(handler).not.toContain('inspectAtlasViewer(');
    expect(handler).not.toContain('launchAtlasViewer(');
    expect(handler).toContain('return { directory, files, warnings, atlasViewer }');
    expect(handler).toContain('maxPayloadBytes: IPC_DEFAULT_MAX_PAYLOAD_BYTES');
  });
});
