/**
 * GPU post-processing pipeline (browser-only) — a strict-TypeScript port of
 * `vendor/afterburn/src/render/pipeline.js` (afterburn commit 8492a00).
 *
 * The graph is `MRT (output + optionally diffuseColor / packed normal /
 * metalrough / velocity) → SSGI or GTAO → SSR → god rays (bilateral blur +
 * depthAwareBlend) → weather overlay → firefly clamp → TRAA → DOF → bloom
 * → renderOutput (AgX + sRGB) → FXAA (if selected) → split-tone →
 * contrast → saturation → vignette → grain → fade`. The nodes and their
 * order **are** the look; see `docs/gpu.md` §1–3, §8 and
 * `docs/gpu-pipeline.md` for the rationale.
 *
 * The impure builder (`createPipeline`) needs a live renderer/scene/camera;
 * the pure companions (`clampQuality`, `qualityPlan`, `createLook`,
 * `QUALITY`) exist so `tests/gpu-pipeline.test.ts` can pin the behaviour
 * that matters without touching a GPU.
 */
import * as THREE from 'three/webgpu';
import type {
  Node as WGNode,
  UniformNode,
  Renderer,
  Scene,
  PerspectiveCamera,
  DirectionalLight,
  PointLight,
} from 'three/webgpu';
import { Color } from 'three';
import {
  pass,
  mrt,
  output,
  normalView,
  diffuseColor,
  velocity,
  metalness,
  roughness,
  vec2,
  vec3,
  vec4,
  float,
  int,
  uniform,
  add,
  mix,
  smoothstep,
  clamp,
  min,
  packNormalToRGB,
  unpackRGBToNormal,
  sample,
  convertToTexture,
  screenUV,
  screenCoordinate,
  time,
  renderOutput,
  interleavedGradientNoise,
  luminance,
} from 'three/tsl';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { ao as gtao } from 'three/addons/tsl/display/GTAONode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { godrays } from 'three/addons/tsl/display/GodraysNode.js';
import { bilateralBlur } from 'three/addons/tsl/display/BilateralBlurNode.js';
import { depthAwareBlend } from 'three/addons/tsl/display/depthAwareBlend.js';

/** One of the four fixed quality tiers from `docs/gpu.md` §3. */
export type QualityName = 'low' | 'medium' | 'high' | 'ultra';

/** Backend capabilities probed by `createRenderer()`. */
export interface RendererCaps {
  webgpu: boolean;
  mrtBytes: number;
  maxQuality: QualityName;
}

/**
 * Per-tier switches, matching afterburn's inline table entries key-for-key.
 * Optional fields are present only on the tiers that use them (matches
 * `{ ...QUALITY[qName], ...override }` semantics — undefined stays undefined).
 */
export interface QualitySettings {
  gi: 'none' | 'ao' | 'ssgi';
  slices?: number;
  steps?: number;
  ssr: boolean;
  ssrQ?: number;
  ssrScale?: number;
  rays: boolean;
  raySteps?: number;
  aa: 'fxaa' | 'traa';
  dof: boolean;
  bloom: boolean;
  shadow: number;
  scale: number;
  /** SSGI-only: run the SSGI target at `giScale` of the beauty size (1 = full). */
  giScale?: number;
}

const RANK: Record<QualityName, number> = { low: 0, medium: 1, high: 2, ultra: 3 };

/**
 * The four tiers, ported one-for-one from
 * `vendor/afterburn/src/render/pipeline.js` `QUALITY`. Do not renumber:
 * the SSGI slice/step counts, SSR quality/scale, ray step counts and
 * shadow-map sizes are load-bearing for the look budget.
 */
