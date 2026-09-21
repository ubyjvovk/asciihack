/**
 * Dungeon lighting moods and the Atmosphere rig that blends between them.
 * Ported from vendor/afterburn/src/render/moods.js with the outdoor bits
 * stripped: no sky dome, no stars, no sun disc, no PMREM environment — a
 * dungeon has none of those. See docs/gpu.md §5 and docs/gpu-materials.md.
 *
 * Import safety: the pure exports (`Mood`, `MoodId`, `MOODS`, `blendMoods`,
 * `fxByte`, `FLAG_*`, `FX_*`) sit at the top of this file and do not call any
 * TSL constructor. Importing this module in node loads `three/webgpu` and
 * `three/tsl` (needed at runtime for the `Atmosphere` class below), but the
 * TSL nodes themselves are only built inside the `Atmosphere` constructor.
 */

import { Color, DirectionalLight, HemisphereLight } from 'three/webgpu';
import type { Scene, UniformNode } from 'three/webgpu';
import { densityFogFactor, fog, uniform } from 'three/tsl';
import type { Weather } from './materials.js';

// ---------------------------------------------------------------------------
// Pure exports — safe to import in node; no TSL graph is built at load time.
// ---------------------------------------------------------------------------

/** fx codes, decoded in the shader from `aMat.a` (see materials.ts). */
export const FX_FLICKER = 1;
/** fx code: gentle sinusoidal pulse, per-voxel phase. */
export const FX_PULSE = 2;
/** fx code: vertex sway around the box centre (leaves, banners). */
export const FX_SWAY = 3;
/** fx code: brief bright twinkle, per-voxel phase. */
export const FX_TWINKLE = 4;

/** Flag bit: surface never receives wetness/puddles (interior faces, emitters). */
export const FLAG_DRY = 128;
/** Flag bit: face is up-facing floor eligible for puddles. */
export const FLAG_GROUND = 64;
/** Flag bit: surface is stone (gets the thin water-film roughness override). */
export const FLAG_STONE = 32;

/** Pack an fx code and per-surface flags into the byte written to `aMat.a`. */
export function fxByte(fx: number = 0, { dry = false, ground = false, stone = false }: { dry?: boolean; ground?: boolean; stone?: boolean } = {}): number {
  return (fx & 31) | (stone ? FLAG_STONE : 0) | (ground ? FLAG_GROUND : 0) | (dry ? FLAG_DRY : 0);
}

/**
 * Numeric look uniforms a mood can override. These are the fields moods
 * touch; `pipeline.ts` owns the real uniform holders and may expose more.
 */
export interface LookValues {
  exposure: number;
  contrast: number;
  saturation: number;
  tintAmount: number;
  vignette: number;
  grain: number;
  bloomStrength: number;
  ssrIntensity: number;
  giIntensity: number;
}

/** A dungeon lighting state. Every field is required except individual `look` entries. */
export interface Mood {
  key: { color: number; intensity: number };
  fill: { sky: number; ground: number; intensity: number };
  fog: { color: number; density: number };
  weather: { wetness: number; puddles: number; wind: number };
  look: Partial<LookValues>;
  glow: number;
  lampGain: number;
}

/** The five mood ids in the dungeon table. */
export type MoodId = 'torchlit' | 'deep_dark' | 'flooded' | 'lava' | 'ice';

/**
 * The five dungeon moods. Numbers are tunings within the ticket's stated
 * intent; the PM eyeballs the frame and may send a follow-up tuning ticket.
 */
