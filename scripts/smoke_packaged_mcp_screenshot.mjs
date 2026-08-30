import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { inflateSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const executable = path.resolve(process.argv[2] ?? 'apps/desktop/out/CortexLume-win32-x64/CortexLume.exe');
const sourceProject = path.resolve(process.argv[3] ?? 'Mentalizing-5x3.cortexlume');
const root = await mkdtemp(path.join(os.tmpdir(), 'cortexlume-mcp-screenshot-smoke-'));
const projectPath = path.join(root, 'worker-smoke.cortexlume');
await copyFile(sourceProject, projectPath);
const transport = new StdioClientTransport({
  command: executable,
  args: ['--mcp-stdio', `--mcp-root=${root}`],
  cwd: path.dirname(executable),
  env: Object.fromEntries(Object.entries(process.env).filter((entry) => typeof entry[1] === 'string')),
  stderr: 'pipe',
});
let stderr = '';
transport.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
const client = new Client({ name: 'cortexlume-screenshot-smoke', version: '1.0.0' });

function inspectRgbaAlpha(png, width, height) {
  const idat = [];
  let offset = 8;
  while (offset < png.byteLength) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const scanlines = inflateSync(Buffer.concat(idat));
  const stride = width * 4 + 1;
  let transparentPixels = 0;
  let visiblePixels = 0;
  for (let row = 0; row < height; row += 1) {
    if (scanlines[row * stride] !== 0) {
      throw new Error('Screenshot PNG unexpectedly uses a filtered scanline.');
    }
    for (let column = 0; column < width; column += 1) {
      const alpha = scanlines[row * stride + 1 + column * 4 + 3];
      if (alpha === 0) transparentPixels += 1;
      else visiblePixels += 1;
    }
  }
  if (transparentPixels === 0 || visiblePixels === 0) {
    throw new Error(`Screenshot alpha content is invalid: ${transparentPixels} transparent, ${visiblePixels} visible pixels.`);
  }
  return { transparentPixels, visiblePixels };
}

try {
  await client.connect(transport);
  const result = await client.callTool({
    name: 'capture_project_screenshot',
    arguments: {
      projectPath,
      width: 640,
      height: 360,
      dpr: 1,
      camera: { kind: 'preset', preset: 'gui-default' },
      layers: { surfaceOverlay: 'project', grid: true },
    },
  }, { timeout: 120_000 });
  if (result.isError || !result.structuredContent) {
    throw new Error(`Screenshot tool failed: ${JSON.stringify(result.content)}`);
  }
  const capture = result.structuredContent;
  const png = await readFile(capture.path);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (view.getUint32(16) !== 640 || view.getUint32(20) !== 360 || png[25] !== 6
    || capture.layers?.groundGrid !== false || capture.backgroundIncluded !== false
    || capture.encoding !== 'rgba8-lossless-png') {
    throw new Error(`Screenshot metadata/PNG mismatch: ${JSON.stringify(capture)}`);
  }
  const alpha = inspectRgbaAlpha(png, 640, 360);
  process.stdout.write(`${JSON.stringify({
    executable,
    path: capture.path,
    width: capture.width,
    height: capture.height,
    transparent: capture.transparent,
    camera: capture.camera,
    layers: capture.layers,
    alpha,
  }, null, 2)}\n`);
} catch (error) {
  if (stderr.trim()) process.stderr.write(`MCP stderr:\n${stderr}\n`);
  throw error;
} finally {
  await client.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
