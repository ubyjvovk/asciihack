/**
 * Dungeon air overlay (T-0044, docs/gpu-weather.md).
 *
 * Ports `vendor/afterburn/src/render/weather.js` into a small dungeon-shaped
 * overlay scene the ported pipeline composites additively **after** the
 * lighting stack (`pass(overlay, camera)` in `pipeline.ts`), so its
 * transparent quads never touch the G-buffer that SSGI/SSR read.
 *
 * Three emitters, one InstancedMesh each, allocated once. **All three
 * default to zero instances** (T-0055): the sealed-stone dungeon has no
 * open-air weather; a caller opts an emitter back on for a specific level
 * via `createWeather(W, { embers: EMBER_COUNT })` etc. The mood table below
 * is the tuned intensity per mood a caller who does opt in inherits:
 *
 * - **drips** — small vertical droplets falling from the ceiling in wet
 *   rooms. Runs on wetness (`W.wetness`) + rain (`W.rain`); dry moods emit
 *   nothing (`deep_dark`, `lava`).
 * - **motes** — dust drifting in torchlight. The dungeon-air ambient; every
 *   mood emits some, `deep_dark` the most (still + dusty).
 * - **embers** — warm points rising from the floor near a torch or lava.
 *   Runs on `W.glow`; only `lava` and `torchlit` emit.
 *
 * The GPU shader graph is derived from `instanceIndex` and `time`, so there
 * is **no per-frame JS particle loop** and no per-frame allocation. Each
 * emitter's world position is wrapped inside a box centred on `focus` (the
 * hero cell) so the volume follows the camera without popping.
 *
 * Intensity per emitter is chosen by the active mood id + the shared `W`
 * uniforms. See `emitterTargets()` for the pure mapping and
 * `docs/gpu-weather.md` for the tuning table.
 */