export const QUALITY: Readonly<Record<QualityName, QualitySettings>> = {
  low: {
    gi: 'none',
    ssr: false,
    rays: false,
    aa: 'fxaa',
    dof: false,
    bloom: true,
    shadow: 2048,
    scale: 1,
  },
  medium: {
    gi: 'ao',
    ssr: true,
    ssrQ: 0.35,
    ssrScale: 0.5,
    rays: false,
    aa: 'traa',
    dof: true,
    bloom: true,
    shadow: 2048,
    scale: 1,
  },
  high: {
    gi: 'ssgi',
    slices: 1,
    steps: 12,
    ssr: true,
    ssrQ: 0.5,
    ssrScale: 0.5,
    rays: true,
    raySteps: 40,
    aa: 'traa',
    dof: true,
    bloom: true,
    shadow: 4096,
    scale: 1,
  },
  ultra: {
    gi: 'ssgi',
    slices: 2,
    steps: 10,
    ssr: true,
    ssrQ: 0.75,
    ssrScale: 1,
    rays: true,
    raySteps: 72,
    aa: 'traa',
    dof: true,
    bloom: true,
    shadow: 4096,
    scale: 1,
  },
};

/**
 * Cap the requested tier by what the backend can run: a non-WebGPU
 * backend, or a WebGPU adapter whose MRT budget is under 64 bytes/sample,
 * cannot run the full stack and is clamped at `'medium'` (docs/gpu.md §3).
 * `caps.maxQuality` may cap tighter; the tighter of the two wins.
 */
export function clampQuality(requested: QualityName, caps: RendererCaps): QualityName {
  const backendCap: QualityName = caps.webgpu && caps.mrtBytes >= 64 ? 'ultra' : 'medium';
  const configuredCap: QualityName = caps.maxQuality;
  const cap = RANK[configuredCap] < RANK[backendCap] ? configuredCap : backendCap;
  return RANK[requested] > RANK[cap] ? cap : requested;
}

/**
 * Resolve a named tier plus an optional dev override into the flags
 * `createPipeline` then consumes — afterburn's `{ ...tier, ...override }`.
 */
export function qualityPlan(name: QualityName, override?: Partial<QualitySettings>): QualitySettings {
  const base = QUALITY[name];
  return override ? { ...base, ...override } : { ...base };
}

/**
 * Tunable look values (moods animate these at runtime). Plain numbers so
 * `createLook` stays testable in Node; `createPipeline` wraps each field
 * in a `uniform(...)` node internally. Tints are `0xRRGGBB` hex, matching
 * afterburn's `uniform(color(0x...))` shorthand.
 */
export interface Look {
  giIntensity: number;
  aoIntensity: number;
  giRadius: number;
  ssrIntensity: number;
  rayDensity: number;
  rayMax: number;
  rayColor: number;
  focus: number;
  focusRange: number;
  bokeh: number;
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
  exposure: number;
  contrast: number;
  saturation: number;
  shadowTint: number;
  highlightTint: number;
  tintAmount: number;
  vignette: number;
  grain: number;
  maxRadiance: number;
  fade: number;
}

const LOOK_DEFAULTS: Look = {
  giIntensity: 9.0,
  aoIntensity: 1.35,
  giRadius: 7.0,
  ssrIntensity: 0.85,
  rayDensity: 0.0035,
  rayMax: 0.3,
  rayColor: 0xffd9ac,
  focus: 30.0,
  focusRange: 38.0,
  bokeh: 1.0,
  bloomStrength: 0.22,
  bloomRadius: 0.55,
  bloomThreshold: 1.0,
  exposure: 1.0,
  contrast: 1.06,
  saturation: 1.02,
  shadowTint: 0x0e2a33,
  highlightTint: 0xfff1dc,
  tintAmount: 0.16,
  vignette: 0.42,
  grain: 0.028,
  maxRadiance: 8.0,
  fade: 1.0,
};

/** Fresh Look at afterburn's defaults, with optional per-field overrides. */
export function createLook(overrides?: Partial<Look>): Look {
  if (!overrides) return { ...LOOK_DEFAULTS };
  return { ...LOOK_DEFAULTS, ...overrides };
}

/**
 * The uniform-wrapped look nodes moods.ts animates at runtime. Same field
 * set as `Look`, but each value is a live `UniformNode` (mutate via
 * `.value = ...`).
 */
