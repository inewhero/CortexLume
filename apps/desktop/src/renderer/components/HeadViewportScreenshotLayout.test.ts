import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('3D screenshot action layout', () => {
  it('anchors a compact control in the top-right corner opposite the array tabs', () => {
    const css = readFileSync(fileURLToPath(new URL('../styles.css', import.meta.url)), 'utf8');
    const start = css.indexOf('.scientific-screenshot-button {');
    const end = css.indexOf('}', start);
    const rule = css.slice(start, end);
    expect(rule).toContain('top: 15px');
    expect(rule).toContain('right: 16px');
    expect(rule).toContain('width: 31px');
    expect(rule).toContain('min-height: 29px');
  });

  it('keeps scientific labels out of the live WebGL texture/object path', () => {
    const source = readFileSync(fileURLToPath(new URL('./HeadViewport.tsx', import.meta.url)), 'utf8');
    expect(source).toContain('scientificScreenshotLabel');
    expect(source).not.toContain('new THREE.CanvasTexture');
    expect(source).not.toContain('<ScientificScreenshotLabelAnchor');
  });

  it('keeps the WebGL viewport out of development remount cycles', () => {
    const entry = readFileSync(fileURLToPath(new URL('../main.tsx', import.meta.url)), 'utf8');
    const viteConfig = readFileSync(fileURLToPath(new URL('../../../vite.renderer.config.ts', import.meta.url)), 'utf8');
    expect(entry).not.toContain("import { StrictMode }");
    expect(entry).not.toContain('<StrictMode>');
    expect(viteConfig).toContain("name: 'cortexlume-webgl-full-reload'");
    expect(viteConfig).toContain("type: 'full-reload'");
  });

  it('stacks screenshot feedback above the anatomical coverage legend', () => {
    const source = readFileSync(fileURLToPath(new URL('./HeadViewport.tsx', import.meta.url)), 'utf8');
    const css = readFileSync(fileURLToPath(new URL('../styles.css', import.meta.url)), 'utf8');
    expect(source).toContain('className="viewport-overlay bottom-left-stack"');
    expect(source.indexOf('className="toast"')).toBeLessThan(source.indexOf('className="coverage-map-legend"'));
    expect(source.indexOf('className="coverage-map-legend"')).toBeLessThan(source.indexOf('className="legend"'));
    expect(css).toContain('.bottom-left-stack');
    expect(css).toContain('flex-direction: column');
  });
});