export const MOODS: Readonly<Record<MoodId, Mood>> = {
  torchlit: {
    key:     { color: 0xffb060, intensity: 1.4 },
    fill:    { sky: 0x263140, ground: 0x080a0d, intensity: 0.05 },
    fog:     { color: 0x0b0d10, density: 0.10 },
    weather: { wetness: 0.5, puddles: 0.25, wind: 0.0 },
    look:    { exposure: 1.0, contrast: 1.08, saturation: 1.0, tintAmount: 0.18, vignette: 0.42, grain: 0.03, bloomStrength: 0.22, ssrIntensity: 0.6, giIntensity: 8.0 },
    glow: 1.0, lampGain: 1.0,
  },
  deep_dark: {
    key:     { color: 0xffb060, intensity: 0.0 },
    fill:    { sky: 0x000000, ground: 0x000000, intensity: 0.0 },
    fog:     { color: 0x05070a, density: 0.20 },
    weather: { wetness: 0.4, puddles: 0.10, wind: 0.0 },
    look:    { exposure: 1.0, contrast: 1.10, saturation: 0.75, tintAmount: 0.10, vignette: 0.75, grain: 0.03, bloomStrength: 0.20, ssrIntensity: 0.5, giIntensity: 6.0 },
    glow: 1.0, lampGain: 1.2,
  },
  flooded: {
    key:     { color: 0xffb060, intensity: 1.8 },
    fill:    { sky: 0x2b4a52, ground: 0x0f181c, intensity: 0.08 },
    fog:     { color: 0x0c1416, density: 0.14 },
    weather: { wetness: 1.0, puddles: 1.0, wind: 0.2 },
    look:    { exposure: 1.0, contrast: 1.06, saturation: 0.95, tintAmount: 0.22, vignette: 0.45, grain: 0.028, bloomStrength: 0.28, ssrIntensity: 1.4, giIntensity: 8.0 },
    glow: 1.0, lampGain: 1.0,
  },
  lava: {
    key:     { color: 0xff6a2a, intensity: 3.2 },
    fill:    { sky: 0x2a1410, ground: 0x1a0806, intensity: 0.10 },
    fog:     { color: 0x1a0a06, density: 0.11 },
    weather: { wetness: 0.0, puddles: 0.0, wind: 0.4 },
    look:    { exposure: 1.05, contrast: 1.08, saturation: 1.20, tintAmount: 0.22, vignette: 0.42, grain: 0.028, bloomStrength: 0.55, ssrIntensity: 0.2, giIntensity: 10.0 },
    glow: 1.4, lampGain: 1.8,
  },
  ice: {
    key:     { color: 0xbfe4ff, intensity: 1.2 },
    fill:    { sky: 0x9fc8ea, ground: 0x2a3a48, intensity: 0.10 },
    fog:     { color: 0x8ca8bc, density: 0.09 },
    weather: { wetness: 0.3, puddles: 0.10, wind: 0.2 },
    look:    { exposure: 1.05, contrast: 1.02, saturation: 0.92, tintAmount: 0.08, vignette: 0.30, grain: 0.010, bloomStrength: 0.24, ssrIntensity: 0.4, giIntensity: 9.0 },
    glow: 1.0, lampGain: 1.6,
  },
};

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function blendHex(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(lerp(ar, br, t)) & 0xff;
  const g = Math.round(lerp(ag, bg, t)) & 0xff;
  const bl = Math.round(lerp(ab, bb, t)) & 0xff;
  return (r << 16) | (g << 8) | bl;
}

function blendLook(a: Partial<LookValues>, b: Partial<LookValues>, t: number): Partial<LookValues> {
  const out: Partial<LookValues> = {};
  const keys = new Set<keyof LookValues>([
    ...(Object.keys(a) as (keyof LookValues)[]),
    ...(Object.keys(b) as (keyof LookValues)[]),
  ]);
  for (const k of keys) {
    const va = a[k];
    const vb = b[k];
    if (va === undefined) out[k] = vb;
    else if (vb === undefined) out[k] = va;
    else out[k] = lerp(va, vb, t);
  }
  return out;
}

/**
 * Pure linear blend of two `Mood` records. `t` is clamped to `[0, 1]`; hex
 * colours are blended per RGB channel. Never touches TSL; testable in node.
 */
export function blendMoods(a: Mood, b: Mood, t: number): Mood {
  const u = Math.min(1, Math.max(0, t));
  return {
    key: {
      color: blendHex(a.key.color, b.key.color, u),
      intensity: lerp(a.key.intensity, b.key.intensity, u),
    },
    fill: {
      sky: blendHex(a.fill.sky, b.fill.sky, u),
      ground: blendHex(a.fill.ground, b.fill.ground, u),
      intensity: lerp(a.fill.intensity, b.fill.intensity, u),
    },
    fog: {
      color: blendHex(a.fog.color, b.fog.color, u),
      density: lerp(a.fog.density, b.fog.density, u),
    },
    weather: {
      wetness: lerp(a.weather.wetness, b.weather.wetness, u),
      puddles: lerp(a.weather.puddles, b.weather.puddles, u),
      wind: lerp(a.weather.wind, b.weather.wind, u),
    },
    look: blendLook(a.look, b.look, u),
    glow: lerp(a.glow, b.glow, u),
    lampGain: lerp(a.lampGain, b.lampGain, u),
  };
}

// ---------------------------------------------------------------------------
// Atmosphere — impure rig. TSL nodes are built inside the constructor so that
// merely importing this module does not evaluate any TSL graph.
// ---------------------------------------------------------------------------

/** Structural uniform holder — anything with a mutable `.value` of the right type. */
export interface Uniform<T> {
  value: T;
}

/**
 * Look uniform bag: any subset of `LookValues` present is written to. The
 * concrete `.value` slots are the pipeline's TSL uniforms (T-0037); we take
 * the object structurally to avoid depending on `web/src/gpu/pipeline.ts`.
 */