export interface LookUniforms {
  giIntensity: UniformNode<'float', number>;
  aoIntensity: UniformNode<'float', number>;
  giRadius: UniformNode<'float', number>;
  ssrIntensity: UniformNode<'float', number>;
  rayDensity: UniformNode<'float', number>;
  rayMax: UniformNode<'float', number>;
  rayColor: UniformNode<'color', Color>;
  focus: UniformNode<'float', number>;
  focusRange: UniformNode<'float', number>;
  bokeh: UniformNode<'float', number>;
  bloomStrength: UniformNode<'float', number>;
  bloomRadius: UniformNode<'float', number>;
  bloomThreshold: UniformNode<'float', number>;
  exposure: UniformNode<'float', number>;
  contrast: UniformNode<'float', number>;
  saturation: UniformNode<'float', number>;
  shadowTint: UniformNode<'color', Color>;
  highlightTint: UniformNode<'color', Color>;
  tintAmount: UniformNode<'float', number>;
  vignette: UniformNode<'float', number>;
  grain: UniformNode<'float', number>;
  maxRadiance: UniformNode<'float', number>;
  fade: UniformNode<'float', number>;
}

function wrapLook(l: Look): LookUniforms {
  return {
    giIntensity: uniform(l.giIntensity),
    aoIntensity: uniform(l.aoIntensity),
    giRadius: uniform(l.giRadius),
    ssrIntensity: uniform(l.ssrIntensity),
    rayDensity: uniform(l.rayDensity),
    rayMax: uniform(l.rayMax),
    rayColor: uniform(new Color(l.rayColor)),
    focus: uniform(l.focus),
    focusRange: uniform(l.focusRange),
    bokeh: uniform(l.bokeh),
    bloomStrength: uniform(l.bloomStrength),
    bloomRadius: uniform(l.bloomRadius),
    bloomThreshold: uniform(l.bloomThreshold),
    exposure: uniform(l.exposure),
    contrast: uniform(l.contrast),
    saturation: uniform(l.saturation),
    shadowTint: uniform(new Color(l.shadowTint)),
    highlightTint: uniform(new Color(l.highlightTint)),
    tintAmount: uniform(l.tintAmount),
    vignette: uniform(l.vignette),
    grain: uniform(l.grain),
    maxRadiance: uniform(l.maxRadiance),
    fade: uniform(l.fade),
  };
}

/**
 * Options for `createPipeline`; `sun` is only needed on tiers that turn god
 * rays on. Callers are expected to have already called `clampQuality` with
 * the probed `RendererCaps`, so `requested` is applied directly.
 */
export interface PipelineOptions {
  renderer: Renderer;
  scene: Scene;
  camera: PerspectiveCamera;
  requested?: QualityName;
  override?: Partial<QualitySettings> | null;
  sun?: DirectionalLight | PointLight | null;
  look?: Partial<Look>;
  /** Scene of additive unlit effects (rain, motes) composited after the lighting stack. */
  overlay?: Scene | null;
}

/** Handle returned by `createPipeline` — owns the graph and the tier state. */
export interface PipelineHandle {
  pipeline: THREE.RenderPipeline;
  look: LookUniforms;
  state: PipelineState;
  setQuality: (q: QualityName) => void;
  render: () => void;
}

/** Live tier state and the per-build node references (for moods / debugging). */
export interface PipelineState {
  quality: QualityName;
  nodes: Record<string, WGNode>;
}

/**
 * Build the post-processing graph and return a handle. Impure — needs a
 * live `Renderer` (WebGPURenderer or its WebGL2 fallback) plus scene and
 * camera. The pass order **is** the look; see the file JSDoc and
 * `docs/gpu-pipeline.md` before touching it.
 */
