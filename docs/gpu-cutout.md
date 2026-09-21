# Hero cutout on the GPU render path

*T-0063. Supersedes T-0058's world-space proximity rule; read
`docs/gpu-thirdperson.md` §"Pose" first for the camera the cutout serves.*

## Why

In `third` and `ortho`, the camera sits south of the hero at a 42° pitch
(`docs/gpu-thirdperson.md` §"Pose"). Any wall between the two occludes the
player. `docs/gpu-ortho.md` §"What (a) does not deliver — and the follow-up"
already recorded why the ghost-mesh cutaway T-0043 shipped cannot fix this
— the GPU dungeon is one merged geometry per chunk, so individual wall
cells cannot be hidden by collapsing a matrix. The material must know to
skip the fragments in front of the hero.

## Why the world-space proximity version was wrong

T-0058 shipped a world-space proximity rule: any fragment within 2.5 cells
of the hero on the "camera side" of him (the horizontal disk on the hero's
half-plane) was discarded above the floor. That rule failed the ticket's
own test — *"the cutout is always present even when not obscured by a
southern wall"*. Walk close to any wall in the third-person view and a
hole opens through it, whether or not the wall is between the camera and
the hero, because the wall lives inside the 2.5-cell disk that surrounds
the hero. The rule was proximity, not occlusion. Iso games get this right
with the check every renderer already does under the hood: **depth from
the camera**. A wall that is not between the camera and the hero is never
closer to the camera than the hero along the ray to the hero, so it is
never a candidate for the cut.

## The rule

Uniform block (`web/src/gpu/materials.ts::CUTOUT`, written from
`gl-viewport.ts::GpuPath.render`):

| uniform         | type   | default | meaning                                                                                                       |
|-----------------|--------|---------|---------------------------------------------------------------------------------------------------------------|
| `enabled`       | float  | 0       | 1 in `third`/`ortho`, 0 in `fps`                                                                              |
| `heroCamDist`   | float  | 0       | Hero's camera-space distance (`-viewZ` at the hero's world position, positive in front of the camera)         |
| `heroScreen`    | vec2   | (0, 0)  | Hero's projected pixel position, WebGPU convention (top-left origin) — matches TSL `screenCoordinate.xy`      |
| `heroScreenPx`  | float  | 0       | Pixel radius around `heroScreen` inside which fragments are cut (per frame: `1.4 · avatarOnScreenHeightPx`)   |
| `depthBias`     | float  | 0.15    | Cells the fragment must be *nearer* than the hero to fire; `CUTOUT_DEPTH_BIAS_CELLS`                          |

A fragment is discarded when **all** of:

1. **It is closer to the camera than the hero** —
   `-positionView.z < heroCamDist - depthBias`. `positionView.z` is negative
   in front of the camera in three's convention, so `-positionView.z` is a
   positive depth. The `depthBias = 0.15 cells` guards the hero's own cell
   from flickering under fp noise; it is strictly less than the 0.5 cells
   between the hero's cell centre and an adjacent wall's nearest fragment,
   so adjacent walls in front of the hero still receive the full cut.
2. **Its projected pixel is inside the hero's screen disk** —
   `length(screenCoordinate.xy - heroScreen) < heroScreenPx`. Both terms
   are in pixels; `screenCoordinate.xy` follows the WebGPU convention
   (top-left origin) on both backends via `builder.isFlipY()`, and the
   CPU-side projection flips NDC y explicitly to agree.
3. Its world Y is above the floor
   (`> CUTOUT_FLOOR_EPSILON = 0.05`) — we never cut the floor plane out
   from under the hero, only what stands up in the way.

A soft screen-door fade extends past `heroScreenPx` by
`CUTOUT_SCREEN_FADE_FRACTION = 35 %` of the radius: a per-pixel
`interleavedGradientNoise(screenCoordinate.xy)` sample is compared against
a 1 → 0 ramp across `[heroScreenPx, heroScreenPx · (1 + fadeFraction)]`,
and pixels where `cutStrength > dither` are discarded. The keep condition
is `step(cutStrength, dither)` — TSL `step(edge, x)` returns 1 when
`x >= edge`, so a fraction `cutStrength` of the pixels in the fade band
are cut and the shape stays opaque.

`heroScreenPx` is `1.4 · avatarOnScreenHeightPx`. The avatar's on-screen
height is derived per frame from the live camera and the hero's distance,
not hard-coded — for a perspective camera, one world unit at depth `d`
subtends `canvasH / (2 · d · tan(fov/2))` pixels; for the ortho camera it
subtends `canvasH / (top − bottom)` pixels. So a hole opens tight around
the avatar at every zoom.

The predicate at cell resolution is in `web/src/gpu/cutout.ts::isCutCell`
— the same rule expressed as a horizontal cone (screen radius at hero's
depth is a world radius `screenRadius`; at cell depth `d`, the cone covers
lateral offset `≤ screenRadius · d / heroDepth`). Same test the shader
evaluates, no `three`, so `tests/gpu-cutout.test.ts` can catch a sign flip
without a GPU.

## What is exempt

