/**
 * Pure-function tests for the ortho view on the GPU render path (T-0043,
 * docs/gpu-ortho.md). Every case exercises `web/src/gpu/ortho.ts`, whose
 * helpers stay `three`-free so this file compiles under the root tsconfig
 * (no DOM lib) — the impure wiring in `GpuPath` (ceiling toggle, ghost mesh,
 * per-frame DOF override) is inside a browser-only class and cannot be
 * tested here; see `docs/gpu-ortho.md` §"what I could not verify".
 *
 * Case names are the ticket's acceptance list — do not rename them.
 */
import { describe, expect, it } from 'vitest';
import { HERO_SPRITE_HEIGHT, orthoPlacement, ORTHO_DISTANCE_CELLS } from '../web/src/gl/ortho-camera.js';
import {
  applyOrthoPlacementTo,
  cutawayKey,
  FPS_FOG_DENSITY,
  moodFogDensityForView,
  orthoDofFocus,
  ORTHO_FOG_DENSITY,
  pipelineCameraForView,
  THIRD_FOG_DENSITY,
} from '../web/src/gpu/ortho.js';
import { THIRD_DIST_DEFAULT_CELLS } from '../web/src/gpu/thirdperson.js';

/** In-memory stand-in for an `OrthographicCamera` — records everything
 *  `applyOrthoPlacementTo` writes, so the test can assert against it without
 *  pulling in `three` or `three/webgpu`. */
function fakeOrthoCamera(): {
  position: { x: number; y: number; z: number };
  up: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  left: number; right: number; top: number; bottom: number;
  near: number; far: number;
  updateCalls: number;
  set: (x: number, y: number, z: number) => void;
  lookAt: (x: number, y: number, z: number) => void;
  updateProjectionMatrix: () => void;
  // shim getters that `applyOrthoPlacementTo` calls through `.set`.
  positionSetter: { set: (x: number, y: number, z: number) => void };
  upSetter: { set: (x: number, y: number, z: number) => void };
} {
  const cam = {
    position: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    target: { x: 0, y: 0, z: 0 },
    left: -1, right: 1, top: 1, bottom: -1,
    near: 0.1, far: 100,
    updateCalls: 0,
  } as ReturnType<typeof fakeOrthoCamera>;
  cam.positionSetter = { set(x: number, y: number, z: number): void { cam.position = { x, y, z }; } };
  cam.upSetter = { set(x: number, y: number, z: number): void { cam.up = { x, y, z }; } };
  cam.set = (x: number, y: number, z: number): void => { cam.position = { x, y, z }; };
  cam.lookAt = (x: number, y: number, z: number): void => { cam.target = { x, y, z }; };
  cam.updateProjectionMatrix = (): void => { cam.updateCalls++; };
  return cam;
}

