# Hero cutout on the GPU render path

*T-0058. Read `docs/gpu-ortho.md` §"What (a) does not deliver" and
`docs/gpu-thirdperson.md` §"Pose" first — this file is the follow-up they
name.*

## Why

In `third` and `ortho`, the camera sits south of the hero at a 42° pitch
(`docs/gpu-thirdperson.md` §"Pose"). Any wall between the two occludes the
player. `docs/gpu-ortho.md` §"What (a) does not deliver — and the follow-up"
already recorded why the ghost-mesh cutaway T-0043 shipped **cannot fix
this**: the GPU dungeon is one merged geometry per chunk, so individual wall
cells cannot be hidden the way the legacy `InstancedMesh` hides them by
collapsing their matrix to `scale = 0`. The ghost mesh is an overlay drawn
*on top of* the still-opaque wall — the hero is still partly hidden behind
the real thing.

This ticket ships option (b), the material-side clip volume. The wall stays
opaque everywhere except a small "keyhole" the hero reads through: a
per-fragment `discard` driven by the hero cell centre and the camera
direction.

## The rule

Uniform block (`web/src/gpu/materials.ts::CUTOUT`, written from
`gl-viewport.ts::GpuPath.render`):

| uniform          | type   | default    | meaning                                             |
|------------------|--------|------------|-----------------------------------------------------|
| `enabled`        | float  | 0          | 1 in `third`/`ortho`, 0 in `fps`                    |
| `center`         | vec3   | (0, 0, 0)  | Hero cell centre `(heroX + 0.5, 0, heroY + 0.5)`    |
| `forward`        | vec3   | (0, 0, 0)  | Horizontal unit vector, **hero → camera** (y = 0)   |
| `radius`         | float  | 2.5 cells  | `CUTOUT_RADIUS_CELLS`                               |
| `fade`           | float  | 0.8 cells  | `CUTOUT_FADE_CELLS`, the screen-door soft edge      |

A fragment is discarded when **all** of:

1. **It is on the camera side of the hero** —
   `dot(fragWorld − center, forward) > 0`. `forward` is the hero → camera
   direction (see the test case
   `cutoutForwardFor points from the hero toward the camera and is horizontal`
   in `tests/gpu-cutout.test.ts`), so a fragment on that side has
   `frag − hero` and `forward` pointing the same way.
2. Its horizontal distance to `center` is under `radius`.
3. Its world Y is above the floor
   (`> CUTOUT_FLOOR_EPSILON = 0.05`) — we never cut the floor plane out
   from under the hero, only what stands up in the way.

A soft screen-door fade extends past `radius` by `fade` cells: a per-pixel
`interleavedGradientNoise(screenCoordinate.xy)` sample is compared against a
1 → 0 ramp across `[radius, radius + fade]`, and pixels where
`cutStrength > dither` are discarded. The keep condition is
`step(cutStrength, dither)` — TSL `step(edge, x)` returns 1 when `x >= edge`,
so a fraction `cutStrength` of the pixels in the fade band are cut, and the
shape stays opaque.

The predicate at cell resolution is in `web/src/gpu/cutout.ts::isCutCell` —
same rule, no y check (cells always stand from y = 0 to y = 1), so the docs
can state the rule with a rerunnable example and the tests catch a sign
flip without a GPU.

### Convention: `forward` points from the hero toward the camera

The ticket's fragment rule was stated as `dot < 0` against a
"camera→hero direction"; the test name in the acceptance list is
`cutoutForwardFor points from the hero toward the camera`, which is the
opposite direction. This module implements the test name — `forward =
normalize(camera − hero)` in the horizontal plane — and the fragment rule
therefore reads `dot > 0` for "camera side". Both files (`cutout.ts` and
`materials.ts`) use the same convention, and `isCutCell` matches it: a cell
between the hero and the camera has `cell − hero` pointing along `forward`
(same direction), so the dot product is positive.

## What is exempt

