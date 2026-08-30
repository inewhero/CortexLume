import { zlibSync } from 'fflate';
import * as THREE from 'three';

export const SCIENTIFIC_SCREENSHOT_LIMITS = Object.freeze({
  maxDevicePixelRatio: 1.6,
  maxEdgePixels: 3072,
  maxPixelCount: 4_194_304,
});

export interface ScreenshotCameraState {
  position: [number, number, number];
  target: [number, number, number];
  up?: [number, number, number];
  fov?: number;
}

export interface ScientificScreenshotOptions {
  width?: number;
  height?: number;
  excludedObjects?: readonly THREE.Object3D[];
}

export interface ScientificScreenshotResult {
  png: Uint8Array;
  width: number;
  height: number;
}

interface ScientificScreenshotLabel {
  label: string;
  position: [number, number, number];
  accent: boolean;
  compact: boolean;
}

export type ScientificScreenshotBlockReason = 'save-project' | 'scene-loading' | 'coverage-loading' | null;

export function scientificScreenshotBlockReason(options: {
  projectPath: string | null;
  surfaceVerified: boolean;
  surfaceRevision: number;
  anatomicalCoverageEnabled: boolean;
  anatomicalCoverageReady: boolean;
}): ScientificScreenshotBlockReason {
  if (!options.projectPath) return 'save-project';
  if (!options.surfaceVerified || options.surfaceRevision < 1) return 'scene-loading';
  if (options.anatomicalCoverageEnabled && !options.anatomicalCoverageReady) return 'coverage-loading';
  return null;
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[index] = value >>> 0;
}

function writeUint32(target: Uint8Array, offset: number, value: number) {
  target[offset] = value >>> 24;
  target[offset + 1] = value >>> 16;
  target[offset + 2] = value >>> 8;
  target[offset + 3] = value;
}

function pngChunk(type: string, data: Uint8Array) {
  const typeBytes = new TextEncoder().encode(type);
  const result = new Uint8Array(12 + data.byteLength);
  writeUint32(result, 0, data.byteLength);
  result.set(typeBytes, 4);
  result.set(data, 8);
  let crc = 0xffffffff;
  for (let index = 4; index < result.byteLength - 4; index += 1) {
    crc = crcTable[(crc ^ result[index]!) & 0xff]! ^ (crc >>> 8);
  }
  writeUint32(result, result.byteLength - 4, (crc ^ 0xffffffff) >>> 0);
  return result;
}

function concatBytes(parts: readonly Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

/** Encode exact 8-bit RGBA pixels as a lossless, non-quantized PNG. */
export function encodeRgbaPng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error('PNG dimensions must be positive integers.');
  }
  if (rgba.byteLength !== width * height * 4) throw new Error('RGBA byte count does not match PNG dimensions.');
  const scanlines = new Uint8Array(height * (width * 4 + 1));
  for (let row = 0; row < height; row += 1) {
    const destination = row * (width * 4 + 1);
    scanlines[destination] = 0;
    scanlines.set(rgba.subarray(row * width * 4, (row + 1) * width * 4), destination + 1);
  }
  const header = new Uint8Array(13);
  writeUint32(header, 0, width);
  writeUint32(header, 4, height);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, deflate, no interlace.
  return concatBytes([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlibSync(scanlines, { level: 6 })),
    pngChunk('IEND', new Uint8Array()),
  ]);
}

export function screenshotPngToBase64(png: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < png.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...png.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function calculateScreenshotSize(cssWidth: number, cssHeight: number, devicePixelRatio: number) {
  if (![cssWidth, cssHeight, devicePixelRatio].every(Number.isFinite) || cssWidth <= 0 || cssHeight <= 0) {
    throw new Error('The 3D viewport has no capturable pixel area.');
  }
  const dpr = Math.min(Math.max(devicePixelRatio, 1), SCIENTIFIC_SCREENSHOT_LIMITS.maxDevicePixelRatio);
  let width = Math.max(1, Math.round(cssWidth * dpr));
  let height = Math.max(1, Math.round(cssHeight * dpr));
  const scale = Math.min(
    1,
    SCIENTIFIC_SCREENSHOT_LIMITS.maxEdgePixels / Math.max(width, height),
    Math.sqrt(SCIENTIFIC_SCREENSHOT_LIMITS.maxPixelCount / (width * height)),
  );
  width = Math.max(1, Math.floor(width * scale));
  height = Math.max(1, Math.floor(height * scale));
  return { width, height, dpr, limited: scale < 1 };
}

/** Apply a serializable camera pose used by deterministic GUI/MCP capture workers. */
export function applyScreenshotCamera(camera: THREE.PerspectiveCamera, state: ScreenshotCameraState): void {
  camera.position.fromArray(state.position);
  camera.up.fromArray(state.up ?? [0, 1, 0]);
  if (state.fov != null) camera.fov = Math.min(120, Math.max(1, state.fov));
  camera.lookAt(new THREE.Vector3().fromArray(state.target));
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
}

function screenshotLabel(value: unknown): ScientificScreenshotLabel | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.label !== 'string' || candidate.label.length === 0 || candidate.label.length > 64) return null;
  if (!Array.isArray(candidate.position) || candidate.position.length !== 3
    || candidate.position.some((coordinate) => typeof coordinate !== 'number' || !Number.isFinite(coordinate))) return null;
  return {
    label: candidate.label,
    position: candidate.position as [number, number, number],
    accent: candidate.accent === true,
    compact: candidate.compact === true,
  };
}

/**
 * Composite scientific labels in CPU memory after the WebGL readback. Using
 * CanvasTexture sprites here caused ANGLE to lose the primary WebGL context on
 * some Windows GPUs even before a capture was requested. A single capture-only
 * 2D canvas keeps labels out of the live renderer and cannot disturb its GPU
 * resource lifetime.
 */
