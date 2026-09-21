/**
 * Hero cutout — pure geometry for the "see through the wall in front of the
 * hero" rule (T-0058, docs/gpu-cutout.md). The material-side discard lives in
 * `createVoxelMaterial` (`materials.ts`); this file only holds the shared
 * predicate — the same rule the fragment shader evaluates, restated in cell
 * terms — plus the two constants the shader defaults to. Pure: no `three`,
 * no DOM, so `tests/gpu-cutout.test.ts` exercises it in node without a
 * renderer.
 *
 * The rule. The camera sits south of the hero at a 42° pitch (docs/
 * gpu-thirdperson.md §"Pose"); any wall between the two occludes the player.
 * Options were sketched in `docs/gpu-ortho.md` §"What (a) does not deliver":
 * this ticket ships option (b), a per-fragment discard driven by the hero
 * cell — the wall stays opaque everywhere except a small "keyhole" the hero
 * reads through. Fragments are cut when **all** of:
 *
 *   1. the fragment is on the camera side of the hero, so the wall between
 *      them clears and the wall behind the hero stays (`dot > 0` — since
 *      `cutoutForwardFor` returns the hero → camera direction);
 *   2. the fragment's horizontal distance to the hero cell is under
 *      `cutoutRadius` (default `CUTOUT_RADIUS_CELLS = 2.5`);
 *   3. the fragment's world Y is above the floor (`> CUTOUT_FLOOR_EPSILON =
 *      0.05`) — we never cut the floor out from under the hero, only what
 *      stands up in the way.
 *
 * A soft screen-door fade extends past `cutoutRadius` by `CUTOUT_FADE_CELLS =
 * 0.8` cells: a per-pixel dither sample (`interleavedGradientNoise`) versus a
 * 1 → 0 ramp across that band, then `Discard()`. Alpha blending would pull
 * these surfaces out of the opaque pass and corrupt the G-buffer that SSGI
 * and SSR read from; a `discard` keeps the material opaque and simply makes
 * the wall genuinely absent for those rays, which is what we want.
 */

/** Minimal 3D vector shape used by the pure helpers — plain numbers so
 *  the tests can hand in literals and the caller can pass through either a
 *  `THREE.Vector3` or a plain object. */
export interface Vec3Lite {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Default cutout radius in cells — the "core" fully-discarded zone around
 *  the hero. Matches the material uniform default; kept here so the docs and
 *  the tests state one number. */
export const CUTOUT_RADIUS_CELLS = 2.5;

/** Soft outer band, in cells, past `CUTOUT_RADIUS_CELLS` where the screen-
 *  door dither ramps from 1 to 0. Total effective footprint is
 *  `CUTOUT_RADIUS_CELLS + CUTOUT_FADE_CELLS`. */
export const CUTOUT_FADE_CELLS = 0.8;

/** World Y (cells) below which the discard never fires. Guards the floor —
 *  cutting the floor plane leaves a hole under the hero. Anything standing
 *  up in the way (walls, doorframes) has fragments above this threshold. */
export const CUTOUT_FLOOR_EPSILON = 0.05;

/**
 * Horizontal unit vector pointing **from the hero toward the camera**. Only
 * the (x, z) components carry information; `y` is forced to 0 so the rule is
 * indifferent to the camera's pitch — every fragment above the floor within
 * the horizontal disk is subject to the discard regardless of camera height.
 *
 * Degenerate case: `camera === hero` (or the two share the same horizontal
 * position) returns the zero vector. The material's fragment rule then reads
 * `dot(anything, 0) = 0`, which is not `> 0`, so nothing is cut — the sane
 * behaviour when the camera sits on top of the hero (there is no wall in
 * front to see through).
 */
export function cutoutForwardFor(cameraPos: Vec3Lite, heroPos: Vec3Lite): Vec3Lite {
  const dx = cameraPos.x - heroPos.x;
  const dz = cameraPos.z - heroPos.z;
  const len = Math.hypot(dx, dz);
  if (len === 0) return { x: 0, y: 0, z: 0 };
  return { x: dx / len, y: 0, z: dz / len };
}

/**
 * Whether the wall cell at `(cellX, cellY)` is inside the hero cutout: the
 * same predicate the fragment shader evaluates, restated at cell resolution
 * so the docs pin down a rerunnable example and the tests can catch a sign
 * flip without a GPU. Both cell coordinates and the hero position are in the
 * game's map axes (`x` = column, `y` = row / world-z), the same axes
 * `LevelView.kindAt` uses.
 *
 * `forward` is the (x, z) vector `cutoutForwardFor` produced (any `y` on it
 * is ignored — the predicate is horizontal by construction). `radius` is in
 * cells; the outer soft fade is not modelled here because a cell is either
 * "in" the cutout or "not" — the dither band is a per-pixel effect the
 * shader owns, not a per-cell one.
 *
 * A cell exactly at the hero's position (`cellX === hero.x && cellY ===
 * hero.y`) reads `dist === 0`, `dot === 0` and is **not** cut — the hero's
 * own cell is left alone.
 */
export function isCutCell(
  cellX: number,
  cellY: number,
  hero: { readonly x: number; readonly y: number },
  forward: Vec3Lite,
  radius: number,
): boolean {
  const dx = cellX - hero.x;
  const dz = cellY - hero.y;
  const dist = Math.hypot(dx, dz);
  if (dist >= radius) return false;
  const dot = dx * forward.x + dz * forward.z;
  return dot > 0;
}
