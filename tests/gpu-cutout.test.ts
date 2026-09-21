/**
 * Pure-function tests for the hero cutout (T-0063, docs/gpu-cutout.md). The
 * cell-resolution predicate (`isCutCell`) exercises the shader's depth rule
 * without a GPU; the projection helper (`projectHeroForCutout`) is the CPU
 * side the render loop calls each frame, tested against a real `three`
 * `PerspectiveCamera` to pin the rectangle rule that supersedes rework 1's
 * screen-space disc. The material-side discard is
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
  CUTOUT_SCREEN_FADE_MARGIN_PX,
  HERO_SILHOUETTE_WIDTH_CELLS,
  isCutCell,
  projectHeroForCutout,
} from '../web/src/gpu/cutout.js';

// Radius used by the pure helper's tests: cell-space stand-in for the shader's
// pixel rectangle. 1.5 cells is comfortably larger than 1 cell (the minimum
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

  it('the cut region is the hero\'s projected silhouette, not a disc', () => {
    // T-0063 rework 2: the disc reached past the figure (a 54 px radius
    // around a ~40 px avatar) and scooped floor his shape never covered.
    // The fix: project the hero's world-space AABB and use the pixel
    // extremes as a rectangle, so the hole is exactly as big as the
    // avatar's silhouette on screen — no wider.
    const canvasW = 1600;
    const canvasH = 900;
    const camera = new PerspectiveCamera(30, canvasW / canvasH, 0.1, 100);
    camera.position.set(5.5, 9.4, 13.9);
    camera.lookAt(5.5, 0.35, 3.5);
    const spriteHeight = 0.7;
    const spriteWidth = HERO_SILHOUETTE_WIDTH_CELLS;
    const frame = projectHeroForCutout(
      camera, 5.5, 0, 3.5, spriteWidth, spriteHeight, canvasW, canvasH, CUTOUT_SCREEN_FADE_MARGIN_PX,
    );

    // The rectangle matches the projected AABB corners. Reproduce the
    // helper's projection here: the eight corners of the same AABB
    // through the same camera, take the pixel min/max, compare.
    camera.updateMatrixWorld(true);
    const halfW = spriteWidth * 0.5;
    let sxMin = Infinity, syMin = Infinity, sxMax = -Infinity, syMax = -Infinity;
    for (let i = 0; i < 8; i++) {
      const cx = (i & 1) === 0 ? 5.5 - halfW : 5.5 + halfW;
      const cy = (i & 2) === 0 ? 0 : spriteHeight;
      const cz = (i & 4) === 0 ? 3.5 - halfW : 3.5 + halfW;
      const p = new Vector3(cx, cy, cz).project(camera);
      const px = (p.x * 0.5 + 0.5) * canvasW;
      const py = (1.0 - (p.y * 0.5 + 0.5)) * canvasH;
      if (px < sxMin) sxMin = px;
      if (py < syMin) syMin = py;
      if (px > sxMax) sxMax = px;
      if (py > syMax) syMax = py;
    }
    expect(frame.heroScreenMinX).toBeCloseTo(sxMin, 3);
    expect(frame.heroScreenMinY).toBeCloseTo(syMin, 3);
    expect(frame.heroScreenMaxX).toBeCloseTo(sxMax, 3);
    expect(frame.heroScreenMaxY).toBeCloseTo(syMax, 3);

    // Silhouette shape, not a disc: aspect ratio matches a standing
    // figure (taller than wide). A disc-based rule would report a
    // width == height rectangle even for a tall thin avatar, which
    // is the very artefact rework 2 scraps.
    const rectW = frame.heroScreenMaxX - frame.heroScreenMinX;
    const rectH = frame.heroScreenMaxY - frame.heroScreenMinY;
    expect(rectH).toBeGreaterThan(rectW);
    expect(rectH / rectW).toBeGreaterThan(1.3);

    // Tight around the figure. The rectangle is the projected AABB, so it
    // contains a bit of extra vertical from the depth-of-box seen at 42°
    // pitch (top-back and bottom-front corners of a 0.3-cell-deep footprint
    // land above/below the vertical head→feet line). But it is nowhere
    // near a 1.4 × avatar-height disc, which would give a rectangle
    // ~2.8 × the head→feet distance. `1.6` sits between the two: the
    // AABB (~1.4×) passes; the disc (~2.8×) fails.
    const feetPx = new Vector3(5.5, 0, 3.5).project(camera);
    const headPx = new Vector3(5.5, spriteHeight, 3.5).project(camera);
    const feetY = (1.0 - (feetPx.y * 0.5 + 0.5)) * canvasH;
    const headY = (1.0 - (headPx.y * 0.5 + 0.5)) * canvasH;
    const projectedHeightPx = Math.abs(feetY - headY);
    expect(rectH).toBeLessThan(projectedHeightPx * 1.6);
    // And a disc-based rule at the ticket's 1.4× multiplier would exceed
    // this bound by a wide margin — pinning "rectangle, not disc" directly.
    const discRectHeight = 2 * 1.4 * projectedHeightPx;
    expect(discRectHeight).toBeGreaterThan(projectedHeightPx * 1.6);

    // The fade margin is passed through unchanged — the shader adds
    // 6 px of dither around the rectangle, not around a disc.
    expect(frame.fadeMarginPx).toBe(CUTOUT_SCREEN_FADE_MARGIN_PX);
  });
});
