/**
 * WebGPU capability probe (`/gpu-probe.html`) — PM tooling, not part of the
 * render path. Answers the one question the whole GPU wave rests on: does a
 * `WebGPURenderer` + a TSL post graph actually initialise and draw a frame in
 * this browser (and in headless chromium under `scripts/web-shot.mjs`), and
 * on which backend?
 *
 * Reports into `window.__probe` and paints the result as text, so a
 * screenshot is readable on its own.
 */
import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, packNormalToRGB, vec4, uniform, renderOutput, convertToTexture, screenUV, mix, float, smoothstep, vec2 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';

interface ProbeResult {
  step: string;
  ok: boolean;
  backend: string;
  mrtBytes: number;
  nodes: string[];
  error: string | null;
  frameMs: number;
  forced: string;
}

const result: ProbeResult = {
  step: 'start',
  ok: false,
  backend: 'none',
  mrtBytes: 0,
  nodes: [],
  error: null,
  frameMs: 0,
  forced: '',
};

/** Build a trivial lit scene so the pass has something to shade. */
function makeScene(): { scene: THREE.Scene; camera: THREE.PerspectiveCamera } {
  const scene = new THREE.Scene();
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0x8899aa, roughness: 0.6 });
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
  scene.add(box);
  const light = new THREE.PointLight(0xffd0a0, 12, 20, 1);
  light.position.set(2, 2, 2);
  scene.add(light);
  scene.add(new THREE.AmbientLight(0x223344, 1.0));
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
  camera.position.set(2, 1.5, 3);
  camera.lookAt(0, 0, 0);
  return { scene, camera };
}

async function probe(): Promise<void> {
  try {
    result.step = 'adapter';
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(o: unknown): Promise<{ limits: Record<string, number> } | null> } }).gpu;
    if (gpu !== undefined) {
      const ad = await gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (ad !== null) result.mrtBytes = ad.limits['maxColorAttachmentBytesPerSample'] ?? 32;
    }

    result.step = 'renderer';
    result.forced = new URLSearchParams(window.location.search).get('backend') ?? '';
    const canvas = document.getElementById('gpu') as HTMLCanvasElement;
    const params: Record<string, unknown> = { canvas, antialias: false, powerPreference: 'high-performance' };
    if (result.mrtBytes >= 64) params['requiredLimits'] = { maxColorAttachmentBytesPerSample: 64 };
    // `?backend=webgl2` forces three's WebGL2 fallback backend — the path
    // headless verification uses when this Chromium's WebGPU disagrees with
    // three r185 (see docs/gpu.md §3).
    if (new URLSearchParams(window.location.search).get('backend') === 'webgl2') params['forceWebGL'] = true;
    const renderer = new THREE.WebGPURenderer(params as ConstructorParameters<typeof THREE.WebGPURenderer>[0]);
    renderer.setPixelRatio(1);
    renderer.setSize(640, 360, false);
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.toneMappingExposure = 1.0;
    await renderer.init();
    const backend = renderer.backend as { isWebGPUBackend?: boolean };
    result.backend = backend.isWebGPUBackend === true ? 'webgpu' : 'webgl2';

    result.step = 'graph';
    const { scene, camera } = makeScene();
    const pipeline = new THREE.RenderPipeline(renderer);
    pipeline.outputColorTransform = false;
    const scenePass = pass(scene, camera);
    scenePass.setMRT(mrt({ output, normal: packNormalToRGB(normalView) }));
    result.nodes.push('pass+mrt');
    let node = scenePass.getTextureNode('output');
    const b = bloom(node, 1, 0.5, 1);
    node = node.add(b) as typeof node;
    result.nodes.push('bloom');
    const exposure = uniform(1.0);
    // `fxaa()` returns an FXAANode, which the .d.ts does not expose as a
    // swizzleable node — the cast is what a TS port of afterburn's JS needs.
    const graded = fxaa(convertToTexture(renderOutput(vec4(node.rgb.mul(exposure), 1.0)))) as unknown as { rgb: ReturnType<typeof vec4>['rgb'] };
    result.nodes.push('fxaa+agx');
    const d = screenUV.sub(0.5).mul(vec2(1.0, 0.85)).length();
    pipeline.outputNode = vec4(graded.rgb.mul(mix(float(1.0), smoothstep(0.85, 0.2, d), float(0.42))), 1.0);
    pipeline.needsUpdate = true;

    result.step = 'render';
    const t0 = performance.now();
    await pipeline.renderAsync();
    result.frameMs = Math.round((performance.now() - t0) * 10) / 10;
    result.step = 'done';
    result.ok = true;
  } catch (err) {
    result.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  const out = document.getElementById('out');
  if (out !== null) out.textContent = JSON.stringify(result, null, 2);
  window.__probe = result;
  window.__ready = true;
}

declare global {
  interface Window {
    __probe?: unknown;
    __ready?: boolean;
  }
}

void probe();
