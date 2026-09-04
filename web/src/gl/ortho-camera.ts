/**
 * Fixed 3/4 overhead camera for the browser ortho view (T-0032). A pure-math
 * placement (positions and frustum sides as plain numbers) plus a thin
 * `THREE.OrthographicCamera` wrapper: the camera sits at azimuth 225° and
 * elevation 35° above the hero cell centre, matching the terminal ortho's
 * "Diablo/Fallout" look. The frustum is sized so a `HERO_SPRITE_HEIGHT`-tall
 * hero fills ≈ 1/7 of the viewport vertically, and the aspect ratio follows
 * the DOM terminal's `cols × rows × cellAspect` pixel rectangle. The
 * `cutawaySet` helper mirrors `src/render/ortho.ts`'s "walls in front of the
 * hero" rule so the GL viewport can ghost them and keep the hero visible.
 */
import * as THREE from 'three';

/** Height of the hero sprite in world units (cells); matches `spritesFromMap`. */
export const HERO_SPRITE_HEIGHT = 0.7;

/** Frustum height in world units so the hero fills ≈ 1/7 of the viewport. */
export const ORTHO_VIEW_HEIGHT_CELLS = 7 * HERO_SPRITE_HEIGHT;

/** Near plane for the ortho camera — nothing sits closer than the floor box. */
export const ORTHO_NEAR = 0.1;
/** Far plane for the ortho camera. Kept modest (not the 2000 default) so any
 *  depth-based style that reads `cameraFar` for `linearDepth` does not go black
 *  across the whole ortho frustum. */
export const ORTHO_FAR = 200;

/** Camera azimuth in radians (northwest of the hero, per the ticket). */
export const ORTHO_AZIMUTH_RAD = (225 * Math.PI) / 180;

/** Camera elevation above the horizon in radians (35° for the 3/4 look). */
export const ORTHO_ELEVATION_RAD = (35 * Math.PI) / 180;

/** Distance in cells from the hero to the camera. Arbitrary for an ortho
 *  projection but big enough to keep the whole 80×21 map inside near/far. */
export const ORTHO_DISTANCE_CELLS = 40;

/** Half-width of the "in front of the hero" cutaway box, in cells (|dx| ≤ 2). */
export const CUTAWAY_RADIUS = 2;

/** DOM terminals render cells that are twice as tall as wide; the aspect
 *  ratio the ortho projection must compensate for. */
export const DEFAULT_CELL_ASPECT = 2;

/** Numeric camera placement — plain numbers so tests can assert against them. */
export interface OrthoPlacement {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  left: number;
  right: number;
  top: number;
  bottom: number;
  near: number;
  far: number;
}

/**
 * Compute the ortho camera position, look target and frustum sides for a hero
 * at map cell `(hero.x, hero.y)` viewed on a `cols × rows` terminal with
 * `cellAspect = height/width` per cell (the DOM terminal is 2). Pure — no
 * WebGL, no three.js, plain numbers.
 */
export function orthoPlacement(
  hero: { x: number; y: number },
  cols: number,
  rows: number,
  cellAspect: number = DEFAULT_CELL_ASPECT,
): OrthoPlacement {
  const target = { x: hero.x + 0.5, y: 0.5, z: hero.y + 0.5 };
  const cosEl = Math.cos(ORTHO_ELEVATION_RAD);
  // azimuth 225°: cos = sin = −√2/2, so both x and z go negative (NW-above).
  const position = {
    x: target.x + ORTHO_DISTANCE_CELLS * cosEl * Math.cos(ORTHO_AZIMUTH_RAD),
    y: target.y + ORTHO_DISTANCE_CELLS * Math.sin(ORTHO_ELEVATION_RAD),
    z: target.z + ORTHO_DISTANCE_CELLS * cosEl * Math.sin(ORTHO_AZIMUTH_RAD),
  };
  const height = ORTHO_VIEW_HEIGHT_CELLS;
  const aspect = Math.max(1, cols) / Math.max(1, rows * cellAspect);
  const width = height * aspect;
  return {
    position,
    target,
    left: -width / 2,
    right: width / 2,
    top: height / 2,
    bottom: -height / 2,
    near: ORTHO_NEAR,
    far: ORTHO_FAR,
  };
}

/**
 * Position an `OrthographicCamera` for the ortho view of the hero cell: sets
 * position, up-vector, look target, frustum sides and near/far. Idempotent;
 * safe to call every frame. Delegates the arithmetic to `orthoPlacement`.
 */
export function placeOrthoCamera(
  cam: THREE.OrthographicCamera,
  hero: { x: number; y: number },
  cols: number,
  rows: number,
  cellAspect: number = DEFAULT_CELL_ASPECT,
): void {
  const p = orthoPlacement(hero, cols, rows, cellAspect);
  cam.position.set(p.position.x, p.position.y, p.position.z);
  cam.up.set(0, 1, 0);
  cam.lookAt(p.target.x, p.target.y, p.target.z);
  cam.left = p.left;
  cam.right = p.right;
  cam.top = p.top;
  cam.bottom = p.bottom;
  cam.near = p.near;
  cam.far = p.far;
  cam.updateProjectionMatrix();
}

/**
 * Cells whose walls should be ghosted in the ortho view: those strictly in
 * front of the hero (greater `x + y`) and within `CUTAWAY_RADIUS` on each
 * axis. Same rule the terminal ortho uses (`src/render/ortho.ts:isCutaway`),
 * pure over hero coordinates so the caller intersects with real wall cells.
 */
export function cutawayCellsFor(hero: { x: number; y: number }): Set<string> {
  const out = new Set<string>();
  const hs = hero.x + hero.y;
  for (let dy = -CUTAWAY_RADIUS; dy <= CUTAWAY_RADIUS; dy++) {
    for (let dx = -CUTAWAY_RADIUS; dx <= CUTAWAY_RADIUS; dx++) {
      const x = hero.x + dx;
      const y = hero.y + dy;
      if (x + y <= hs) continue; // "in front" = strictly greater x + y
      out.add(`${x},${y}`);
    }
  }
  return out;
}
