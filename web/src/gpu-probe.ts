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
import { createVoxelMaterial, W } from './gpu/materials.js';
import { Atmosphere, MOODS, type MoodId } from './gpu/moods.js';
import { VoxelBuilder } from './voxel/kit.js';
import { buildModelObject } from './voxel/mesh.js';
import { DungeonScene } from './gpu/dungeon.js';
import type { CellKind, LevelView, MapCell } from '../../src/model/types.js';

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

const BENCH_MAP = [
  '###############',
  '#.............#',
  '#............>#',
  '#.............#',
  '#......<......D%%%%%+.........#',
  '#.............#     #...~~~~..#',
  '#.............#     #...~~~~..#',
  '###############     #....{....#',
  '                    #.........#',
  '                    #..III....#',
  '                    #..III.LL.#',
  '                    #......LL.#',
  '                    ###########',
];

const BENCH_KIND: Readonly<Record<string, CellKind>> = {
  '#': 'wall', '.': 'floor', '%': 'corridor', D: 'doorway', '+': 'door_closed',
  '<': 'stairs_up', '>': 'stairs_down', '{': 'fountain', '~': 'water',
  L: 'lava', I: 'ice', ' ': 'unexplored',
};

/** The same level `/scene.html` uses, as a `LevelView`, with rooms lit. */
function benchLevel(): LevelView {
  const height = BENCH_MAP.length;
  const width = Math.max(...BENCH_MAP.map((r) => r.length));
  const kindAt = (x: number, y: number): CellKind => {
    if (x < 0 || y < 0 || y >= height) return 'unexplored';
    return BENCH_KIND[BENCH_MAP[y]?.[x] ?? ' '] ?? 'unexplored';
  };
  return {
    width, height, kindAt,
    cellAt(x: number, y: number): MapCell | null {
      const kind = kindAt(x, y);
      if (kind === 'unexplored') return null;
      return { x, y, kind, terrain: null, top: null, lit: kind !== 'corridor' };
    },
  };
}

/** The real dungeon: `DungeonScene` over the bench level, lit by real torches. */
function makeDungeonScene(): { scene: THREE.Scene; camera: THREE.PerspectiveCamera } {
  const q = new URLSearchParams(window.location.search);
  const scene = new THREE.Scene();
  const material = createVoxelMaterial({ weather: true, sway: false });
  const dungeon = new DungeonScene({ material, seed: 7 });
  const level = benchLevel();
  dungeon.refresh(level);
  const [px, py, pdeg] = (q.get('pose') ?? '7.5,4.5,90').split(',').map(Number);
  const hx = px ?? 7.5;
  const hy = py ?? 4.5;
  dungeon.updateLights(hx, hy);
  if (q.get('ceiling') === '0') dungeon.ceiling.visible = false;
  scene.add(dungeon.root);
  const camera = new THREE.PerspectiveCamera(Number(q.get('fov') ?? '70'), 16 / 9, 0.05, 60);
  camera.position.set(hx, 0.5, hy);
  camera.rotation.set(-0.08, -(((pdeg ?? 90) * Math.PI) / 180), 0, 'YXZ');
  // the hero's lantern, same constants the legacy viewport uses
  const lantern = new THREE.PointLight(0xffe0a8, Number(q.get('lantern') ?? '12'), 14, 1);
  camera.add(lantern);
  scene.add(camera);
  return { scene, camera };
}

/**
 * A scrap of dungeon built with the real voxel kit and lit with the real
 * voxel node material — a stone floor, a chunk of wall and a small emissive
 * torch head. This is what `?stack=voxel` renders, and it is the cheapest way
 * to find out whether the ported TSL material actually compiles on a backend
 * before the dungeon builder depends on it.
 */
function makeVoxelScene(): { scene: THREE.Scene; camera: THREE.PerspectiveCamera; material: THREE.Material } {
  const scene = new THREE.Scene();
  const b = new VoxelBuilder({ unit: 0.125, seed: 7 });
  // floor slab (ground flag = puddles may form), 8x8 voxels = one cell
  b.box(0, 0, 0, 8, 1, 8, 'basalt1', 'wetrock', {});
  // a wall stub behind it
  b.box(0, 1, 0, 8, 7, 1, 'basalt2', 'rock', {});
  // a torch head: tiny emissive box with the flicker fx
  b.box(3, 5, 1, 2, 2, 1, 'fire', 'ember', {});
  const model = b.build('dungeon-scrap');
  const material = createVoxelMaterial({ weather: true, sway: false });
  const obj = buildModelObject(model, material);
  scene.add(obj);
  // `?light=<intensity>` puts a real point light at the torch head. An
  // emissive box only glows — it does not light the stone around it (SSGI
  // bounce aside), which is why the dungeon builder places real lights.
  const lit = new URLSearchParams(window.location.search).get('light');
  if (lit !== null) {
    const torch = new THREE.PointLight(0xffb060, Number(lit), 6, 2);
    torch.position.set(0.5, 0.72, 0.19);
    torch.castShadow = true;
    scene.add(torch);
  }
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 60);
  camera.position.set(0.5, 0.45, 1.6);
  camera.lookAt(0.5, 0.35, 0.5);
  return { scene, camera, material };
}

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
    const stack = new URLSearchParams(window.location.search).get('stack');
    const voxelMode = stack === 'voxel' || stack === 'dungeon';
    const built = stack === 'dungeon' ? makeDungeonScene() : stack === 'voxel' ? makeVoxelScene() : makeScene();
    const { scene, camera } = built;

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

    if (stack === 'ported' || voxelMode) {
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
      if (voxelMode) {
        // Drive the real Atmosphere so the mood's lights, fog and weather
        // uniforms are what light the voxels.
        const moodId = ((new URLSearchParams(window.location.search).get('mood') ?? 'torchlit') as MoodId);
        result.nodes.push(`mood:${moodId in MOODS ? moodId : 'torchlit'}`);
      }
      const handle = createPipeline({
        renderer, scene, camera, requested: tier, sun,
        override: off.length > 0 ? (override as Parameters<typeof createPipeline>[0]['override']) : null,
        look: lookOverride as Parameters<typeof createPipeline>[0]['look'],
      });
      if (voxelMode) {
        const moodId = ((new URLSearchParams(window.location.search).get('mood') ?? 'torchlit') as MoodId);
        const atmos = new Atmosphere({ scene, look: handle.look, weather: W });
        atmos.set(moodId in MOODS ? moodId : 'torchlit');
        atmos.update(0.016);
      }
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
