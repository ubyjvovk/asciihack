/**
 * Behaviour tests for the pure parts of the dungeon mood table and the
 * shared voxel-fx byte packing. Node-only: no TSL graph is evaluated when
 * these imports resolve (see docs/gpu-materials.md).
 */
import { describe, expect, it } from 'vitest';
import { Color, DataUtils, EquirectangularReflectionMapping, HalfFloatType, RGBAFormat } from 'three/webgpu';
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
  moodEnvironment,
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
      for (const k of ['exposure', 'contrast', 'saturation', 'tintAmount', 'vignette', 'grain', 'bloomStrength', 'ssrIntensity', 'giIntensity', 'focus', 'focusRange', 'bokeh'] as const) {
        expect(m.look[k]).toBeDefined();
        expect(Number.isFinite(m.look[k]!)).toBe(true);
      }
      // focus distances must be indoor-scale: a dungeon is only ~10 cells deep.
      expect(m.look.focus!).toBeGreaterThan(0);
      expect(m.look.focus!).toBeLessThanOrEqual(10);
      expect(m.look.focusRange!).toBeGreaterThan(0);
      expect(m.look.focusRange!).toBeLessThanOrEqual(20);
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

  it('moodEnvironment builds a 32x16 equirect gradient between the mood\'s fill colours', () => {
    const mood = MOODS.torchlit;
    const tex = moodEnvironment(mood);
    // Format / mapping the stochastic SSR path requires (setEnvMap rejects PMREM cubemaps).
    expect(tex.isDataTexture).toBe(true);
    expect(tex.image.width).toBe(32);
    expect(tex.image.height).toBe(16);
    expect(tex.format).toBe(RGBAFormat);
    expect(tex.type).toBe(HalfFloatType);
    expect(tex.mapping).toBe(EquirectangularReflectionMapping);
    const data = tex.image.data as Uint16Array;
    expect(data.length).toBe(32 * 16 * 4);

    // Equirect V: row 0 = bottom pole (ground); row H-1 = top pole (sky).
    // Each channel = fill.{ground|sky}.* pre-multiplied by fill.intensity.
    const sky = new Color(mood.fill.sky);
    const ground = new Color(mood.fill.ground);
    const I = mood.fill.intensity;
    const decode = (y: number, x: number): [number, number, number, number] => {
      const i = (y * 32 + x) * 4;
      return [
        DataUtils.fromHalfFloat(data[i]!),
        DataUtils.fromHalfFloat(data[i + 1]!),
        DataUtils.fromHalfFloat(data[i + 2]!),
        DataUtils.fromHalfFloat(data[i + 3]!),
      ];
    };
    const [r0, g0, b0, a0] = decode(0, 0);
    expect(r0).toBeCloseTo(ground.r * I, 3);
    expect(g0).toBeCloseTo(ground.g * I, 3);
    expect(b0).toBeCloseTo(ground.b * I, 3);
    expect(a0).toBeCloseTo(1, 3);
    const [rT, gT, bT] = decode(15, 0);
    expect(rT).toBeCloseTo(sky.r * I, 3);
    expect(gT).toBeCloseTo(sky.g * I, 3);
    expect(bT).toBeCloseTo(sky.b * I, 3);
    // Midpoint row lands halfway between the two endpoints.
    const [rM, gM, bM] = decode(Math.round(15 / 2), 0);
    expect(rM).toBeCloseTo(((ground.r + sky.r) / 2) * I, 3);
    expect(gM).toBeCloseTo(((ground.g + sky.g) / 2) * I, 3);
    expect(bM).toBeCloseTo(((ground.b + sky.b) / 2) * I, 3);
    // No horizontal variation: every column of a row matches column 0.
    for (let y = 0; y < 16; y++) {
      const [ra, ga, ba, aa] = decode(y, 0);
      for (let x = 1; x < 32; x++) {
        const [rb, gb, bb, ab] = decode(y, x);
        expect(rb).toBe(ra);
        expect(gb).toBe(ga);
        expect(bb).toBe(ba);
        expect(ab).toBe(aa);
      }
    }
    tex.dispose();
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
