/**
 * Pure-function tests for the GPU post-processing pipeline (T-0037).
 * Only imports the pure exports of `web/src/gpu/pipeline.ts`; the impure
 * `createRenderer`/`createPipeline` cannot be tested without a GPU (see
 * `docs/gpu-pipeline.md` "what I could not verify").
 */
import { describe, it, expect } from 'vitest';
import {
  QUALITY,
  clampQuality,
  qualityPlan,
  createLook,
  type RendererCaps,
} from '../web/src/gpu/pipeline.js';

describe('gpu pipeline — pure exports', () => {
  it('qualityPlan enables SSGI, SSR, god rays and TRAA on ultra and none of them on low', () => {
    const ultra = qualityPlan('ultra');
    expect(ultra.ssgi).toBe(true);
    expect(ultra.ssr).toBe(true);
    expect(ultra.godRays).toBe(true);
    expect(ultra.traa).toBe(true);

    const low = qualityPlan('low');
    expect(low.ssgi).toBe(false);
    expect(low.ssr).toBe(false);
    expect(low.godRays).toBe(false);
    expect(low.traa).toBe(false);
  });

  it('qualityPlan applies a dev override on top of the named tier', () => {
    const base = QUALITY.medium;
    const plan = qualityPlan('medium', { godRays: true, godRaySteps: 48, giScale: 0.5 });
    expect(plan.godRays).toBe(true);
    expect(plan.godRaySteps).toBe(48);
    expect(plan.giScale).toBeCloseTo(0.5);
    // Untouched fields still come from the named tier.
    expect(plan.ssr).toBe(base.ssr);
    expect(plan.dof).toBe(base.dof);
    expect(plan.gtao).toBe(base.gtao);
    expect(plan.maxRadiance).toBeCloseTo(base.maxRadiance);
  });

  it('clampQuality caps a WebGL2 backend and a small MRT budget at medium', () => {
    const webgl2: RendererCaps = { webgpu: false, mrtBytes: 128, maxQuality: 'ultra' };
    expect(clampQuality('ultra', webgl2)).toBe('medium');
    expect(clampQuality('high', webgl2)).toBe('medium');
    expect(clampQuality('medium', webgl2)).toBe('medium');
    expect(clampQuality('low', webgl2)).toBe('low');

    const tinyMrt: RendererCaps = { webgpu: true, mrtBytes: 32, maxQuality: 'ultra' };
    expect(clampQuality('ultra', tinyMrt)).toBe('medium');

    const good: RendererCaps = { webgpu: true, mrtBytes: 64, maxQuality: 'ultra' };
    expect(clampQuality('ultra', good)).toBe('ultra');
    expect(clampQuality('high', good)).toBe('high');
  });

  it('createLook exposes every uniform the grade block reads, at the documented defaults', () => {
    const look = createLook();
    // Every field the grade block in pipeline.ts wraps in `uniform(...)`.
    expect(look.exposure).toBeCloseTo(1.0);
    expect(look.shadowTint).toEqual([0.86, 1.00, 1.08]);
    expect(look.highlightTint).toEqual([1.10, 1.04, 0.92]);
    expect(look.tintBalance).toBeCloseTo(0.5);
    expect(look.contrast).toBeCloseTo(1.05);
    expect(look.midGrey).toBeCloseTo(0.18);
    expect(look.saturation).toBeCloseTo(1.08);
    expect(look.vignette).toBeCloseTo(0.35);
    expect(look.vignetteFalloff).toBeCloseTo(1.20);
    expect(look.grain).toBeCloseTo(0.03);
    expect(look.fade).toBeCloseTo(1.0);

    // Overrides win field-by-field; tints are copied so callers can mutate.
    const tuned = createLook({ grain: 0.0, shadowTint: [0.5, 0.5, 0.5] });
    expect(tuned.grain).toBeCloseTo(0.0);
    expect(tuned.shadowTint).toEqual([0.5, 0.5, 0.5]);
    tuned.shadowTint[0] = 0.99;
    expect(createLook().shadowTint[0]).toBeCloseTo(0.86);
  });
});