describe('gpu ortho — the ported afterburn view over the ortho camera', () => {
  it('the ortho frustum from placeOrthoCamera is applied unchanged to the GPU camera', () => {
    const hero = { x: 40, y: 10 };
    const cols = 80, rows = 21, cellAspect = 2;
    const p = orthoPlacement(hero, cols, rows, cellAspect);

    // A structural stand-in with the same shape as WG.OrthographicCamera —
    // `applyOrthoPlacementTo` only touches `position.set`, `up.set`,
    // `lookAt`, the frustum fields, near/far, and `updateProjectionMatrix`.
    const fake = fakeOrthoCamera();
    const cam = {
      position: fake.positionSetter,
      up: fake.upSetter,
      lookAt: fake.lookAt,
      left: fake.left, right: fake.right, top: fake.top, bottom: fake.bottom,
      near: fake.near, far: fake.far,
      updateProjectionMatrix: fake.updateProjectionMatrix,
    };
    applyOrthoPlacementTo(cam, p);

    // The frustum sides land byte-for-byte from `orthoPlacement` — the
    // "applied unchanged" contract. If a future refactor tries to be clever
    // and, say, rescale for pixel ratio here, this pins it down.
    expect(cam.left).toBe(p.left);
    expect(cam.right).toBe(p.right);
    expect(cam.top).toBe(p.top);
    expect(cam.bottom).toBe(p.bottom);
    expect(cam.near).toBe(p.near);
    expect(cam.far).toBe(p.far);
    // Position and look target also match exactly (numbers, not rounded).
    expect(fake.position.x).toBe(p.position.x);
    expect(fake.position.y).toBe(p.position.y);
    expect(fake.position.z).toBe(p.position.z);
    expect(fake.target.x).toBe(p.target.x);
    expect(fake.target.y).toBe(p.target.y);
    expect(fake.target.z).toBe(p.target.z);
    // Sanity: frustum height is `7 · HERO_SPRITE_HEIGHT` (same rule as fps).
    expect(cam.top - cam.bottom).toBeCloseTo(7 * HERO_SPRITE_HEIGHT);
    // And `updateProjectionMatrix` was called once so downstream consumers
    // see the new projection this frame.
    expect(fake.updateCalls).toBe(1);
  });

  it('the cutaway set changes only when the hero cell changes', () => {
    // The ortho cutaway set is a pure function of the hero cell (all its
    // inputs are the hero's `x` and `y` — see `cutawayCellsFor`), so the
    // memoisation key `GpuPath` uses to skip a ghost-mesh rebuild must stay
    // stable frame-to-frame at the same hero and move iff the hero moves.
    const k1 = cutawayKey({ x: 10, y: 10 });
    const k2 = cutawayKey({ x: 10, y: 10 });
    expect(k2).toBe(k1); // same hero → same key, so the ghost mesh is reused
    expect(cutawayKey({ x: 11, y: 10 })).not.toBe(k1); // east step moves the key
    expect(cutawayKey({ x: 10, y: 11 })).not.toBe(k1); // south step too
    // Distinct hero cells produce distinct keys — no accidental collisions
    // between neighbouring cells and their sums or diagonals.
    expect(cutawayKey({ x: 1, y: 20 })).not.toBe(cutawayKey({ x: 20, y: 1 }));
    expect(cutawayKey({ x: 2, y: 3 })).not.toBe(cutawayKey({ x: 23, y: 0 }));
  });

  it('switching to the ortho view rebuilds the graph against an orthographic camera', () => {
    // T-0050: the T-0043 approach copied the ortho projection matrix onto the
    // pipeline's perspective camera; the graph derived its own uniforms from
    // the still-`isPerspectiveCamera === true` reference and rendered a black
    // frame. The fix hands the graph the real `OrthographicCamera` on F3 —
    // `pipelineCameraForView('ortho', ...)` returns it, `GpuPath` passes that
    // to `PipelineHandle.setCamera`, and `build()` rebinds `pass(scene, ...)`
    // against it so `camera.isOrthographicCamera` is true where three checks
    // it (SSR/TRAA branch on it, SSGI is demoted to GTAO in `build()`).
    //
    // Stub `setCamera` in place of the real handle, the same way
    // `tests/gpu-compose.test.ts` stubs the pipeline factory for the mood
    // environment wiring — the assertion is that ortho hands over the
    // orthographic camera reference and fps hands the perspective one back.
    const perspective = { isPerspectiveCamera: true as const };
    const orthographic = { isOrthographicCamera: true as const };
    let received: unknown = null;
    const setCamera = (cam: unknown): void => { received = cam; };
    setCamera(pipelineCameraForView('ortho', { perspective, orthographic }));
    expect(received).toBe(orthographic);
    expect((received as { isOrthographicCamera?: boolean }).isOrthographicCamera).toBe(true);
    // The fps direction hands back the perspective camera — without this, F3
    // would leave an ortho projection in the graph after returning to fps.
    setCamera(pipelineCameraForView('fps', { perspective, orthographic }));
    expect(received).toBe(perspective);
  });

  it('the camera bound to the graph carries the ortho placement', () => {
    // T-0050 rework 2: T-0043's first test (case 1 above) pins the placement
    // math on a *bare* camera-like — it never proves the reference that
    // reaches `PipelineHandle.setCamera` is the same one the placement was
    // written to. This case drives the exact sequence `GpuPath.render` runs
    // on an ortho frame (place → setCamera), through a stub pipeline factory
    // that records the received camera, and asserts every field
    // `orthoPlacement` returns — position, frustum bounds, near/far — lands
    // on that recorded reference. Before this, a `debugInfo()` report of
    // "position (0,0,0), frustum ±1, near 0.1, far 100" (the untouched
    // legacy default) could pass every existing case: nothing pinned that
    // the camera bound to the graph is the placement target.
    const perspective = { isPerspectiveCamera: true as const };
    const fake = fakeOrthoCamera();
    const orthographic = {
      isOrthographicCamera: true as const,
      position: fake.positionSetter,
      up: fake.upSetter,
      lookAt: fake.lookAt,
      left: fake.left, right: fake.right, top: fake.top, bottom: fake.bottom,
      near: fake.near, far: fake.far,
      updateProjectionMatrix: fake.updateProjectionMatrix,
    };

    // Stub pipeline handle: same shape as `PipelineHandle.setCamera`. Records
    // every received reference so the assertion can pin down reference
    // identity, not just field values.
    const bound: unknown[] = [];
    const handle = { setCamera: (cam: unknown): void => { bound.push(cam); } };

    // Mirror `GpuPath.render(...)` in ortho — the per-frame branch:
    //   1) compute the placement for the hero cell + viewport grid,
    //   2) write it to the ortho camera the class holds a reference to,
    //   3) on a view change, hand `pipelineCameraForView(view, cams)` to
    //      `handle.setCamera` (see `web/src/gl/gl-viewport.ts::GpuPath.render`).
    const hero = { x: 40, y: 10 };
    const cols = 80, rows = 21;
    const p = orthoPlacement(hero, cols, rows, 2);
    applyOrthoPlacementTo(orthographic, p);
    handle.setCamera(pipelineCameraForView('ortho', { perspective, orthographic }));

    // The reference the graph is now bound to is the ortho camera we wrote
    // the placement to — same object identity. This is the invariant
    // T-0043's first test never pinned.
    expect(bound).toHaveLength(1);
    expect(bound[0]).toBe(orthographic);

    // Every field `orthoPlacement` returns is present on that same reference.
    // Position: `applyOrthoPlacementTo` calls `cam.position.set(...)`; the
    // fake camera's `positionSetter.set` mutates `fake.position` in place,
    // so reading it back verifies the placement landed on the bound camera.
    expect(fake.position.x).toBe(p.position.x);
    expect(fake.position.y).toBe(p.position.y);
    expect(fake.position.z).toBe(p.position.z);
    // Look target — same story via `cam.lookAt(...)` → `fake.target`.
    expect(fake.target.x).toBe(p.target.x);
    expect(fake.target.y).toBe(p.target.y);
    expect(fake.target.z).toBe(p.target.z);
    // Frustum bounds land byte-for-byte from `orthoPlacement` on the very
    // reference `handle.setCamera` received (this is the important part).
    const boundOrtho = bound[0] as {
      left: number; right: number; top: number; bottom: number;
      near: number; far: number;
    };
    expect(boundOrtho.left).toBe(p.left);
    expect(boundOrtho.right).toBe(p.right);
    expect(boundOrtho.top).toBe(p.top);
    expect(boundOrtho.bottom).toBe(p.bottom);
    expect(boundOrtho.near).toBe(p.near);
    expect(boundOrtho.far).toBe(p.far);
    // And `updateProjectionMatrix` fired once — so downstream projection
    // maths on the graph read the fresh matrix, not the constructor default.
    expect(fake.updateCalls).toBe(1);
  });

  it('the ortho view scales the mood fog density by the ortho/fps ratio', () => {
    // T-0050 rework 3: even after the camera-rebuild fix and the honest
    // `debugInfo()` snapshot, the ortho view rendered black at every quality
    // tier — including `q=low` (bloom + FXAA + grade only, no SSGI/SSR/god
    // rays/DOF/TRAA). The camera was placed correctly and the geometry was
    // there; the mood's fog was eating the scene. `FogExp2` survival is
    // `e^(−density·distance)`: at torchlit's density 0.10 and the ortho
    // camera's ~40-unit stand-off, only 1.8 % of the scene reaches the eye,
    // and against the near-black fog colour (`0x0b0d10`) every pixel lands
    // under the black point. Scaling by `ORTHO_FOG_DENSITY / FPS_FOG_DENSITY`
    // (= 0.1) is exactly what the legacy path already does for the same
    // reason (T-0032). `moodFogDensityForView` is applied *after* the mood
    // blend, so deep_dark's heavier fog stays proportionally heavier than
    // torchlit's — the scale is multiplicative, not a clamp.
    const torchlit = 0.10;   // MOODS.torchlit.fog.density
    const deepDark = 0.20;   // MOODS.deep_dark.fog.density — visibly heavier
    // The fps view passes both densities through unchanged: the mood table's
    // values are already tuned for a camera at the hero cell.
    expect(moodFogDensityForView('fps', torchlit)).toBe(torchlit);
    expect(moodFogDensityForView('fps', deepDark)).toBe(deepDark);
    // The ortho view scales by `ORTHO_FOG_DENSITY / FPS_FOG_DENSITY` — the
    // exact ratio T-0032 established for the legacy 3/4 camera at the same
    // distance. Reuses the two exported constants; no third number introduced.
    const ratio = ORTHO_FOG_DENSITY / FPS_FOG_DENSITY;
    expect(moodFogDensityForView('ortho', torchlit)).toBeCloseTo(torchlit * ratio);
    expect(moodFogDensityForView('ortho', deepDark)).toBeCloseTo(deepDark * ratio);
    // Proportional heaviness preserved: `deep_dark / torchlit` is the same
    // in both views. Without this the ortho scale would flatten the mood
    // table's expressive range — deep_dark would look the same as torchlit.
    const fpsRatio = moodFogDensityForView('fps', deepDark) / moodFogDensityForView('fps', torchlit);
    const orthoRatio = moodFogDensityForView('ortho', deepDark) / moodFogDensityForView('ortho', torchlit);
    expect(orthoRatio).toBeCloseTo(fpsRatio);
    // And the scale actually pulls the frame back into visible territory:
    // e^(−0.01·40) ≈ 67 %, vs e^(−0.10·40) ≈ 1.8 % before. Pinned as an
    // integer percentage so a future retune keeps the ortho view visible.
    const survivalPct = Math.exp(-moodFogDensityForView('ortho', torchlit) * ORTHO_DISTANCE_CELLS) * 100;
    expect(survivalPct).toBeGreaterThan(50);
  });

  it('the third-person view uses its own fog density, between fps and ortho', () => {
    // T-0054: the T-0052 helper mapped `'third'` → `'fps'` on the assumption
    // that `e^(−0.10 · 10.7) ≈ 34 %` fog survival was "atmospheric". The PM's
    // shot proved otherwise — mean luminance over the same frame, same pose,
    // same mood:
    //
    //   view       mean
    //   fps        54.0
    //   ortho      28.8
    //   third       8.0   ← the mapping to fps left the diorama in a cave
    //
    // 34 % survival plus the ported pipeline's inverse-square falloff over
    // ~10 cells was too much loss. `THIRD_FOG_DENSITY = 0.04` gives
    // `e^(−0.04 · 10.7) ≈ 65 %` — atmospheric rather than black. Sits between
    // the fps and ortho knobs and is scaled through `moodFogDensityForView`
    // the same way the ortho path already does, so `deep_dark`'s heavier fog
    // stays proportionally heavier than `torchlit`'s in the third view too.
    const torchlit = 0.10;   // MOODS.torchlit.fog.density
    const deepDark = 0.20;   // MOODS.deep_dark.fog.density — visibly heavier
    // The constant itself sits between ortho and fps — the ordering encodes
    // "how much of the scene the eye sees" at each camera distance.
    expect(THIRD_FOG_DENSITY).toBeGreaterThan(ORTHO_FOG_DENSITY);
    expect(THIRD_FOG_DENSITY).toBeLessThan(FPS_FOG_DENSITY);
    // Third-view scale is `THIRD_FOG_DENSITY / FPS_FOG_DENSITY` — same shape
    // as the ortho path. Reuses the exported constants; no third magic number.
    const thirdRatio = THIRD_FOG_DENSITY / FPS_FOG_DENSITY;
    expect(moodFogDensityForView('third', torchlit)).toBeCloseTo(torchlit * thirdRatio);
    expect(moodFogDensityForView('third', deepDark)).toBeCloseTo(deepDark * thirdRatio);
    // Third-view density sits between the fps pass-through and the ortho
    // scale for the same mood — the eye's ordering by camera distance.
    expect(moodFogDensityForView('third', torchlit)).toBeLessThan(moodFogDensityForView('fps', torchlit));
    expect(moodFogDensityForView('third', torchlit)).toBeGreaterThan(moodFogDensityForView('ortho', torchlit));
    // Proportional heaviness preserved: `deep_dark / torchlit` is the same in
    // every view. Without this the third-view scale would flatten the mood
    // table's expressive range — deep_dark would look the same as torchlit.
    const fpsRatio = moodFogDensityForView('fps', deepDark) / moodFogDensityForView('fps', torchlit);
    const thirdViewRatio = moodFogDensityForView('third', deepDark) / moodFogDensityForView('third', torchlit);
    expect(thirdViewRatio).toBeCloseTo(fpsRatio);
    // And the scale lands the frame back in the 65 % survival band the ticket
    // asked for, at the default `THIRD_DIST_DEFAULT_CELLS ≈ 10.7`. Pinned to
    // catch a retune that walks the number back toward the old 34 %.
    const survivalPct = Math.exp(-moodFogDensityForView('third', torchlit) * THIRD_DIST_DEFAULT_CELLS) * 100;
    expect(survivalPct).toBeGreaterThan(60); // 65.7 % at the 14-cell default
    expect(survivalPct).toBeLessThan(75);
  });

  it('every view routes its own name to the fog helper', () => {
    // T-0054 rework: the helper's three-branch signature was correct in
    // attempt 1, but its one runtime caller at `gl-viewport.ts::GpuPath.render`
    // still read `moodFogDensityForView(view === 'ortho' ? 'ortho' : 'fps', …)`
    // — mapping `'third'` back to `'fps'` before the helper ever saw it, so
    // the new THIRD_FOG_DENSITY branch was dead code and the third-view
    // frame stayed at mean luminance 8.0 (against 54.0 fps / 28.8 ortho).
    // The fix is to pass `view` straight through. This case pins the
    // routing against a recorded call — not the helper in isolation, which
    // case 6 above already covers.
    //
    // Mirror the exact one-liner at `gl-viewport.ts::GpuPath.render` (see
    // the T-0054 comment on `this.fogDensity.value = moodFogDensityForView(
    // view, currentMood.fog.density)`): drive the helper through a recorder
    // and iterate every `ViewName` the render flow accepts. If a future
    // edit re-introduces a `view === 'ortho' ? 'ortho' : 'fps'` collapse,
    // the recorded first argument no longer matches `view` and this fails.
    const density = 0.10;
    const seen: Array<'fps' | 'ortho' | 'third'> = [];
    const record = (view: 'fps' | 'ortho' | 'third', d: number): number => {
      seen.push(view);
      return moodFogDensityForView(view, d);
    };
    for (const view of ['fps', 'ortho', 'third'] as const) {
      record(view, density);
    }
    // Every view's own name reaches the helper — 'third' is not collapsed
    // to 'fps', 'ortho' is not collapsed to 'fps' either.
    expect(seen).toEqual(['fps', 'ortho', 'third']);
    // Distinct densities out — a regression that keeps the first argument
    // correct but pre-scales the second would show two views tied.
    const outputs = (['fps', 'ortho', 'third'] as const).map((v) =>
      moodFogDensityForView(v, density),
    );
    expect(new Set(outputs).size).toBe(3);
    // And the third-view branch actually fires when its name is routed
    // straight through — the exact regression the previous attempt shipped
    // was `moodFogDensityForView('fps', density) === density`, i.e. the
    // third-view frame ran at the fps density. Pinning `!==` here catches
    // any future re-collapse.
    expect(moodFogDensityForView('third', density)).not.toBe(
      moodFogDensityForView('fps', density),
    );
  });

  it('DOF focus follows the ortho camera distance', () => {
    // The ortho camera sits `ORTHO_DISTANCE_CELLS` metres out along the
    // camera-to-target line, so `orthoDofFocus` returns that same distance —
    // afterburn's fps mood focuses at ≈ 5 m and would blur the whole board
    // if we did not shift the focal plane out for the ortho view.
    const p = orthoPlacement({ x: 40, y: 10 }, 80, 21);
    const dof = orthoDofFocus(p);
    expect(dof.focus).toBeCloseTo(ORTHO_DISTANCE_CELLS);
    // Distance derived directly from the placement matches `focus` — the
    // point of the helper: focus tracks the camera-to-target distance, not
    // a hardcoded 40.
    const dx = p.position.x - p.target.x;
    const dy = p.position.y - p.target.y;
    const dz = p.position.z - p.target.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    expect(dof.focus).toBeCloseTo(distance);
    // Range at least as wide as the focus distance — enough that everything
    // from the near plane through past the target lands inside the sharp
    // slab. If a future tuning tightens the range, this catches it going
    // too narrow to cover the visible scene.
    expect(dof.focusRange).toBeGreaterThanOrEqual(dof.focus);
    // A different hero (closer to the map edge) shifts position/target but
    // keeps the camera-to-target distance constant by construction, so
    // focus is stable across hero moves — this is the property the DOF
    // override relies on to hand the same value every frame.
    const q = orthoPlacement({ x: 5, y: 5 }, 80, 21);
    expect(orthoDofFocus(q).focus).toBeCloseTo(dof.focus);
  });
});
