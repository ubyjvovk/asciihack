/**
 * Pure decision helpers for the browser viewport's GPU/legacy path split
 * (T-0040, docs/gpu-compose.md). Every export in this module is a plain
 * function or plain type — **no `three` import, no DOM lib** — so
 * `tests/gpu-compose.test.ts` can exercise them in node under the root
 * tsconfig. `GlViewport` (browser-only) consumes them at runtime.
 *
 * The rules live in `docs/gpu.md` §3 (backend/fallback), §6 (composition,
 * depth styles) and §6.1 (styled vs. raw grade); this file is the executable
 * summary of those sections.
 */
import type { CellKind, LevelView } from '../../../src/model/types.js';
import type { MoodId } from './moods.js';
import type { QualityName } from './pipeline.js';

/** `?gpu=` param values. `auto` = GPU where the current style allows it. */
export type GpuParam = 'auto' | 'off' | 'raw';
/** Backend actually reached / requested. `'auto'` = let the renderer decide. */
export type BackendChoice = 'webgpu' | 'webgl2';
/** Which of the three viewport paths a frame is going through. */
export type ViewportPath = 'legacy' | 'styled' | 'raw';

/** Inputs to `choosePath` — decoupled from any renderer object so the rule
 *  is a pure function of state that a test can pin down. */
export interface ChoosePathOpts {
  /** Resolved `?gpu=` value (or the equivalent explicit option). */
  gpuParam: GpuParam;
  /** True iff the GPU renderer initialised and has not fallen back. */
  gpuReady: boolean;
  /** True iff the active style sets `needsDepth` — only `edges` today
   *  (docs/gpu.md §6). A blitted quad has no scene depth. */
  styleNeedsDepth: boolean;
}

/**
 * Decide which of `legacy | styled | raw` renders this frame.
 * `off` and a not-ready GPU both fall to `legacy`; `raw` skips the style
 * pass entirely; `auto` picks styled for a depth-free style and legacy for
 * a depth style so the `edges` style keeps working (docs/gpu.md §6).
 */
export function choosePath(opts: ChoosePathOpts): ViewportPath {
  if (opts.gpuParam === 'off') return 'legacy';
  if (!opts.gpuReady) return 'legacy';
  if (opts.gpuParam === 'raw') return 'raw';
  if (opts.styleNeedsDepth) return 'legacy';
  return 'styled';
}

/**
 * Resolve `?backend=webgpu|webgl2` (or `null`) into the backend the
 * viewport constructs. Anything but explicit `webgl2` maps to `webgpu` so
 * three's own probe picks the real WebGPU adapter when one is available
 * (docs/gpu.md §3).
 */
export function backendFor(param: 'webgpu' | 'webgl2' | null): BackendChoice {
  return param === 'webgl2' ? 'webgl2' : 'webgpu';
}

/** Style shape `gpuCanvasSize` needs (a subset of `RenderStyle`). */
export interface StyleShape {
  /** Scene samples per cell horizontally. */
  subX: number;
  /** Scene samples per cell vertically. */
  subY: number;
}

/** Viewport rectangle for raw mode. `dpr` is capped at 1.5 (docs/gpu.md §6). */
export interface ViewportPx {
  cssW: number;
  cssH: number;
  dpr: number;
}

/**
 * Pixel size of the GPU-owned canvas. Styled mode returns the style's scene
 * target size (`cols·subX × rows·subY`; already capped at 640×360 by
 * `styleGrid` upstream). Raw mode returns the CSS viewport rectangle scaled
 * by `min(dpr, 1.5)` — the same 1.5 cap `createRenderer` uses.
 */
export function gpuCanvasSize(
  mode: 'styled' | 'raw',
  style: StyleShape,
  cols: number,
  rows: number,
  viewportPx: ViewportPx,
): { w: number; h: number } {
  if (mode === 'styled') {
    return {
      w: Math.max(1, Math.floor(cols * style.subX)),
      h: Math.max(1, Math.floor(rows * style.subY)),
    };
  }
  const dpr = Math.min(Math.max(viewportPx.dpr, 1), 1.5);
  return {
    w: Math.max(1, Math.round(viewportPx.cssW * dpr)),
    h: Math.max(1, Math.round(viewportPx.cssH * dpr)),
  };
}

/** Orthogonal (4-neighbour) offsets, evaluated N/S/W/E every time. */
const ORTHO_DELTAS: ReadonlyArray<readonly [number, number]> = [
  [0, -1], [0, 1], [-1, 0], [1, 0],
];

/**
 * Pick the mood for the hero's cell, following the ticket's precedence
 * table (lava → ice → flooded → torchlit → deep_dark; first match wins).
 * Adjacency for lava/water is orthogonal only (a diagonal lava tile does
 * not tint the hero).
 */
