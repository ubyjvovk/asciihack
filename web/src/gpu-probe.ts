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
import { pass, mrt, output, normalView, packNormalToRGB, unpackRGBToNormal, sample, metalness, roughness, vec4, uniform, renderOutput, convertToTexture, screenUV, mix, float, smoothstep, vec2 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { clampQuality, createPipeline, type QualityName } from './gpu/pipeline.js';

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

    // `?stack=ported` builds OUR ported pipeline (web/src/gpu/pipeline.ts) at
    // `?q=<tier>` instead of the hand-rolled minimal graph — this is the only
    // way anyone on this project finds out whether the SSGI/SSR/god-ray graph
    // actually compiles, since no worker has a GPU.
    const q = new URLSearchParams(window.location.search);

    // `?stack=ssr&stochastic=0|1` isolates three r185's SSRNode: the
    // non-stochastic path emits `max(int(...), 1.0)` which GLSL ES 3.0
    // rejects, so it cannot link on the WebGL2 backend. This tells us whether
    // the stochastic path is a usable substitute there.
    if (q.get('stack') === 'ssr') {
      const stochastic = q.get('stochastic') === '1';
      result.nodes.push(`ssr:stochastic=${String(stochastic)}`);
      const pipeline = new THREE.RenderPipeline(renderer);
      const sp = pass(scene, camera);
      sp.setMRT(mrt({ output, normal: packNormalToRGB(normalView), metalrough: vec2(metalness, roughness) }));
      const pColor = sp.getTextureNode('output');
      const pDepth = sp.getTextureNode('depth');
      const pNormal = sample((uv) => unpackRGBToNormal(sp.getTextureNode('normal').sample(uv)));
      const mr = sp.getTextureNode('metalrough');
      const r = ssr(pColor, pDepth, pNormal, { metalnessNode: mr.r, roughnessNode: mr.g, reflectNonMetals: true, stochastic, camera });
      pipeline.outputNode = vec4(pColor.rgb.add(r.rgb), 1.0);
      pipeline.needsUpdate = true;
      result.step = 'render';
      const ts = performance.now();
      pipeline.render();
      result.frameMs = Math.round((performance.now() - ts) * 10) / 10;
      result.step = 'done';
      result.ok = true;
      finish();
      return;
    }

    if (q.get('stack') === 'ported') {
      const caps = { webgpu: result.backend === 'webgpu', mrtBytes: result.mrtBytes, maxQuality: 'ultra' as QualityName };
      const requested = (q.get('q') ?? 'high') as QualityName;
      const tier = q.get('noclamp') === '1' ? requested : clampQuality(requested, caps);
      result.nodes.push(`ported:${tier}`);
      // `?off=gi,ssr,rays,traa,dof,bloom` disables passes one at a time, to
      // find which one blacks the frame on a given backend.
      const off = (q.get('off') ?? '').split(',').filter((k) => k.length > 0);
      const override: Record<string, unknown> = {};
      for (const k of off) {
        if (k === 'gi') override['gi'] = 'none';
        else if (k === 'traa') override['aa'] = 'fxaa';
        else override[k] = false;
      }
      if (off.length > 0) result.nodes.push(`off:${off.join('+')}`);
      // GodraysNode reads the light's shadow map, so a god-ray tier needs a
      // shadow-casting light — without castShadow it throws on a null
      // `shadow.map`. `?noshadow=1` reproduces that.
      const sun = new THREE.DirectionalLight(0xffd0a0, 2);
      sun.position.set(3, 5, 2);
      if (q.get('noshadow') !== '1') {
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        sun.castShadow = true;
        sun.shadow.mapSize.set(1024, 1024);
        scene.traverse((o) => { if ((o as THREE.Mesh).isMesh === true) { o.castShadow = true; o.receiveShadow = true; } });
      }
      scene.add(sun);
      // `?focus=N` retunes DOF for this tiny scene (afterburn's default focus
      // is 30 m, which is nowhere near a 4 m test box).
      const lookOverride: Record<string, number> = {};
      const focus = q.get('focus');
      if (focus !== null) { lookOverride['focus'] = Number(focus); lookOverride['focusRange'] = Number(q.get('focusRange') ?? '6'); }
      const handle = createPipeline({
        renderer, scene, camera, requested: tier, sun,
        override: off.length > 0 ? (override as Parameters<typeof createPipeline>[0]['override']) : null,
        look: lookOverride as Parameters<typeof createPipeline>[0]['look'],
      });
      result.step = 'render';
      // TRAA accumulates history, so a single frame comes back black on every
      // tier that enables it. `?frames=N` (default 8) renders a short burst,
      // which is what a real render loop does anyway.
      const frames = Math.max(1, Number(q.get('frames') ?? '8'));
      const tp = performance.now();
      if (q.get('raf') !== '0') {
        // Render across real animation frames — the default, and the only way
        // TRAA and DOF produce anything on the WebGL2 backend. `?raf=0` uses a
        // synchronous loop and reproduces the all-black frame.
        await new Promise<void>((resolve) => {
          let n = 0;
          const tick = (): void => {
            handle.render();
            n += 1;
            if (n >= frames) { resolve(); return; }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      } else {
        for (let i = 0; i < frames; i++) handle.render();
      }
      result.frameMs = Math.round(((performance.now() - tp) / frames) * 10) / 10;
      result.nodes.push(...Object.keys(handle.state.nodes));
      result.step = 'done';
      result.ok = true;
      finish();
      return;
    }

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
  finish();
}

/** Publish the result to the page and to the automation handles. */
function finish(): void {
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