function compositeScientificLabels(
  pixels: Uint8Array,
  width: number,
  height: number,
  scene: THREE.Scene,
  camera: THREE.Camera,
): void {
  if (typeof document === 'undefined') return;
  const labels: Array<{ definition: ScientificScreenshotLabel; point: THREE.Vector3 }> = [];
  camera.updateMatrixWorld(true);
  scene.traverse((object) => {
    const definition = screenshotLabel(object.userData.scientificScreenshotLabel);
    if (!definition) return;
    const projected = new THREE.Vector3().fromArray(definition.position).project(camera);
    if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y) || !Number.isFinite(projected.z)
      || projected.z < -1 || projected.z > 1) return;
    labels.push({ definition, point: projected });
  });
  if (labels.length === 0) return;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return;
  const image = context.createImageData(width, height);
  image.data.set(pixels);
  context.putImageData(image, 0, 0);
  const scale = Math.max(1, Math.min(2, width / 1500));
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.lineJoin = 'miter';
  for (const { definition, point } of labels) {
    const fontSize = Math.round((definition.compact ? 10 : 12) * scale);
    context.font = `800 ${fontSize}px Consolas, monospace`;
    const paddingX = Math.round(4 * scale);
    const boxHeight = Math.round((definition.compact ? 16 : 19) * scale);
    const boxWidth = Math.max(
      boxHeight,
      Math.ceil(context.measureText(definition.label).width) + paddingX * 2,
    );
    const centerX = Math.round((point.x * 0.5 + 0.5) * width);
    const centerY = Math.round((-point.y * 0.5 + 0.5) * height);
    const left = Math.max(0, Math.min(width - boxWidth, centerX - Math.floor(boxWidth / 2)));
    const top = Math.max(0, Math.min(height - boxHeight, centerY - Math.floor(boxHeight / 2)));
    context.fillStyle = definition.accent ? '#e6b84a' : '#21282b';
    context.fillRect(left, top, boxWidth, boxHeight);
    context.strokeStyle = definition.accent ? '#806311' : '#788588';
    context.lineWidth = Math.max(1, Math.round(scale));
    context.strokeRect(left + 0.5, top + 0.5, boxWidth - 1, boxHeight - 1);
    context.fillStyle = definition.accent ? '#171a1b' : '#f1f4f2';
    context.fillText(definition.label, left + boxWidth / 2, top + boxHeight / 2 + scale * 0.25);
  }
  pixels.set(context.getImageData(0, 0, width, height).data);
}

/**
 * Render only WebGL scene content to an offscreen RGBA target. DOM overlays
 * never enter this path. Background, fog, and explicitly excluded helpers are
 * restored immediately after capture.
 */
export function captureScientificScene(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: ScientificScreenshotOptions = {},
): ScientificScreenshotResult {
  const calculated = calculateScreenshotSize(
    renderer.domElement.clientWidth,
    renderer.domElement.clientHeight,
    renderer.getPixelRatio(),
  );
  const width = options.width ?? calculated.width;
  const height = options.height ?? calculated.height;
  if (width * height > SCIENTIFIC_SCREENSHOT_LIMITS.maxPixelCount
    || width > SCIENTIFIC_SCREENSHOT_LIMITS.maxEdgePixels
    || height > SCIENTIFIC_SCREENSHOT_LIMITS.maxEdgePixels) {
    throw new Error('Requested screenshot exceeds the RGBA capture limits.');
  }

  const target = new THREE.WebGLRenderTarget(width, height, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: true,
    stencilBuffer: false,
    samples: Math.min(4, renderer.capabilities.maxSamples),
  });
  target.texture.colorSpace = renderer.outputColorSpace;
  const previousTarget = renderer.getRenderTarget();
  const previousBackground = scene.background;
  const previousFog = scene.fog;
  const previousClearColor = renderer.getClearColor(new THREE.Color()).clone();
  const previousClearAlpha = renderer.getClearAlpha();
  const previousXr = renderer.xr.enabled;
  const exclusions = new Set<THREE.Object3D>(options.excludedObjects ?? []);
  const screenshotOnly = new Set<THREE.Object3D>();
  scene.traverse((object) => {
    if (object.userData.excludeFromScientificScreenshot === true) exclusions.add(object);
    if (object.userData.scientificScreenshotOnly === true) screenshotOnly.add(object);
  });
  const visibility = [...exclusions].map((object) => [object, object.visible] as const);
  const screenshotVisibility = [...screenshotOnly].map((object) => [object, object.visible] as const);
  const bottomUp = new Uint8Array(width * height * 4);
  const topDown = new Uint8Array(bottomUp.byteLength);

  try {
    visibility.forEach(([object]) => { object.visible = false; });
    screenshotVisibility.forEach(([object]) => { object.visible = true; });
    scene.background = null;
    scene.fog = null;
    renderer.xr.enabled = false;
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, bottomUp);
    const stride = width * 4;
    for (let row = 0; row < height; row += 1) {
      topDown.set(bottomUp.subarray(row * stride, (row + 1) * stride), (height - row - 1) * stride);
    }
    compositeScientificLabels(topDown, width, height, scene, camera);
    return { png: encodeRgbaPng(width, height, topDown), width, height };
  } finally {
    visibility.forEach(([object, visible]) => { object.visible = visible; });
    screenshotVisibility.forEach(([object, visible]) => { object.visible = visible; });
    scene.background = previousBackground;
    scene.fog = previousFog;
    renderer.xr.enabled = previousXr;
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousClearColor, previousClearAlpha);
    target.dispose();
  }
}
