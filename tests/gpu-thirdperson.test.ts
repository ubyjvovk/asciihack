/**
 * Pure-function tests for the third-person "diorama follow" camera on the
 * GPU render path (T-0052, docs/gpu-thirdperson.md). Every case exercises
 * `web/src/gpu/thirdperson.ts`, whose helpers stay `three`-free so this file
 * compiles under the root tsconfig (no DOM lib). The impure wiring in
 * `GlViewport` (view-change side effects, F9/Q/E/wheel, DOF override on the
 * pipeline) is inside a browser-only class and cannot be tested here — see
 * `docs/gpu-thirdperson.md` §"what I could not verify".
 *
 * Case names are the ticket's acceptance list — do not rename them, do not
 * add other tests.
 */
import { describe, expect, it } from 'vitest';
import { HERO_SPRITE_HEIGHT } from '../web/src/gl/ortho-camera.js';
import {
  AFTERBURN_HERO_M,
  clampThirdDist,
  THIRD_DIST_DEFAULT_CELLS,
  THIRD_DIST_MAX_CELLS,
  THIRD_DIST_MIN_CELLS,
  THIRD_FOV_DEG,
  THIRD_LOOK_HEIGHT_CELLS,
  THIRD_PITCH_RAD,
  THIRD_SCALE,
  thirdPersonPose,
  wrapYawSteps,
} from '../web/src/gpu/thirdperson.js';