export function createPipeline(opts: PipelineOptions): PipelineHandle {
  const { renderer, scene, camera } = opts;
  const sun = opts.sun ?? null;
  const overlay = opts.overlay ?? null;
  const override = opts.override ?? null;
  const look = wrapLook(createLook(opts.look));

  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = false; // we tone-map ourselves, then grade in display space

  // afterburn's default is `'high'`; the caller is expected to clamp with `clampQuality` first.
  const state: PipelineState = {
    quality: opts.requested ?? 'high',
    nodes: {},
  };

  const build = (qName: QualityName): void => {
    const q: QualitySettings = qualityPlan(qName, override ?? undefined);
    state.quality = qName;
    state.nodes = {};

    const scenePass = pass(scene, camera);
    const needNormal = q.gi !== 'none' || q.ssr;
    const targets: Record<string, WGNode> = { output };
    if (q.gi === 'ssgi') targets['diffuseColor'] = diffuseColor;
    if (needNormal) targets['normal'] = packNormalToRGB(normalView);
    if (q.ssr) targets['metalrough'] = vec2(metalness, roughness);
    if (q.aa === 'traa') targets['velocity'] = velocity;
    scenePass.setMRT(mrt(targets));
    for (const k of ['diffuseColor', 'normal', 'metalrough'] as const) {
      if (targets[k] !== undefined) scenePass.getTexture(k).type = THREE.UnsignedByteType;
    }

    const pColor: WGNode<'vec4'> = scenePass.getTextureNode('output');
    const pDepth = scenePass.getTextureNode('depth');
    // Unpack RG-encoded normals from the MRT slot back into a view-space direction.
    const pNormal: WGNode<'vec3'> | null = needNormal
      ? sample<'vec3'>((uv) =>
          unpackRGBToNormal(scenePass.getTextureNode('normal').sample(uv)),
        )
      : null;

    let node: WGNode<'vec4'> = pColor;

    if (q.gi === 'ssgi' && pNormal !== null) {
      const gi = ssgi(pColor, pDepth, pNormal, camera);
      gi.sliceCount.value = q.slices ?? 1;
      gi.stepCount.value = q.steps ?? 12;
      gi.radius = look.giRadius;
      gi.giIntensity = look.giIntensity;
      gi.aoIntensity = look.aoIntensity;
      gi.thickness.value = 0.6;
      // SSGI has no resolution knob of its own and is the most expensive pass: run it on a smaller
      // target when `q.giScale < 1`. GI/AO are low-frequency; bilinear upsample + TRAA hides it.
      // (`setSize` isn't declared on SSGINode but exists at runtime — see the vendored source.)
      const giScale = q.giScale ?? 1;
      if (giScale !== 1) {
        const sized = gi as unknown as { setSize(w: number, h: number): void };
        const baseSetSize = sized.setSize.bind(sized);
        sized.setSize = (w: number, h: number): void =>
          baseSetSize(Math.max(1, Math.round(w * giScale)), Math.max(1, Math.round(h * giScale)));
      }
      const pDiffuse = scenePass.getTextureNode('diffuseColor');
      node = vec4(
        add(pColor.rgb.mul(gi.getAONode().r), pDiffuse.rgb.mul(gi.getGINode().rgb)),
        pColor.a,
      );
      state.nodes['gi'] = gi;
    } else if (q.gi === 'ao' && pNormal !== null) {
      const aoPass = gtao(pDepth, pNormal, camera);
      aoPass.resolutionScale = 0.5;
      node = vec4(pColor.rgb.mul(aoPass.getTextureNode().r), pColor.a);
      state.nodes['ao'] = aoPass;
    }

    if (q.ssr && pNormal !== null) {
      const mr = scenePass.getTextureNode('metalrough');
      // SSR reads the *base* color pass, not the GI-composited node; the composite is done below.
      const r = ssr(pColor, pDepth, pNormal, {
        metalnessNode: mr.r,
        roughnessNode: mr.g,
        reflectNonMetals: true,
        camera,
      });
      r.maxDistance.value = 40;
      r.thickness.value = 0.4;
      r.quality.value = q.ssrQ ?? 0.5;
      r.intensity = look.ssrIntensity;
      r.resolutionScale = q.ssrScale ?? 1;
      node = vec4(node.rgb.add(r.rgb), node.a);
      state.nodes['ssr'] = r;
    }

    if (q.rays && sun !== null) {
      const g = godrays(pDepth, camera, sun);
      g.density = look.rayDensity;
      g.maxDensity = look.rayMax;
      g.distanceAttenuation.value = 0.02;
      g.raymarchSteps.value = q.raySteps ?? 40;
      const blur = bilateralBlur(g.getTextureNode());
      node = depthAwareBlend(convertToTexture(node), blur.getTextureNode(), pDepth, camera, {
        blendColor: look.rayColor,
        edgeRadius: uniform(int(2)),
        edgeStrength: uniform(float(2)),
      });
      state.nodes['rays'] = g;
    }

    // Weather overlay (rain, motes) gets its own pass so transparent quads never touch the
    // G-buffer that SSGI/SSR read from.
    if (overlay !== null) {
      const op = pass(overlay, camera);
      node = vec4(node.rgb.add(op.getTextureNode('output').rgb), node.a);
      state.nodes['overlay'] = op;
    }

    // Tame fireflies (sun/moon glints on mirror puddles) before TRAA history, DOF bokeh and bloom.
    node = vec4(min(node.rgb, vec3(look.maxRadiance)), node.a);

    if (q.aa === 'traa') {
      node = traa(node, pDepth, scenePass.getTextureNode('velocity'), camera);
    }

    if (q.dof) {
      // DepthOfFieldNode's addon .d.ts extends TempNode without <'vec4'>; cast to preserve the vec4 chain.
      node = dof(node, scenePass.getViewZNode(), look.focus, look.focusRange, look.bokeh) as unknown as WGNode<'vec4'>;
    }

    if (q.bloom) {
      const b = bloom(node, 1, 0.5, 1);
      b.strength = look.bloomStrength;
      b.radius = look.bloomRadius;
      b.threshold = look.bloomThreshold;
      node = node.add(b);
      state.nodes['bloom'] = b;
    }

    // ---- display-space finishing ----
    // renderOutput → Node<'vec4'>; fxaa → FXAANode (untyped TempNode → cast).
    let o: WGNode<'vec4'> = renderOutput(vec4(node.rgb.mul(look.exposure), 1.0));
    if (q.aa === 'fxaa') o = fxaa(convertToTexture(o)) as unknown as WGNode<'vec4'>;
    let c: WGNode<'vec3'> = o.rgb;
    // Split-tone: shadows toward teal, highlights toward warm; the ×1.9 keeps mid-tones bright.
    const l = luminance(c);
    const tint = mix(look.shadowTint, look.highlightTint, smoothstep(0.0, 0.75, l));
    c = mix(c, c.mul(tint).mul(1.9), look.tintAmount);
    // Contrast around mid grey, then saturation around luminance.
    c = c.sub(0.5).mul(look.contrast).add(0.5);
    c = mix(vec3(luminance(c)), c, look.saturation);
    // Vignette: elliptical (0.85 vertical squash) fading between 0.85 (edge) and 0.2 (centre).
    const d = screenUV.sub(0.5).mul(vec2(1.0, 0.85)).length();
    c = c.mul(mix(float(1.0), smoothstep(0.85, 0.2, d), look.vignette));
    // Grain: animated `interleavedGradientNoise`, luminance-weighted so blacks stay clean.
    const n = interleavedGradientNoise(
      screenCoordinate.xy.add(time.mul(61.0).floor().mul(vec2(37.0, 17.0))),
    ).sub(0.5);
    c = c.add(n.mul(look.grain).mul(mix(1.0, 0.35, l)));
    c = clamp(c, 0.0, 1.0).mul(look.fade);
    pipeline.outputNode = vec4(c, 1.0);
    pipeline.needsUpdate = true;
    state.nodes['scenePass'] = scenePass;
  };

  build(state.quality);

  return {
    pipeline,
    look,
    state,
    setQuality(q: QualityName): void {
      if (q !== state.quality) build(q);
    },
    render(): void {
      pipeline.render();
    },
  };
}
