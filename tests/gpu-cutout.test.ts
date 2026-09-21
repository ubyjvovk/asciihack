/**
 * Pure-function tests for the hero cutout (T-0063, docs/gpu-cutout.md). The
 * cell-resolution predicate (`isCutCell`) exercises the shader's discard rule
 * without a GPU; the projection helper (`projectHeroForCutout`) is the CPU
 * side the render loop calls each frame, tested against a real `three`
 * `PerspectiveCamera` to catch the rework's "the radius is in world units,
 * not pixels" class of bug. The material-side discard is
 * `MeshStandardNodeMaterial.maskNode` in `web/src/gpu/materials.ts` and
 * cannot run without a WebGPU renderer; see `docs/gpu-cutout.md` §"What I
 * could not verify".
 *
 * Case names are the ticket's acceptance list — do not rename them, do not
 * add other tests.
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three/webgpu';
import {
  CUTOUT_DEPTH_BIAS_CELLS,
  CUTOUT_SCREEN_RADIUS_FACTOR,
  isCutCell,
  projectHeroForCutout,
} from '../web/src/gpu/cutout.js';

// Radius used by the pure helper's tests: cell-space stand-in for the shader's
// pixel radius. 1.5 cells is comfortably larger than 1 cell (the minimum
// horizontal separation between the hero cell centre and an adjacent-wall
// cell centre — 1 cell), and smaller than the depth to any of the "beside"
// or "behind" cases below, so the tests pin the depth test and the cone
// test independently rather than incidentally.
const SCREEN_RADIUS_CELLS = 1.5;

describe('gpu cutout — cut only what actually blocks the hero', () => {
  it('a cell nearer the camera than the hero and near him on screen is cut', () => {
    // Hero at map cell (5, 3); camera south of the hero, world (5.5, 4, 10)
    // (matches `docs/gpu-thirdperson.md` §"Pose" — south + lifted). A cell
    // between the hero and the camera is closer to the camera AND aligned
    // with the camera → hero ray, so it satisfies both the depth test and
    // the screen-radius cone: the wall clears.
    const hero = { x: 5, y: 3 };
    const camera = { x: 5.5, y: 4, z: 10 };
    // Cell one step south of the hero → depth ≈ 5.5, hero depth ≈ 6.5,
    // lateral offset ≈ 0. Well under `heroDepth − depthBias`, well inside
    // the cone.
    expect(isCutCell(5, 4, hero, camera, SCREEN_RADIUS_CELLS, CUTOUT_DEPTH_BIAS_CELLS)).toBe(true);
  });

  it('a cell beside the hero at the same depth is not cut', () => {
    // Same camera as above. A cell **beside** the hero (east/west) at the
    // hero's own row projects onto (or past) the hero's depth — it is not
    // strictly closer to the camera, so the depth test fails and the cell
    // is not cut. This is the case the previous world-space proximity rule
    // got wrong: a wall beside the hero triggered a hole even though it
    // never occluded him.
    const hero = { x: 5, y: 3 };
    const camera = { x: 5.5, y: 4, z: 10 };
    // Cell one east of the hero at the same row. Its projected depth
    // ≈ 6.6 (marginally past the hero's plane) — the depth test rejects.
    expect(isCutCell(6, 3, hero, camera, SCREEN_RADIUS_CELLS, CUTOUT_DEPTH_BIAS_CELLS)).toBe(false);
  });

  it('a cell behind the hero is never cut', () => {
    // Same camera. A cell **behind** the hero (further from the camera
    // than the hero) is at a greater view-space depth and never satisfies
    // "closer than the hero" — the depth test rejects even if the cell
    // is directly in the camera → hero ray. This is the rule that keeps
    // the room the hero came from opaque behind him.
    const hero = { x: 5, y: 3 };
    const camera = { x: 5.5, y: 4, z: 10 };
    // Cell one step north of the hero (opposite side from the camera).
    // Camera → hero is +z, cell is at hero.y − 1 (smaller z) → cellDepth
    // > heroDepth → not cut.
    expect(isCutCell(5, 2, hero, camera, SCREEN_RADIUS_CELLS, CUTOUT_DEPTH_BIAS_CELLS)).toBe(false);
  });

  it('the cut follows the camera as it rotates', () => {
    // The third-person camera can yaw around the hero (docs/gpu-thirdperson.md
    // §"The spring"); the depth test evaluates against the *live* camera →
    // hero direction, so a cell that was in the cone becomes safe and a
    // different cell rotates into it once the camera moves. Pin that
    // property with two orthogonal cameras and the same hero.
    const hero = { x: 5, y: 3 };
    // Camera south of the hero → the cell south of the hero is cut, the
    // cell east of the hero (same depth) is not.
    const southCam = { x: 5.5, y: 4, z: 10 };
    expect(isCutCell(5, 4, hero, southCam, SCREEN_RADIUS_CELLS, CUTOUT_DEPTH_BIAS_CELLS)).toBe(true);
    expect(isCutCell(6, 3, hero, southCam, SCREEN_RADIUS_CELLS, CUTOUT_DEPTH_BIAS_CELLS)).toBe(false);
    // Rotate camera 90° to due east. Now the cell east of the hero (closer
    // to the east camera than the hero) is cut, and the cell south of the
    // hero is at the same depth as the hero → not cut. Same hero, same
    // helper, same radius: the cutout follows the camera.
    const eastCam = { x: 12, y: 4, z: 3.5 };
    expect(isCutCell(6, 3, hero, eastCam, SCREEN_RADIUS_CELLS, CUTOUT_DEPTH_BIAS_CELLS)).toBe(true);
    expect(isCutCell(5, 4, hero, eastCam, SCREEN_RADIUS_CELLS, CUTOUT_DEPTH_BIAS_CELLS)).toBe(false);
  });

  it('the screen radius is in pixels and scales with the viewport', () => {
    // T-0063 rework: attempt 1 derived `heroScreenPx` from
    // `HERO_SPRITE_HEIGHT · canvasH / (2·d·tan(fov/2))`. That treats the
    // avatar as a segment perpendicular to the view direction, but the
    // third-person camera is pitched 42° down — so a vertical world
    // segment projects *shorter* than the formula predicts, and the cutout
    // scooped a wide arc out of walls that never blocked the hero.
    //
    // The fix: project the hero's head and feet through the live camera
    // and take the pixel distance between them as the on-screen height.
    // This test pins the number against that projected distance (not a
    // constant) and pins the "in pixels" claim by doubling the canvas.
    const canvasW = 1600;
    const canvasH = 900;
    // Third-person defaults: fov 30°, pitch 42°, distance ~14 cells.
    const camera = new PerspectiveCamera(30, canvasW / canvasH, 0.1, 100);
    camera.position.set(5.5, 9.4, 13.9);
    camera.lookAt(5.5, 0.35, 3.5);
    const spriteHeight = 0.7;
    const factor = CUTOUT_SCREEN_RADIUS_FACTOR;
    const frame = projectHeroForCutout(camera, 5.5, spriteHeight * 0.5, 3.5, spriteHeight, canvasW, canvasH, factor);

    // Camera aimed at the hero's mid-height → hero projects near the middle
    // of the canvas. Loose tolerance: the point is that the projection is
    // running, not that lookAt is byte-exact.
    expect(frame.heroScreenX).toBeCloseTo(canvasW / 2, 0);
    expect(frame.heroScreenY).toBeCloseTo(canvasH / 2, 0);
    expect(frame.heroCamDist).toBeGreaterThan(0);

    // Radius pinned against a projected height, not a constant: reproduce
    // the head→feet pixel distance the helper computes and assert 1.4× it.
    // Attempt 1's camera-space formula gave a value ~30 % larger than this
    // because it ignored the pitch foreshortening; that is the regression
    // this case blocks.
    camera.updateMatrixWorld(true);
    const feetNDC = new Vector3(5.5, 0, 3.5).project(camera);
    const headNDC = new Vector3(5.5, spriteHeight, 3.5).project(camera);
    const dxPx = (headNDC.x - feetNDC.x) * 0.5 * canvasW;
    const dyPx = -(headNDC.y - feetNDC.y) * 0.5 * canvasH;
    const projectedHeightPx = Math.hypot(dxPx, dyPx);
    expect(frame.screenRadiusPx).toBeCloseTo(factor * projectedHeightPx, 3);
    // Sanity: the perpendicular-segment formula overestimates by more than
    // one pixel. If a future refactor slid back into it, this catches it.
    const fovRad = (camera.fov * Math.PI) / 180;
    const perpendicularHeightPx = spriteHeight * canvasH / (2 * frame.heroCamDist * Math.tan(fovRad * 0.5));
    expect(perpendicularHeightPx - projectedHeightPx).toBeGreaterThan(1);

    // Scales with the viewport: doubling both canvas dimensions doubles
    // every pixel number the helper returns. If the radius were a world-
    // unit value (the reworker's hypothesis), the number would be the same
    // at both resolutions.
    const bigger = projectHeroForCutout(camera, 5.5, spriteHeight * 0.5, 3.5, spriteHeight, canvasW * 2, canvasH * 2, factor);
    expect(bigger.screenRadiusPx).toBeCloseTo(frame.screenRadiusPx * 2, 3);
    expect(bigger.heroScreenX).toBeCloseTo(frame.heroScreenX * 2, 3);
    expect(bigger.heroScreenY).toBeCloseTo(frame.heroScreenY * 2, 3);
    // `heroCamDist` is a world-space distance — invariant under a canvas
    // resize (the camera did not move).
    expect(bigger.heroCamDist).toBeCloseTo(frame.heroCamDist, 3);
  });
});
