import { createPortal } from '@react-three/fiber';
import { useEffect, useMemo, type ReactNode } from 'react';
import * as THREE from 'three';

const vertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fragmentShader = `
  uniform sampler2D whiteColor;
  uniform sampler2D grayColor;
  uniform sampler2D scalpColor;
  uniform sampler2D whiteDepth;
  uniform sampler2D grayDepth;
  uniform sampler2D scalpDepth;
  varying vec2 vUv;

  // Rendering onto transparent black produces premultiplied layer textures.
  vec4 over(vec4 under, vec4 layer) {
    return vec4(layer.rgb + under.rgb * (1.0 - layer.a),
                layer.a + under.a * (1.0 - layer.a));
  }
  void main() {
    vec4 wm = texture2D(whiteColor, vUv);
    vec4 gm = texture2D(grayColor, vUv);
    vec4 scalp = texture2D(scalpColor, vUv);
    vec4 result = over(over(over(vec4(0.0), wm), gm), scalp);
    if (result.a <= 0.0) discard;
    gl_FragColor = vec4(result.rgb / result.a, result.a);
    // Keep scene objects (optodes, channels and landmarks) depth-tested against
    // the anatomy, while anatomical layers have independent depth buffers.
    float depth = 1.0;
    if (wm.a > 0.0) depth = min(depth, texture2D(whiteDepth, vUv).r);
    if (gm.a > 0.0) depth = min(depth, texture2D(grayDepth, vUv).r);
    if (scalp.a > 0.0) depth = min(depth, texture2D(scalpDepth, vUv).r);
    gl_FragDepth = depth;
  }
`;

function makeLayer() {
  const target = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
    samples: 4,
  });
  target.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
  return { scene: new THREE.Scene(), target };
}

export function renderAnatomyLayers(
  layers: Array<{ scene: THREE.Scene; target: THREE.WebGLRenderTarget }>,
  renderer: THREE.WebGLRenderer, camera: THREE.Camera,
) {
  // onBeforeRender also runs for high-resolution scientific screenshots;
  // use their actual render target and camera instead of a stale frame texture.
  const previousTarget = renderer.getRenderTarget();
  const previousScissorTest = renderer.getScissorTest();
  const previousClearColor = renderer.getClearColor(new THREE.Color());
  const previousClearAlpha = renderer.getClearAlpha();
  const previousAutoClear = renderer.autoClear;
  const previousXr = renderer.xr.enabled;
  const size = previousTarget
    ? new THREE.Vector2(previousTarget.width, previousTarget.height)
    : renderer.getDrawingBufferSize(new THREE.Vector2());
  try {
    renderer.xr.enabled = false;
    renderer.autoClear = false;
    renderer.setClearColor(0, 0);
    for (const { scene, target } of layers) {
      if (target.width !== size.x || target.height !== size.y) target.setSize(size.x, size.y);
      renderer.setRenderTarget(target);
      renderer.setScissorTest(false);
      renderer.clear(true, true, true);
      renderer.render(scene, camera);
    }
  } finally {
    renderer.setScissorTest(previousScissorTest);
    // setRenderTarget restores the target's physical viewport/scissor. The
    // renderer's default viewport is CSS-sized and must not overwrite it.
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousClearColor, previousClearAlpha);
    renderer.autoClear = previousAutoClear;
    renderer.xr.enabled = previousXr;
  }
}

/** Composite complete anatomy surfaces in anatomical order without cutting WM. */
export function AnatomyCompositor({ white, gray, scalp }: {
  white: ReactNode; gray: ReactNode; scalp: ReactNode;
}) {
  const layers = useMemo(() => [makeLayer(), makeLayer(), makeLayer()], []);
  const uniforms = useMemo(() => ({
    whiteColor: { value: layers[0]!.target.texture },
    grayColor: { value: layers[1]!.target.texture },
    scalpColor: { value: layers[2]!.target.texture },
    whiteDepth: { value: layers[0]!.target.depthTexture },
    grayDepth: { value: layers[1]!.target.depthTexture },
    scalpDepth: { value: layers[2]!.target.depthTexture },
  }), [layers]);
  useEffect(() => () => layers.forEach(({ target }) => target.dispose()), [layers]);

  return <>
    {createPortal(white, layers[0]!.scene)}
    {createPortal(gray, layers[1]!.scene)}
    {createPortal(scalp, layers[2]!.scene)}
    <mesh frustumCulled={false} renderOrder={-100} onBeforeRender={(renderer, _scene, camera) => renderAnatomyLayers(layers, renderer, camera)} raycast={() => {}}>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial uniforms={uniforms} vertexShader={vertexShader} fragmentShader={fragmentShader}
        transparent depthWrite depthTest toneMapped={false} />
    </mesh>
  </>;
}
