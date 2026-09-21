/**
 * Behaviour tests for the pure parts of the dungeon mood table and the
 * shared voxel-fx byte packing. Node-only: no TSL graph is evaluated when
 * these imports resolve (see docs/gpu-materials.md).
 */
import { describe, expect, it } from 'vitest';
import {
  FLAG_DRY,
  FLAG_GROUND,
  FLAG_STONE,
  FX_FLICKER,
  FX_PULSE,
  FX_TWINKLE,
  MOODS,
  blendMoods,
  fxByte,
  type Mood,
  type MoodId,
} from '../web/src/gpu/moods.js';

const A: Mood = {
  key: { color: 0x000000, intensity: 0 },
  fill: { sky: 0x000000, ground: 0x000000, intensity: 0 },
  fog: { color: 0x000000, density: 0 },
  weather: { wetness: 0, puddles: 0, wind: 0 },
  look: { exposure: 1.0, vignette: 0.2, grain: 0.02 },
  glow: 0, lampGain: 0,
};
const B: Mood = {
  key: { color: 0xff8000, intensity: 4 },
  fill: { sky: 0xffffff, ground: 0x808080, intensity: 1 },
  fog: { color: 0x102040, density: 0.4 },
  weather: { wetness: 1, puddles: 1, wind: 2 },
  look: { exposure: 2.0, vignette: 1.0, grain: 0.10 },
  glow: 4, lampGain: 3,
};

describe('gpu/moods — pure parts', () => {
  it('blendMoods interpolates numbers and per-channel colours and clamps t to 0..1', () => {
    // clamp: values outside [0,1] behave like the closest endpoint
    expect(blendMoods(A, B, -0.5)).toEqual(blendMoods(A, B, 0));
    expect(blendMoods(A, B, 1.5)).toEqual(blendMoods(A, B, 1));

    // t=0 returns A's numbers/colours exactly, t=1 returns B's
    const at0 = blendMoods(A, B, 0);
    const at1 = blendMoods(A, B, 1);
    expect(at0.key.color).toBe(A.key.color);
    expect(at0.key.intensity).toBe(A.key.intensity);
    expect(at1.fog.color).toBe(B.fog.color);
    expect(at1.fog.density).toBeCloseTo(B.fog.density, 10);

    // numeric interpolation at midpoint (weather.wind: 0 → 2 → 1)
    const mid = blendMoods(A, B, 0.5);
    expect(mid.weather.wind).toBeCloseTo(1, 10);
    expect(mid.glow).toBeCloseTo(2, 10);
    expect(mid.look.exposure!).toBeCloseTo(1.5, 10);

    // per-channel hex interp: 0x000000 → 0xff8000 at 0.5 = R:128 G:64 B:0
    expect(mid.key.color).toBe(0x804000);
    // and 0x000000 → 0xffffff at 0.5 = 0x808080 (each channel Math.round(127.5) = 128)
    expect(mid.fill.sky).toBe(0x808080);
  });

  it('every mood in the table carries the full record and stays in range', () => {
    const ids: MoodId[] = ['torchlit', 'deep_dark', 'flooded', 'lava', 'ice'];
    expect(Object.keys(MOODS).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      const m = MOODS[id];
      // structural completeness
      expect(m).toMatchObject({
        key: { color: expect.any(Number), intensity: expect.any(Number) },
        fill: { sky: expect.any(Number), ground: expect.any(Number), intensity: expect.any(Number) },
        fog: { color: expect.any(Number), density: expect.any(Number) },
        weather: { wetness: expect.any(Number), puddles: expect.any(Number), wind: expect.any(Number) },
        glow: expect.any(Number),
        lampGain: expect.any(Number),
      });
      // hex colours in [0, 0xffffff]
      for (const c of [m.key.color, m.fill.sky, m.fill.ground, m.fog.color]) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(0xffffff);
      }
      // physical intensities are non-negative
      for (const v of [m.key.intensity, m.fill.intensity, m.glow, m.lampGain]) expect(v).toBeGreaterThanOrEqual(0);
      // 0..1 fields
      for (const v of [m.weather.wetness, m.weather.puddles, m.fog.density]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      // wind stays reasonable (not required 0..1 but bounded)
      expect(m.weather.wind).toBeGreaterThanOrEqual(0);
      expect(m.weather.wind).toBeLessThanOrEqual(4);
      // look overrides must be present and finite for the fields moods drive
      for (const k of ['exposure', 'contrast', 'saturation', 'tintAmount', 'vignette', 'grain', 'bloomStrength', 'ssrIntensity', 'giIntensity'] as const) {
        expect(m.look[k]).toBeDefined();
        expect(Number.isFinite(m.look[k]!)).toBe(true);
      }
      // grade fields have narrow ranges (vignette/grain are 0..1)
      expect(m.look.vignette!).toBeGreaterThanOrEqual(0);
      expect(m.look.vignette!).toBeLessThanOrEqual(1);
      expect(m.look.grain!).toBeGreaterThanOrEqual(0);
      expect(m.look.grain!).toBeLessThanOrEqual(1);
    }
  });

  it('blending deep_dark to torchlit at t = 1 equals torchlit exactly', () => {
    const result = blendMoods(MOODS.deep_dark, MOODS.torchlit, 1);
    expect(result).toEqual(MOODS.torchlit);
  });

  it('fxByte packs the fx code with the stone, ground and dry flags', () => {
    // no flags, zero fx
    expect(fxByte(0)).toBe(0);
    // pure fx code, no flags
    expect(fxByte(FX_FLICKER)).toBe(FX_FLICKER);
    // each flag adds its expected bit
    expect(fxByte(0, { stone: true })).toBe(FLAG_STONE);
    expect(fxByte(0, { ground: true })).toBe(FLAG_GROUND);
    expect(fxByte(0, { dry: true })).toBe(FLAG_DRY);
    // fx + all flags composes bitwise
    expect(fxByte(FX_FLICKER, { stone: true, ground: true, dry: true })).toBe(FX_FLICKER | FLAG_STONE | FLAG_GROUND | FLAG_DRY);
    expect(fxByte(FX_PULSE, { stone: true })).toBe(FX_PULSE | FLAG_STONE);
    expect(fxByte(FX_TWINKLE, { ground: true, dry: true })).toBe(FX_TWINKLE | FLAG_GROUND | FLAG_DRY);
    // fx is masked to the low 5 bits (32..255 bits belong to flags)
    expect(fxByte(0xff)).toBe(31);
  });
});
