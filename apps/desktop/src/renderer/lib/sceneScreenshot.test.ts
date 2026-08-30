import { unzlibSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  applyScreenshotCamera,
  calculateScreenshotSize,
  captureScientificScene,
  encodeRgbaPng,
  SCIENTIFIC_SCREENSHOT_LIMITS,
  scientificScreenshotBlockReason,
} from './sceneScreenshot';

function pngScanlines(png: Uint8Array) {
  let offset = 8;
  const idat: Uint8Array[] = [];
  while (offset < png.byteLength) {
    const view = new DataView(png.buffer, png.byteOffset + offset, 4);
    const length = view.getUint32(0);
    const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
    if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const compressed = new Uint8Array(idat.reduce((sum, chunk) => sum + chunk.length, 0));
  let cursor = 0;
  idat.forEach((chunk) => { compressed.set(chunk, cursor); cursor += chunk.length; });
  return unzlibSync(compressed);
}

describe('scientific scene screenshot core', () => {
  it('requires a saved project and fully ready requested scientific layers', () => {
    expect(scientificScreenshotBlockReason({
      projectPath: null, surfaceVerified: true, surfaceRevision: 1,
      anatomicalCoverageEnabled: false, anatomicalCoverageReady: false,
    })).toBe('save-project');
    expect(scientificScreenshotBlockReason({
      projectPath: 'study.cortexlume', surfaceVerified: false, surfaceRevision: 0,
      anatomicalCoverageEnabled: false, anatomicalCoverageReady: false,
    })).toBe('scene-loading');
    expect(scientificScreenshotBlockReason({
      projectPath: 'study.cortexlume', surfaceVerified: true, surfaceRevision: 1,
      anatomicalCoverageEnabled: true, anatomicalCoverageReady: false,
    })).toBe('coverage-loading');
  });

  it('caps DPR, edge length, and total RGBA pixels without changing aspect ratio', () => {
    const size = calculateScreenshotSize(5000, 3000, 4);
    expect(size.dpr).toBe(SCIENTIFIC_SCREENSHOT_LIMITS.maxDevicePixelRatio);
    expect(size.width).toBeLessThanOrEqual(SCIENTIFIC_SCREENSHOT_LIMITS.maxEdgePixels);
    expect(size.width * size.height).toBeLessThanOrEqual(SCIENTIFIC_SCREENSHOT_LIMITS.maxPixelCount);
    expect(size.width / size.height).toBeCloseTo(5 / 3, 2);
  });

  it('encodes exact non-quantized RGBA scanlines as PNG color type 6', () => {
    const rgba = new Uint8Array([255, 2, 3, 4, 5, 240, 7, 8]);
    const png = encodeRgbaPng(2, 1, rgba);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(6);
    expect([...pngScanlines(png)]).toEqual([0, ...rgba]);
  });

  it('applies a serializable deterministic camera pose', () => {
    const camera = new THREE.PerspectiveCamera(39, 1, 0.1, 1000);
    applyScreenshotCamera(camera, {
      position: [20, 30, 40], target: [1, 2, 3], up: [0, 0, 1], fov: 51,
    });
    expect(camera.position.toArray()).toEqual([20, 30, 40]);
    expect(camera.up.toArray()).toEqual([0, 0, 1]);
    expect(camera.fov).toBe(51);
  });

  it('enables capture-only scientific labels, excludes grid/background, and restores on failure', () => {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#123456');
    scene.fog = new THREE.Fog('#123456', 1, 10);
    const grid = new THREE.Object3D();
    grid.userData.excludeFromScientificScreenshot = true;
    const label = new THREE.Object3D();
    label.visible = false;
    label.userData.scientificScreenshotOnly = true;
    scene.add(grid, label);
    const render = vi.fn(() => {
      expect(grid.visible).toBe(false);
      expect(label.visible).toBe(true);
      expect(scene.background).toBeNull();
      expect(scene.fog).toBeNull();
      throw new Error('render failed');
    });
    const renderer = {
      domElement: { clientWidth: 20, clientHeight: 10 },
      capabilities: { maxSamples: 4 },
      outputColorSpace: THREE.SRGBColorSpace,
      xr: { enabled: true },
      getPixelRatio: () => 1,
      getRenderTarget: () => null,
      getClearColor: (color: THREE.Color) => color.set('#abcdef'),
      getClearAlpha: () => 1,
      setRenderTarget: vi.fn(),
      setClearColor: vi.fn(),
      clear: vi.fn(),
      render,
      readRenderTargetPixels: vi.fn(),
    } as unknown as THREE.WebGLRenderer;
    expect(() => captureScientificScene(renderer, scene, new THREE.PerspectiveCamera())).toThrow('render failed');
    expect(grid.visible).toBe(true);
    expect(label.visible).toBe(false);
    expect(scene.background).toBeInstanceOf(THREE.Color);
    expect(scene.fog).toBeInstanceOf(THREE.Fog);
    expect(renderer.xr.enabled).toBe(true);
  });
});
