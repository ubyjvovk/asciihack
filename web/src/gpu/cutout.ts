/**
 * Hero cutout — pure geometry for the "cut only what actually blocks the hero"
 * rule (T-0063, `docs/gpu-cutout.md`). The material-side discard lives in
 * `createVoxelMaterial` (`materials.ts`); this file holds two testable
 * predicates the render loop and the shader rely on:
 *
 *   - `isCutCell(...)` — the same fragment-shader test restated at cell
 *     resolution. `three`-free so the "which cells are inside the cone"
 *     property can be pinned without a GPU.
 *   - `projectHeroForCutout(...)` — the CPU-side projection the render loop
 *     runs each frame. Takes a live `three.Camera` and returns the pixel
 *     numbers the shader gets. Rework of attempt 1: attempt 1 derived
 *     `heroScreenPx` from `HERO_SPRITE_HEIGHT · canvasH / (2·d·tan(fov/2))`,
 *     which assumes a segment perpendicular to the view direction — but the
 *     third-person camera is pitched 42° down, so a vertical world segment
 *     projects **shorter** than that. The overestimated radius scooped a
 *     wide dithered arc out of walls that never blocked the hero. Fix:
 *     project the hero's head and feet through the live camera and take
 *     the pixel distance between them as the true on-screen height, then
 *     multiply by `screenRadiusFactor` (default 1.4, from the ticket).
 *
 * The rule (T-0063): cut only fragments that are (a) **nearer the camera than
 * the hero** and (b) **projected within a screen-space radius** of the hero's
 * projected position. The previous version compared a world-space distance
 * from the hero cell and clipped anything on the camera side, which cut walls
 * that never occluded the player. Iso games get this right with the depth +
 * screen test — a wall beside or behind the hero is never in the camera's
 * line to the hero, so it is never nearer than the hero along that ray, so
 * it is never cut. See `docs/gpu-cutout.md` §"Why the world-space proximity
 * version was wrong".
 */

import { Vector3, type Camera } from 'three';

/** Minimal 3D vector shape used by `isCutCell` — plain numbers so the tests
 *  can hand in literals and the caller can pass a `THREE.Vector3` or a plain
 *  object interchangeably. */
