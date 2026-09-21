/**
 * The one node material every voxel in the scene uses — ported from
 * vendor/afterburn/src/render/materials.js. Browser-only: constructs a
 * `MeshStandardNodeMaterial` and evaluates TSL nodes at import (the shared
 * `W` uniform block is created at module top, matching afterburn).
 *
 * Differences from afterburn:
 * - The Crystal Hollow `aoNode` special case is dropped (that is a place in
 *   afterburn's world, not ours) along with the `hollowAO` uniform.
 * - The pure helpers `fxByte`, `FLAG_*` and `FX_*` live in `./moods.ts` so
 *   the mood tests can import them without pulling in three/webgpu.
 * - Adds the T-0058 hero cutout: a per-fragment `discard` driven by the
 *   `CUTOUT` uniform block that the render loop writes each frame in the
 *   third-person and ortho views (fps disables it — the camera *is* the
 *   hero there). Rule and constants live in `./cutout.ts`; see
 *   `docs/gpu-cutout.md`. Kept opaque on purpose: alpha blending would pull
 *   these surfaces out of the opaque pass and corrupt the G-buffer that
 *   SSGI and SSR read from, so this uses `discard` + screen-door dither.
 *   Pass `cutout: false` to build the avatar variant, which shares this
 *   material family but skips the discard so the hero and pet are never
 *   cut along with the walls (`docs/gpu-cutout.md` §"What is exempt").
 *
 * Wetness/puddles darkening + roughness, the stone water film, the blocky
 * puddle noise, the emissive fx (`flicker`/`pulse`/`twinkle`), `lampGain`,
 * `glow` and the vertex `sway` option are all kept.
 */

import { MeshStandardNodeMaterial, Vector3 } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  attribute, clamp, cos, float, floor, interleavedGradientNoise, length, max, mix,
  modelWorldMatrix, mx_noise_float, normalWorld, positionGeometry, positionWorld, pow, round,
  screenCoordinate, sRGBTransferEOTF, sin, smoothstep, step, time, uniform, varying, vec2, vec3, vec4,
} from 'three/tsl';
import { EMISSIVE_RANGE } from '../voxel/mesh.js';
import { CUTOUT_FADE_CELLS, CUTOUT_FLOOR_EPSILON, CUTOUT_RADIUS_CELLS } from './cutout.js';
import { FX_FLICKER, FX_PULSE, FX_SWAY, FX_TWINKLE } from './moods.js';

/** Shared weather / mood uniforms, written by `Atmosphere` in `./moods.ts`. Every voxel material samples these. */
export const W = {
  /** 0 dry … 1 soaked; darker albedo, lower roughness on up-facing surfaces. */
  wetness: uniform(0.0),
  /** 0 none … 1 lots of standing water on ground tops. */
  puddles: uniform(0.0),
  /** Kept from afterburn for weather-overlay wiring; unused by this material directly. */
  rain: uniform(0.0),
  /** Multiplier for fx=pulse/twinkle "living" emitters. */
  glow: uniform(1.0),
  /** Multiplier for all emissive (exposure compensation per mood). */
  lampGain: uniform(1.0),
  /** Sway strength for fx=sway boxes. */
  wind: uniform(1.0),
};

/** Structural type describing the shared uniform block above. */
export type Weather = typeof W;

/**
 * Inner keep-radius (cells) — fragments closer than this to `CUTOUT.center`
 * are never cut, so the hero voxel avatar (which shares this material and
 * sits at the cutout centre) stays intact. Half the hero's sprite height
 * comfortably covers its own horizontal extent (~0.15 cells), and it is
 * strictly less than the minimum wall-cell distance from the hero cell
 * centre (0.5 cells), so adjacent walls are still cut at full strength.
 * See `docs/gpu-cutout.md` §"Why an inner keep-radius" for the arithmetic.
 */
const CUTOUT_INNER_KEEP_CELLS = 0.35;

/**
 * Shared hero-cutout uniforms — the "Diablo cutout" (T-0058, `docs/gpu-cutout.md`).
 * Every voxel material samples these; the render loop writes them each frame
 * in `web/src/gl/gl-viewport.ts::GpuPath.render` (enabled in `third`/`ortho`,
 * disabled in `fps`). The rule pinned in `./cutout.ts` at cell resolution is
 * evaluated per fragment here with a screen-door dither for a soft edge.
 */
