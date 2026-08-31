import path from 'node:path';
import {
  CortexLumeProjectSchema,
  CROSS_PROCESS_LIMITS,
} from '@cortexlume/contracts';
import { PROJECT_ARCHIVE_LIMITS, readProjectArchiveDetailed } from '@cortexlume/project-io';
import type {
  McpScreenshotCameraState,
  McpScreenshotLayerState,
  McpScreenshotWorkerCompletion,
  McpScreenshotWorkerRequest,
} from '../shared/mcpScreenshot';
import {
  durableAtomicCreateExclusive,
  resolveAuthorizedPath,
  stableReadRegularFile,
} from './durableFile';
import { decodeScientificScreenshotBase64 } from './screenshotWriter';

export const MCP_CAPTURE_REQUEST_MAX_BYTES = CROSS_PROCESS_LIMITS.projectJsonBytes + 1024 * 1024;

function normalized(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function assertExactKeys(value: unknown, expected: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new Error(`${label} has an unexpected field set.`);
  }
}

function parseVector(value: unknown, label: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3
    || value.some((item) => typeof item !== 'number' || !Number.isFinite(item) || Math.abs(item) > 10_000)) {
    throw new Error(`${label} must be a finite three-vector.`);
  }
  return value as [number, number, number];
}

function parseCamera(value: unknown): McpScreenshotCameraState {
  assertExactKeys(value, ['source', 'preset', 'position', 'target', 'up', 'fov', 'near', 'far'], 'Screenshot camera');
  if (value.source !== 'preset' && value.source !== 'explicit') throw new Error('Screenshot camera source is invalid.');
  if (value.preset !== null && !['gui-default', 'front', 'left', 'right', 'superior'].includes(String(value.preset))) {
    throw new Error('Screenshot camera preset is invalid.');
  }
  for (const key of ['fov', 'near', 'far'] as const) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) throw new Error(`Screenshot camera ${key} is invalid.`);
  }
  return {
    source: value.source,
    preset: value.preset as McpScreenshotCameraState['preset'],
    position: parseVector(value.position, 'Screenshot camera position'),
    target: parseVector(value.target, 'Screenshot camera target'),
    up: parseVector(value.up, 'Screenshot camera up'),
    fov: value.fov as number,
    near: value.near as number,
    far: value.far as number,
  };
}

function parseLayers(value: unknown): McpScreenshotLayerState {
  const keys = [
    'scalp', 'grayMatter', 'whiteMatter', 'fivePoint', 'tenTen', 'pointLabels',
    'fivePointLabelsIncluded', 'channelLabels', 'surfaceOverlay', 'functionalMap',
    'patches', 'digitizer', 'anatomicalCoverage', 'groundGrid',
  ] as const;
  assertExactKeys(value, keys, 'Screenshot layers');
  const booleanKeys = keys.filter((key) => key !== 'surfaceOverlay');
  if (booleanKeys.some((key) => typeof value[key] !== 'boolean')) throw new Error('Screenshot layer flags must be boolean.');
  if (!['none', 'functional-target', 'coverage-mosaic', 'coverage-region'].includes(String(value.surfaceOverlay))) {
    throw new Error('Screenshot surface overlay is invalid.');
  }
  if (value.groundGrid !== false || value.fivePointLabelsIncluded !== value.fivePoint
    || value.functionalMap !== (value.surfaceOverlay === 'functional-target')
    || value.anatomicalCoverage !== String(value.surfaceOverlay).startsWith('coverage-')) {
    throw new Error('Screenshot resolved layer metadata is inconsistent.');
  }
  return value as unknown as McpScreenshotLayerState;
}

