/**
 * GPU post-processing pipeline (browser-only) — the MRT → SSGI → SSR →
 * god rays → firefly-clamp → TRAA → DOF → bloom → AgX → grade → vignette →
 * grain → fade node graph ported from `~/afterburn/src/render/pipeline.js`
 * (see `docs/gpu.md` and `docs/gpu-pipeline.md`).
 *
 * The impure builder (`createPipeline`) constructs the graph and drives
 * `setQuality`; the pure exports (`clampQuality`, `qualityPlan`,
 * `createLook`) exist so that `tests/gpu-pipeline.test.ts` can pin the
 * behaviour that matters without touching a GPU.
 */
import { PostProcessing, type PerspectiveCamera, type Scene } from 'three/webgpu';
import {
  pass,
  mrt,
  output,
  emissive,
  transformedNormalView,
  uniform,
  mix,
  luminance,
  saturate,
  clamp,
  uv,
  vec3,
  vec4,
  dot,
  renderOutput,
  interleavedGradientNoise,
} from 'three/tsl';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { godrays } from 'three/addons/tsl/display/GodraysNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { depthAwareBlend } from 'three/addons/tsl/display/depthAwareBlend.js';

/** One of the four fixed quality tiers from `docs/gpu.md` §3. */
export type QualityName = 'low' | 'medium' | 'high' | 'ultra';

/** Backend capabilities probed by `createRenderer()`. */
export interface RendererCaps {
  webgpu: boolean;
  mrtBytes: number;
  maxQuality: QualityName;
}

/** Boolean/numeric flags a tier resolves to; consumed by `createPipeline`. */
export interface QualitySettings {
  ssgi: boolean;
  ssgiSlices: number;
  ssgiSteps: number;
  ssr: boolean;
  ssrFullRes: boolean;
  godRays: boolean;
  godRaySteps: number;
  traa: boolean;
  dof: boolean;
  bloom: boolean;
  gtao: boolean;
  fxaa: boolean;
  giScale: number;
  maxRadiance: number;
}

const RANK: Record<QualityName, number> = { low: 0, medium: 1, high: 2, ultra: 3 };
const NAMES: readonly QualityName[] = ['low', 'medium', 'high', 'ultra'];

/** The four tiers, kept verbatim from afterburn (docs/gpu-pipeline.md#quality). */
export const QUALITY: Readonly<Record<QualityName, QualitySettings>> = {
  low: {
    ssgi: false,
    ssgiSlices: 0,
    ssgiSteps: 0,
    ssr: false,
    ssrFullRes: false,
    godRays: false,
    godRaySteps: 0,
    traa: false,
    dof: false,
    bloom: true,
    gtao: false,
    fxaa: true,
    giScale: 1.0,
    maxRadiance: 8.0,
  },
  medium: {
    ssgi: false,
    ssgiSlices: 0,
    ssgiSteps: 0,
    ssr: true,
    ssrFullRes: false,
    godRays: false,
    godRaySteps: 0,
    traa: true,
    dof: true,
    bloom: true,
    gtao: true,
    fxaa: false,
    giScale: 1.0,
    maxRadiance: 8.0,
  },
  high: {
    ssgi: true,
    ssgiSlices: 1,
    ssgiSteps: 12,
    ssr: true,
    ssrFullRes: false,
    godRays: true,
    godRaySteps: 36,
    traa: true,
    dof: true,
    bloom: true,
    gtao: false,
    fxaa: false,
    giScale: 1.0,
    maxRadiance: 8.0,
  },
  ultra: {
    ssgi: true,
    ssgiSlices: 2,
    ssgiSteps: 16,
    ssr: true,
    ssrFullRes: true,
    godRays: true,
    godRaySteps: 72,
    traa: true,
    dof: true,
    bloom: true,
    gtao: false,
    fxaa: false,
    giScale: 1.0,
    maxRadiance: 8.0,
  },
};

/**
 * Cap the requested tier by what the backend can run — the rule from
 * `docs/gpu.md` §3: a non-WebGPU backend, or a WebGPU adapter whose MRT
 * budget is under 64 bytes/sample, cannot run the full stack and is
 * clamped at `'medium'`.
 */
export function clampQuality(requested: QualityName, caps: RendererCaps): QualityName {
  const backendCap: QualityName = caps.webgpu && caps.mrtBytes >= 64 ? 'ultra' : 'medium';
  const configuredCap: QualityName = caps.maxQuality;
  const cap = RANK[configuredCap] < RANK[backendCap] ? configuredCap : backendCap;
  return RANK[requested] > RANK[cap] ? cap : requested;
}

