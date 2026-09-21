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

**SSR does not compile on the WebGL2 backend (three r185 bug).** Isolated
with `/gpu-probe.html?stack=ssr&stochastic=0|1`. `SSRNode.js` builds its step
count as

```js
trunc( max( abs( xLen ), abs( yLen ) ).mul( quality.clamp() ) ).max( int( 1 ) )
```

which the GLSL backend emits as `max( int( trunc( … ) ), 1.0 )` — an
`int`/`float` mismatch GLSL ES 3.0 rejects, so the fragment shader never
links and the pass silently contributes nothing while spewing
`INVALID_OPERATION`. WGSL coerces it, so WebGPU is unaffected. The same node
with **`stochastic: true`** takes the other branch (`quality.clamp().mul(
MAX_STEPS ).max( float( 1 ) )`, all floats) and compiles and renders fine
(37.5 ms at 640×360 under SwiftShader).

**God rays need a shadow-casting light.** `GodraysNode` reads the light's
shadow map; handed a light with `castShadow = false` it throws
`TypeError: Cannot read properties of null (reading 'depthTexture')` while
building the graph and takes the whole pipeline down with it. So: **only pass
`sun` to `createPipeline` when that light has `castShadow = true` and the
renderer has `shadowMap.enabled = true`.** A dungeon usually has no sun at
all, and `createPipeline` already skips the branch when `sun` is null — which
is the normal case here. Verified with
`/gpu-probe.html?stack=ported&q=high` (throws with `&noshadow=1`, clean
without it).

**The whole ported stack runs on the WebGL2 backend** — verified after the
SSR gate landed, with `/gpu-probe.html?backend=webgl2&stack=ported&q=<tier>`:
`medium`, `high` and `ultra` all build (`gi`, `ssr`, `rays`, `bloom`,
`scenePass`), link without a single shader error, and draw the probe scene
through AgX and the grade. SSR was the only pass needing a gate.

**But it must be driven from `requestAnimationFrame`.** Calling
`pipeline.render()` in a synchronous loop returns an **all-black frame** on
that backend once TRAA or DOF is in the graph — the passes need the
compositor to tick between frames. `?raf=0` on the probe reproduces it.
This costs nothing in the app (`GlViewport` already renders from the rAF
loop) but it is exactly the symptom that reads as "the GPU path is broken",
so: **a black GPU frame in a test harness means the harness, not the
pipeline.**

**The rule:** SSR uses afterburn's `stochastic: false` on a **WebGPU**
backend and `stochastic: true` on the **WebGL2** backend. Stochastic SSR is
noisier by design and expects a temporal denoiser downstream — which every
tier that enables SSR already has (TRAA). Revisit when three fixes
`SSRNode.js` (one character: `.max( int( 1 ) )` → `.max( 1 )`); the gate is
deliberately one line so it can be deleted.

### 3.1 First light — the ported stack rendering the real dungeon

`/gpu-probe.html` can build three scenes, each through the **real ported
pipeline** (`?q=` picks the tier, `?mood=` the mood, `?pose=x,y,yawDeg` the
camera):

| `?stack=` | what it builds |
|---|---|
| *(absent)* | a hand-rolled minimal graph (`pass` + bloom + FXAA + AgX) — the backend smoke test |
| `voxel` | a scrap of dungeon from `VoxelBuilder` + `createVoxelMaterial()` |
| `dungeon` | **the real `DungeonScene`** over the bench level, with its baked torches and the hero's lantern |

`?stack=dungeon&q=high` on the WebGL2 backend renders
`.tigerteam/shots/first-light-dungeon.png` — torch sconces pooling warm light
on flagstones, the ceiling catching the bounce, SSR putting the torches back
in the wet floor and the ice, the corridor falling away into black. Zero
shader errors, all of `gi`, `ssr`, `rays`, `bloom` live in the graph.

Measured, 640×360, mood `torchlit`, hero in the lit room:

| | black | mean | 
|---|---|---|
| legacy path (`before-amber.png`) | 94.8 % | 1.5 |
| ported stack, first light | **5.2 %** | **92.6** |

The frame is, if anything, now **too bright**: dark basalt stone renders as
pale grey plaster, and the ice slab blows out to white. That is the tuning
ticket's job (T-0045), not a defect in the port — and it is a far better
problem than the one we started with. Styled mode's `outputScale` (§6.1)
divides by the style exposure, so the number the quantiser sees is ≈ 54.