export const CUTOUT = {
  /** 1 = the discard rule fires; 0 = disabled (fps). Keeps the material opaque
   *  in every view — this is a hard switch, not a shader recompile. */
  enabled: uniform(0.0),
  /** Hero's world position (cell coordinates; y-component is unused for the
   *  horizontal-disk rule). Written from `pose` every frame. */
  center: uniform(new Vector3(0, 0, 0)),
  /** Horizontal unit vector pointing from the hero toward the camera —
   *  `cutoutForwardFor(cameraPos, heroPos)` in `./cutout.ts`. `y` is always
   *  zero so the cutout is indifferent to camera pitch. */
  forward: uniform(new Vector3(0, 0, 0)),
  /** Cutout radius in cells (default `CUTOUT_RADIUS_CELLS = 2.5`). */
  radius: uniform(CUTOUT_RADIUS_CELLS),
  /** Screen-door dither band width in cells past `radius` (default
   *  `CUTOUT_FADE_CELLS = 0.8`). Zero would give a hard circular edge. */
  fade: uniform(CUTOUT_FADE_CELLS),
};

/** Structural type for the shared cutout uniform block above. */
export type Cutout = typeof CUTOUT;

/** Options for `createVoxelMaterial`. */
export interface VoxelMaterialOptions {
  /** React to wetness/puddles (off for UI / portrait renders). */
  weather?: boolean;
  /** Enable vertex sway for `FX_SWAY` boxes. */
  sway?: boolean;
  /**
   * Include the T-0058 hero-cutout `discard` branch (default `true` — the
   * dungeon material). Set to `false` for the hero/pet avatar material: the
   * avatars share this material and sit at `CUTOUT.center`, so the same
   * per-fragment rule that clears the wall in front of the hero would also
   * discard the hero itself. See `docs/gpu-cutout.md` §"What is exempt".
   */
  cutout?: boolean;
}

/**
 * The one node material every voxel mesh uses. Reads per-vertex `aColor`
 * (rgb + per-box rnd) and `aMat` (roughness, metalness, emissive,
 * fx|flags) and the shared `W` block.
 */