The hero and pet **avatars** are exempt from the cutout. Both are voxel
models built from the same kit as the dungeon (`web/src/gpu/avatar.ts`,
`docs/gpu-avatar.md`) and meshed with `createVoxelMaterial`. Under the new
rule the avatars project onto the same screen pixels as the hero, and pose
smoothing can leave individual avatar voxels a hair closer to the camera
than the smoothed hero position — inside the depth bias, but not by a
comfortable margin. Belt and braces: `createVoxelMaterial` takes an
optional `cutout` flag (default `true`); the dungeon is built with the
default, and `web/src/gl/gl-viewport.ts::GpuPath.build` builds a second
material with `cutout: false` and hands it to `SpriteLayer`, which routes
it to `createHeroAvatar` / `createPetAvatar`. The avatar material shares
the whole appearance pipeline — colour, roughness, metalness, emissive,
weather, sway — and simply omits the `maskNode` discard branch.

Monster sprites drawn as billboards (`buildSpriteMaterial` in
`web/src/gpu/sprites.ts`) already use their own materials and were never
subject to the cutout, so they need no change.

## Why discard, not alpha blending

`MeshStandardNodeMaterial.transparent = true` would move the cutout wall
out of the opaque pass. Two consequences that made this a non-starter:

- **G-buffer corruption.** SSGI (`three/addons/tsl/display/SSGINode`) and
  SSR (`SSRNode`) sample world normals and depth from the opaque pass. A
  transparent wall writes nothing there, so reflections and one-bounce
  indirect light "see through" the whole cutout column as if it weren't
  there. Discard keeps the material opaque, and the fragments that
  survive contribute to the G-buffer normally.
- **Sort order.** Transparent materials render back-to-front against
  every other transparent thing in the scene (weather quads, the ghost
  mesh from T-0043). Getting the layer order right without swapping
  visual bugs is possible but not free.

The screen-door dither uses `interleavedGradientNoise(screenCoordinate.xy)`,
the same helper the pipeline's grain node uses. Stable per frame
(screen-space, not world-space), so the cutout edge does not shimmer as
the camera moves; a moving hero shifts the *centre* of the pattern, which
reads as motion rather than noise.

## Wiring

- `web/src/gpu/materials.ts` — the shared `CUTOUT` uniform block and the
  fragment-stage discard, evaluated inside `createVoxelMaterial`. Written
  by `gl-viewport.ts::GpuPath.render`; the material never touches these
  uniforms itself.
- `web/src/gl/gl-viewport.ts::GpuPath.render` — every frame, when
  `view === 'third' || view === 'ortho'`:
  - `CUTOUT.enabled.value = 1`;
  - Pick the active camera (`this.orthoCamera` in ortho, `this.camera`
    otherwise), refresh its `matrixWorldInverse` via
    `activeCam.updateMatrixWorld(true)`, then compute
    `heroCamDist = -heroWorld.applyMatrix4(matrixWorldInverse).z` and
    project `heroWorld` to NDC → pixel coords (top-left origin) for
    `heroScreen`;
  - Compute `heroScreenPx = 1.4 · HERO_SPRITE_HEIGHT · pxPerWorldUnit`
    from the live camera (perspective: `canvasH / (2 · heroCamDist ·
    tan(fov/2))`; ortho: `canvasH / (top − bottom) · zoom`);
  - Set `depthBias = CUTOUT_DEPTH_BIAS_CELLS`.
- `web/src/gpu/cutout.ts` — pure helpers (no `three`, no DOM).
  `isCutCell` for the cell-resolution predicate the docs and tests reason
  about; `CUTOUT_DEPTH_BIAS_CELLS`, `CUTOUT_SCREEN_FADE_FRACTION` and
  `CUTOUT_FLOOR_EPSILON` for the shader's defaults.

## The T-0043 ghost mesh is still in place

T-0043 shipped a translucent ghost mesh over cutaway cells in `ortho`;
that overlay is still drawn on top of the wall. With this ticket's
discard, the wall underneath is genuinely absent inside the radius, so
the ghost mesh overlay is now **redundant** in `ortho`. Removing it is
a small, isolated cleanup and worth a separate ticket:

- `gl-viewport.ts::refreshGhostMesh` / `disposeGhostMesh` and the
  `ghostGroup`/`ghostGeom`/`ghostMaterial` fields on `GpuPath`,
- the `cutawayKey`, `lastGhostKey`, `refreshGhostMesh` call in `render`,
- the `cutawayCellsFor` import (still needed by the legacy path in the
  same file — `applyCutaway` / `cutawayMesh` on `GlViewport`).

Left in place here because the ticket's scope explicitly excludes
removing it and because "harmless overlay" is safer than "half-removed
cutaway" if either half of the removal misses a call site.

## What I could not verify

The worker container has no GPU and cannot look at a rendered frame. So:

- **No visual verification of the discard.** The four pure-function
  cases in `tests/gpu-cutout.test.ts` pin the geometry rule at cell
  resolution, and the shader is a direct restatement of the same
  predicate against `positionView.z` and `screenCoordinate.xy`. Whether
  the compiled fragment shader actually discards the fragments the rule
  identifies — and whether the screen-door fade reads as a "soft hole"
  or a "dither cloud" at the ticket's `1.4 · avatarHeight` radius — is
  the PM's eyeball review through `/scene.html?view=third` and
  `/scene.html?view=ortho` under `?gpu=raw` and `?gpu=auto`.
- **The eyeball shot for the fix itself.** The bug shot is
  `.tigerteam/shots/wall-cutout.png` (from the T-0058 accept run) — the
  cutout is visible in a wall that never blocked the hero. The
  reshoot after this ticket should show that same wall opaque, and a
  wall directly in front of the hero clear.
