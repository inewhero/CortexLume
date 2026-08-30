import { EventEmitter } from 'node:events';
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readProjectArchiveDetailed } from '@cortexlume/project-io';

const { spawnCalls, spawnMock } = vi.hoisted(() => {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  return {
    spawnCalls: calls,
    spawnMock: vi.fn((command: string, args: string[], options: Record<string, unknown>) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough; stderr: PassThrough; kill(): void;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      calls.push({ command, args, options });
      setImmediate(() => {
        void (async () => {
          const requestArgument = args.find((argument) => argument.startsWith('--mcp-capture-worker='))!;
          const requestPath = requestArgument.slice('--mcp-capture-worker='.length);
          const request = JSON.parse(await readFile(requestPath, 'utf8'));
          child.stdout.write('renderer diagnostic that must not reach MCP stdout\n');
          await writeFile(request.resultPath, JSON.stringify({
            version: 1,
            ok: true,
            width: Math.round(request.logicalWidth * request.dpr),
            height: Math.round(request.logicalHeight * request.dpr),
            camera: request.camera,
            layers: request.layers,
          }));
          child.emit('exit', 0);
        })().catch((error) => child.emit('error', error));
      });
      return child;
    }),
  };
});

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { createMcpCaptureProcess } from './mcpCaptureProcess';

describe('MCP capture process bridge', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    spawnMock.mockClear();
  });

  it('isolates worker stdout and passes exact roots/hash through non-Node Electron args', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cortexlume-mcp-process-'));
    const projectPath = path.join(root, 'project.cortexlume');
    await copyFile(path.resolve(process.cwd(), '../../Mentalizing-5x3.cortexlume'), projectPath);
    const detailed = readProjectArchiveDetailed(await readFile(projectPath));
    const camera = {
      source: 'preset' as const, preset: 'front' as const,
      position: [0, -12, -360] as [number, number, number],
      target: [0, -12, 3] as [number, number, number],
      up: [0, 1, 0] as [number, number, number],
      fov: 39, near: 0.1, far: 2_000,
    };
    const layers = {
      scalp: true, grayMatter: true, whiteMatter: false,
      fivePoint: true, tenTen: true, pointLabels: false, fivePointLabelsIncluded: true,
      channelLabels: true, surfaceOverlay: 'none' as const, functionalMap: false,
      patches: true, digitizer: true, anatomicalCoverage: false, groundGrid: false as const,
    };
    const stdoutWrite = vi.spyOn(process.stdout, 'write');
    const capture = createMcpCaptureProcess({
      executable: 'C:\\CortexLume.exe',
      appRoot: 'E:\\CortexLume\\apps\\desktop',
      packaged: true,
      authorizedRoots: [root],
      environment: { ELECTRON_RUN_AS_NODE: '1', CORTEXLUME_MCP_CHILD: '1' },
    });
    const result = await capture({
      project: detailed.project,
      projectPath,
      sourceProjectSha256: detailed.archiveProjectSha256,
      temporaryPath: path.join(root, '.capture.png'),
      logicalWidth: 800,
      logicalHeight: 400,
      dpr: 1.5,
      camera,
      layers,
    });
    expect(result).toMatchObject({ width: 1200, height: 600, camera, layers });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.args).toContain(`--mcp-root=${root}`);
    expect(spawnCalls[0]!.args).toContain(`--mcp-capture-project-sha256=${detailed.archiveProjectSha256}`);
    expect((spawnCalls[0]!.options.env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect((spawnCalls[0]!.options.env as NodeJS.ProcessEnv).CORTEXLUME_MCP_CHILD).toBeUndefined();
    expect(stdoutWrite).not.toHaveBeenCalled();
    stdoutWrite.mockRestore();
  });
});
