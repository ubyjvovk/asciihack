/**
 * Hero cutout — pure geometry for the "cut only what actually blocks the hero"
 * rule (T-0063, `docs/gpu-cutout.md`). The material-side discard lives in
 * `createVoxelMaterial` (`materials.ts`); this file holds the pure helpers
 * the render loop and the shader rely on:
 *
 *   - `isCutCell(...)` — the same depth predicate at cell resolution, using a
 *     lateral cone against the camera → hero ray as a cheap stand-in for
 *     "inside the hero's silhouette". `three`-free, node-testable, and the
 *     four depth cases in `tests/gpu-cutout.test.ts` pin the depth part of
 *     the shader rule without a GPU. The shader itself uses the projected
 *     screen rectangle (below); the cone is a strictly-conservative
 *     approximation for the "beside/behind is safe" property the depth
 *     cases exercise.
 *   - `projectHeroForCutout(...)` — the CPU-side projection the render loop
 *     runs each frame. Takes a live `three.Camera` and returns the four
 *     pixel numbers the shader gets: `heroCamDist` for the depth test and
 *     `heroScreenMin`/`heroScreenMax` for the rectangle test, plus the
 *     fade margin the shader softens the edges with. The rectangle comes
 *     from projecting the eight corners of the hero's AABB and taking the
 *     pixel-space extremes.
 *
 * The rule (T-0063 rework 3): cut only fragments that are (a) **nearer the
 * camera than the hero** and (b) **inside the hero's projected silhouette
 * rectangle**, expanded by a small fade margin for the screen-door dither.
 * The previous versions failed the ticket in turn:
 *
 *  - T-0058 world-space proximity — cut any wall inside a 2.5-cell disk
 *    around the hero, regardless of occlusion (`docs/gpu-cutout.md` §"Why
 *    the world-space proximity version was wrong").
 *  - Rework 1 depth + screen-space **disc** — the disc reached well past
 *    the figure and scooped floor/wall that never overlapped his silhouette
 *    (`docs/gpu-cutout.md` §"Why a screen-space disc was tried and
 *    rejected"). Fix: use the projected AABB, not a radius.
 *
 * With the rectangle rule the hole is exactly as big as the avatar is on
 * screen and appears only where something would actually hide him.
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

/** World Y (cells) below which the discard never fires. Guards the floor —
 *  cutting the floor plane leaves a hole under the hero. Anything standing
 *  up in the way (walls, doorframes) has fragments above this threshold. */
export const CUTOUT_FLOOR_EPSILON = 0.05;

/** Pixel margin the shader expands the silhouette rectangle by for the
 *  screen-door fade band. A per-pixel `interleavedGradientNoise` sample is
 *  compared against a 1 → 0 ramp across this margin, so the hole's edge
 *  reads as a soft dither rather than a hard rectangle. `6 px` matches the
 *  rework's number — comfortably visible but not a wash across the
 *  surrounding wall. */
export const CUTOUT_SCREEN_FADE_MARGIN_PX = 6.0;

/** Silhouette footprint in cells — the horizontal extent (both x and z) of
 *  the AABB the projection uses. Measured from `web/src/gpu/avatar.ts`:
 *  the widest voxels (shoulder pad + arm) reach ~9.6 units on the 0.025
 *  cell grid → 0.24 cells shoulder-to-shoulder; the pack + cloak give a
 *  similar depth. `0.3` cells rounds up so a yawing hero (shoulders → 45°
 *  diagonal) still fits inside the box, and matches the width the ortho
 *  frustum sizes rooms against. Square in x/z so the projected rectangle
 *  is rotation-invariant to `Pose.yaw`. */
export const HERO_SILHOUETTE_WIDTH_CELLS = 0.3;

/**
 * Whether the wall cell at `(cellX, cellY)` is inside the hero cutout at cell
 * resolution: the depth predicate the shader evaluates per fragment, applied
 * to a cell centre, with a lateral cone as a strictly-conservative stand-in
 * for the shader's screen-space rectangle. `cellX`/`cellY` and `hero` are in
 * the game's map axes (`x` = column, `y` = row / world-z, the same axes
 * `LevelView.kindAt` uses); `camera` is a world position (map-y → world-z)
 * so callers can pass `THREE.Camera.position` in.
 *
 * A cell is cut iff both:
 *
 *  - it is strictly closer to the camera than the hero (measured along the
 *    horizontal camera → hero direction), minus `depthBiasCells` — a wall
 *    at or behind the hero's plane, or exactly at the hero's cell, is never
 *    cut;
 *  - its projected lateral offset from the camera → hero ray falls inside a
 *    cone whose radius at the hero's depth is `screenRadiusCells`.
 *
 * The shader uses a screen-space rectangle instead of a cone; the cone is a
 * cell-resolution approximation that pins the depth part of the rule (walls
 * beside or behind the hero fail the depth test regardless of the lateral
 * shape). `projectHeroForCutout` and `tests/gpu-cutout.test.ts`'s silhouette
 * case exercise the rectangle rule directly.
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

  // Screen-space cone at cell resolution: `lateral < screenRadius · cellDepth
  // / heroDepth` (the perspective radius at the cell's depth). Rearranged to
  // avoid the divide.
  return lateral * heroDepth < screenRadiusCells * cellDepth;
}

/** Plain-number result of `projectHeroForCutout` — the numbers the shader's
 *  `CUTOUT` uniform block wants each frame, plus what `debugInfo()` prints. */
