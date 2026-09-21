# Hero cutout on the GPU render path

*T-0063. Supersedes T-0058's world-space proximity rule and rework 1's
screen-space disc; read `docs/gpu-thirdperson.md` §"Pose" first for the
camera the cutout serves.*

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

## Why a screen-space disc was tried and rejected

Rework 1 added depth + a screen-space disc: the fragment was cut iff it
was strictly closer than the hero AND within `heroScreenPx = 1.4 ·
avatarPixelHeight` of the hero's projected pixel position. The depth
half was correct and stays; the disc was wrong. At the default
third-person pose the projected avatar is roughly 40 px tall; a
1.4-multiplier gives a ~55 px radius; a disc of radius 55 px around
a 40 px figure reaches ~15 px below his feet and off both his shoulders.
On screen that read as a dithered arc scooped out of the wall (and the
floor) *below and beside* the avatar even when nothing was actually
between him and the camera. `.tigerteam/shots/cutout-disc.png` is the
before shot. The geometry confirms the complaint: from the third-person
camera the sight line to the hero's chest passes ~2 units above a 1-unit
wall two cells south — nothing to see through, so nothing should be cut,
but the disc reached past the figure and cut anyway.

The fix is a shape change, not a units change: **cut only inside the
hero's projected silhouette rectangle**. Project the avatar's world-space
AABB with the live camera, take the pixel-space extremes, use that
rectangle as the screen-space test. The hole is then exactly as big as
the avatar is on screen and appears only where something would actually
hide him.

## The rule

Uniform block (`web/src/gpu/materials.ts::CUTOUT`, written from
`gl-viewport.ts::GpuPath.render`):

| uniform          | type   | default | meaning                                                                                                       |
|------------------|--------|---------|---------------------------------------------------------------------------------------------------------------|
| `enabled`        | float  | 0       | 1 in `third`/`ortho`, 0 in `fps`                                                                              |
| `heroCamDist`    | float  | 0       | Hero's camera-space distance (`-viewZ` at the hero's world position, positive in front of the camera)         |
| `heroScreenMin`  | vec2   | (0, 0)  | Top-left pixel corner of the hero's projected AABB (top-left origin, matches TSL `screenCoordinate.xy`)       |
| `heroScreenMax`  | vec2   | (0, 0)  | Bottom-right pixel corner of the hero's projected AABB                                                        |
| `fadeMarginPx`   | float  | 6       | Pixel margin the rectangle is expanded by for the screen-door dither (`CUTOUT_SCREEN_FADE_MARGIN_PX`)         |
| `depthBias`      | float  | 0.15    | Cells the fragment must be *nearer* than the hero to fire; `CUTOUT_DEPTH_BIAS_CELLS`                          |

A fragment is discarded when **all** of:

1. **It is closer to the camera than the hero** —
   `-positionView.z < heroCamDist - depthBias`. `positionView.z` is negative
   in front of the camera in three's convention, so `-positionView.z` is a
   positive depth. The `depthBias = 0.15 cells` guards the hero's own cell
   from flickering under fp noise; it is strictly less than the 0.5 cells
   between the hero's cell centre and an adjacent wall's nearest fragment,
   so adjacent walls in front of the hero still receive the full cut.
2. **Its projected pixel is inside the hero's silhouette rectangle** —
   `heroScreenMin ≤ screenCoordinate.xy ≤ heroScreenMax`, expanded by
   `fadeMarginPx` for the soft edge. `screenCoordinate.xy` follows the
   WebGPU convention (top-left origin) on both backends via
   `builder.isFlipY()`, and the CPU-side projection flips NDC y explicitly
   to agree. The shader computes the external distance to the rectangle
   as `length(max(vec2(minPx - frag, frag - maxPx), 0))` — 0 inside the
   rectangle, growing linearly outside — and uses `smoothstep(0,
   fadeMarginPx, extDist)` for the 1 → 0 ramp.
3. Its world Y is above the floor
   (`> CUTOUT_FLOOR_EPSILON = 0.05`) — we never cut the floor plane out
   from under the hero, only what stands up in the way.

A soft screen-door fade extends the rectangle by `fadeMarginPx = 6 px`
on each side: a per-pixel `interleavedGradientNoise(screenCoordinate.xy)`
sample is compared against a 1 → 0 ramp across that margin, and pixels
where `cutStrength > dither` are discarded. The keep condition is
`step(cutStrength, dither)` — TSL `step(edge, x)` returns 1 when
`x >= edge`, so a fraction `cutStrength` of the pixels in the fade band
are cut and the shape stays opaque.

## The silhouette rectangle

`web/src/gpu/cutout.ts::projectHeroForCutout` projects the eight corners
of a world-space AABB centred on the hero and takes the pixel-space
min/max. The AABB has:

- height `HERO_SPRITE_HEIGHT = 0.7 cells` from the shared ortho-camera
  constant (top-of-head to feet in world units),
- horizontal footprint `HERO_SILHOUETTE_WIDTH_CELLS = 0.3 cells` on both
  x and z. Measured from `web/src/gpu/avatar.ts`: the widest voxels
  (shoulder pad + arm) reach ~9.6 units on the 0.025-cell grid → ~0.24
  cells shoulder-to-shoulder; `0.3 cells` rounds up so a yawing hero
  (shoulders → 45° diagonal) still fits. Square in x/z so the projected
  rectangle is rotation-invariant to `Pose.yaw`.

That gives the four `heroScreenMin/Max` numbers directly — no per-view
special case, no formula that depends on camera pitch: a perspective
camera pitched 42° down projects the AABB smaller vertically than a
head-on camera would, and the rectangle shrinks with it. An ortho camera
zoomed out makes the avatar smaller, and the rectangle scales down.
`heroCamDist` is the camera-space z of the hero's mid-height, so the
depth test is in the same frame as the fragment shader.

