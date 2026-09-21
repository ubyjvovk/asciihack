/**
 * Pure helpers that bring the browser's 3/4 overhead ortho view onto the GPU
 * render path (T-0043, docs/gpu-ortho.md).
 *
 * The frustum maths (`orthoPlacement`, `cutawayCellsFor`, `HERO_SPRITE_HEIGHT`
 * etc.) is already in `web/src/gl/ortho-camera.ts` and is reused **unchanged**;
 * this file only adds the plumbing the ported afterburn scene needs on top:
 *
 * - `applyOrthoPlacementTo(cam, p)` copies an `OrthoPlacement` onto a
 *   `three/webgpu`-flavoured `OrthographicCamera` the same way
 *   `placeOrthoCamera` copies it onto a `three` (legacy) one — position,
 *   up, look target, frustum sides, near/far. Accepts a structural stand-in
 *   so tests can hand it a plain object and pin the "applied unchanged"
 *   contract without instantiating a real camera.
 * - `cutawayKey(hero)` builds the memoisation key `GpuPath` uses to skip
 *   rebuilding the ghost mesh when the hero cell has not moved: the ortho
 *   cutaway set is a pure function of the hero cell (`cutawayCellsFor`), so
 *   two frames with the same hero share one ghost mesh.
 * - `orthoDofFocus(p)` returns the DOF focus + range that keeps the whole
 *   ortho scene sharp. The mood table sets focus ≈ 5 m for the fps camera
 *   (right on top of the dungeon); the ortho camera sits `ORTHO_DISTANCE_CELLS`
 *   metres out, and afterburn's DOF blurs everything beyond `focus + focusRange`
 *   metres from the camera, so the fps values render the whole board out of
 *   focus.
 * - `pipelineCameraForView(view, cams)` picks which of the two cameras the
 *   pipeline is rebuilt against on a view change (T-0050). The previous
 *   T-0043 approach copied the ortho projection onto a `PerspectiveCamera`,
 *   which produced a black frame because the graph derived its own uniforms
 *   from the still-perspective reference — this helper hands the graph the
 *   real `OrthographicCamera` so `isOrthographicCamera` is true where three
 *   checks it.
 *
 * Pure: no `three` / `three/webgpu` import, no DOM. `tests/gpu-ortho.test.ts`
 * exercises every case in node under the root tsconfig.
 */
import type { OrthoPlacement } from '../gl/ortho-camera.js';

/**
 * Structural stand-in for a `three` / `three/webgpu` `OrthographicCamera` —
 * only the fields `applyOrthoPlacementTo` writes. Both real cameras satisfy
 * this shape, and a test can hand in a plain object.
 */
export interface OrthoCameraLike {
  position: { set(x: number, y: number, z: number): unknown };
  up: { set(x: number, y: number, z: number): unknown };
  lookAt(x: number, y: number, z: number): unknown;
  left: number;
  right: number;
  top: number;
  bottom: number;
  near: number;
  far: number;
  updateProjectionMatrix(): unknown;
}

/**
 * Copy an `OrthoPlacement` (from `web/src/gl/ortho-camera.ts`) onto `cam`.
 * The frustum sides, near/far, position and look target land byte-for-byte
 * from `p`, and `updateProjectionMatrix()` is called last so downstream
 * consumers see fresh matrices. Pure aside from the mutations on `cam`.
 */
export function applyOrthoPlacementTo(cam: OrthoCameraLike, p: OrthoPlacement): void {
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
 * Memoisation key for the ortho cutaway set. `cutawayCellsFor(hero)` in
 * `ortho-camera.ts` is a pure function of the hero cell — two frames with
 * the same hero produce the same set — so this key changes iff the hero
 * moves, and `GpuPath` uses it to skip a ghost-mesh rebuild.
 */
export function cutawayKey(hero: { x: number; y: number }): string {
  return `${hero.x},${hero.y}`;
}

/** DOF focus + focus range (both in metres) computed from an ortho placement. */
export interface OrthoDof {
  /** Focus distance in metres — camera-to-target for the ortho placement. */
  focus: number;
  /** Full focus range in metres — a slab wide enough to include the whole
   *  visible scene, so the DOF pass leaves ortho frames looking sharp. */
  focusRange: number;
}

/**
 * DOF focus and range for the ortho camera. Afterburn's mood table pins
 * focus ≈ 5 m for the fps view (the camera is inside the dungeon); the ortho
 * camera sits ~40 m out and needs its focal plane moved to match, plus a
 * range that covers the whole board — everything within `focus ± focusRange`
 * renders sharp, so a range equal to the camera distance keeps the near
 * plane through past the target inside the sharp slab.
 */
export function orthoDofFocus(p: OrthoPlacement): OrthoDof {
  const dx = p.position.x - p.target.x;
  const dy = p.position.y - p.target.y;
  const dz = p.position.z - p.target.z;
  const focus = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return { focus, focusRange: focus };
}

/** The pair of cameras `GpuPath` keeps — one perspective for fps, one
 *  orthographic for the 3/4 overhead view. Generic so the pure test can hand
 *  in plain sentinels while the runtime hands in real `three/webgpu`
 *  cameras. */
export interface ViewCameras<P, O> {
  perspective: P;
  orthographic: O;
}

/**
 * Which of the two cameras the GPU pipeline is rebuilt against for a given
 * view (T-0050). Ortho gets the `OrthographicCamera` so `pass(scene, camera)`
 * and every projection-aware node (SSGI/SSR/TRAA/DOF) read a real ortho
 * projection — the previous "copy the projection matrix onto a perspective
 * camera" trick produced a black frame because the graph derived its own
 * uniforms from the still-`isPerspectiveCamera === true` reference. Fps takes
 * the perspective camera back so the projection is restored on F3-back.
 *
 * Pure — same shape as `pipelineOptionsWithEnv` in `web/src/gpu/path.ts`, so
 * `tests/gpu-ortho.test.ts` can inject a `setCamera` stub and pin the wiring
 * without instantiating a `WebGPURenderer`.
 */
export function pipelineCameraForView<P, O>(
  view: 'fps' | 'ortho',
  cams: ViewCameras<P, O>,
): P | O {
  return view === 'ortho' ? cams.orthographic : cams.perspective;
}