export interface CutoutFrame {
  /** Hero's positive camera-space distance (`-heroView.z`), guarded against
   *  a zero/negative degenerate. Same convention as `-positionView.z` in
   *  the shader — positive is in front of the camera. */
  heroCamDist: number;
  /** Pixel min-x of the projected hero AABB (origin top-left, matching TSL
   *  `screenCoordinate.xy` on both WebGPU and WebGL2 backends via
   *  `builder.isFlipY()`). */
  heroScreenMinX: number;
  /** Pixel min-y of the projected hero AABB (top-left origin). */
  heroScreenMinY: number;
  /** Pixel max-x of the projected hero AABB (top-left origin). */
  heroScreenMaxX: number;
  /** Pixel max-y of the projected hero AABB (top-left origin). */
  heroScreenMaxY: number;
  /** Pixel margin the shader expands the rectangle by for the dither fade. */
  fadeMarginPx: number;
}

/**
 * Project the hero for the per-frame cutout uniforms. Returns the pixel
 * numbers the material's `CUTOUT` block needs: hero camera-space depth, the
 * screen-space AABB of the hero's silhouette (top-left pixel origin), and
 * the fade margin.
 *
 * `heroScreenMin`/`heroScreenMax` are the axis-aligned bounding rectangle of
 * the hero's world-space AABB after projection through the live camera —
 * the eight corners of a `spriteWidth × spriteHeight × spriteWidth` box
 * centred at `(heroX, heroBaseY + spriteHeight/2, heroZ)` are projected to
 * NDC, converted to top-left pixel coords, and the pixel-space min/max are
 * taken. This is the actual on-screen silhouette of the avatar and it
 * shrinks/grows with zoom, camera pitch, and canvas size the way the avatar
 * does, so the hole is the size of the figure it is revealing (see
 * `docs/gpu-cutout.md` §"Why a screen-space disc was tried and rejected" for
 * why rework 1's radius was scrapped).
 *
 * Works with any three `Camera` (perspective or orthographic) —
 * `Vector3.project` handles the projection matrix.
 * `camera.updateMatrixWorld(true)` is called before reading matrices so a
 * first-frame call after a view flip does not read the previous frame's
 * transform.
 *
 * Degenerate: hero at the camera position → `heroCamDist` clamps to 0 and
 * the caller is expected to skip the cutout uniforms that frame.
 */
export function projectHeroForCutout(
  camera: Camera,
  heroX: number,
  heroBaseY: number,
  heroZ: number,
  spriteWidth: number,
  spriteHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  fadeMarginPx: number,
): CutoutFrame {
  camera.updateMatrixWorld(true);
  const centre = new Vector3(heroX, heroBaseY + spriteHeight * 0.5, heroZ);
  const heroView = centre.clone().applyMatrix4(camera.matrixWorldInverse);
  const heroCamDist = Math.max(0, -heroView.z);

  const halfW = spriteWidth * 0.5;
  const minX = heroX - halfW;
  const maxX = heroX + halfW;
  const minY = heroBaseY;
  const maxY = heroBaseY + spriteHeight;
  const minZ = heroZ - halfW;
  const maxZ = heroZ + halfW;

  let sxMin = Infinity;
  let syMin = Infinity;
  let sxMax = -Infinity;
  let syMax = -Infinity;
  const corner = new Vector3();
  for (let i = 0; i < 8; i++) {
    corner.set(
      (i & 1) === 0 ? minX : maxX,
      (i & 2) === 0 ? minY : maxY,
      (i & 4) === 0 ? minZ : maxZ,
    );
    corner.project(camera);
    const px = (corner.x * 0.5 + 0.5) * canvasWidth;
    const py = (1.0 - (corner.y * 0.5 + 0.5)) * canvasHeight;
    if (px < sxMin) sxMin = px;
    if (py < syMin) syMin = py;
    if (px > sxMax) sxMax = px;
    if (py > syMax) syMax = py;
  }
  return {
    heroCamDist,
    heroScreenMinX: sxMin,
    heroScreenMinY: syMin,
    heroScreenMaxX: sxMax,
    heroScreenMaxY: syMax,
    fadeMarginPx,
  };
}
