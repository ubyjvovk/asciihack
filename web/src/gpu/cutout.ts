/**
 * Hero cutout — pure geometry for the "cut only what actually blocks the hero"
 * rule (T-0063, `docs/gpu-cutout.md`). The material-side discard lives in
 * `createVoxelMaterial` (`materials.ts`); this file only holds the shared
 * predicate — the same test the fragment shader evaluates, restated at cell
 * resolution — plus the two constants the shader defaults to. Pure: no
 * `three`, no DOM, so `tests/gpu-cutout.test.ts` exercises it in node without
 * a renderer.
 *
 * The rule (T-0063): cut only fragments that are (a) **nearer the camera than
 * the hero** and (b) **projected within a screen-space radius** of the hero's
 * projected position. The previous version compared a world-space distance
 * from the hero cell and clipped anything on the camera side, which cut walls
 * that never occluded the player: walk near a wall and a hole opened, whether
 * or not the wall was between the hero and the camera. Iso games get this
 * right with the depth + screen test — a wall beside or behind the hero is
 * never in the camera's line to the hero, so it is never nearer than the
 * hero along that ray, so it is never cut. See `docs/gpu-cutout.md` §"Why
 * the world-space proximity version was wrong".
 *
 * The pure helper `isCutCell` restates the shader test in cell space:
 *
 *   1. **Depth.** The cell's centre must be strictly closer to the camera
 *      than the hero is, minus `depthBiasCells` — a small bias so the hero's
 *      own cell does not flicker in and out under fp noise.
 *   2. **Screen radius (cone).** The cell must project inside a cone whose
 *      apex is the camera and whose radius at the hero's depth is
 *      `screenRadiusCells`. In world units that is a perspective cone: a
 *      cell at half the hero's depth is inside the cut iff its lateral
 *      offset from the camera → hero ray is under `screenRadius / 2`.
 *
 * `screenRadiusCells` is the cell-space stand-in for the shader's pixel
 * radius (`heroScreenPx` in `materials.ts`): the fragment shader compares
 * `screenCoordinate.xy` against `heroScreen` in pixels, and this helper
 * compares the perspective-projected cell centre against the same cone
 * expressed in cells at the hero's depth. Both agree on which cells are
 * inside the cone; the shader gets a soft edge via the screen-door dither.
 *
 * `aboveFloor` (the shader guards the ground plane) and the fade band are
 * not modelled here — a cell is either "in" the cone or "not"; the shader
 * owns the per-pixel fade.
 */

/** Minimal 3D vector shape used by the pure helpers — plain numbers so
 *  the tests can hand in literals and the caller can pass through either a
 *  `THREE.Vector3` or a plain object. */
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
 *  ticket's "35 % of the radius" number. Not used by the pure helper — a
 *  cell is either inside the cone or not; the fade is a per-pixel effect
 *  the shader owns. */
export const CUTOUT_SCREEN_FADE_FRACTION = 0.35;

/** World Y (cells) below which the discard never fires. Guards the floor —
 *  cutting the floor plane leaves a hole under the hero. Anything standing
 *  up in the way (walls, doorframes) has fragments above this threshold. */
export const CUTOUT_FLOOR_EPSILON = 0.05;

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
