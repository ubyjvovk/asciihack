# GPU render path (browser) — the contract

*PM-owned (like `docs/architecture.md`). Tickets cite sections of this file;
workers read the cited section before writing code and flag a contradiction
in their report instead of guessing.*

## 1. Why

The browser viewport (`docs/web.md`, "WebGL viewport") currently renders the
dungeon as textured boxes under a `MeshLambertMaterial` and one point light,
then quantises the frame through AsciiCity's style shaders. It is legible but
flat: no bounce light, no shadows, no reflections, no tone mapping. The
sibling project **`~/afterburn`** (three.js r185 WebGPU/TSL, commit `8492a00`,
2026-09-20) renders a voxel world through a full post stack — SSGI bounce,
SSR wet reflections, god rays, TRAA, DOF, bloom, AgX tone map, split-tone
grade, vignette, grain — and looks like a photographed diorama. We port that
renderer here and light the dungeon with it. The user has authorised copying
code and resources from `~/afterburn` freely.

Two things get better at once: the raw 3D view becomes beautiful, and every
ASCII style downstream gets a far better input image (real shadow shapes,
torch pools, wet-floor highlights are exactly the low-frequency structure a
cell quantiser can show).

## 2. Shape of the port

```
web/src/voxel/            ported from vendor/afterburn/src/voxel/  (asciihack owns the copy)
  kit.ts        VoxelBuilder + seeded rng/noise — pure data, no three.js
  palette.ts    PAL colours, MAT presets, FX codes
  mesh.ts       VoxelModel -> BufferGeometry (24 B/vertex, hidden-face cull)
web/src/gpu/              ported from vendor/afterburn/src/render/
  renderer.ts   createRenderer(): WebGPURenderer + capability probe
  pipeline.ts   createPipeline(): the MRT -> ... -> grade node graph, QUALITY table
  materials.ts  createVoxelMaterial() + the shared `W` weather/mood uniforms
  moods.ts      dungeon MOODS + Atmosphere (blends between them)
  dungeon.ts    LevelView -> voxel scene (walls, floors, doors, stairs, lights)
  compose.ts    the GPU frame -> StyleRenderer's scene target, or straight to screen
```

`three` is already a dependency (`^0.185.1`, same version afterburn uses), and
`three/webgpu` + `three/tsl` + `three/addons/tsl/display/*` ship inside it —
**no new npm dependency is needed or allowed** for this wave.

## 3. Renderer and backends

`createRenderer()` is afterburn's, unchanged in behaviour: probe
`navigator.gpu` for `maxColorAttachmentBytesPerSample`, construct
`THREE.WebGPURenderer`, `AgXToneMapping`, exposure 1.0, PCF soft shadows,
`await renderer.init()`, and report
`caps = { webgpu, mrtBytes, maxQuality }` where `maxQuality` is `'ultra'` on
a WebGPU backend with a 64-byte attachment budget and `'medium'` otherwise
(the WebGL2 fallback backend cannot run the full MRT stack).

Quality ladder (afterburn's `QUALITY`, kept verbatim): `low` (no GI, no SSR,
no rays, FXAA) · `medium` (GTAO, SSR, TRAA, DOF) · `high` (SSGI 1 slice, SSR,
god rays, TRAA, DOF) · `ultra` (SSGI 2 slices, full-res SSR, 72-step rays).
`?q=low|medium|high|ultra` overrides; default is `caps.maxQuality`.

If `createRenderer()` throws or `renderer.init()` rejects, the viewport keeps
the existing WebGL path (§6) and logs one line. The GPU path is never
required for the browser client to work.

**Measured on this host (2026-09-21, `/gpu-probe.html`, see §9).** A
`WebGPURenderer` reaches the **WebGPU backend** in headless Chromium, but
`pipeline.render()` then dies inside three r185 with

```
TypeError: Failed to execute 'createView' on 'GPUTexture': Failed to read the
'swizzle' property from 'GPUTextureViewDescriptor'
```

— a Chromium-vs-three version skew, not our bug. Forcing three's **WebGL2
fallback backend** (`new WebGPURenderer({ forceWebGL: true })`) builds and
renders the same TSL graph (`pass` + MRT → `bloom` → `fxaa` → `renderOutput`
AgX → vignette) in ~80 ms at 640×360 under SwiftShader. Consequences:

- the WebGL2 fallback is not theoretical — it is the path headless
  verification runs on, so it must work, and `?gpu=` needs a way to force it
  (`?backend=webgl2`, mirroring the probe);
- that headless adapter reports `maxColorAttachmentBytesPerSample = 32`, so
  `clampQuality` lands on `medium` there. A real GPU in the user's browser
  should reach 64 and `ultra`;
- `pipeline.renderAsync()` is deprecated in r185 — use `pipeline.render()`
  after `await renderer.init()` (afterburn already does).

## 4. Scene conventions (unchanged from `docs/web.md`)

Map `x` grows east, map `y` grows south; three's `x` = east, `z` = south,
`y` = up. Cell `(cx, cy)` covers `(cx…cx+1, 0…1, cy…cy+1)`; centre
`(cx + 0.5, 0.5, cy + 0.5)`. **One cell = one three.js unit = 1 "metre"**, so
afterburn's light intensities, fog densities and DOF distances port over
without rescaling. Wall height stays 1 unit and eye height 0.5
(`EYE_HEIGHT`), because the ortho camera and the cutaway depend on them.

**Voxel unit = 0.125** (8 voxels per cell edge) — afterburn's prop unit, and
chunky enough that a wall face reads as stacked blocks at ASCII resolution.

## 5. Lighting model for a dungeon

Afterburn's moods are outdoor weather states; ours are dungeon states. The
`Atmosphere` machinery (blend two mood records over N seconds, write the
uniforms) ports unchanged; the mood *table* is ours:

- there is no sun and no sky — `sun` becomes an optional weak shaft light
  used only where the level has one (god rays through a doorway), and the
  hemisphere light becomes a very dim cool fill;
- the key light is the **hero's lantern** (already `LANTERN_INTENSITY` /
  `LANTERN_DISTANCE` in `gl-viewport.ts`) plus emissive torches placed by the
  scene builder;
- `W.wetness` / `W.puddles` are kept — a damp dungeon floor with SSR
  reflections of the torch is exactly the afterburn look, and it costs
  nothing to drive them from a per-level constant;
- the grade (split-tone toward teal shadows / warm highlights, contrast,
  saturation, vignette, grain) is kept and is what carries the mood.

## 6. Composition with the style shaders

The AsciiCity style pass is **raw GLSL on a `WebGLRenderer`** and the vendored
files under `web/src/asciicity/` must not be edited here. A `WebGPURenderer`
cannot run them. So the two renderers coexist:

1. The GPU pipeline renders the dungeon into **its own canvas**, sized to the
   style's scene target (`cols·subX × rows·subY`, capped 640×360) in styled
   mode, or to the full viewport in raw mode.
2. `compose.ts` wraps that canvas in a `THREE.CanvasTexture` on a full-screen
   quad in a one-mesh scene, and hands *that* scene to
   `StyleRenderer.render(scene, camera)` — the vendored code is untouched and
   still owns the target, the quad and the uniforms. The quad's vertex shader
   writes clip space directly and ignores the camera, so the **real
   perspective camera** is passed in and `cameraNear`/`cameraFar` stay correct.
3. Raw mode skips the style renderer: the GPU canvas is shown directly
   (`F8` toggles, `?gpu=raw`), which is how the port gets eyeballed.

### 6.1 The grade fights the quantiser — what styled mode sends

This is the decision most likely to make the port look *worse* than what it
replaces, so it is settled here rather than in a ticket.

Afterburn's pipeline ends in **display space**: AgX tone map, split-tone,
contrast, saturation, **vignette** and **animated grain**. The AsciiCity style
prelude then applies its own `exposure` (1.7) and `shaped(v) = pow(v, 0.45)`
density curve to what it is given, because it expects a scene-linear frame.
Feeding it a finished film frame double-grades it: blacks crush, the 1.7×
clips the top end, the vignette eats the corners of a 40-column image, and
per-pixel grain averaged into cells **shimmers between frames** — noise is the
one thing a cell quantiser cannot hide.

So the two modes take different amounts of finishing:

| | raw mode | styled mode |
|---|---|---|
| lighting stack (SSGI, SSR, rays, TRAA, DOF, bloom) | on | on |
| AgX + split-tone + contrast + saturation | on | on |
| vignette | on | **`look.vignette = 0`** |
| grain | on | **`look.grain = 0`** |
| final scale | `look.outputScale = 1` | **`look.outputScale = 1 / styleExposure`** (≈ 0.59 at the default 1.7) |

`outputScale` is a new `createLook()` uniform (default `1.0`) applied as the
last multiply of the grade block, beside `fade`. Scaling **after** the tone
map is deliberate: scaling before it would change the AgX response, whereas
this just hands the style pass a frame whose peak lands where its own
exposure expects it. Lighting and colour still come from the ported stack —
only the film finishing is withheld, because the ASCII cell is the film.

**Depth styles.** Only `edges` sets `needsDepth`. A blitted quad has no scene
depth, so: *the GPU path supports every style with `needsDepth === false`;
selecting a depth style switches the viewport back to the legacy WebGL path
for as long as it is active.* This is a hard rule, not a TODO — it keeps the
legacy path alive and honest.

`?gpu=auto|off|raw` (default `auto`) selects the path. `auto` = GPU when it
initialises and the style allows it.

## 7. What stays

`web/src/gl/scene-builder.ts`, its materials and the cutaway stay exactly as
they are: they are the fallback path (§3, §6) and the ortho view keeps using
them until a later ticket ports the cutaway to the GPU scene. `GlViewport`
owns both paths and decides per frame.

## 8. Budget

The styled path renders at ≤ 640×360, so the whole post stack is cheap; the
budget is **16 ms/frame at 640×360 on `high`** and **33 ms at 1600×900 in raw
mode on `high`**. `?q=` exists for slower machines.

## 9. Verification

Workers cannot see a rendered frame and containers have no GPU. Every ticket
in this wave is therefore verified by unit tests over the *pure* parts (node
graph construction, mood tables, voxel geometry, size math) plus
`npx tsc --noEmit` and `npx tsc --noEmit -p web/tsconfig.json`. A worker must
say plainly in its report which claims it could not verify.

The eyeball review is the PM's, on the host, through two pieces of tooling
that already exist (PM-owned; **not in any ticket's scope**):

- **`/scene.html`** — `web/src/scene-bench.ts`, a standalone bench that mounts
  `GlViewport` over a synthetic level (lit room, doorway, dark corridor,
  both staircases) with **no WebSocket, no server and no NetHack**. Query:
  `?pose=x,y,yawDeg`, `?render=<style>`, `?fov=`, `?view=fps|ortho`, and
  whatever the viewport reads (`?gpu=`, `?q=`). Arrow keys/WASD walk, `[`/`]`
  cycle styles. It sets `window.__ready` after the second frame and exposes
  `window.__bench` (`viewport`, `setPose`, `debugInfo()`, `frames`).
- **`/gpu-probe.html`** — `web/src/gpu-probe.ts`, a standalone capability
  probe: adapter limits, backend actually reached, which TSL nodes built, and
  whether one frame rendered, reported in `window.__probe` and painted as
  text. `?backend=webgl2` forces the fallback. This is what §3's measured
  numbers come from; re-run it after any three upgrade.
- **`scripts/web-shot.mjs`** — headless screenshot, ported from
  `vendor/afterburn/tools/shot.mjs`. Playwright is deliberately **not** a
  dependency: the script resolves it from `~/asciicity/node_modules` (or
  `$PLAYWRIGHT_DIR`), with the browsers in `~/.cache/ms-playwright`.

```sh
npm run web:dev &                       # vite on 127.0.0.1:5173
node scripts/web-shot.mjs "/scene.html?render=amber" shot.png --swiftshader
node scripts/web-shot.mjs "/scene.html?gpu=raw&q=high" raw.png --gpu --strict
```

`--swiftshader` forces software GL (portable, no GPU needed); `--gpu` asks for
the real device and is what the WebGPU path wants. The tool prints console
errors, page errors, failed requests and `window.__bench.debugInfo()`, and
`--strict` makes any of those a non-zero exit. Baseline "before" frame:
`.tigerteam/shots/before-amber.png`.