export function createVoxelMaterial({ weather = true, sway = true, cutout = true }: VoxelMaterialOptions = {}): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.name = cutout ? 'voxel' : 'voxel-nocut';

  const aColor = attribute<'vec4'>('aColor', 'vec4');
  const aMat = attribute<'vec4'>('aMat', 'vec4');

  // Decode per-box data (constant across a face, so interpolation is harmless; round() kills fp drift).
  const flags = varying(round(aMat.a.mul(255.0)), 'vFlags');
  const dry = step(127.5, flags);
  const rest: Node<'float'> = flags.sub(dry.mul(128.0));
  const ground = step(63.5, rest);
  const surface: Node<'float'> = rest.sub(ground.mul(64.0));
  const stone = step(31.5, surface);
  const fx: Node<'float'> = surface.sub(stone.mul(32.0));
  const is = (code: number): Node<'float'> => float(1.0).sub(clamp(fx.sub(code).abs(), 0.0, 1.0));
  const rnd = aColor.a;

  const albedo = sRGBTransferEOTF(aColor.rgb) as Node<'vec3'>;
  const rough0 = aMat.r;
  const metal0 = aMat.g;
  const emis0: Node<'float'> = aMat.b.mul(EMISSIVE_RANGE);

  // --- wetness & puddles ---
  let colorNode: Node<'vec3'> = albedo;
  let rough: Node<'float'> = rough0;
  let puddleMask: Node<'float'> = float(0.0);
  if (weather) {
    const up = smoothstep(0.75, 0.98, normalWorld.y);
    const wet = W.wetness.mul(dry.oneMinus());
    // porous (rough, non-metal) things darken when wet; everything gets shinier
    const porous = rough0.mul(metal0.oneMinus());
    colorNode = albedo.mul(mix(float(1.0), float(0.58), wet.mul(porous)));
    rough = mix(rough0, rough0.mul(0.42), wet.mul(mix(0.55, 1.0, up)));
    // A thin water film on stone catches existing sky/lantern reflections, including on Low.
    // Reuse the per-voxel seed for subtle variation: no extra textures, noise, lights or render passes.
    const filmRoughness = mix(0.28, 0.18, up).add(rnd.mul(0.05));
    rough = mix(rough, filmRoughness, wet.mul(stone));
    // Standing water: low-frequency noise picks the hollows; only on ground tops. Sampled at the voxel
    // cell centre → puddles have blocky, stepped shores like everything else in this world.
    const p = floor(positionWorld.xz.mul(2.0)).add(0.5).mul(0.5);
    const n = mx_noise_float(p.mul(0.17)).mul(0.6).add(mx_noise_float(p.mul(0.53).add(19.0)).mul(0.4));
    const level = mix(float(0.8), float(0.12), W.puddles);
    const damp = smoothstep(level.sub(0.22), level, n).mul(up).mul(ground).mul(step(0.001, W.puddles));
    const puddle = step(level, n).mul(up).mul(ground).mul(step(0.001, W.puddles));
    colorNode = colorNode.mul(mix(float(1.0), float(0.72), damp));
    colorNode = mix(colorNode, vec3(0.2, 0.235, 0.245), puddle);
    rough = mix(rough, float(0.07), puddle);
    puddleMask = puddle;
  }

  // --- emissive fx ---
  const t = time;
  const flick: Node<'float'> = mx_noise_float(vec3(t.mul(7.0), rnd.mul(91.0), 0.0)).mul(0.5).add(0.5);
  const flickB: Node<'float'> = mix(float(0.45), float(1.15), flick);
  const pulse: Node<'float'> = sin(t.mul(1.4).add(rnd.mul(6.283))).mul(0.18).add(0.82);
  const twinkle: Node<'float'> = pow(max(sin(t.mul(0.8).add(rnd.mul(40.0))), 0.0), 6.0).mul(1.2).add(0.55);
  let gain: Node<'float'> = float(1.0);
  gain = mix(gain, flickB, is(FX_FLICKER));
  gain = mix(gain, pulse.mul(W.glow), is(FX_PULSE));
  gain = mix(gain, twinkle.mul(W.glow), is(FX_TWINKLE));

  m.colorNode = vec4(colorNode, 1.0);
  m.roughnessNode = rough;
  m.metalnessNode = mix(metal0, float(0.82), puddleMask); // still water mirrors the sky even from a steep camera
  m.emissiveNode = albedo.mul(emis0).mul(gain).mul(W.lampGain);

  // --- hero cutout (T-0058) ---
  // Per-fragment discard driven by the shared `CUTOUT` uniforms. Kept in the
  // opaque pass on purpose (see the module JSDoc): a screen-door dither +
  // `NodeMaterial.maskNode` gives us a soft-edged hole without pulling the
  // wall out of the G-buffer that SSGI/SSR read. Rule mirrors `isCutCell` in
  // `./cutout.ts` at cell resolution — same three conditions, plus an
  // inner keep-radius that protects the hero avatar (which sits at the
  // cutout centre and shares this material). Skipped for the avatar
  // material (`cutout: false`) — see `docs/gpu-cutout.md` §"What is exempt".
  if (cutout) {
    const rel = positionWorld.sub(CUTOUT.center);
    const dHoriz = length(vec2(rel.x, rel.z));
    const dotFwd = rel.x.mul(CUTOUT.forward.x).add(rel.z.mul(CUTOUT.forward.z));
    // Outer ramp: 1 inside `radius`, 0 at `radius + fade`, smoothstep between.
    const outerRamp = float(1.0).sub(smoothstep(CUTOUT.radius, CUTOUT.radius.add(CUTOUT.fade), dHoriz));
    // Inner keep-zone: no cut too close to the hero (protects the voxel
    // avatar's own fragments — see `CUTOUT_INNER_KEEP_CELLS`). Hard step so
    // adjacent walls at exactly 0.5 cells still receive the full cut.
    const innerKeep = step(float(CUTOUT_INNER_KEEP_CELLS), dHoriz);
    // Camera-side test — `dot > 0` because `cutoutForwardFor` returns the
    // hero → camera direction. The small epsilon keeps the boundary line
    // through the hero (dot = 0) from flickering.
    const cameraSide = step(float(0.0001), dotFwd);
    // Above the floor: never cut the ground plane out from under the hero.
    const aboveFloor = step(float(CUTOUT_FLOOR_EPSILON), positionWorld.y);
    // Combined discard strength ∈ [0, 1]. `enabled` is 0 (fps) or 1 (third/ortho).
    const cutStrength = CUTOUT.enabled.mul(cameraSide).mul(aboveFloor).mul(outerRamp).mul(innerKeep);
    // Screen-door dither: `interleavedGradientNoise(screenCoordinate.xy)` gives
    // a 0..1 per-pixel value; `keep = step(cutStrength, dither)` returns 1
    // (keep) when `dither >= cutStrength` — so a fraction `cutStrength` of
    // the pixels in the fade band are discarded, and the shape stays opaque.
    const dither = interleavedGradientNoise(screenCoordinate.xy);
    const keep = step(cutStrength, dither);
    // `MeshStandardNodeMaterial.maskNode` discards when the mask is false;
    // `NodeMaterial.setup()` wraps this in `bool(maskNode).not().discard()`,
    // so any non-zero value keeps the fragment and 0 discards it. Sole path
    // used here — `Discard()` outside an `Fn()` scope has no stack to push
    // onto, so it is not safe to call from module setup code.
    m.maskNode = keep;
  }

  if (sway) {
    const wp = modelWorldMatrix.mul(vec4(positionGeometry, 1.0)).xyz;
    const amp = is(FX_SWAY).mul(W.wind).mul(rnd.mul(0.5).add(0.5)).mul(0.035);
    const ph = t.mul(1.3).add(wp.x.mul(0.9)).add(wp.z.mul(0.7));
    m.positionNode = positionGeometry.add(vec3(sin(ph).mul(amp), sin(ph.mul(1.7)).mul(amp).mul(0.35), cos(ph.mul(0.8)).mul(amp)));
  }
  return m;
}
