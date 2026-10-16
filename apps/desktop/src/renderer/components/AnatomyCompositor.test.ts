import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { renderAnatomyLayers } from './AnatomyCompositor';

function fixture(fail = false) {
  const exportTarget = new THREE.WebGLRenderTarget(1240, 1220);
  let activeTarget: THREE.WebGLRenderTarget | null = exportTarget;
  const layers = Array.from({ length: 3 }, () => ({
    scene: new THREE.Scene(), target: new THREE.WebGLRenderTarget(1, 1),
  }));
  const renderer = {
    autoClear: true, xr: { enabled: true },
    getRenderTarget: () => activeTarget,
    setRenderTarget: vi.fn((target: THREE.WebGLRenderTarget | null) => { activeTarget = target; }),
    getScissorTest: () => true, setScissorTest: vi.fn(),
    getClearColor: (color: THREE.Color) => color.set('#123456'),
    getClearAlpha: () => 0.7, setClearColor: vi.fn(),
    getDrawingBufferSize: (size: THREE.Vector2) => size.set(800, 600),
    clear: vi.fn(),
    render: vi.fn(() => { if (fail) throw new Error('GPU render failed'); }),
    // Setting a CSS viewport here corrupts high-DPI/offscreen captures.
    setViewport: vi.fn(), setScissor: vi.fn(),
  };
  return { renderer, layers, exportTarget };
}

describe('independent anatomy layer rendering', () => {
  it('uses separate full-size buffers and restores the screenshot target without a CSS viewport override', () => {
    const { renderer, layers, exportTarget } = fixture();
    const camera = new THREE.PerspectiveCamera();
    renderAnatomyLayers(layers, renderer as unknown as THREE.WebGLRenderer, camera);
    for (const layer of layers) {
      expect([layer.target.width, layer.target.height]).toEqual([1240, 1220]);
      expect(renderer.render).toHaveBeenCalledWith(layer.scene, camera);
    }
    expect(renderer.clear).toHaveBeenCalledTimes(3);
    expect(renderer.getRenderTarget()).toBe(exportTarget);
    expect(renderer.setViewport).not.toHaveBeenCalled();
    expect(renderer.setScissor).not.toHaveBeenCalled();
    expect(renderer.autoClear).toBe(true);
    expect(renderer.xr.enabled).toBe(true);
  });

  it('restores renderer state even when a layer fails', () => {
    const { renderer, layers, exportTarget } = fixture(true);
    expect(() => renderAnatomyLayers(layers, renderer as unknown as THREE.WebGLRenderer,
      new THREE.PerspectiveCamera())).toThrow('GPU render failed');
    expect(renderer.getRenderTarget()).toBe(exportTarget);
    expect(renderer.setScissorTest).toHaveBeenLastCalledWith(true);
    expect(renderer.setClearColor).toHaveBeenLastCalledWith(new THREE.Color('#123456'), 0.7);
    expect(renderer.autoClear).toBe(true);
    expect(renderer.xr.enabled).toBe(true);
  });
});