export async function loadMcpCaptureWorkerRequest(
  rawRequestPath: string,
  authorizedRoots: readonly string[],
  expectedProjectSha256: string,
): Promise<McpScreenshotWorkerRequest> {
  if (!rawRequestPath.endsWith('.request.json')) throw new Error('Screenshot worker request path suffix is invalid.');
  const rawResolvedRequestPath = path.resolve(rawRequestPath);
  const requestPath = await resolveAuthorizedPath(rawRequestPath, authorizedRoots, {
    mustExist: true,
    label: 'MCP screenshot authorized roots',
  });
  const bytes = await stableReadRegularFile(requestPath, MCP_CAPTURE_REQUEST_MAX_BYTES, {
    label: 'Screenshot worker request',
  });
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new Error('Screenshot worker request is not valid JSON.');
  }
  assertExactKeys(raw, [
    'version', 'project', 'projectPath', 'sourceProjectSha256', 'temporaryPath', 'resultPath',
    'logicalWidth', 'logicalHeight', 'dpr', 'camera', 'layers',
  ], 'Screenshot worker request');
  if (raw.version !== 1) throw new Error('Screenshot worker request version is invalid.');
  // Validate the request-controlled spellings against the spelling supplied by
  // the trusted parent process. On Windows, authorization canonicalizes an 8.3
  // temp path (RUNNER~1) to its long form (runneradmin); output files do not yet
  // exist and therefore cannot be realpathed for a spelling comparison.
  const rawExpectedTemporaryPath = rawResolvedRequestPath.slice(0, -'.request.json'.length);
  const rawExpectedResultPath = `${rawExpectedTemporaryPath}.result.json`;
  const expectedTemporaryPath = requestPath.slice(0, -'.request.json'.length);
  const expectedResultPath = `${expectedTemporaryPath}.result.json`;
  if (typeof raw.temporaryPath !== 'string' || typeof raw.resultPath !== 'string'
    || normalized(raw.temporaryPath) !== normalized(rawExpectedTemporaryPath)
    || normalized(raw.resultPath) !== normalized(rawExpectedResultPath)) {
    throw new Error('Screenshot worker output paths do not derive exactly from the authorized request path.');
  }
  const temporaryPath = await resolveAuthorizedPath(expectedTemporaryPath, authorizedRoots, {
    mustExist: false,
    label: 'MCP screenshot authorized roots',
  });
  const resultPath = await resolveAuthorizedPath(expectedResultPath, authorizedRoots, {
    mustExist: false,
    label: 'MCP screenshot authorized roots',
  });
  if (typeof raw.projectPath !== 'string') throw new Error('Screenshot project path is invalid.');
  const projectPath = await resolveAuthorizedPath(raw.projectPath, authorizedRoots, {
    mustExist: true,
    label: 'MCP screenshot authorized roots',
  });
  const archive = await stableReadRegularFile(projectPath, PROJECT_ARCHIVE_LIMITS.compressedBytes, {
    label: 'Screenshot project archive',
  });
  const diskProject = readProjectArchiveDetailed(archive);
  // Parse the payload so malformed/tampered graphs fail closed, but never use
  // it as render authority. Rebuild the only permitted presentation changes
  // from the authorized on-disk archive and the independently parsed layers.
  CortexLumeProjectSchema.parse(raw.project);
  const layers = parseLayers(raw.layers);
  const project = CortexLumeProjectSchema.parse({
    ...diskProject.project,
    surfaceOverlay: layers.surfaceOverlay,
    instances: layers.patches
      ? diskProject.project.instances
      : diskProject.project.instances.map((instance) => ({ ...instance, visible: false })),
    digitizerSessions: layers.digitizer
      ? diskProject.project.digitizerSessions
      : diskProject.project.digitizerSessions.map((session) => ({ ...session, visible: false })),
  });
  if (!/^[a-f0-9]{64}$/.test(expectedProjectSha256)
    || raw.sourceProjectSha256 !== expectedProjectSha256
    || diskProject.archiveProjectSha256 !== expectedProjectSha256
    || project.id !== diskProject.project.id) {
    throw new Error('Screenshot worker project identity does not match the authorized project archive.');
  }
  for (const key of ['logicalWidth', 'logicalHeight'] as const) {
    if (!Number.isInteger(raw[key]) || (raw[key] as number) < 256 || (raw[key] as number) > 2_048) {
      throw new Error(`Screenshot worker ${key} is invalid.`);
    }
  }
  if (typeof raw.dpr !== 'number' || !Number.isFinite(raw.dpr) || raw.dpr < 1 || raw.dpr > 1.6) {
    throw new Error('Screenshot worker DPR is invalid.');
  }
  const width = Math.round((raw.logicalWidth as number) * raw.dpr);
  const height = Math.round((raw.logicalHeight as number) * raw.dpr);
  if (width > 3_072 || height > 3_072 || width * height > 4_194_304) {
    throw new Error('Screenshot worker physical resolution exceeds its limit.');
  }
  return {
    version: 1,
    project,
    projectPath,
    sourceProjectSha256: expectedProjectSha256,
    temporaryPath,
    resultPath,
    logicalWidth: raw.logicalWidth as number,
    logicalHeight: raw.logicalHeight as number,
    dpr: raw.dpr,
    camera: parseCamera(raw.camera),
    layers,
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value);
}

export async function completeMcpCaptureWorker(
  request: McpScreenshotWorkerRequest,
  completion: McpScreenshotWorkerCompletion,
  authorizedRoots: readonly string[],
): Promise<void> {
  const width = Math.round(request.logicalWidth * request.dpr);
  const height = Math.round(request.logicalHeight * request.dpr);
  if (completion.width !== width || completion.height !== height
    || canonical(completion.camera) !== canonical(request.camera)
    || canonical(completion.layers) !== canonical(request.layers)) {
    throw new Error('Screenshot worker completion metadata does not match its request.');
  }
  const png = decodeScientificScreenshotBase64(completion.pngBase64);
  // The shared writer's validation is repeated by the MCP parent after the
  // child exits; validate the minimum PNG invariants before publishing temp.
  if (png.byteLength < 33 || png[25] !== 6
    || new DataView(png.buffer, png.byteOffset, png.byteLength).getUint32(16) !== width
    || new DataView(png.buffer, png.byteOffset, png.byteLength).getUint32(20) !== height) {
    throw new Error('Screenshot worker completion PNG is not the requested RGBA image.');
  }
  const temporaryPath = await resolveAuthorizedPath(request.temporaryPath, authorizedRoots, {
    mustExist: false,
    label: 'MCP screenshot authorized roots',
  });
  const resultPath = await resolveAuthorizedPath(request.resultPath, authorizedRoots, {
    mustExist: false,
    label: 'MCP screenshot authorized roots',
  });
  await durableAtomicCreateExclusive(temporaryPath, png, {
    ensureParent: false,
    beforePublish: async () => { await resolveAuthorizedPath(temporaryPath, authorizedRoots, { mustExist: false, label: 'MCP screenshot authorized roots' }); },
    afterPublish: async () => { await resolveAuthorizedPath(temporaryPath, authorizedRoots, { mustExist: true, label: 'MCP screenshot authorized roots' }); },
  });
  await durableAtomicCreateExclusive(resultPath, Buffer.from(JSON.stringify({
    version: 1,
    ok: true,
    width,
    height,
    camera: request.camera,
    layers: request.layers,
  }), 'utf8'), {
    ensureParent: false,
    beforePublish: async () => { await resolveAuthorizedPath(resultPath, authorizedRoots, { mustExist: false, label: 'MCP screenshot authorized roots' }); },
    afterPublish: async () => { await resolveAuthorizedPath(resultPath, authorizedRoots, { mustExist: true, label: 'MCP screenshot authorized roots' }); },
  });
}
