/**
 * Pure-function tests for the hero cutout (T-0063, docs/gpu-cutout.md). Every
 * case exercises `web/src/gpu/cutout.ts`, whose helpers stay `three`-free so
 * this file compiles under the root tsconfig (no DOM lib) — the material-side
 * discard is `MeshStandardNodeMaterial.maskNode` in `web/src/gpu/materials.ts`
 * and cannot run without a WebGPU renderer; see `docs/gpu-cutout.md` §"What I
 * could not verify".
 *
 * Case names are the ticket's acceptance list — do not rename them.
 */
import { describe, expect, it } from 'vitest';
import {
  CUTOUT_DEPTH_BIAS_CELLS,
  isCutCell,
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
});