import {
  AdditiveBlending,
  Color,
  DoubleSide,
  InstancedMesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  Scene,
  Vector2,
  Vector3,
} from 'three/webgpu';
import type { UniformNode } from 'three/webgpu';
import {
  cameraPosition,
  color,
  cos,
  cross,
  float,
  hash,
  instanceIndex,
  mix,
  mod,
  normalize,
  positionGeometry,
  sin,
  smoothstep,
  time,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { W, type Weather } from './materials.js';
import type { MoodId } from './moods.js';

/**
 * Afterburn-scale instance count per emitter — the number the original
 * outdoor weather overlay used, kept as a named constant so a caller
 * opting a specific emitter back on can spell the intent
 * (`createWeather(W, { drips: DRIP_COUNT })`). The dungeon default is
 * **zero** on every emitter (see `createWeather`); nothing runs unless
 * something asks for it (T-0055, docs/gpu-weather.md "Emit nothing by default").
 */
export const DRIP_COUNT = 400;
/** Afterburn-scale instance count for the drifting dust motes. See `DRIP_COUNT`. */
export const MOTE_COUNT = 560;
/** Afterburn-scale instance count for the rising torch/lava embers. See `DRIP_COUNT`. */
export const EMBER_COUNT = 300;

/** Horizontal half-extent (cells) of the wrap volume centred on `focus` for drips. */
export const DRIP_RADIUS = 7;
/** Horizontal half-extent for the mote wrap volume. */
export const MOTE_RADIUS = 8;
/** Horizontal half-extent for the ember wrap volume. */
export const EMBER_RADIUS = 5;
/** Vertical extent (metres) drips fall through — ceiling at 1 down to floor 0, plus a lead-in. */
const DRIP_HEIGHT = 4;
/** Vertical extent motes drift through. */
const MOTE_HEIGHT = 2.5;
/** Vertical extent embers rise through. */
const EMBER_HEIGHT = 2.5;
/** Speed the visibility intensity eases toward its per-frame target (1/s). */
const FADE_RATE = 1.5;
/** Below this intensity the InstancedMesh hides so the pipeline can skip the pass. */
const VISIBLE_EPS = 0.004;

/** Baseline drips intensity per mood, before scaling by wetness + rain. */
const DRIPS_PER_MOOD: Readonly<Record<MoodId, number>> = {
  torchlit: 0.35,
  deep_dark: 0.0,
  flooded: 1.0,
  lava: 0.0,
  ice: 0.05,
};

/** Baseline motes intensity per mood. Motes are mood-only (not weather-driven). */
const MOTES_PER_MOOD: Readonly<Record<MoodId, number>> = {
  torchlit: 0.55,
  deep_dark: 0.80,
  flooded: 0.10,
  lava: 0.15,
  ice: 0.30,
};

/** Baseline embers intensity per mood, before scaling by `W.glow`. */
const EMBERS_PER_MOOD: Readonly<Record<MoodId, number>> = {
  torchlit: 0.20,
  deep_dark: 0.0,
  flooded: 0.0,
  lava: 0.90,
  ice: 0.0,
};

/** Warm/cool tint per mood, applied to all three emitters. */
const TINT_PER_MOOD: Readonly<Record<MoodId, { drip: number; mote: number; ember: number }>> = {
  torchlit:  { drip: 0xa8bccb, mote: 0xffe2b8, ember: 0xffb45e },
  deep_dark: { drip: 0x6a7078, mote: 0xcfd8dc, ember: 0x000000 },
  flooded:   { drip: 0xa8bccb, mote: 0x9fc0d0, ember: 0x000000 },
  lava:      { drip: 0x000000, mote: 0xffb090, ember: 0xff6a2a },
  ice:       { drip: 0xbfe4ff, mote: 0xbfe4ff, ember: 0x000000 },
};

/** Plain numeric side of the shared `W` block — the pure inputs to `emitterTargets`. */
export interface WeatherValues {
  wetness: number;
  rain: number;
  glow: number;
  wind: number;
}

/** Per-emitter target intensity for a `(mood, W)` snapshot. Range `[0, 1]`. */
export interface EmitterTargets {
  drips: number;
  motes: number;
  embers: number;
}

/**
 * Pure mapping from the mood id + the shared `W` values to a per-emitter
 * intensity in `[0, 1]`. Called from `update()` every frame; exported so the
 * tests can pin behaviour without a GPU.
 *
 * Rules:
 *   drips  = MOOD_BASE.drips  × clamp01(wetness + rain × 0.5)
 *   motes  = MOOD_BASE.motes                                       (mood-only)
 *   embers = MOOD_BASE.embers × (0.4 + 0.6 × clamp01(glow))
 *
 * `wind` is read directly by the shader (drift + wobble); it does not scale
 * emitter intensity, so it is not consumed here.
 */
export function emitterTargets(mood: MoodId, w: WeatherValues): EmitterTargets {
  const wet = clamp01(w.wetness + w.rain * 0.5);
  const glow = clamp01(w.glow);
  return {
    drips: DRIPS_PER_MOOD[mood] * wet,
    motes: MOTES_PER_MOOD[mood],
    embers: EMBERS_PER_MOOD[mood] * (0.4 + 0.6 * glow),
  };
}

/**
 * The wrap function every emitter uses in its `positionNode`: keeps a
 * particle inside `focus ± halfExtent` on a single axis. Exported (in JS
 * form) so a Node test can pin the invariant the GPU shader implements with
 * `mod(base + focus - halfExtent, 2·halfExtent) - halfExtent + focus`.
 */
export function wrapAround(base: number, focus: number, halfExtent: number): number {
  const size = 2 * halfExtent;
  const rel = ((base - focus + halfExtent) % size + size) % size - halfExtent;
  return focus + rel;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Options for `createWeather`. Every field defaults to **zero** — a plain
 * `createWeather(W)` allocates no particle instances, so the overlay pass
 * runs but nothing emits. Pass `{ embers: EMBER_COUNT }` (or a smaller
 * number) to turn one emitter back on for, say, a lava-pool level.
 */
export interface CreateWeatherOptions {
  /** Instance count allocated for the falling-drip emitter. Default `0`. */
  drips?: number;
  /** Instance count allocated for the drifting-mote emitter. Default `0`. */
  motes?: number;
  /** Instance count allocated for the rising-ember emitter. Default `0`. */
  embers?: number;
}

/** Live handle returned by `createWeather()` — pure data plus the update hook. */
export interface WeatherHandle {
  /** The overlay `THREE.Scene` — hand this to `createPipeline({ overlay })`. */
  scene: Scene;
  /** The three pre-allocated instance meshes (one per emitter). */
  drips: InstancedMesh;
  motes: InstancedMesh;
  embers: InstancedMesh;
  /** Camera / hero focus point in world space; every emitter wraps around it. */
  focus: UniformNode<'vec3', Vector3>;
  /** Per-emitter runtime uniforms (`update` writes these; shader reads them). */
  drip: { intensity: UniformNode<'float', number>; tint: UniformNode<'color', Color> };
  mote: { intensity: UniformNode<'float', number>; tint: UniformNode<'color', Color> };
  ember: { intensity: UniformNode<'float', number>; tint: UniformNode<'color', Color> };
  /** Horizontal wind vector consumed by drips + motes. */
  wind: UniformNode<'vec2', Vector2>;
  /** Advance eased intensities toward the mood + W target and update focus. */
  update(dt: number, focusPos: Vector3, mood: MoodId): void;
  /** Free every GPU-side resource the overlay owns. */
  dispose(): void;
}

/**
 * Build the overlay scene. Reads the shared `W` block by reference so a
 * mood/atmosphere change is picked up automatically (the shader samples W
 * every frame). One buffer is allocated per emitter and never reallocated.
 *
 * Every emitter's instance count is **zero by default** (T-0055): the
 * dungeon is sealed stone, not an open valley in the rain, so no motes,
 * drips or embers unless the caller explicitly turns them on via
 * `opts.drips`/`opts.motes`/`opts.embers`. The mood plumbing, the tint
 * uniforms and the overlay pass wiring all still exist so a later ticket
 * (e.g. embers over a lava pool) is a single-number change.
 */
export function createWeather(weather: Weather = W, opts: CreateWeatherOptions = {}): WeatherHandle {
  const dripCount = Math.max(0, opts.drips ?? 0);
  const moteCount = Math.max(0, opts.motes ?? 0);
  const emberCount = Math.max(0, opts.embers ?? 0);

  const scene = new Scene();
  scene.name = 'dungeon-air';

  const focus = uniform(new Vector3());
  const wind = uniform(new Vector2(0.6, 0.4));

  const drip = {
    intensity: uniform(0.0),
    tint: uniform(new Color(TINT_PER_MOOD.torchlit.drip)),
  };
  const mote = {
    intensity: uniform(0.0),
    tint: uniform(new Color(TINT_PER_MOOD.torchlit.mote)),
  };
  const ember = {
    intensity: uniform(0.0),
    tint: uniform(new Color(TINT_PER_MOOD.torchlit.ember)),
  };

  const dripsBuilt = buildDrips(focus, wind, drip.intensity, drip.tint, dripCount);
  const motesBuilt = buildMotes(focus, wind, mote.intensity, mote.tint, weather, moteCount);
  const embersBuilt = buildEmbers(focus, ember.intensity, ember.tint, weather, emberCount);
  const drips = dripsBuilt.mesh;
  const motes = motesBuilt.mesh;
  const embers = embersBuilt.mesh;
  scene.add(drips, motes, embers);

  const scratchTint = new Color();

  return {
    scene,
    drips,
    motes,
    embers,
    focus,
    drip,
    mote,
    ember,
    wind,
    update(dt: number, focusPos: Vector3, mood: MoodId): void {
      focus.value.copy(focusPos);
      const targets = emitterTargets(mood, {
        wetness: weather.wetness.value,
        rain: weather.rain.value,
        glow: weather.glow.value,
        wind: weather.wind.value,
      });
      const k = Math.min(1, Math.max(0, dt) * FADE_RATE);
      drip.intensity.value += (targets.drips - drip.intensity.value) * k;
      mote.intensity.value += (targets.motes - mote.intensity.value) * k;
      ember.intensity.value += (targets.embers - ember.intensity.value) * k;
      // Ease the per-mood tint too so a doorway transition doesn't punch a
      // colour change; reuses a single scratch Color so `update` allocates
      // nothing per frame.
      const t = TINT_PER_MOOD[mood];
      drip.tint.value.lerp(scratchTint.setHex(t.drip), k);
      mote.tint.value.lerp(scratchTint.setHex(t.mote), k);
      ember.tint.value.lerp(scratchTint.setHex(t.ember), k);
      // Wind vector follows W.wind (magnitude); direction is a fixed slight
      // NE lean so the drift reads as air movement rather than a still box.
      const w = weather.wind.value;
      wind.value.set(0.6 * w + 0.2, 0.4 * w);
      // Hide dead emitters so the additive pass has zero work when a mood
      // opts out (deep_dark: no drips + no embers → only motes ever draw).
      drips.visible = drip.intensity.value > VISIBLE_EPS;
      motes.visible = mote.intensity.value > VISIBLE_EPS;
      embers.visible = ember.intensity.value > VISIBLE_EPS;
    },
    dispose(): void {
      dripsBuilt.mesh.geometry.dispose();
      dripsBuilt.material.dispose();
      motesBuilt.mesh.geometry.dispose();
      motesBuilt.material.dispose();
      embersBuilt.mesh.geometry.dispose();
      embersBuilt.material.dispose();
    },
  };
}

interface BuiltEmitter { mesh: InstancedMesh; material: MeshBasicNodeMaterial; }

/** Build the falling-drip emitter. Vertical streaks aligned to gravity, wrapped in a box around `focus`. */
function buildDrips(
  focusNode: UniformNode<'vec3', Vector3>,
  windNode: UniformNode<'vec2', Vector2>,
  intensity: UniformNode<'float', number>,
  tint: UniformNode<'color', Color>,
  count: number,
): BuiltEmitter {
  const mat = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    fog: false,
    side: DoubleSide,
    blending: AdditiveBlending,
  });
  const id = float(instanceIndex);
  const r1 = hash(id.mul(1.31).add(0.17));
  const r2 = hash(id.mul(2.77).add(5.1));
  const r3 = hash(id.mul(0.73).add(9.4));
  const r4 = hash(id.mul(4.13).add(2.2));
  const H = float(DRIP_HEIGHT);
  const R2 = float(DRIP_RADIUS * 2);
  const speed = mix(2.4, 4.6, r4);
  const fall = mod(r2.mul(H).add(time.mul(speed)), H); // distance fallen (0..H)
  const y = H.sub(fall);
  // Random anchor in an R×R patch, wrapped around the focus in XZ every 2R.
  const base = vec2(r1, r3).mul(R2);
  const drift = windNode.mul(fall.div(speed).mul(0.4));
  const rel = mod(base.add(drift).sub(focusNode.xz).add(float(DRIP_RADIUS)), R2).sub(DRIP_RADIUS);
  const centre = vec3(
    focusNode.x.add(rel.x),
    focusNode.y.add(y).sub(0.5),
    focusNode.z.add(rel.y),
  );
  // Orient the streak toward the camera: gravity direction × view direction.
  const dirFall = normalize(vec3(windNode.x.mul(0.2), speed.negate(), windNode.y.mul(0.2)));
  const toCam = normalize(cameraPosition.sub(centre));
  const side = normalize(cross(dirFall, toCam));
  const len = mix(0.10, 0.22, r4);
  const wid = mix(0.008, 0.014, r1);
  const p = positionGeometry; // plane −0.5..0.5
  mat.positionNode = centre.add(dirFall.mul(p.y.mul(len))).add(side.mul(p.x.mul(wid)));
  const edge = smoothstep(0.0, 0.25, uv().y).mul(smoothstep(1.0, 0.6, uv().y));
  const near = smoothstep(0.8, 3.5, centre.sub(cameraPosition).length()); // don't smear across the lens
  const alive = smoothstep(0.0, 0.3, fall).mul(smoothstep(H, H.sub(0.4), y.add(fall)));
  const a = edge.mul(near).mul(alive).mul(intensity).mul(mix(0.5, 1.1, r2));
  mat.colorNode = vec4(color(tint).mul(a), 1.0);

  const mesh = new InstancedMesh(new PlaneGeometry(1, 1), mat, count);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.name = 'drips';
  mesh.renderOrder = 20;
  return { mesh, material: mat };
}

