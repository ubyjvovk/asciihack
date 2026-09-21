// Shared node materials for everything made of voxels.
// One material for the static world + one for dynamic models keeps draw state tiny and lets weather touch everything.
import * as THREE from 'three/webgpu';
import {
  attribute, uniform, float, vec3, vec4, mix, smoothstep, step, clamp, max, pow, sin, cos, round, floor,
  positionWorld, positionLocal, positionGeometry, modelWorldMatrix, normalWorld, time, mx_noise_float, sRGBTransferEOTF, varying,
} from 'three/tsl';
import { EMISSIVE_RANGE } from '../voxel/mesh.js';

/** Global weather / mood uniforms, driven by render/moods.js. Shared by all voxel materials. */
export const W = {
  wetness: uniform(0.0), // 0 dry … 1 soaked: darker albedo, lower roughness everywhere outdoors
  puddles: uniform(0.0), // 0 none … 1 lots of standing water on ground
  rain: uniform(0.0), // 0..1 rainfall intensity (ripples)
  glow: uniform(1.0), // multiplier for fx=pulse/twinkle "living" emitters (glow flora opens at night)
  lampGain: uniform(1.0), // multiplier for all emissive (exposure compensation per mood)
  wind: uniform(1.0),
  hollowAO: uniform(0.16), // how much sky light reaches the floor of the Crystal Hollow
};

export const FX_FLICKER = 1, FX_PULSE = 2, FX_SWAY = 3, FX_TWINKLE = 4;
export const FLAG_DRY = 128, FLAG_GROUND = 64, FLAG_STONE = 32;

/**
 * @param {object} [o]
 * @param {boolean} [o.weather=true] react to wetness/puddles (turn off for UI/portrait renders)
 * @param {boolean} [o.sway=true] vertex sway for fx=sway boxes
 */
export function createVoxelMaterial({ weather = true, sway = true } = {}) {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'voxel';

  const aColor = attribute('aColor', 'vec4');
  const aMat = attribute('aMat', 'vec4');

  // decode per-box data (constant across a face, so interpolation is harmless; round() kills fp drift)
  const flags = varying(round(aMat.a.mul(255.0)), 'vFlags');
  const dry = step(127.5, flags);
  const rest = flags.sub(dry.mul(128.0));
  const ground = step(63.5, rest);
  const surface = rest.sub(ground.mul(64.0));
  const stone = step(31.5, surface);
  const fx = surface.sub(stone.mul(32.0));
  const is = (code) => float(1.0).sub(clamp(fx.sub(code).abs(), 0.0, 1.0));
  const rnd = aColor.a;

  const albedo = sRGBTransferEOTF(aColor.rgb);
  const rough0 = aMat.r;
  const metal0 = aMat.g;
  const emis0 = aMat.b.mul(EMISSIVE_RANGE);

  // --- wetness & puddles ---
  let color = albedo, rough = rough0, puddleMask = float(0.0);
  if (weather) {
    const up = smoothstep(0.75, 0.98, normalWorld.y);
    const wet = W.wetness.mul(dry.oneMinus());
    // porous (rough, non-metal) things darken when wet; everything gets shinier
    const porous = rough0.mul(metal0.oneMinus());
    color = albedo.mul(mix(float(1.0), float(0.58), wet.mul(porous)));
    rough = mix(rough0, rough0.mul(0.42), wet.mul(mix(0.55, 1.0, up)));
    // A thin water film on stone catches existing sky/lantern reflections, including on Low.
    // Reuse the per-voxel seed for subtle variation: no extra textures, noise, lights or render passes.
    const filmRoughness = mix(0.28, 0.18, up).add(rnd.mul(0.05));
    rough = mix(rough, filmRoughness, wet.mul(stone));
    // standing water: low-frequency noise picks the hollows; only on ground tops
    // sampled at the voxel cell centre → puddles have blocky, stepped shores like everything else in this world
    const p = floor(positionWorld.xz.mul(2.0)).add(0.5).mul(0.5);
    const n = mx_noise_float(p.mul(0.17)).mul(0.6).add(mx_noise_float(p.mul(0.53).add(19.0)).mul(0.4)); // ~[-1,1]
    const level = mix(float(0.8), float(0.12), W.puddles); // threshold drops as puddles grow
    const damp = smoothstep(level.sub(0.22), level, n).mul(up).mul(ground).mul(step(0.001, W.puddles));
    const puddle = step(level, n).mul(up).mul(ground).mul(step(0.001, W.puddles));
    color = color.mul(mix(float(1.0), float(0.72), damp)); // dark wet margin around the water
    color = mix(color, vec3(0.2, 0.235, 0.245), puddle);
    rough = mix(rough, float(0.07), puddle);
    puddleMask = puddle;
  }

  // --- emissive fx ---
  const t = time;
  const flick = mx_noise_float(vec3(t.mul(7.0), rnd.mul(91.0), 0.0)).mul(0.5).add(0.5);
  const flickB = mix(float(0.45), float(1.15), flick);
  const pulse = sin(t.mul(1.4).add(rnd.mul(6.283))).mul(0.18).add(0.82);
  const twinkle = pow(max(sin(t.mul(0.8).add(rnd.mul(40.0))), 0.0), 6.0).mul(1.2).add(0.55);
  let gain = float(1.0);
  gain = mix(gain, flickB, is(FX_FLICKER));
  gain = mix(gain, pulse.mul(W.glow), is(FX_PULSE));
  gain = mix(gain, twinkle.mul(W.glow), is(FX_TWINKLE));

  // the Crystal Hollow is open to the sky (the camera must see in) but should feel like a cave:
  // sky/ambient light is strangled below the rim, so crystals and Pip's lantern do the lighting
  if (weather) {
    const pw = positionWorld;
    const inX = smoothstep(50.0, 54.0, pw.x).mul(smoothstep(80.0, 77.0, pw.x)), inZ = smoothstep(-14.0, -10.0, pw.z).mul(smoothstep(25.0, 21.0, pw.z));
    const deep = smoothstep(2.4, 0.0, pw.y);
    m.aoNode = mix(float(1.0), W.hollowAO, inX.mul(inZ).mul(deep));
  }

  m.colorNode = vec4(color, 1.0);
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

/** Byte for aMat.a given fx code and flags — used by terrain mesher and kit. */
export function fxByte(fx = 0, { dry = false, ground = false, stone = false } = {}) {
  return (fx & 31) | (stone ? FLAG_STONE : 0) | (ground ? FLAG_GROUND : 0) | (dry ? FLAG_DRY : 0);
}