/**
 * Resolve a named tier plus an optional dev override into the flat flags
 * the graph builder consumes. Override wins field-by-field.
 */
export function qualityPlan(
  name: QualityName,
  override?: Partial<QualitySettings>,
): QualitySettings {
  const base = QUALITY[name];
  if (!override) return { ...base };
  return { ...base, ...override };
}

/**
 * The grade-block uniforms (afterburn's split-tone → contrast → saturation
 * → vignette → grain → fade). Plain values so the tier + look are testable
 * in Node; the pipeline builder wraps each field in a `uniform()` node.
 */
export interface Look {
  exposure: number;
  shadowTint: [number, number, number];
  highlightTint: [number, number, number];
  tintBalance: number;
  contrast: number;
  midGrey: number;
  saturation: number;
  vignette: number;
  vignetteFalloff: number;
  grain: number;
  fade: number;
}

const LOOK_DEFAULTS: Look = {
  exposure: 1.0,
  shadowTint: [0.86, 1.00, 1.08],
  highlightTint: [1.10, 1.04, 0.92],
  tintBalance: 0.5,
  contrast: 1.05,
  midGrey: 0.18,
  saturation: 1.08,
  vignette: 0.35,
  vignetteFalloff: 1.20,
  grain: 0.03,
  fade: 1.0,
};

/** Returns a fresh Look object at the documented defaults. */
export function createLook(overrides?: Partial<Look>): Look {
  const base: Look = {
    ...LOOK_DEFAULTS,
    shadowTint: [...LOOK_DEFAULTS.shadowTint] as [number, number, number],
    highlightTint: [...LOOK_DEFAULTS.highlightTint] as [number, number, number],
  };
  if (!overrides) return base;
  const merged: Look = { ...base, ...overrides };
  if (overrides.shadowTint) merged.shadowTint = [...overrides.shadowTint] as [number, number, number];
  if (overrides.highlightTint) merged.highlightTint = [...overrides.highlightTint] as [number, number, number];
  return merged;
}

/** Handle returned by `createPipeline` — owns the graph and the tier state. */
export interface PipelineHandle {
  readonly postProcessing: PostProcessing;
  readonly look: Look;
  quality(): { name: QualityName; settings: QualitySettings };
  setQuality(name: QualityName, override?: Partial<QualitySettings>): void;
  render(): void;
  renderAsync(): Promise<void>;
  dispose(): void;
}

/** Options for `createPipeline`; the sun is only needed when god rays are enabled. */
export interface PipelineOptions {
  readonly renderer: import('three/webgpu').Renderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly caps: RendererCaps;
  readonly requested?: QualityName;
  readonly override?: Partial<QualitySettings>;
  readonly sun?: import('three').DirectionalLight | import('three').PointLight;
  readonly look?: Partial<Look>;
}

type Node4 = import('three/webgpu').Node<'vec4'>;

/**
 * Build the post-processing graph and return a handle. Impure — needs a
 * `WebGPURenderer` and a live scene/camera. The pass order (MRT → SSGI/GTAO
 * → SSR → god rays → firefly-clamp → TRAA → DOF → bloom → AgX renderOutput
 * → split-tone/contrast/saturation grade → vignette → grain → fade) is the
 * whole reason this file exists; see `docs/gpu-pipeline.md`.
 */