/** Build the drifting-dust-mote emitter. Camera-facing tiny discs, gentle wobble. */
function buildMotes(
  focusNode: UniformNode<'vec3', Vector3>,
  windNode: UniformNode<'vec2', Vector2>,
  intensity: UniformNode<'float', number>,
  tint: UniformNode<'color', Color>,
  weather: Weather,
  count: number,
): BuiltEmitter {
  const mat = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    fog: false,
    blending: AdditiveBlending,
  });
  const id = float(instanceIndex);
  const r1 = hash(id.mul(1.91).add(3.3));
  const r2 = hash(id.mul(3.17).add(1.9));
  const r3 = hash(id.mul(0.57).add(7.7));
  const r4 = hash(id.mul(5.3).add(4.4));
  const H = float(MOTE_HEIGHT);
  const R2 = float(MOTE_RADIUS * 2);
  const t = time.mul(mix(0.05, 0.16, r4));
  const wob = vec3(
    sin(t.mul(6.0).add(r1.mul(40.0))),
    sin(t.mul(4.3).add(r2.mul(40.0))).mul(0.5),
    cos(t.mul(5.1).add(r3.mul(40.0))),
  ).mul(0.35);
  const rise = mix(0.05, 0.2, r4);
  const yy = mod(r2.mul(H).add(time.mul(rise)), H);
  const base = vec2(r1, r3).mul(R2).add(windNode.mul(time.mul(0.12)));
  const rel = mod(base.sub(focusNode.xz).add(float(MOTE_RADIUS)), R2).sub(MOTE_RADIUS);
  const centre = vec3(
    focusNode.x.add(rel.x),
    focusNode.y.add(yy).add(0.2),
    focusNode.z.add(rel.y),
  ).add(wob);
  const toCam = normalize(cameraPosition.sub(centre));
  const right = normalize(cross(vec3(0, 1, 0), toCam));
  const up = cross(toCam, right);
  const size = mix(0.022, 0.05, r4);
  const p = positionGeometry;
  mat.positionNode = centre.add(right.mul(p.x.mul(size))).add(up.mul(p.y.mul(size)));
  const d = uv().sub(0.5).length();
  const tw = sin(time.mul(mix(0.6, 2.2, r1)).add(r3.mul(30.0))).mul(0.5).add(0.5);
  const fadeY = smoothstep(0.0, 0.6, yy).mul(smoothstep(H, H.sub(0.6), yy));
  const disc = smoothstep(0.5, 0.1, d);
  // W.glow lets the mood breathe — a torchlit sconce pulse brightens motes near it.
  const gain = float(1.0).add(weather.glow.mul(0.15));
  const a = disc.mul(tw).mul(fadeY).mul(intensity).mul(gain);
  mat.colorNode = vec4(color(tint).mul(2.0).mul(a), 1.0);

  const mesh = new InstancedMesh(new PlaneGeometry(1, 1), mat, count);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.name = 'motes';
  mesh.renderOrder = 21;
  return { mesh, material: mat };
}

