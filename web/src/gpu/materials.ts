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
 *
 * Wetness/puddles darkening + roughness, the stone water film, the blocky
 * puddle noise, the emissive fx (`flicker`/`pulse`/`twinkle`), `lampGain`,
 * `glow` and the vertex `sway` option are all kept.
 */

import { MeshStandardNodeMaterial } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  attribute, clamp, cos, float, floor, max, mix, modelWorldMatrix, mx_noise_float,
  normalWorld, positionGeometry, positionWorld, pow, round, sRGBTransferEOTF, sin,
  smoothstep, step, time, uniform, varying, vec3, vec4,
} from 'three/tsl';
import { EMISSIVE_RANGE } from '../voxel/mesh.js';
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

/** Options for `createVoxelMaterial`. */
export interface VoxelMaterialOptions {
  /** React to wetness/puddles (off for UI / portrait renders). */
  weather?: boolean;
  /** Enable vertex sway for `FX_SWAY` boxes. */
  sway?: boolean;
}

/**
 * The one node material every voxel mesh uses. Reads per-vertex `aColor`
 * (rgb + per-box rnd) and `aMat` (roughness, metalness, emissive,
 * fx|flags) and the shared `W` block.
 */
export function createVoxelMaterial({ weather = true, sway = true }: VoxelMaterialOptions = {}): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.name = 'voxel';

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

  if (sway) {
    const wp = modelWorldMatrix.mul(vec4(positionGeometry, 1.0)).xyz;
    const amp = is(FX_SWAY).mul(W.wind).mul(rnd.mul(0.5).add(0.5)).mul(0.035);
    const ph = t.mul(1.3).add(wp.x.mul(0.9)).add(wp.z.mul(0.7));
    m.positionNode = positionGeometry.add(vec3(sin(ph).mul(amp), sin(ph.mul(1.7)).mul(amp).mul(0.35), cos(ph.mul(0.8)).mul(amp)));
  }
  return m;
}
