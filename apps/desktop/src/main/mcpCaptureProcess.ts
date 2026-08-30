import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import {
  CortexLumeProjectSchema,
  type CortexLumeProject,
} from '@cortexlume/contracts';
import {
  type McpScreenshotCameraState,
  type McpScreenshotLayerState,
  type McpScreenshotRenderRequest,
  type McpScreenshotRenderResult,
} from '../shared/mcpScreenshot';
import { durableAtomicCreateExclusive, stableReadRegularFile } from './durableFile';

export const MCP_CAPTURE_WORKER_TIMEOUT_MS = 90_000;
export const MCP_CAPTURE_RESULT_MAX_BYTES = 64 * 1024;

export interface McpCaptureWorkerRequestFile {
  version: 1;
  project: CortexLumeProject;
  projectPath: string;
  sourceProjectSha256: string;
  temporaryPath: string;
  resultPath: string;
  logicalWidth: number;
  logicalHeight: number;
  dpr: number;
  camera: McpScreenshotCameraState;
  layers: McpScreenshotLayerState;
}

interface McpCaptureWorkerResultFile extends McpScreenshotRenderResult {
  version: 1;
  ok: true;
}

export interface McpCaptureProcessOptions {
  executable: string;
  appRoot: string;
  packaged: boolean;
  authorizedRoots: readonly string[];
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

function exactKeys(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has an unexpected field set.`);
  }
}

export function parseMcpCaptureWorkerResult(raw: unknown): McpCaptureWorkerResultFile {
  exactKeys(raw, ['version', 'ok', 'width', 'height', 'camera', 'layers'], 'Screenshot worker result');
  if (raw.version !== 1 || raw.ok !== true) throw new Error('Screenshot worker result version/status is invalid.');
  if (!Number.isInteger(raw.width) || !Number.isInteger(raw.height)
    || (raw.width as number) < 1 || (raw.height as number) < 1) {
    throw new Error('Screenshot worker dimensions are invalid.');
  }
  // Camera and layer equality is checked by the MCP runtime against its
  // resolved request. Preserve these opaque objects here instead of silently
  // filling missing values in the process bridge.
  return raw as unknown as McpCaptureWorkerResultFile;
}

/**
 * Spawn a non-Node Electron process while keeping its stdout fully isolated
 * from the MCP stdio transport. The worker receives only a bounded request
 * file and writes the PNG to the authorized private temporary path.
 */
export function createMcpCaptureProcess(
  options: McpCaptureProcessOptions,
): (request: McpScreenshotRenderRequest) => Promise<McpScreenshotRenderResult> {
  return async (request) => {
    const requestPath = `${request.temporaryPath}.request.json`;
    const resultPath = `${request.temporaryPath}.result.json`;
    const payload: McpCaptureWorkerRequestFile = {
      version: 1,
      project: CortexLumeProjectSchema.parse(request.project),
      projectPath: request.projectPath,
      sourceProjectSha256: request.sourceProjectSha256,
      temporaryPath: request.temporaryPath,
      resultPath,
      logicalWidth: request.logicalWidth,
      logicalHeight: request.logicalHeight,
      dpr: request.dpr,
      camera: request.camera,
      layers: request.layers,
    };
    const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
    let stderr = '';
    try {
      await durableAtomicCreateExclusive(requestPath, payloadBytes, { ensureParent: false });
      const environment = { ...(options.environment ?? process.env) };
      delete environment.ELECTRON_RUN_AS_NODE;
      delete environment.CORTEXLUME_MCP_CHILD;
      environment.CORTEXLUME_MCP_CAPTURE_WORKER = '1';
      const workerArgument = `--mcp-capture-worker=${requestPath}`;
      const projectHashArgument = `--mcp-capture-project-sha256=${request.sourceProjectSha256}`;
      const rootArguments = options.authorizedRoots.map((root) => `--mcp-root=${root}`);
      const args = options.packaged
        ? [workerArgument, projectHashArgument, ...rootArguments]
        : [options.appRoot, workerArgument, projectHashArgument, ...rootArguments];
      await new Promise<void>((resolve, reject) => {
        const child = spawn(options.executable, args, {
          cwd: options.packaged ? path.dirname(options.executable) : options.appRoot,
          env: environment,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const timeout = setTimeout(() => {
          child.kill();
          reject(new Error(`Screenshot worker timed out after ${options.timeoutMs ?? MCP_CAPTURE_WORKER_TIMEOUT_MS} ms.`));
        }, options.timeoutMs ?? MCP_CAPTURE_WORKER_TIMEOUT_MS);
        child.stdout?.on('data', (chunk: Buffer) => {
          // Worker stdout is diagnostic-only and is intentionally never
          // forwarded to the MCP parent's protocol stdout.
          if (stderr.length < 32_768) stderr += chunk.toString();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          if (stderr.length < 32_768) stderr += chunk.toString();
        });
        child.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once('exit', (code) => {
          clearTimeout(timeout);
          if (code === 0) resolve();
          else reject(new Error(`Screenshot worker exited with code ${code ?? 'unknown'}${stderr.trim() ? `: ${stderr.trim()}` : '.'}`));
        });
      });
      const resultBytes = await stableReadRegularFile(resultPath, MCP_CAPTURE_RESULT_MAX_BYTES, {
        label: 'Screenshot worker result',
      });
      let decoded: unknown;
      try {
        decoded = JSON.parse(Buffer.from(resultBytes).toString('utf8'));
      } catch {
        throw new Error('Screenshot worker result is not valid JSON.');
      }
      return parseMcpCaptureWorkerResult(decoded);
    } finally {
      await Promise.all([
        rm(requestPath, { force: true }).catch(() => undefined),
        rm(resultPath, { force: true }).catch(() => undefined),
      ]);
    }
  };
}