The hero and pet **avatars** are exempt from the cutout. Both are voxel models
built from the same kit as the dungeon (`web/src/gpu/avatar.ts`,
`docs/gpu-avatar.md`) and meshed with `createVoxelMaterial`, so a naive first
attempt at this ticket applied the fragment discard rule to their voxels too:
the hero sits **at** `CUTOUT.center`, above the floor, on the camera side of
himself, so every avatar fragment satisfies the discard rule. The bug shot
saved as `.tigerteam/shots/cutout-bug.png` shows exactly that — the wall
opens as intended, but the hero has vanished with it, replaced by the bright
dome of the cutout boundary.

The fix is a separate material for the avatars. `createVoxelMaterial` takes
an optional `cutout` flag (default `true`): the dungeon is built with the
default, and `web/src/gl/gl-viewport.ts::GpuPath.build` builds a second
material with `cutout: false` and hands it to `SpriteLayer`, which routes it
to `createHeroAvatar` / `createPetAvatar`. The avatar material shares the
whole appearance pipeline — colour, roughness, metalness, emissive, weather,
sway — and simply omits the `maskNode` discard branch, so the hero and pet
are never touched by the cutout.

Two consequences worth stating:

- **The inner keep-radius is now belt-and-braces.** With the avatar
  material exempt, the per-fragment inner keep-zone is no longer the sole
  guard on the hero avatar. It remains in place for the dungeon material
  because it also covers any *future* voxel meshes that share the dungeon
  material and happen to sit at `CUTOUT.center` (a floor decal, a portal
  effect); removing it is a separate cleanup and out of scope here.
- **The pet is exempt too.** The pet uses the same avatar material via
  `createPetAvatar`, so a pet standing one cell from the hero — comfortably
  inside the cutout radius on the camera side — is never sliced by the
  cutout, which was the second half of the bug the rework calls out. This
  replaces the "pet + monster avatars" caveat the earlier revision of this
  document flagged as "could not verify"; the avatar material path makes it
  unconditional.

Monster sprites drawn as billboards (`buildSpriteMaterial` in
`web/src/gpu/sprites.ts`) already used their own materials and were never
subject to the cutout, so they need no change.

## Why an inner keep-radius

The voxel material is shared with the hero avatar (`web/src/gpu/avatar.ts`
via `sprites.ts`), which sits exactly at `center`. Its fragments are within
~0.15 cells of the hero cell centre in the horizontal plane, and their
world Y ranges from 0 (feet) up to `HERO_SPRITE_HEIGHT = 0.7` (head). Half of
them are on the camera side of `center` and would be discarded by the rule
above.

The shader adds a small **inner keep-zone**: fragments with `dHoriz <
CUTOUT_INNER_KEEP_CELLS = 0.35` are never cut. 0.35 is:

- comfortably wider than the hero avatar's ~0.15-cell horizontal reach, so
  the avatar stays intact;
- strictly less than 0.5, the minimum distance from the hero cell centre to
  the nearest fragment of an adjacent wall cell, so adjacent walls are still
  cut at full strength (a wall in cell `(hero.x + 1, hero.y)` has its
  nearest fragment at `x = hero.x + 1`, `dHoriz = 0.5`, above the keep
  threshold).

The keep-zone is a hard `step()`, not a ramp — adjacent walls are exactly at
0.5, so a ramp starting at 0.35 and ending at 0.5 would soften the innermost
wall edge as an unintended side-effect. The screen-door fade band lives on
the outer edge (`radius → radius + fade`) instead, where it has real space
to spread across a wall's face.

## Why discard, not alpha blending

`MeshStandardNodeMaterial.transparent = true` would move the cutout wall out
of the opaque pass. Two consequences that made this a non-starter:

- **G-buffer corruption.** SSGI (`three/addons/tsl/display/SSGINode`) and SSR
  (`SSRNode`) sample world normals and depth from the opaque pass. A
  transparent wall writes nothing there, so reflections and one-bounce
  indirect light "see through" the whole cutout column as if it weren't
  there. Discard keeps the material opaque, and the fragments that survive
  contribute to the G-buffer normally.
- **Sort order.** Transparent materials render back-to-front against every
  other transparent thing in the scene (weather quads, the ghost mesh from
  T-0043). Getting the layer order right without swapping visual bugs is
  possible but not free, and any tuning of the cutout would ripple through
  the transparency stack.

