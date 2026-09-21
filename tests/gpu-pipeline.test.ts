/**
 * Pure-function tests for the GPU post-processing pipeline (T-0037).
 * Only imports the pure exports of `web/src/gpu/pipeline.ts`; the impure
 * `createRenderer`/`createPipeline` cannot be tested without a GPU (see
 * `docs/gpu-pipeline.md` §"what I could not verify").
 *
 * Expected values are the ported afterburn defaults; do not adjust them
 * without a matching change to `vendor/afterburn/src/render/pipeline.js`.
 */
import { describe, it, expect } from 'vitest';
import {
  QUALITY,
  clampQuality,
  qualityPlan,
  createLook,
  ssrStochastic,
  type RendererCaps,
} from '../web/src/gpu/pipeline.js';

describe('gpu pipeline — pure exports', () => {
  it('qualityPlan enables SSGI, SSR, god rays and TRAA on ultra and none of them on low', () => {
    const ultra = qualityPlan('ultra');
    expect(ultra.gi).toBe('ssgi');
    expect(ultra.ssr).toBe(true);
    expect(ultra.rays).toBe(true);
    expect(ultra.aa).toBe('traa');
    // Ported step/slice counts from afterburn's ultra entry.
    expect(ultra.slices).toBe(2);
    expect(ultra.steps).toBe(10);
    expect(ultra.raySteps).toBe(72);
    expect(ultra.ssrScale).toBe(1);

    const low = qualityPlan('low');
    expect(low.gi).toBe('none');
    expect(low.ssr).toBe(false);
    expect(low.rays).toBe(false);
    expect(low.aa).toBe('fxaa');
    expect(low.dof).toBe(false);
  });

  it('qualityPlan applies a dev override on top of the named tier', () => {
    const base = QUALITY.medium;
    const plan = qualityPlan('medium', { rays: true, raySteps: 48, giScale: 0.5 });
    expect(plan.rays).toBe(true);
    expect(plan.raySteps).toBe(48);
    expect(plan.giScale).toBeCloseTo(0.5);
    // Untouched fields still come from the named tier (medium = ao + ssr + dof + traa).
    expect(plan.gi).toBe(base.gi);
    expect(plan.ssr).toBe(base.ssr);
    expect(plan.dof).toBe(base.dof);
    expect(plan.aa).toBe(base.aa);
    expect(plan.ssrQ).toBeCloseTo(base.ssrQ ?? -1);
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

  it('SSR uses the stochastic path on WebGL2 and afterburn\'s mirror path on WebGPU', () => {
    // three r185 SSRNode.js emits `max( int( trunc( … ) ), 1.0 )` on GLSL — an int/float
    // mismatch GLSL ES 3.0 rejects, so the WebGL2 backend must take the stochastic branch.
    // WGSL coerces the same expression, so WebGPU keeps afterburn's ported `stochastic: false`.
    expect(ssrStochastic(false)).toBe(true);
    expect(ssrStochastic(true)).toBe(false);
  });

  it('createLook exposes every uniform the grade block reads, at the documented defaults', () => {
    const look = createLook();
    // Split-tone / contrast / saturation / vignette / grain / fade — the fields the display-space
    // grade block in createPipeline wraps in `uniform(...)`. Values ported verbatim from
    // vendor/afterburn/src/render/pipeline.js `createLook()`.
    expect(look.exposure).toBeCloseTo(1.0);
    expect(look.shadowTint).toBe(0x0e2a33);
    expect(look.highlightTint).toBe(0xfff1dc);
    expect(look.tintAmount).toBeCloseTo(0.16);
    expect(look.contrast).toBeCloseTo(1.06);
    expect(look.saturation).toBeCloseTo(1.02);
    expect(look.vignette).toBeCloseTo(0.42);
    expect(look.grain).toBeCloseTo(0.028);
    expect(look.fade).toBeCloseTo(1.0);

    // Overrides win field-by-field; every call returns a fresh object.
    const tuned = createLook({ grain: 0.0, shadowTint: 0x808080 });
    expect(tuned.grain).toBeCloseTo(0.0);
    expect(tuned.shadowTint).toBe(0x808080);
    expect(createLook().shadowTint).toBe(0x0e2a33);
  });
});