### Reading the numbers back

The PM can read the resolved rectangle from the console — the debug hook
carries it since rework 2:

```js
window.__asciihack.gl.debugInfo().cutout
// → {
//     enabled: true,
//     heroCamDist: 13.8,
//     heroScreen: {
//       min: { x: 486, y: 265 },
//       max: { x: 513, y: 305 },
//     },
//     fadeMarginPx: 6,
//   }
```

`enabled: false` in fps. When `heroScreen.max.y - min.y` is close to zero
or larger than the visible avatar, the projection is off; when it looks
right but a shot still shows a scoop, the depth half is the problem.

## What is exempt

The hero and pet **avatars** are exempt from the cutout. Both are voxel
models built from the same kit as the dungeon (`web/src/gpu/avatar.ts`,
`docs/gpu-avatar.md`) and meshed with `createVoxelMaterial`. Under the
depth + rectangle rule the avatars project onto the same screen pixels
as the hero — inside the rectangle by definition — and pose smoothing
can leave individual avatar voxels a hair closer to the camera than the
smoothed hero position, inside the depth bias. Belt and braces:
`createVoxelMaterial` takes an optional `cutout` flag (default `true`);
the dungeon is built with the default, and
`web/src/gl/gl-viewport.ts::GpuPath.build` builds a second material with
`cutout: false` and hands it to `SpriteLayer`, which routes it to
`createHeroAvatar` / `createPetAvatar`. The avatar material shares the
whole appearance pipeline — colour, roughness, metalness, emissive,
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
- `web/src/gpu/cutout.ts` — the pure helpers:
  - `projectHeroForCutout(camera, heroX, heroBaseY, heroZ, spriteWidth,
    spriteHeight, canvasW, canvasH, fadeMarginPx)` returns the pixel
    numbers the material's `CUTOUT` block wants. Projects the eight
    corners of the world-space AABB with the live camera and takes the
    pixel-space min/max.
  - `isCutCell(cellX, cellY, hero, camera, screenRadiusCells,
    depthBiasCells)` — cell-resolution depth predicate, `three`-independent
    (uses only `{ x, y, z }` literals), so the "which cells satisfy the
    depth rule" property is pinned without a GPU. The lateral half of
    this helper is a cone approximation; the shader uses the projected
    rectangle instead. The four depth cases in
    `tests/gpu-cutout.test.ts` exercise this helper; the silhouette case
    exercises `projectHeroForCutout` against a real `PerspectiveCamera`.
  - `CUTOUT_DEPTH_BIAS_CELLS`, `CUTOUT_FLOOR_EPSILON`,
    `CUTOUT_SCREEN_FADE_MARGIN_PX`, `HERO_SILHOUETTE_WIDTH_CELLS` —
    the shader's and projection's defaults, named and reused.
- `web/src/gl/gl-viewport.ts::GpuPath.render` — every frame, when
  `view === 'third' || view === 'ortho'`:
  - `CUTOUT.enabled.value = 1`;
  - Pick the active camera (`this.orthoCamera` in ortho, `this.camera`
    otherwise), call `projectHeroForCutout` with the smoothed hero pose,
    `HERO_SILHOUETTE_WIDTH_CELLS` as the sprite width, `HERO_SPRITE_HEIGHT`
    as the sprite height and the current canvas dimensions;
  - Write the returned `heroCamDist`, `heroScreenMin`, `heroScreenMax`
    and `fadeMarginPx` into `CUTOUT`; set `depthBias =
    CUTOUT_DEPTH_BIAS_CELLS`;
  - Cache the returned `CutoutFrame` on `lastCutoutFrame` so
    `GlViewport.debugInfo()` can surface the resolved rectangle.
- `web/src/gl/gl-viewport.ts::GlViewport.debugInfo().cutout` — reports
  `{ enabled, heroScreen: { min, max }, heroCamDist, fadeMarginPx }`
  from the most recent frame the cutout ran. `enabled` is false and the
  numbers are zero in fps or before the first GPU frame.

## The T-0043 ghost mesh is still in place

T-0043 shipped a translucent ghost mesh over cutaway cells in `ortho`;
that overlay is still drawn on top of the wall. With this ticket's
discard, the wall underneath is genuinely absent inside the rectangle,
so the ghost mesh overlay is now **redundant** in `ortho`. Removing it
is a small, isolated cleanup and worth a separate ticket:

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

- **No visual verification of the discard.** The pure-function cases in
  `tests/gpu-cutout.test.ts` pin the depth predicate at cell resolution
  and the rectangle rule at pixel resolution against a real
  `PerspectiveCamera`; the shader is a direct restatement of the same
  predicates against `positionView.z` and `screenCoordinate.xy`.
  Whether the compiled fragment shader actually discards the fragments
  the rule identifies — and whether the 6 px fade margin reads as a
  "soft hole" rather than a jagged rectangle — is the PM's eyeball
  review through `/scene.html?view=third` and `/scene.html?view=ortho`
  under `?gpu=raw` and `?gpu=auto`.
- **The eyeball shot for the fix itself.** The rework shot is
  `.tigerteam/shots/cutout-disc.png` (hero two cells from the south
  wall, a dithered arc under his feet and past his shoulders). The
  reshoot should show:
  - Top pose (hero two cells from the south wall, nothing occluding):
    wall opaque, floor untouched. The rectangle is above and inside the
    avatar's silhouette; nothing in the rectangle is nearer than the
    hero, so the depth test rejects and nothing is cut.
  - Bottom pose (hero against a wall): a tight rectangular hole the
    width and height of the projected avatar — no wider.
  - `window.__asciihack.gl.debugInfo().cutout` in the browser console
    prints the exact rectangle for either shot.