export interface Vec3Lite {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Default depth bias in cells: how much closer than the hero a fragment
 *  must be before the cut fires. The hero's own cell centre reads the same
 *  depth as the hero itself; without a bias every ambient wobble in the
 *  fragment's view-space z would flicker the hero's own voxels. `0.15` cells
 *  is comfortably wider than any fp noise and strictly less than the 0.5
 *  cells that separate the hero cell centre from the nearest adjacent-wall
 *  fragment, so adjacent walls in front of the hero still receive the full
 *  cut. */
export const CUTOUT_DEPTH_BIAS_CELLS = 0.15;

/** Fade-band fraction of `screenRadius` for the screen-door dither. The
 *  shader keeps the ring `[screenRadius, screenRadius · (1 + fade)]` soft
 *  via `interleavedGradientNoise(screenCoordinate.xy)`. `0.35` matches the
 *  ticket's "35 % of the radius" number. Not used by `isCutCell` — a cell
 *  is either inside the cone or not; the fade is a per-pixel effect the
 *  shader owns. */
export const CUTOUT_SCREEN_FADE_FRACTION = 0.35;

/** World Y (cells) below which the discard never fires. Guards the floor —
 *  cutting the floor plane leaves a hole under the hero. Anything standing
 *  up in the way (walls, doorframes) has fragments above this threshold. */
export const CUTOUT_FLOOR_EPSILON = 0.05;

/** Default multiplier for `screenRadiusPx = factor · heroOnScreenHeightPx`.
 *  Ticket T-0063: "1.4 × the avatar's on-screen height". Keep it a named
 *  constant so a re-tune touches one place. */
export const CUTOUT_SCREEN_RADIUS_FACTOR = 1.4;

/**
 * Whether the wall cell at `(cellX, cellY)` is inside the hero cutout: the
 * same predicate the fragment shader evaluates, restated at cell resolution
 * so the docs pin down a rerunnable example and the tests can catch a
 * regression without a GPU. `cellX`/`cellY` and `hero` are in the game's map
 * axes (`x` = column, `y` = row / world-z, the same axes `LevelView.kindAt`
 * uses); `camera` is a world position (map-y → world-z) so callers can pass
 * `THREE.Camera.position` in.
 *
 * A cell is cut iff both:
 *
 *  - it is strictly closer to the camera than the hero (measured along the
 *    horizontal camera → hero direction), minus `depthBiasCells` — a wall
 *    at or behind the hero's plane, or exactly at the hero's cell, is never
 *    cut;
 *  - its projected offset from the camera → hero ray falls inside a cone
 *    whose radius at the hero's depth is `screenRadiusCells`. This is a
 *    perspective cone: the same on-screen radius covers less world lateral
 *    at shallower depths, so cells nearer the camera need a tighter
 *    lateral offset to be cut.
 *
 * Degenerate: `camera` sits at the hero's horizontal position → the camera →
 * hero direction is undefined. Nothing is cut (there is no wall "in front of
 * the hero" from a camera on top of him).
 */
export function isCutCell(
  cellX: number,
  cellY: number,
  hero: { readonly x: number; readonly y: number },
  camera: Vec3Lite,
  screenRadiusCells: number,
  depthBiasCells: number,
): boolean {
  const heroWorldX = hero.x + 0.5;
  const heroWorldZ = hero.y + 0.5;
  const cellWorldX = cellX + 0.5;
  const cellWorldZ = cellY + 0.5;

  const toHeroX = heroWorldX - camera.x;
  const toHeroZ = heroWorldZ - camera.z;
  const heroDepth = Math.hypot(toHeroX, toHeroZ);
  if (heroDepth === 0) return false;
  const fwdX = toHeroX / heroDepth;
  const fwdZ = toHeroZ / heroDepth;

  const cellRelX = cellWorldX - camera.x;
  const cellRelZ = cellWorldZ - camera.z;
  const cellDepth = cellRelX * fwdX + cellRelZ * fwdZ;

  // Depth: strictly nearer camera than hero, minus the bias.
  if (cellDepth <= 0) return false;
  if (cellDepth >= heroDepth - depthBiasCells) return false;

  // Lateral offset from the camera → hero ray.
  const latX = cellRelX - cellDepth * fwdX;
  const latZ = cellRelZ - cellDepth * fwdZ;
  const lateral = Math.hypot(latX, latZ);

  // Screen-space cone: the cell is inside the cut iff its lateral offset
  // is under `screenRadius · cellDepth / heroDepth` (the perspective radius
  // at the cell's depth). Rearranged to avoid the divide.
  return lateral * heroDepth < screenRadiusCells * cellDepth;
}

/** Plain-number result of `projectHeroForCutout` — the four numbers the
 *  shader's `CUTOUT` uniform block wants, plus what `debugInfo()` prints. */
export interface CutoutFrame {
  /** Hero's positive camera-space distance (`-heroView.z`), guarded against
   *  a zero/negative degenerate. Same convention as `-positionView.z` in
   *  the shader — positive is in front of the camera. */
  heroCamDist: number;
  /** Hero's projected pixel X (origin top-left, matching TSL
   *  `screenCoordinate.xy` on both WebGPU and WebGL2 backends via
   *  `builder.isFlipY()`). */
  heroScreenX: number;
  /** Hero's projected pixel Y (origin top-left). */
  heroScreenY: number;
  /** Pixel radius around `heroScreen*` inside which fragments are cut. */
  screenRadiusPx: number;
}

/**
 * Project the hero for the per-frame cutout uniforms. Returns the four pixel
 * numbers the material's `CUTOUT` block needs: hero camera-space depth, hero
 * projected pixel position (top-left origin), and the screen radius.
 *
 * `screenRadiusPx` is derived from the **projected pixel distance between
 * the hero's head and feet** — not from `HERO_SPRITE_HEIGHT · canvasH /
 * (2·d·tan(fov/2))`, which was attempt 1's mistake. That formula treats
 * the avatar as a segment perpendicular to the view direction; the
 * third-person camera is pitched 42° down, so a vertical world segment
 * projects shorter, and the overestimated radius scooped a wide arc out
 * of walls that never blocked the hero (see `docs/gpu-cutout.md`
 * §"Radius from projected head→feet, not a camera-space formula").
 *
 * `heroCentre*` is the world-space position of the hero's mid-height
 * (typically `spriteHeight * 0.5`); head is `+spriteHeight/2` above it,
 * feet `-spriteHeight/2` below. Works with any three `Camera` (perspective
 * or orthographic) — `Vector3.project` handles the projection matrix.
 * `camera.updateMatrixWorld(true)` is called before reading matrices so
 * a first-frame call after a view flip does not read the previous frame's
 * transform.
 *
 * Degenerate: hero at the camera position → `heroCamDist` clamps to 0 and
 * the caller is expected to skip the cutout uniforms that frame.
 */
export function projectHeroForCutout(
  camera: Camera,
  heroCentreX: number,
  heroCentreY: number,
  heroCentreZ: number,
  spriteHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  screenRadiusFactor: number,
): CutoutFrame {
  camera.updateMatrixWorld(true);
  const centre = new Vector3(heroCentreX, heroCentreY, heroCentreZ);
  const heroView = centre.clone().applyMatrix4(camera.matrixWorldInverse);
  const heroCamDist = Math.max(0, -heroView.z);
  const centreNDC = centre.clone().project(camera);
  const heroScreenX = (centreNDC.x * 0.5 + 0.5) * canvasWidth;
  const heroScreenY = (1.0 - (centreNDC.y * 0.5 + 0.5)) * canvasHeight;

  const halfHeight = spriteHeight * 0.5;
  const feetNDC = new Vector3(heroCentreX, heroCentreY - halfHeight, heroCentreZ).project(camera);
  const headNDC = new Vector3(heroCentreX, heroCentreY + halfHeight, heroCentreZ).project(camera);
  const feetPxX = (feetNDC.x * 0.5 + 0.5) * canvasWidth;
  const feetPxY = (1.0 - (feetNDC.y * 0.5 + 0.5)) * canvasHeight;
  const headPxX = (headNDC.x * 0.5 + 0.5) * canvasWidth;
  const headPxY = (1.0 - (headNDC.y * 0.5 + 0.5)) * canvasHeight;
  const onScreenHeightPx = Math.hypot(headPxX - feetPxX, headPxY - feetPxY);
  const screenRadiusPx = screenRadiusFactor * onScreenHeightPx;

  return { heroCamDist, heroScreenX, heroScreenY, screenRadiusPx };
}
