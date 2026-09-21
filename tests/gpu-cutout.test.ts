/**
 * Pure-function tests for the hero cutout (T-0058, docs/gpu-cutout.md). Every
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
  CUTOUT_RADIUS_CELLS,
  cutoutForwardFor,
  isCutCell,
} from '../web/src/gpu/cutout.js';

describe('gpu cutout — the Diablo cutout, in the material', () => {
  it('cutoutForwardFor points from the hero toward the camera and is horizontal', () => {
    // The ticket's third-person camera sits south of the hero at a 42° pitch
    // (docs/gpu-thirdperson.md §"Pose"), i.e. `camera.z > hero.z` and lifted
    // in world y. `cutoutForwardFor` must return the horizontal unit vector
    // pointing from the hero back to that camera so the fragment discard
    // rule reads "same direction" as `frag − hero` for anything on the
    // camera side of the hero — see the JSDoc for the sign convention.
    const hero = { x: 5, y: 0, z: 3 };
    const camera = { x: 5, y: 6, z: 15 };
    const f = cutoutForwardFor(camera, hero);
    // Horizontal: y = 0 regardless of the camera pitch. The 42° tilt of the
    // camera would otherwise leak into the discard geometry and make it
    // pitch-dependent — the whole point of a horizontal cutout is that a
    // steeper camera does not enlarge the hole under the hero.
    expect(f.y).toBe(0);
    // Unit magnitude in the horizontal plane. Bare `Math.hypot(dx, dz)`
    // catches a missing divide (the vector would then scale with distance,
    // breaking the dot-product predicate — 12 cells south should read the
    // same as 6 cells south).
    expect(Math.hypot(f.x, f.z)).toBeCloseTo(1);
    // Direction check: same signs as `camera − hero`. Anything else means
    // the vector points into the wall the ticket wants cut, and the discard
    // rule fires on the opposite side of the hero (walls behind, hero
    // still occluded). Camera due south → forward.z > 0; camera and hero
    // share x → forward.x = 0.
    expect(f.x).toBeCloseTo(0);
    expect(f.z).toBeGreaterThan(0);
    // A camera due east of the hero → forward.x > 0, forward.z = 0.
    const east = cutoutForwardFor({ x: 20, y: 4, z: 3 }, hero);
    expect(east.x).toBeGreaterThan(0);
    expect(east.z).toBeCloseTo(0);
    expect(east.y).toBe(0);
    // Degenerate case: camera and hero share a horizontal position. Returns
    // the zero vector so the shader's `dot(rel, 0) = 0` predicate produces
    // no cut. Anything else (e.g. NaN from a naive `/ 0`) corrupts the
    // uniform and takes the whole frame down with it.
    const same = cutoutForwardFor({ x: 5, y: 10, z: 3 }, hero);
    expect(same.x).toBe(0);
    expect(same.z).toBe(0);
    expect(same.y).toBe(0);
  });

  it('a cell between the hero and the camera within the radius is cut', () => {
    // Layout: hero at (5, 3), camera south of the hero. `cutoutForwardFor`
    // returns (0, 0, +1) — one unit toward +z (south, toward camera). Cells
    // on the camera side of the hero have `cellY > hero.y`; those inside
    // the default radius (2.5 cells) must be cut. Two representative cells
    // are pinned here: a cell directly south (aligned with the camera line)
    // and a diagonal south-east cell, both well inside the radius.
    const hero = { x: 5, y: 3 };
    const forward = cutoutForwardFor({ x: 5, y: 4, z: 10 }, { x: 5, y: 0, z: 3 });
    // Sanity: forward is due south (+z), zero on x. If this ever regresses,
    // the two `isCutCell` calls below silently fail against a wrong axis.
    expect(forward.z).toBeGreaterThan(0);
    expect(forward.x).toBeCloseTo(0);
    // Cell one south of the hero: distance 1, direction matches forward → cut.
    expect(isCutCell(5, 4, hero, forward, CUTOUT_RADIUS_CELLS)).toBe(true);
    // Cell two south + one east: distance √5 ≈ 2.24 (< 2.5), still on the
    // camera side (positive `dz`) → cut. This pins the disk-shaped extent,
    // not just the axis line.
    expect(isCutCell(6, 5, hero, forward, CUTOUT_RADIUS_CELLS)).toBe(true);
  });

  it('a cell behind the hero or outside the radius is not cut', () => {
    // Same layout as above. Two "not cut" cases the ticket rule requires:
    //   1. On the opposite side of the hero from the camera (`dz < 0`),
    //      even if within the radius — otherwise walls behind the hero
    //      would also be cut, hiding the room the hero came from.
    //   2. Outside the radius on the camera side (`dz > radius`), so the
    //      cutout is a keyhole, not a fog band that eats the whole level.
    const hero = { x: 5, y: 3 };
    const forward = cutoutForwardFor({ x: 5, y: 4, z: 10 }, { x: 5, y: 0, z: 3 });
    // 1: cell one north of the hero (opposite side). Distance 1 (< 2.5),
    // but `dz = −1` gives `dot(cell − hero, forward) < 0` → not cut.
    expect(isCutCell(5, 2, hero, forward, CUTOUT_RADIUS_CELLS)).toBe(false);
    // 2: cell three south of the hero. On the camera side, but distance 3
    // is beyond the 2.5-cell radius. If this fires, `CUTOUT_RADIUS_CELLS`
    // is not being respected and the whole southern corridor gets cut.
    expect(isCutCell(5, 6, hero, forward, CUTOUT_RADIUS_CELLS)).toBe(false);
    // The hero's own cell — a wall inside the hero cell shouldn't exist
    // in practice, but the predicate must be well-defined: `dist = 0`,
    // `dot = 0`, not strictly greater than zero → not cut.
    expect(isCutCell(5, 3, hero, forward, CUTOUT_RADIUS_CELLS)).toBe(false);
  });

  it('the cut set follows the camera as it rotates', () => {
    // The third-person camera can yaw around the hero (docs/gpu-thirdperson.md
    // §"The spring"); every yaw step reorients `cutoutForward` toward the
    // new camera position, so the cutout keyhole rotates with the camera.
    // Pin the rotation from "camera south" to "camera east": the *same*
    // wall cell moves from "cut" to "not cut" (rotates out of the keyhole)
    // and a different cell moves into it — the property that gives the
    // "cutout follows the camera" behaviour the ticket asks for.
    const hero = { x: 5, y: 3 };
    // Camera south → walls south of the hero get cut, east walls don't.
    const southForward = cutoutForwardFor({ x: 5, y: 4, z: 10 }, { x: 5, y: 0, z: 3 });
    expect(isCutCell(5, 4, hero, southForward, CUTOUT_RADIUS_CELLS)).toBe(true);
    expect(isCutCell(6, 3, hero, southForward, CUTOUT_RADIUS_CELLS)).toBe(false);
    // Rotate camera 90° to due east — same hero, same radius. Now the east
    // wall gets cut and the south wall does not: the cut set is a function
    // of the (camera relative to hero) direction, exactly the invariant
    // that makes the third-person view read the same at every yaw step.
    const eastForward = cutoutForwardFor({ x: 12, y: 4, z: 3 }, { x: 5, y: 0, z: 3 });
    expect(isCutCell(6, 3, hero, eastForward, CUTOUT_RADIUS_CELLS)).toBe(true);
    expect(isCutCell(5, 4, hero, eastForward, CUTOUT_RADIUS_CELLS)).toBe(false);
    // And nothing outside the radius rotates in — a wall three cells north-
    // east of the hero stays uncut even with the camera east, since
    // `√(1² + 3²) ≈ 3.16 > 2.5`. This pins the radius against a subtle
    // regression where a rotation would bleed the cutout beyond its disk.
    expect(isCutCell(6, 0, hero, eastForward, CUTOUT_RADIUS_CELLS)).toBe(false);
  });
});