export type Look = { [K in keyof LookValues]?: Uniform<number> };

/** Constructor arguments for the Atmosphere rig. */
export interface AtmosphereOptions {
  scene: Scene;
  look: Look;
  weather: Weather;
  shadowSize?: number;
  shadowRange?: number;
}

/**
 * Drives the dungeon lighting for a scene: builds a key `DirectionalLight`
 * plus a `HemisphereLight` fill, wires the fog node, and blends between two
 * `Mood` records over N seconds, writing the current values into the light
 * objects, the fog uniforms, the `weather` uniforms and the caller's `look`
 * uniforms every `update()`.
 */
export class Atmosphere {
  private readonly scene: Scene;
  private readonly look: Look;
  private readonly weather: Weather;
  readonly keyLight: DirectionalLight;
  readonly fill: HemisphereLight;
  private readonly fogColor: UniformNode<'color', Color>;
  private readonly fogDensity: UniformNode<'float', number>;
  private cur: Mood;
  private from: Mood | null;
  private to: Mood | null;
  private t: number;
  private dur: number;
  name: MoodId;

  constructor({ scene, look, weather, shadowSize = 2048, shadowRange = 24 }: AtmosphereOptions) {
    this.scene = scene;
    this.look = look;
    this.weather = weather;

    this.keyLight = new DirectionalLight(0xffffff, 1);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(shadowSize, shadowSize);
    const R = shadowRange;
    Object.assign(this.keyLight.shadow.camera, { left: -R, right: R, top: R, bottom: -R, near: 0.1, far: R * 6 });
    this.keyLight.shadow.bias = -0.0005;
    this.keyLight.shadow.normalBias = 0.035;
    this.keyLight.shadow.radius = 2.5;
    this.keyLight.position.set(0, R, 0);
    this.keyLight.target.position.set(0, 0, 0);
    scene.add(this.keyLight, this.keyLight.target);

    this.fill = new HemisphereLight(0xffffff, 0x000000, 0);
    scene.add(this.fill);

    this.fogColor = uniform(new Color(0x000000));
    this.fogDensity = uniform(0.0);
    scene.fogNode = fog(this.fogColor, densityFogFactor(this.fogDensity));

    this.name = 'torchlit';
    this.cur = blendMoods(MOODS.torchlit, MOODS.torchlit, 0);
    this.from = null;
    this.to = null;
    this.t = 1;
    this.dur = 0;
    this._apply();
  }

  /** Snap to `id` immediately, no blend. */
  set(id: MoodId): void {
    const target = MOODS[id];
    if (!target) throw new Error('Unknown mood: ' + id);
    this.name = id;
    this.cur = blendMoods(target, target, 0);
    this.from = null;
    this.to = null;
    this.t = 1;
    this._apply();
  }

  /** Blend to `id` over `seconds` real-time; `seconds <= 0` snaps. */
  blendTo(id: MoodId, seconds: number): void {
    const target = MOODS[id];
    if (!target) throw new Error('Unknown mood: ' + id);
    if (seconds <= 0) { this.set(id); return; }
    this.name = id;
    this.from = blendMoods(this.cur, this.cur, 0);
    this.to = blendMoods(target, target, 0);
    this.t = 0;
    this.dur = seconds;
  }

  /** Advance the blend by `dtSeconds` and write current values everywhere. */
  update(dtSeconds: number): void {
    if (this.to !== null && this.from !== null) {
      this.t = Math.min(1, this.t + dtSeconds / this.dur);
      const e = this.t * this.t * (3 - 2 * this.t);
      this.cur = blendMoods(this.from, this.to, e);
      if (this.t >= 1) { this.from = null; this.to = null; }
    }
    this._apply();
  }

  private _apply(): void {
    const s = this.cur;
    this.keyLight.color.setHex(s.key.color);
    this.keyLight.intensity = s.key.intensity;
    this.fill.color.setHex(s.fill.sky);
    this.fill.groundColor.setHex(s.fill.ground);
    this.fill.intensity = s.fill.intensity;
    this.fogColor.value.setHex(s.fog.color);
    this.fogDensity.value = s.fog.density;
    this.weather.wetness.value = s.weather.wetness;
    this.weather.puddles.value = s.weather.puddles;
    this.weather.wind.value = s.weather.wind;
    this.weather.glow.value = s.glow;
    this.weather.lampGain.value = s.lampGain;
    for (const k of Object.keys(s.look) as (keyof LookValues)[]) {
      const holder = this.look[k];
      const v = s.look[k];
      if (holder !== undefined && v !== undefined) holder.value = v;
    }
  }

  /** The current (interpolated) mood record. Fresh object each call. */
  get state(): Mood { return blendMoods(this.cur, this.cur, 0); }
}