export function createPipeline(opts: PipelineOptions): PipelineHandle {
  const { renderer, scene, camera, caps, sun } = opts;
  const look = createLook(opts.look);

  const postProcessing = new PostProcessing(renderer);
  postProcessing.outputColorTransform = false;

  const state = {
    name: clampQuality(opts.requested ?? 'ultra', caps),
    settings: {} as QualitySettings,
  };
  state.settings = qualityPlan(state.name, opts.override);

  const exposureU = uniform(look.exposure);
  const shadowTintU = uniform(vec3(look.shadowTint[0], look.shadowTint[1], look.shadowTint[2]));
  const highlightTintU = uniform(
    vec3(look.highlightTint[0], look.highlightTint[1], look.highlightTint[2]),
  );
  const tintBalanceU = uniform(look.tintBalance);
  const contrastU = uniform(look.contrast);
  const midGreyU = uniform(look.midGrey);
  const saturationU = uniform(look.saturation);
  const vignetteU = uniform(look.vignette);
  const vignetteFalloffU = uniform(look.vignetteFalloff);
  const grainU = uniform(look.grain);
  const fadeU = uniform(look.fade);

  const rebuild = () => {
    const s = state.settings;

    const scenePass = pass(scene, camera);
    scenePass.setMRT(
      mrt({
        output: output,
        emissive: emissive,
        normal: transformedNormalView,
      }),
    );

    const beauty = scenePass.getTextureNode('output');
    const depth = scenePass.getTextureNode('depth');
    const normal = scenePass.getTextureNode('normal');
    const viewZ = scenePass.getViewZNode();
    const velocity = scenePass.getTextureNode('velocity');

    let color: Node4 = beauty.mul(exposureU) as unknown as Node4;

    if (s.ssgi) {
      const gi = ssgi(beauty, depth, normal, camera);
      gi.sliceCount.value = s.ssgiSlices;
      gi.stepCount.value = s.ssgiSteps;
      gi.giIntensity.value = s.giScale;
      color = mix(color, gi as unknown as Node4, saturate(uniform(s.giScale))) as unknown as Node4;
    } else if (s.gtao) {
      const gtao = ao(depth, normal, camera);
      color = color.mul(gtao as unknown as Node4) as unknown as Node4;
    }

    if (s.ssr) {
      const rough = uniform(s.ssrFullRes ? 0.15 : 0.35);
      const metal = uniform(0.0);
      const reflected = ssr(color, depth, normal as unknown as import('three/webgpu').Node<'vec3'>, {
        roughness: rough,
        metalness: metal,
      });
      color = depthAwareBlend(color, reflected as unknown as Node4, depth, {}) as unknown as Node4;
    }

    if (s.godRays && sun !== undefined) {
      const rays = godrays(depth, camera, sun);
      rays.raymarchSteps.value = s.godRaySteps;
      color = (color.add(rays as unknown as Node4)) as unknown as Node4;
    }

    // Firefly clamp before TRAA — keep highlights inside the stable range.
    const maxRadU = uniform(s.maxRadiance);
    color = clamp(color, vec4(0.0, 0.0, 0.0, 0.0), vec4(maxRadU, maxRadU, maxRadU, 1.0)) as unknown as Node4;

    if (s.traa) {
      color = traa(color, depth, velocity, camera) as unknown as Node4;
    }

    if (s.dof) {
      color = dof(color, viewZ) as unknown as Node4;
    }

    if (s.bloom) {
      color = color.add(bloom(color) as unknown as Node4) as unknown as Node4;
    }

    // AgX tone map + sRGB write; pipeline.outputColorTransform stays false.
    color = renderOutput(color) as unknown as Node4;

    // Split-tone grade: shadowTint → highlightTint by (luma/tintBalance).
    const lum = luminance(color);
    const tintMix = saturate(lum.div(tintBalanceU));
    const tint = mix(shadowTintU, highlightTintU, tintMix);
    color = color.mul(vec4(tint, 1.0)) as unknown as Node4;

    // Contrast around mid grey.
    color = mix(vec4(midGreyU, midGreyU, midGreyU, 1.0), color, contrastU) as unknown as Node4;

    // Saturation around luminance.
    const gray = luminance(color);
    color = mix(vec4(gray, gray, gray, 1.0), color, saturationU) as unknown as Node4;

    // Radial vignette.
    const centred = uv().sub(0.5);
    const d = saturate(dot(centred, centred).mul(vignetteFalloffU));
    const v = saturate(uniform(1.0).sub(d.mul(vignetteU)));
    color = color.mul(vec4(v, v, v, 1.0)) as unknown as Node4;

    // Grain via interleavedGradientNoise, then final fade multiply.
    const noise = interleavedGradientNoise().sub(0.5).mul(grainU);
    color = color.add(vec4(noise, noise, noise, 0.0)) as unknown as Node4;
    color = color.mul(vec4(fadeU, fadeU, fadeU, 1.0)) as unknown as Node4;

    if (s.fxaa) {
      color = fxaa(color) as unknown as Node4;
    }

    postProcessing.outputNode = color;
    postProcessing.needsUpdate = true;
  };

  rebuild();

  return {
    postProcessing,
    look,
    quality() {
      return { name: state.name, settings: { ...state.settings } };
    },
    setQuality(name: QualityName, override?: Partial<QualitySettings>) {
      const next = clampQuality(name, caps);
      if (next === state.name && override === undefined) return;
      state.name = next;
      state.settings = qualityPlan(next, override);
      rebuild();
    },
    render() {
      postProcessing.render();
    },
    async renderAsync() {
      await postProcessing.renderAsync();
    },
    dispose() {
      postProcessing.dispose();
    },
  };
}
