import { copyFile, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readProjectArchiveDetailed } from '@cortexlume/project-io';
import { encodeRgbaPng } from '../renderer/lib/sceneScreenshot';
import { completeMcpCaptureWorker, loadMcpCaptureWorkerRequest } from './mcpCaptureWorker';

const camera = {
  source: 'preset', preset: 'gui-default',
  position: [215, 138, -300], target: [0, -12, 3], up: [0, 1, 0],
  fov: 39, near: 0.1, far: 2_000,
} as const;

const layers = {
  scalp: true, grayMatter: true, whiteMatter: false,
  fivePoint: true, tenTen: true, pointLabels: false, fivePointLabelsIncluded: true,
  channelLabels: true, surfaceOverlay: 'none', functionalMap: false,
  patches: false, digitizer: false, anatomicalCoverage: false, groundGrid: false,
} as const;

describe('MCP capture worker request boundary', () => {
  it('derives output paths and render-only project changes from the authorized archive', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cortexlume-mcp-worker-'));
    const projectPath = path.join(root, 'project.cortexlume');
    await copyFile(path.resolve(process.cwd(), '../../examples/cases/05-nifti-functional-target/nifti-visual-target.cortexlume'), projectPath);
    const detailed = readProjectArchiveDetailed(await readFile(projectPath));
    const temporaryPath = path.join(root, '.capture.png');
    const requestPath = `${temporaryPath}.request.json`;
    const rawProject = structuredClone(detailed.project);
    rawProject.layouts[0]!.name = 'tampered but schema-valid layout name';
    rawProject.instances = rawProject.instances.map((instance) => ({ ...instance, visible: true }));
    await writeFile(requestPath, JSON.stringify({
      version: 1,
      project: rawProject,
      projectPath,
      sourceProjectSha256: detailed.archiveProjectSha256,
      temporaryPath,
      resultPath: `${temporaryPath}.result.json`,
      logicalWidth: 640,
      logicalHeight: 320,
      dpr: 1.5,
      camera,
      layers,
    }));
    const request = await loadMcpCaptureWorkerRequest(requestPath, [root], detailed.archiveProjectSha256);
    const canonicalRoot = await realpath(root);
    expect(request.project.layouts[0]!.name).toBe(detailed.project.layouts[0]!.name);
    expect(request.project.instances.every((instance) => instance.visible === false)).toBe(true);
    expect(request.project.digitizerSessions.every((session) => session.visible === false)).toBe(true);
    expect(request.temporaryPath).toBe(path.join(canonicalRoot, '.capture.png'));
    expect(request.resultPath).toBe(path.join(canonicalRoot, '.capture.png.result.json'));
    const png = encodeRgbaPng(960, 480, new Uint8Array(960 * 480 * 4));
    await completeMcpCaptureWorker(request, {
      pngBase64: Buffer.from(png).toString('base64'),
      width: 960,
      height: 480,
      camera: request.camera,
      layers: request.layers,
    }, [root]);
    expect((await readFile(temporaryPath)).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await expect(completeMcpCaptureWorker(request, {
      pngBase64: Buffer.from(png).toString('base64'),
      width: 960,
      height: 480,
      camera: request.camera,
      layers: request.layers,
    }, [root])).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it('rejects request-controlled output paths and mismatched archive identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cortexlume-mcp-worker-path-'));
    const projectPath = path.join(root, 'project.cortexlume');
    await copyFile(path.resolve(process.cwd(), '../../examples/cases/05-nifti-functional-target/nifti-visual-target.cortexlume'), projectPath);
    const detailed = readProjectArchiveDetailed(await readFile(projectPath));
    const temporaryPath = path.join(root, '.capture.png');
    const requestPath = `${temporaryPath}.request.json`;
    await writeFile(requestPath, JSON.stringify({
      version: 1,
      project: detailed.project,
      projectPath,
      sourceProjectSha256: detailed.archiveProjectSha256,
      temporaryPath: path.join(root, 'different.png'),
      resultPath: `${temporaryPath}.result.json`,
      logicalWidth: 640,
      logicalHeight: 320,
      dpr: 1,
      camera,
      layers,
    }));
    await expect(loadMcpCaptureWorkerRequest(requestPath, [root], detailed.archiveProjectSha256))
      .rejects.toThrow(/derive exactly/);
    await writeFile(requestPath, JSON.stringify({
      version: 1,
      project: detailed.project,
      projectPath,
      sourceProjectSha256: detailed.archiveProjectSha256,
      temporaryPath,
      resultPath: `${temporaryPath}.result.json`,
      logicalWidth: 640,
      logicalHeight: 320,
      dpr: 1,
      camera,
      layers,
    }));
    await expect(loadMcpCaptureWorkerRequest(requestPath, [root], '0'.repeat(64)))
      .rejects.toThrow(/identity/);
    const unrelatedRoot = await mkdtemp(path.join(os.tmpdir(), 'cortexlume-mcp-unrelated-'));
    await expect(loadMcpCaptureWorkerRequest(requestPath, [unrelatedRoot], detailed.archiveProjectSha256))
      .rejects.toThrow(/outside MCP screenshot authorized roots/);
  });
});