export function moodFor(level: LevelView, x: number, y: number): MoodId {
  const here: CellKind = level.kindAt(x, y);
  if (here === 'lava') return 'lava';
  for (const [dx, dy] of ORTHO_DELTAS) {
    if (level.kindAt(x + dx, y + dy) === 'lava') return 'lava';
  }
  if (here === 'ice') return 'ice';
  if (here === 'water') return 'flooded';
  for (const [dx, dy] of ORTHO_DELTAS) {
    if (level.kindAt(x + dx, y + dy) === 'water') return 'flooded';
  }
  const cell = level.cellAt(x, y);
  if (cell !== null && cell.lit === true) return 'torchlit';
  return 'deep_dark';
}

/** Subset of `Look` that `styledLook` / `rawLook` write; matches
 *  `web/src/gpu/pipeline.ts` field names so the caller can spread it. */
export interface LookGradeOverride {
  vignette?: number;
  grain?: number;
  outputScale?: number;
}

/**
 * Grade values styled mode writes into the pipeline's look every frame
 * (after the mood has updated its own values). Zeros vignette + grain
 * because the ASCII cell already averages them into visible noise, and
 * scales the frame by `1 / styleExposure` so the style pass' own exposure
 * lands where it expects (docs/gpu.md §6.1).
 */
export function styledLook(styleExposure: number): Required<LookGradeOverride> {
  return {
    vignette: 0,
    grain: 0,
    outputScale: 1 / styleExposure,
  };
}

/** Raw mode leaves the grade alone (mood values apply as-is). Kept as a
 *  paired export so callers do not sprinkle the two-branch decision. */
export function rawLook(): LookGradeOverride {
  return {};
}

/**
 * Structural shape of anything exposing an `environment` field. Generic
 * over the texture type so the helper stays free of `three` imports —
 * `tests/gpu-compose.test.ts` (compiled under the root tsconfig, no DOM
 * lib) hands in a plain sentinel while `GpuPath.create` passes the real
 * `Atmosphere` (whose `.environment` is a `DataTexture | null`), and the
 * caller keeps its type.
 */
export interface AtmosphereEnv<E = unknown> {
  readonly environment: E;
}

/**
 * Attach the active mood's env map to a `createPipeline` options bag so
 * SSR receives it at construction. Without it the stochastic path (used on
 * the WebGL2 backend) throws
 * `TypeError: Cannot read properties of null (reading 'sampleEnvironmentBRDF')`
 * every frame at `SSRNode.js:1051` (T-0048 note in `docs/gpu-pipeline.md`).
 * Extracted from `GpuPath.create` so `tests/gpu-compose.test.ts` can inject
 * a stub factory and inspect the option bag without instantiating a real
 * `WebGPURenderer` (which needs a browser).
 */
export function pipelineOptionsWithEnv<Opts extends object, E>(
  base: Opts,
  atmosphere: AtmosphereEnv<E>,
): Opts & { environment: E } {
  return { ...base, environment: atmosphere.environment };
}

/** Fully-resolved GPU options after query-string parsing. */
export interface GpuQueryOptions {
  gpu: GpuParam;
  quality: QualityName | 'auto';
  backend: BackendChoice | 'auto';
  mood: MoodId | null;
}

/** Legal quality names, kept local so this file does not import pipeline. */
const QUALITY_NAMES: readonly string[] = ['low', 'medium', 'high', 'ultra'];
const MOOD_IDS: readonly string[] = ['torchlit', 'deep_dark', 'flooded', 'lava', 'ice'];

/**
 * Parse the GPU-path knobs from a URL query string (as passed by
 * `window.location.search`). Missing/invalid values fall to `auto` /
 * `null` so `GlViewport({})` and `?gpu=auto&q=…` behave the same, and the
 * bench (`/scene.html`) needs no code changes.
 */
export function parseGpuQueryOptions(search: string): GpuQueryOptions {
  const p = new URLSearchParams(search);
  const rawGpu = p.get('gpu');
  // Default `raw`: the full afterburn frame, un-quantised (user, 2026-09-21).
  // `?gpu=auto` puts the ASCII style pass back, `?gpu=off` drops to the
  // legacy WebGL path, and F8 toggles raw <-> styled at runtime.
  const gpu: GpuParam = rawGpu === 'off' || rawGpu === 'raw' || rawGpu === 'auto' ? rawGpu : 'raw';
  const rawQ = p.get('q');
  const quality: QualityName | 'auto' = rawQ !== null && QUALITY_NAMES.includes(rawQ)
    ? (rawQ as QualityName)
    : 'auto';
  const rawBackend = p.get('backend');
  const backend: BackendChoice | 'auto' = rawBackend === 'webgl2' || rawBackend === 'webgpu'
    ? rawBackend
    : 'auto';
  const rawMood = p.get('mood');
  const mood: MoodId | null = rawMood !== null && MOOD_IDS.includes(rawMood)
    ? (rawMood as MoodId)
    : null;
  return { gpu, quality, backend, mood };
}
