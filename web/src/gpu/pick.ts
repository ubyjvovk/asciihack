/**
 * Click-to-move picking maths (T-0061, docs/gpu-pick.md).
 *
 * The click part is split into a pure and an impure half so the maths is
 * testable in node without any renderer:
 *
 * - `cellUnderRay(origin, dir)` — the pure half. Intersect a ray with the
 *   floor plane `y = 0`, return the map cell the hit falls in, or `null`
 *   when the ray never reaches the floor (looking up, parallel to it, or
 *   the hit is behind the camera).
 * - `pickCellFromEvent(...)` — the browser wiring. Given a `MouseEvent`, the
 *   canvas the WebGL viewport draws into, and the active `three` camera,
 *   turn the event's client coordinates into a ray with `raycaster.setFromCamera`
 *   and call `cellUnderRay`. Kept apart so it can stay a thin wrapper the
 *   browser tests don't need to cover.
 *
 * World-space convention (docs/architecture.md §7, docs/gpu.md §4): map
 * `x` = column, `z` = row (three's forward is −z, so decreasing z is north).
 * The floor plane is `y = 0`; cell `(cx, cy)` occupies world x ∈ [cx, cx+1),
 * z ∈ [cy, cy+1). `Math.floor` picks the cell the world point sits inside.
 *
 * Pointer routing (`docs/web.md` "WebGL viewport"): the GL canvas is
 * `pointer-events: none` so the DOM terminal keeps focus. `main.ts` listens
 * on `<pre id="term">` and passes the `MouseEvent` here — do **not** change
 * the canvas's `pointer-events`.
 */
import * as THREE from 'three';

/** Three-component vector; plain-numbers shape so the pure helper stays framework-free. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Result of a floor-plane pick — the map cell that contains the ray/floor intersection. */
export interface Cell {
  x: number;
  y: number;
}

/**
 * Intersect a ray with the floor plane `y = 0`. Returns the map cell that
 * contains the hit, or `null` when the ray misses (looks up, is parallel to
 * the floor, or the intersection is behind the origin). Pure — no `three`.
 *
 * The map cell is `(floor(hit.x), floor(hit.z))`; a click near the origin of
 * cell `(cx, cy)` lands on that cell, and a click at the far corner of the
 * same cell lands on the *next* one, which is what "click to move here"
 * expects. Off-map coordinates (negative or ≥ 80/21) are still returned;
 * `findPath` bounds-checks them and returns null naturally.
 */
export function cellUnderRay(origin: Vec3, dir: Vec3): Cell | null {
  if (dir.y === 0) return null;
  const t = -origin.y / dir.y;
  if (!Number.isFinite(t) || t <= 0) return null;
  const hx = origin.x + t * dir.x;
  const hz = origin.z + t * dir.z;
  return { x: Math.floor(hx), y: Math.floor(hz) };
}

/** Structural DOM shapes — kept here so this module compiles under the root
 *  `tsconfig` (no DOM lib) for the `tests/travel.test.ts` compile pass. The
 *  browser's real `MouseEvent`/`HTMLCanvasElement` satisfy these at call sites. */
export interface MouseEventLike {
  clientX: number;
  clientY: number;
}

/** Minimal canvas surface we need for picking — just the client-space rect. */
export interface CanvasLike {
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}

/** Reusable raycaster + NDC vector — allocated once so a click doesn't churn GC. */
const RAYCASTER = new THREE.Raycaster();
const NDC = new THREE.Vector2();

/**
 * Turn a mouse event on top of `canvas` into the map cell under the cursor,
 * using `camera`'s projection. Returns `null` when the click is off the
 * canvas rectangle or the ray misses the floor.
 *
 * Uses three's `Raycaster.setFromCamera`, which does the right thing for both
 * `PerspectiveCamera` and `OrthographicCamera` (the fps/third view uses the
 * first, ortho the second). The heavy lifting stays in `cellUnderRay`.
 */
export function pickCellFromEvent(
  ev: MouseEventLike,
  canvas: CanvasLike,
  camera: THREE.Camera,
): Cell | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return null;
  NDC.x = (x / rect.width) * 2 - 1;
  NDC.y = -((y / rect.height) * 2 - 1);
  RAYCASTER.setFromCamera(NDC, camera);
  const o = RAYCASTER.ray.origin;
  const d = RAYCASTER.ray.direction;
  return cellUnderRay({ x: o.x, y: o.y, z: o.z }, { x: d.x, y: d.y, z: d.z });
}