> A caveat worth keeping: an earlier version of this section credited
> `.tigerteam/shots/reference-torch.png` to the ported pipeline. It was not —
> the probe fell through to the minimal graph for `?stack=voxel`. That image
> is a real frame from the real voxel material, but bloom + AgX only. Fixed;
> the numbers above are from the full stack.

### 3.2 The port, landed

T-0040 wired the path in; all three routes verified from the bench at
1280×720, hero in the lit room facing the doorway
(`.tigerteam/shots/before-after.png`):

| `?gpu=` | path taken | black | mean | p95 | levels |
|---|---|---|---|---|---|
| `off` | legacy WebGL | 93.3 % | 2.4 | 18 | 105 |
| `auto` | **styled through the ported stack** | **81.4 %** | **8.3** | **54** | **148** |
| `raw` | ported stack, no ASCII pass | 13.8 % | 39.4 | — | — |

The ASCII frame is 3.5× brighter in the mean, reaches three times further up
the tone curve (p95 18 → 54) and spends 40 % more distinct levels — which is
the whole point: the quantiser finally has an image with structure in it.

### 3.3 Measured after the wave

Single-cell reveal (the cost that lands on the player's move frame), after
T-0046 chunked the bake into 10×7-cell chunks:

| | full 80×21 bake | one cell revealed |
|---|---|---|
| before chunking | ~38 ms | ~38 ms (whole level rebaked) |
| after chunking | ~38 ms | **p50 1.2 ms, max 2.2 ms** |

The chunked bake is byte-identical to the unchunked one from scratch, and the
rendered frame is unchanged in practice (mean 39.0 vs 39.4; 0.16 % of pixels
differ by more than 12 levels, which is TRAA jitter, not geometry).

ASCII output through the styled path, 1280×720, `q=high`, three poses:

| style | black | mean | p95 |
|---|---|---|---|
| `amber` (pre-port) | 94.8 % | 1.5 | 10 |
| `amber` (ported) | 81 – 83 % | 7.7 – 8.4 | 53 – 55 |
| `ascii` (pre-port) | 82.7 % | 10.4 | 80 |
| `ascii` (ported) | 71.7 % | 21.8 | 130 |

Stable across poses, which is what you want — the brightness comes from the
lighting, not from one lucky camera angle.

**Stochastic SSR is noisier, and only on the fallback backend.** Measuring
high-frequency energy (mean absolute difference between neighbouring pixels)
across the raw frame as the wave landed: 1.89 before the mood environment,
**2.12** after it, 2.26 with sprites. That is the cost of T-0041's stochastic
gate — the mirror path afterburn uses does not need a denoiser, the
stochastic one does, and three's `DenoiseNode` is not in the graph. It does
not converge with more frames, so it is ray noise, not TRAA warm-up. Two
reasons not to chase it: the **WebGPU backend uses the mirror path**, so a
real browser never sees it; and styled mode averages sub-samples per cell,
which suppresses it. Revisit only if the WebGL2 fallback becomes the common
case.

**Not measured here, and it cannot be:** real frame time. Every number in this
document comes from SwiftShader software rasterisation, where `q=high` costs
~240 ms/frame at 640×360. That says nothing about a real GPU; it only proves
the graph compiles and draws. Frame budget (§8) is still unverified.

## 4. Scene conventions (unchanged from `docs/web.md`)

Map `x` grows east, map `y` grows south; three's `x` = east, `z` = south,
`y` = up. Cell `(cx, cy)` covers `(cx…cx+1, 0…1, cy…cy+1)`; centre
`(cx + 0.5, 0.5, cy + 0.5)`. **One cell = one three.js unit = 1 "metre"**, so
afterburn's light intensities, fog densities and DOF distances port over
without rescaling. Wall height stays 1 unit and eye height 0.5
(`EYE_HEIGHT`), because the ortho camera and the cutaway depend on them.

**Voxel unit = 0.125** (8 voxels per cell edge) — afterburn's prop unit, and
chunky enough that a wall face reads as stacked blocks at ASCII resolution.

**The GPU scene has a ceiling**, at `y = 1` over every known passable cell,
which the legacy scene lacks. Without it torchlight escapes upward and the
SSGI bounce has nothing above to come off. It lives in its own `ceiling`
group on `DungeonScene.root` so the ortho view can hide it; sprites up to the
1.3-cell "gigantic" class will clip it, which is accepted.

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
3. Raw mode skips the style renderer: the GPU canvas is shown directly.
   **This is the default** — `F8` toggles to the styled pass, `?gpu=auto`
   starts there. Note the cost difference: styled renders at ≤ 640×360 (the
   style's scene target) while raw renders at the full viewport with pixel
   ratio capped at 1.5, so the default is the more expensive path.

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

`?gpu=auto|off|raw` (**default `raw`** since 2026-09-21 — the user asked for
the full afterburn frame out of the box; `auto` puts the ASCII style pass
back and `F8` toggles at runtime) selects the path. `auto` = GPU when it
initialises and the style allows it.

## 7. What stays

`web/src/gl/scene-builder.ts`, its materials and the cutaway stay exactly as
they are: they are the fallback path (§3, §6), reached when the GPU path
cannot initialise and whenever a `needsDepth` style is active. `GlViewport`
owns both paths and decides per frame.

**The ortho view is on the GPU path** (T-0043 + T-0050); this section used to
say it stayed on the legacy renderer. Getting it there cost three attempts
and turned up one lesson worth keeping: a far camera needs its own fog.
`FogExp2` survival is `e^(−density · distance)`, so the moods' first-person
densities (`torchlit` 0.10, `deep_dark` 0.20) leave **1.8 %** of the scene
at the ortho camera's ~40-unit distance, against a near-black fog colour —
an entirely black frame, at every quality tier, with no error anywhere. The
ortho view therefore scales the mood's density by
`ORTHO_FOG_DENSITY / FPS_FOG_DENSITY` (0.1), reusing the two constants the
legacy path has always had. Two things that were *not* the cause, but were
real bugs found on the way: the graph must be rebuilt against a genuine
`OrthographicCamera` (`pass(scene, camera)` binds it at build time, so
copying a projection matrix onto a perspective camera does nothing), and
`SSGINode.setSize` reads `camera.fov`, which an orthographic camera does not
have — so ortho demotes SSGI to GTAO.

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
  `GlViewport` over a synthetic level — a lit room with both staircases, a
  doorway into a dark corridor, then a closed door into a second chamber of
  water, ice, lava and a fountain, so every special-cased cell kind is
  reachable — with **no WebSocket, no server and no NetHack**. Query:
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
npm run web:dev &                       # vite on 127.0.0.1:5273
node scripts/web-shot.mjs "/scene.html?render=amber" shot.png --swiftshader
node scripts/web-shot.mjs "/scene.html?gpu=raw&q=high" raw.png --gpu --strict
```

- **`scripts/web-sheet.sh`** — one PNG contact sheet from several bench
  queries, each tile labelled with its query, so a whole look review is a
  single image:

  ```sh
  bash scripts/web-sheet.sh out.png "render=amber&pose=7.5,4.5,90" \
      "render=ascii&pose=7.5,4.5,90" "render=gloom&pose=4.5,2.5,135" \
      "render=amber&view=ortho"
  ```

  The pre-port baseline is `.tigerteam/shots/sheet-before.png` — compare
  against it, not against memory.
- **`scripts/shot-stats.py`** — brightness statistics for a shot, so tuning is
  measurable rather than argued. The pre-port numbers at 1280×720, hero in the
  room facing the doorway:

  | shot | black | mean | p95 | levels |
  |---|---|---|---|---|
  | `before-amber.png` | 94.8 % | 1.5 | 10 | 62 |
  | `before-ascii.png` | 82.7 % | 10.4 | 80 | 146 |

  A large black share is inherent to ASCII (a glyph is thin strokes on black),
  so read these **relatively**: the port should move `mean` and `p95` up and
  `levels` up, because more of the frame lands inside the quantiser's usable
  range instead of under its black point.

`--swiftshader` forces software GL (portable, no GPU needed); `--gpu` asks for
the real device and is what the WebGPU path wants. The tool prints console
errors, page errors, failed requests and `window.__bench.debugInfo()`, and
`--strict` makes any of those a non-zero exit. Baseline "before" frame:
`.tigerteam/shots/before-amber.png`.
