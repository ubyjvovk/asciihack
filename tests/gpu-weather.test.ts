/**
 * Behaviour tests for the GPU dungeon-air overlay (T-0044, docs/gpu-weather.md).
 * The overlay owns one InstancedMesh per emitter (drips / motes / embers)
 * with a TSL `positionNode` derived from `instanceIndex` + `time`, so every
 * shape claim here is exercised through the pure `emitterTargets` /
 * `wrapAround` mapping plus the CPU-side `update()` — the shader graph itself
 * cannot be run without a renderer (docs/gpu.md §9).
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three/webgpu';
import { W } from '../web/src/gpu/materials.js';
import {
  DRIP_COUNT,
  DRIP_RADIUS,
  EMBER_COUNT,
  EMBER_RADIUS,
  MOTE_COUNT,
  MOTE_RADIUS,
  createWeather,
  emitterTargets,
  wrapAround,
} from '../web/src/gpu/weather.js';

describe('gpu weather — dungeon air overlay', () => {
  it('the mood id and W uniforms choose which emitters are active and how strong', () => {
    // Rule 1: pure `emitterTargets` maps (mood, W) → per-emitter target intensity.
    // A dry corridor's motes still drift (mood-only signal, no W involvement).
    const dry = { wetness: 0, rain: 0, glow: 0, wind: 0 };
    expect(emitterTargets('deep_dark', dry)).toEqual({ drips: 0, motes: 0.8, embers: 0 });

    // Flooded rooms drip hard when W.wetness peaks; embers stay dark.
    const soaked = { wetness: 1, rain: 0, glow: 1, wind: 0 };
    const flooded = emitterTargets('flooded', soaked);
    expect(flooded.drips).toBeCloseTo(1.0, 5);
    expect(flooded.embers).toBeCloseTo(0.0, 10);

    // A dry lava room throws embers, no drips. W.glow lifts embers ~2.5× over the dark floor.
    const bright = { wetness: 0, rain: 0, glow: 1, wind: 0 };
    const lava = emitterTargets('lava', bright);
    expect(lava.drips).toBeCloseTo(0.0, 10);
    expect(lava.embers).toBeCloseTo(0.9, 5);
    // Even torchlit gets a soft ember on `W.glow > 0` — a torch is a small ember source.
    const torchlit = emitterTargets('torchlit', bright);
    expect(torchlit.embers).toBeGreaterThan(0);
    expect(torchlit.motes).toBeCloseTo(0.55, 5);

    // Rain contributes at half the weight of wetness — a shower on a dry floor still drips.
    const shower = { wetness: 0, rain: 1, glow: 0, wind: 0 };
    const rained = emitterTargets('flooded', shower);
    expect(rained.drips).toBeCloseTo(0.5, 5);
    // Turning W.wetness off in a wet mood collapses drips to 0, even though the mood baseline is high.
    expect(emitterTargets('flooded', dry).drips).toBeCloseTo(0, 10);
    // Every value is bounded in [0, 1].
    for (const m of ['torchlit', 'deep_dark', 'flooded', 'lava', 'ice'] as const) {
      for (const w of [dry, soaked, bright, shower]) {
        const t = emitterTargets(m, w);
        for (const v of [t.drips, t.motes, t.embers]) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }

    // Rule 2: update() eases the uniform intensities toward the target chosen above.
    // Set W.wetness = 1 so `flooded` drips ride at their mood baseline; write W.glow so embers stay quiet.
    W.wetness.value = 1;
    W.rain.value = 0;
    W.glow.value = 0;
    W.wind.value = 0;
    const h = createWeather(W);
    // A single long tick reaches the target (FADE_RATE × dt ≥ 1 → k = 1).
    h.update(1.0, new Vector3(0, 0, 0), 'flooded');
    expect(h.drip.intensity.value).toBeCloseTo(1.0, 3);
    expect(h.ember.intensity.value).toBeCloseTo(0, 3);
    expect(h.drips.visible).toBe(true);
    expect(h.embers.visible).toBe(false);
    // Switch mood: lava turns the drips off and lights the embers.
    W.wetness.value = 0;
    W.glow.value = 1;
    h.update(1.0, new Vector3(0, 0, 0), 'lava');
    expect(h.drip.intensity.value).toBeCloseTo(0, 3);
    expect(h.ember.intensity.value).toBeCloseTo(0.9, 3);
    expect(h.drips.visible).toBe(false);
    expect(h.embers.visible).toBe(true);
    h.dispose();
  });

  it('the particle buffer is allocated once and wraps around the camera', () => {
    // Prime W to a middle-of-the-road wet-but-lit setup so all three emitters carry weight.
    W.wetness.value = 1;
    W.rain.value = 0;
    W.glow.value = 1;
    W.wind.value = 0.5;
    // T-0055 defaults every emitter to zero instances; this test is about the
    // buffer identity across updates, so opt in to the afterburn-scale counts.
    const h = createWeather(W, { drips: DRIP_COUNT, motes: MOTE_COUNT, embers: EMBER_COUNT });
    // One InstancedMesh per emitter, sized at construction from the requested counts.
    expect(h.drips.count).toBe(DRIP_COUNT);
    expect(h.motes.count).toBe(MOTE_COUNT);
    expect(h.embers.count).toBe(EMBER_COUNT);
    const geomHandles = [h.drips.geometry, h.motes.geometry, h.embers.geometry];
    const matHandles = [h.drips.material, h.motes.material, h.embers.material];

    // The buffer identities must survive many update() calls with different focus points.
    for (let i = 0; i < 20; i++) {
      h.update(0.016, new Vector3(i * 3, 0.5, i * -2.5), 'torchlit');
    }
    expect(h.drips.count).toBe(DRIP_COUNT);
    expect(h.motes.count).toBe(MOTE_COUNT);
    expect(h.embers.count).toBe(EMBER_COUNT);
    expect(h.drips.geometry).toBe(geomHandles[0]);
    expect(h.motes.geometry).toBe(geomHandles[1]);
    expect(h.embers.geometry).toBe(geomHandles[2]);
    expect(h.drips.material).toBe(matHandles[0]);
    expect(h.motes.material).toBe(matHandles[1]);
    expect(h.embers.material).toBe(matHandles[2]);

    // The `focus` uniform tracks the last hero position handed to update().
    const target = new Vector3(42.5, 0.5, -7.75);
    h.update(0.016, target, 'torchlit');
    expect(h.focus.value.x).toBeCloseTo(target.x, 10);
    expect(h.focus.value.y).toBeCloseTo(target.y, 10);
    expect(h.focus.value.z).toBeCloseTo(target.z, 10);

    // The pure wrap helper is what every emitter uses in its positionNode.
    // Invariant 1: the wrapped result always lies within `focus ± halfExtent`.
    for (const R of [DRIP_RADIUS, MOTE_RADIUS, EMBER_RADIUS]) {
      for (let i = 0; i < 32; i++) {
        const base = i * 0.7 - 5.0;
        for (const f of [-100, -3, 0, 3, 100]) {
          const w = wrapAround(base, f, R);
          expect(w).toBeGreaterThanOrEqual(f - R - 1e-9);
          expect(w).toBeLessThanOrEqual(f + R + 1e-9);
        }
      }
    }
    // Invariant 2: as the camera moves, each particle either stays at the
    // same world position (its lattice image is still inside the window) or
    // teleports by exactly one period `±2R` — never a fractional slide.
    // That is what "wraps around the camera" means for this overlay: the
    // volume follows the camera, particles do not, and boundary crossings
    // are exact.
    const R = MOTE_RADIUS;
    const period = 2 * R;
    for (let base = -20; base <= 20; base += 0.37) {
      for (let f = -6; f <= 6; f += 0.61) {
        const wa = wrapAround(base, f, R);
        const wb = wrapAround(base, f + 1.5, R);
        const d = wb - wa;
        // d must be 0 or ±period, up to fp noise from the mod chain.
        const nearest = [0, period, -period]
          .reduce((best, x) => (Math.abs(d - x) < Math.abs(d - best) ? x : best), Number.POSITIVE_INFINITY);
        expect(Math.abs(d - nearest)).toBeLessThan(1e-9);
      }
    }

    h.dispose();
  });

  it('no emitter produces particles by default', () => {
    // T-0055: a sealed stone dungeon has no drifting motes and no ceiling
    // drips; afterburn's overlay was tuned for an open valley in the rain, so
    // its motes read as "particles all over" underground. `createWeather()`
    // now allocates zero instances on every emitter unless the caller asks
    // for them by passing counts. The mood plumbing, the tint uniforms and
    // the overlay pass wiring all still exist so a later ticket (embers over
    // a lava pool) is a single-number change, not a rebuild.
    const h = createWeather();
    expect(h.drips.count).toBe(0);
    expect(h.motes.count).toBe(0);
    expect(h.embers.count).toBe(0);
    // A full ease-in on a mood that would normally drip hard does not
    // reallocate instances — the buffers stay at zero.
    W.wetness.value = 1;
    W.rain.value = 0;
    W.glow.value = 1;
    W.wind.value = 0;
    h.update(1.0, new Vector3(0, 0, 0), 'flooded');
    expect(h.drips.count).toBe(0);
    expect(h.motes.count).toBe(0);
    expect(h.embers.count).toBe(0);
    // The mood plumbing survives — the pure `emitterTargets` mapping is
    // unchanged, so a caller passing `{ embers: EMBER_COUNT }` for a lava
    // level still gets the 0.9 ember baseline that mood is tuned for.
    expect(emitterTargets('lava', { wetness: 0, rain: 0, glow: 1, wind: 0 }).embers).toBeCloseTo(0.9, 5);
    // Explicit opt-in still works: pass just `embers` and the drips/motes
    // buffers stay empty while the ember buffer gets its afterburn-scale
    // count.
    const lava = createWeather(W, { embers: EMBER_COUNT });
    expect(lava.drips.count).toBe(0);
    expect(lava.motes.count).toBe(0);
    expect(lava.embers.count).toBe(EMBER_COUNT);
    lava.dispose();
    h.dispose();
  });
});