describe('gpu third-person — afterburn long-lens diorama follow', () => {
  it('the camera sits at the art-bible pitch and the converted distance', () => {
    // ART_BIBLE §6: `pitch ≈ 38–46°, distance 22–34 m`; afterburn rig defaults
    // are `pitch 42°, dist 26 m`. Distances scale by 0.7/1.7 (hero heights);
    // angles (pitch, FOV) are dimensionless and copied verbatim.
    const hero = { x: 40, y: 10 };
    const pose = thirdPersonPose(hero, 0, THIRD_DIST_DEFAULT_CELLS);

    // Pitch 42° with yawSteps 0 (behind the target, azimuth 0). Camera sits
    // north of the target at (0, +sin·d, −cos·d), lifted `THIRD_LOOK_HEIGHT`
    // above the floor so it looks at the hero's chest (0.39 cells up).
    const target = { x: hero.x + 0.5, y: THIRD_LOOK_HEIGHT_CELLS, z: hero.y + 0.5 };
    const cosP = Math.cos(THIRD_PITCH_RAD);
    const sinP = Math.sin(THIRD_PITCH_RAD);
    const expectedY = target.y + THIRD_DIST_DEFAULT_CELLS * sinP;
    const expectedZ = target.z - THIRD_DIST_DEFAULT_CELLS * cosP;
    expect(pose.position.x).toBeCloseTo(target.x);
    expect(pose.position.y).toBeCloseTo(expectedY);
    expect(pose.position.z).toBeCloseTo(expectedZ);
    // Look-at point is the hero cell centre, lifted by `THIRD_LOOK_HEIGHT`.
    expect(pose.target.x).toBeCloseTo(target.x);
    expect(pose.target.y).toBeCloseTo(target.y);
    expect(pose.target.z).toBeCloseTo(target.z);
    // FOV is the ART_BIBLE default (30°) — not scaled. If a future refactor
    // "scales" FOV like a distance, this fails.
    expect(pose.fov).toBe(THIRD_FOV_DEG);
    expect(pose.fov).toBe(30);
    // The scale conversion the ticket pins: distances land through
    // `HERO_SPRITE_HEIGHT / AFTERBURN_HERO_M`. Default 26 m → ~10.7 cells,
    // matching the ticket's table.
    expect(THIRD_SCALE).toBeCloseTo(HERO_SPRITE_HEIGHT / AFTERBURN_HERO_M);
    expect(THIRD_DIST_DEFAULT_CELLS).toBeCloseTo(26 * THIRD_SCALE);
    expect(THIRD_DIST_DEFAULT_CELLS).toBeGreaterThan(10);
    expect(THIRD_DIST_DEFAULT_CELLS).toBeLessThan(11);
    // Camera-to-target magnitude equals the requested distance — a sanity
    // check on the sphere placement: the position is exactly `dist` away.
    const dx = pose.position.x - pose.target.x;
    const dy = pose.position.y - pose.target.y;
    const dz = pose.position.z - pose.target.z;
    const magnitude = Math.sqrt(dx * dx + dy * dy + dz * dz);
    expect(magnitude).toBeCloseTo(THIRD_DIST_DEFAULT_CELLS);
  });

  it('yaw snaps to 45-degree steps and wraps', () => {
    // ART_BIBLE §6's "soft spring" follow is angle-snapped in the afterburn
    // rig: yaw moves in 45° steps rather than tracking heading. Q/E in
    // `main.ts` call `rotateThird(±1)` which walks `yawSteps` by ±1 through
    // `wrapYawSteps`; `thirdPersonPose` then multiplies by π/4.
    const hero = { x: 5, y: 5 };
    const dist = THIRD_DIST_DEFAULT_CELLS;
    // Two 45° steps put the camera east of north (azimuth 90°).
    const p0 = thirdPersonPose(hero, 0, dist);
    const p2 = thirdPersonPose(hero, 2, dist);
    // Azimuth 0: camera at (target.x, +y, target.z − d·cosP). Azimuth 90°:
    // camera at (target.x + d·cosP, +y, target.z). Same magnitude, rotated.
    const cosP = Math.cos(THIRD_PITCH_RAD);
    expect(p0.position.z - p0.target.z).toBeCloseTo(-dist * cosP);
    expect(p2.position.x - p2.target.x).toBeCloseTo(dist * cosP);
    // Wrap: 8 steps is a full turn (8 · 45° = 360°) — the pose returns to
    // where it started. If wrapping is broken, `yawSteps = 8` would not land
    // back on the origin.
    const p8 = thirdPersonPose(hero, 8, dist);
    expect(p8.position.x).toBeCloseTo(p0.position.x);
    expect(p8.position.z).toBeCloseTo(p0.position.z);
    // `wrapYawSteps` folds any integer into `[0, 8)` — negative and large
    // positive inputs both work (Q pressed 100× must not overflow anything).
    expect(wrapYawSteps(8)).toBe(0);
    expect(wrapYawSteps(9)).toBe(1);
    expect(wrapYawSteps(-1)).toBe(7);
    expect(wrapYawSteps(-9)).toBe(7);
    expect(wrapYawSteps(1000)).toBe(1000 % 8);
    // Nine 45° steps is one full turn plus one step, so the pose matches the
    // one-step pose exactly — this is the property the wrap guarantees when
    // `thirdPersonPose` reads `yawSteps` unwrapped: multiplying by π/4 gives
    // the same angle modulo 2π.
    const p9 = thirdPersonPose(hero, 9, dist);
    const p1 = thirdPersonPose(hero, 1, dist);
    expect(p9.position.x).toBeCloseTo(p1.position.x);
    expect(p9.position.z).toBeCloseTo(p1.position.z);
  });

  it('zoom clamps to the converted min and max distance', () => {
    // ART_BIBLE §6 pins the distance band at `22–34 m`; the afterburn rig
    // widens to `18–34 m` at the clamps. Converted through `THIRD_SCALE` the
    // bounds are ~7.4 (min) and ~14.0 (max) cells. The mouse wheel walks
    // `zoomThird(delta)` which calls `clampThirdDist`.
    expect(THIRD_DIST_MIN_CELLS).toBeCloseTo(18 * THIRD_SCALE);
    expect(THIRD_DIST_MAX_CELLS).toBeCloseTo(34 * THIRD_SCALE);
    // The scale conversion table in the ticket, verified:
    expect(THIRD_DIST_MIN_CELLS).toBeGreaterThan(7.3);
    expect(THIRD_DIST_MIN_CELLS).toBeLessThan(7.5);
    expect(THIRD_DIST_MAX_CELLS).toBeGreaterThan(13.9);
    expect(THIRD_DIST_MAX_CELLS).toBeLessThan(14.1);
    // Passing the default through is idempotent — the wheel doesn't kick you
    // out of a legal position on the first tick.
    expect(clampThirdDist(THIRD_DIST_DEFAULT_CELLS)).toBe(THIRD_DIST_DEFAULT_CELLS);
    // Below the min → clamped up to min; above the max → clamped down. A
    // wheel notch that would push the camera out gets caught here, not
    // downstream in the DOF math (which would then focus on empty space).
    expect(clampThirdDist(0)).toBe(THIRD_DIST_MIN_CELLS);
    expect(clampThirdDist(-100)).toBe(THIRD_DIST_MIN_CELLS);
    expect(clampThirdDist(1000)).toBe(THIRD_DIST_MAX_CELLS);
    // Interior values pass through — the clamp is not a rounding.
    const interior = (THIRD_DIST_MIN_CELLS + THIRD_DIST_MAX_CELLS) / 2;
    expect(clampThirdDist(interior)).toBe(interior);
  });

  it('DOF focus equals the camera-to-target distance', () => {
    // ART_BIBLE §6: "Depth of field focused on the player, gentle (diorama,
    // not mush)." The pipeline's DOF pass takes a `focus` distance; setting
    // it to `‖position − target‖` puts the sharp slab exactly on the hero.
    // `thirdPersonPose` returns `focus` = the requested `dist`, so a caller
    // who trusts the returned pose lands the focus on the hero without
    // recomputing the camera-to-target vector.
    const hero = { x: 40, y: 10 };
    for (const yawSteps of [0, 1, 2, 3, 4, 5, 6, 7]) {
      for (const dist of [THIRD_DIST_MIN_CELLS, THIRD_DIST_DEFAULT_CELLS, THIRD_DIST_MAX_CELLS]) {
        const p = thirdPersonPose(hero, yawSteps, dist);
        // `focus` matches the requested `dist` (byte-exact — the identity is
        // "focus = dist" by construction, not derived from the vector).
        expect(p.focus).toBe(dist);
        // …and it matches the vector length. If a future refactor decouples
        // focus from the placement (say, offsetting the target while leaving
        // the position alone), this fails.
        const dx = p.position.x - p.target.x;
        const dy = p.position.y - p.target.y;
        const dz = p.position.z - p.target.z;
        const magnitude = Math.sqrt(dx * dx + dy * dy + dz * dz);
        expect(p.focus).toBeCloseTo(magnitude);
      }
    }
    // Different hero cells don't shift the focus at fixed `dist` — the
    // focus tracks the camera-to-target distance, which is `dist` by
    // construction, and the hero cell only moves the target.
    const q1 = thirdPersonPose({ x: 1, y: 1 }, 3, THIRD_DIST_DEFAULT_CELLS);
    const q2 = thirdPersonPose({ x: 60, y: 15 }, 3, THIRD_DIST_DEFAULT_CELLS);
    expect(q1.focus).toBeCloseTo(q2.focus);
  });
});