/** Build the torch/lava ember emitter. Small warm discs rising from the floor. */
function buildEmbers(
  focusNode: UniformNode<'vec3', Vector3>,
  intensity: UniformNode<'float', number>,
  tint: UniformNode<'color', Color>,
  weather: Weather,
  count: number,
): BuiltEmitter {
  const mat = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    fog: false,
    blending: AdditiveBlending,
  });
  const id = float(instanceIndex);
  const r1 = hash(id.mul(2.11).add(0.6));
  const r2 = hash(id.mul(1.53).add(4.2));
  const r3 = hash(id.mul(0.91).add(6.1));
  const r4 = hash(id.mul(3.71).add(1.8));
  const H = float(EMBER_HEIGHT);
  const R2 = float(EMBER_RADIUS * 2);
  const rise = mix(0.9, 1.6, r4);
  const yy = mod(r2.mul(H).add(time.mul(rise)), H);
  const wob = vec3(
    sin(time.mul(4.1).add(r1.mul(40.0))),
    float(0.0),
    cos(time.mul(3.7).add(r3.mul(40.0))),
  ).mul(0.15);
  const base = vec2(r1, r3).mul(R2);
  const rel = mod(base.sub(focusNode.xz).add(float(EMBER_RADIUS)), R2).sub(EMBER_RADIUS);
  const centre = vec3(
    focusNode.x.add(rel.x),
    focusNode.y.add(yy).add(0.1),
    focusNode.z.add(rel.y),
  ).add(wob);
  const toCam = normalize(cameraPosition.sub(centre));
  const right = normalize(cross(vec3(0, 1, 0), toCam));
  const up = cross(toCam, right);
  const size = mix(0.02, 0.045, r4);
  const p = positionGeometry;
  mat.positionNode = centre.add(right.mul(p.x.mul(size))).add(up.mul(p.y.mul(size)));
  const d = uv().sub(0.5).length();
  const flicker = sin(time.mul(mix(3.0, 7.0, r1)).add(r3.mul(50.0))).mul(0.35).add(0.65);
  const fadeY = smoothstep(0.0, 0.15, yy).mul(smoothstep(H, H.sub(0.6), yy));
  const disc = smoothstep(0.5, 0.0, d);
  const glowBoost = float(1.0).add(weather.glow.mul(0.25));
  const a = disc.mul(disc).mul(flicker).mul(fadeY).mul(intensity).mul(glowBoost).mul(mix(0.8, 1.2, r2));
  mat.colorNode = vec4(color(tint).mul(3.0).mul(a), 1.0);

  const mesh = new InstancedMesh(new PlaneGeometry(1, 1), mat, count);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.name = 'embers';
  mesh.renderOrder = 22;
  return { mesh, material: mat };
}