The screen-door dither uses `interleavedGradientNoise(screenCoordinate.xy)`,
the same helper the pipeline's grain node uses (`web/src/gpu/pipeline.ts`
§grade). Stable per frame (screen-space, not world-space), so the cutout
edge does not shimmer as the camera moves; a moving hero shifts the *centre*
of the pattern, which reads as motion rather than noise.

## Wiring

- `web/src/gpu/materials.ts` — the shared `CUTOUT` uniform block and the
  fragment-stage discard, evaluated inside `createVoxelMaterial`. Written by
  `gl-viewport.ts::GpuPath.render`; the material never touches these
  uniforms itself.
- `web/src/gl/gl-viewport.ts::GpuPath.render` — every frame:
  - `CUTOUT.enabled.value = view === 'third' || view === 'ortho' ? 1 : 0`;
  - in the active views, `CUTOUT.center.value.set(heroX + 0.5, 0, heroY +
    0.5)` and `CUTOUT.forward.value.set(fwd.x, 0, fwd.z)` where `fwd`
    comes from `cutoutForwardFor(cameraPos, heroPos)` against whichever
    camera drew the last frame (`orthoPlace.position` in ortho,
    `thirdFrame.position` in third).
- `web/src/gpu/cutout.ts` — pure helpers (no `three`, no DOM).
  `cutoutForwardFor` for the uniform, `isCutCell` for the cell-resolution
  predicate the docs and tests reason about.

## The T-0043 ghost mesh is still in place

T-0043 shipped a translucent ghost mesh over cutaway cells in `ortho`; that
overlay is still drawn on top of the wall. With this ticket's discard, the
wall underneath is genuinely absent inside the radius, so the ghost mesh
overlay is now **redundant** in `ortho` — the hero reads through the real
hole, not through a tinted overlay. Removing it is a small, isolated
cleanup and worth a separate ticket:

- `gl-viewport.ts::refreshGhostMesh` / `disposeGhostMesh` and the
  `ghostGroup`/`ghostGeom`/`ghostMaterial` fields on `GpuPath`,
- the `cutawayKey`, `lastGhostKey`, `refreshGhostMesh` call in `render`,
- the `cutawayCellsFor` import (still needed by the legacy path in the same
  file — `applyCutaway` / `cutawayMesh` on `GlViewport`).

Left in place here because the ticket's scope explicitly excludes removing
it and because "harmless overlay" is safer than "half-removed cutaway" if
either half of the removal misses a call site.

## What I could not verify

The worker container has no GPU and cannot look at a rendered frame. So:

- **No visual verification of the discard.** The four pure-function cases
  in `tests/gpu-cutout.test.ts` pin the geometry rule at the cell boundary,
  and every material uniform is initialised from the same numbers
  (`CUTOUT_RADIUS_CELLS`, `CUTOUT_FADE_CELLS`, `CUTOUT_FLOOR_EPSILON`,
  `CUTOUT_INNER_KEEP_CELLS`). Whether the compiled fragment shader actually
  discards the fragments the rule identifies — and whether the screen-door
  fade reads as a "soft hole" or a "dither cloud" — is the PM's eyeball
  review through `/scene.html?view=third` and `/scene.html?view=ortho`
  under `?gpu=raw` and `?gpu=auto` (see `docs/gpu.md` §9).
- **`maskNode` vs. shader backends.** `three/webgpu` `NodeMaterial.setup()`
  turns `maskNode` into `bool(maskNode).not().discard()` at the start of the
  fragment stage; that path is documented and shipped, but I could not
  measure whether every backend (WebGPU, WebGL2 fallback) inlines the
  discard identically. If the compiled fragment shader for the cutaway
  reads "opacity 0" instead of a real `discard`, SSGI/SSR would still write
  the wall into the G-buffer and the cutout would corrupt indirect light —
  a `?gpu=raw&q=high` shot with a wall in front of the hero is the
  diagnostic.
- **The eyeball shot for the fix itself.** The rework moved the avatars
  onto their own cutout-disabled material (`createVoxelMaterial({ cutout:
  false })`), and the new test case pins that the avatar material's
  `maskNode` stays null — but only the PM can re-shoot
  `/scene.html?pose=7.5,6.5,0` and confirm the hero (and pet) are now
  visible in the hole. The `.tigerteam/shots/cutout-bug.png` reference
  makes the before/after obvious.
