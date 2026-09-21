# GPU / legacy composition (browser viewport)

*T-0040. Read `docs/gpu.md` §3, §6 and §6.1 first — this file describes how
those rules are wired into `web/src/gl/gl-viewport.ts` and how a frame moves
between the ported GPU stack and the legacy WebGL path.*

## The three paths

`GlViewport` owns both renderers and calls `choosePath()` on every frame:

| Path       | When                                                   | Renders through                                             |
|------------|--------------------------------------------------------|-------------------------------------------------------------|
| `legacy`   | `?gpu=off`, GPU not ready, active style `needsDepth`   | `SceneBuilder` + textured Lambert → `StyleRenderer` (WebGL) |
| `styled`   | `?gpu=auto`, GPU ready, style with no depth requirement | ported afterburn pipeline → `GpuCompositor` → `StyleRenderer`|
| `raw`      | `?gpu=raw`, or F8 flipped `auto` into raw              | ported afterburn pipeline → blit onto the visible canvas    |

`choosePath` is pure (`web/src/gpu/path.ts`) so tests exercise the rule
without a browser. The ortho view keeps the legacy path unconditionally —
the ortho camera and cutaway are not ported to the GPU scene yet
(`docs/gpu.md` §7).

## The composition trick, exactly (`docs/gpu.md` §6)

The AsciiCity style shaders are raw GLSL on a `WebGLRenderer`. A
`WebGPURenderer` cannot run them. The two renderers coexist:

1. The GPU pipeline renders into its **own detached canvas**, sized to
   `cols·subX × rows·subY` in styled mode (already capped 640×360 by
   `styleGrid`) or to the CSS viewport × `min(dpr, 1.5)` in raw mode
   (`gpuCanvasSize`, tested by `tests/gpu-compose.test.ts`).
2. `GpuCompositor` (`web/src/gpu/compose.ts`) wraps that canvas in a
   `THREE.CanvasTexture` on a full-screen quad in a **one-mesh scene** and
   passes that scene to the **untouched** `StyleRenderer.render(scene,
   camera)`.
3. The quad's vertex shader writes clip space directly and ignores the
   camera, so the **real perspective camera** is passed in — that is what
   keeps `cameraNear` / `cameraFar` at the values the style prelude
   expects. `texture.needsUpdate` is set once per frame.

Raw mode skips the style pass: `GlViewport.blitRawToCanvas` uses the same
compositor scene but draws it into the legacy renderer's own canvas so
what appears on screen is the untouched GPU frame. F8 toggles raw ↔ styled
at the document level (`web/src/main.ts`, next to F5/F2/F3 capture; F1–F7
are taken in `src/ui/app.ts`, F8 is free).

## Depth styles are a hard rule (`docs/gpu.md` §6)

Only `edges` sets `needsDepth: true`. A blitted quad has no scene depth,
so while a depth style is active the viewport routes through the **legacy
WebGL path** (which reads the scene target's `DepthTexture` for
`linearDepth()`). Cycling to any other style flips right back to the GPU
path. This keeps the legacy renderer a first-class citizen — it never
becomes stale code.

## Styled mode fights the quantiser (`docs/gpu.md` §6.1)

The ported pipeline ends in display space (AgX, split-tone, contrast,
saturation, vignette, grain). The style prelude then applies its own
`exposure = 1.7` and `pow(v, 0.45)` density curve. Feeding it a finished
film frame double-grades: blacks crush, vignette eats a 40-column image,
per-pixel grain shimmers between frames when averaged into cells.

So styled mode overrides three uniforms after the mood has written them:

| uniform          | raw mode         | styled mode                          |
|------------------|------------------|--------------------------------------|
| `look.vignette`  | mood value       | `0`                                  |
| `look.grain`     | mood value       | `0`                                  |
| `look.outputScale` | `1`            | `1 / STYLE_EXPOSURE`  (≈ 0.588)      |

`outputScale` is applied as the last multiply of the grade block, right
after `fade` (`web/src/gpu/pipeline.ts`). Scaling **after** the tone map
is deliberate: scaling before would change the AgX response.

`styledLook(styleExposure)` and `rawLook()` are pure and tested; the
viewport writes their return values into `handle.look.*` every frame in
that order.

## Mood decision (`docs/gpu.md` §5)

`GpuPath` picks the mood from the hero's cell each frame using `moodFor`:

| hero's cell                                          | mood       |
|------------------------------------------------------|------------|
| `lava`, or orthogonally adjacent to a `lava` cell    | `lava`     |
| `ice`                                                | `ice`      |
| `water`, or orthogonally adjacent to `water`         | `flooded`  |
| any cell whose `MapCell.lit === true`                | `torchlit` |
| anything else (corridor, unlit room, unknown)        | `deep_dark`|

Evaluated in that order; first match wins. The transition is
`atmosphere.blendTo(id, MOOD_BLEND_SECONDS)` (1.5 s) so stepping through
a doorway is a fade, not a cut. `?mood=<id>` pins one mood for review,
bypassing the table (used from `/scene.html` and the WS entry alike —
`GpuPath` reads it from `GlViewportOptions.mood`, which defaults to the
query string via `parseGpuQueryOptions`).

## Backends and fallback (`docs/gpu.md` §3)

`GpuPath.create` constructs a `WebGPURenderer` with `forceWebGL: true`
iff `?backend=webgl2` (the exact spelling the probe page uses). Any of:

- `createRenderer()`/`init()` throws;
- the first `pipeline.render()` throws (measured: the r185 WebGPU-side
  `GPUTextureViewDescriptor.swizzle` mismatch surfaces here);
- `renderer.backend.device.lost` resolves;
- `uncapturederror` fires on the backend event target;

routes to `GlViewport.fallbackToLegacy`: a single `console.warn` line, the
GPU path is disposed, and every subsequent frame goes through the legacy
renderer. The first-frame throw retries **once** on the WebGL2 backend
before giving up.

The lost / uncaptured-error listeners are wrapped in a `try/catch` because
neither exists on three's WebGL2 fallback backend.

## Params

Parsed once at construction from `window.location.search`, so
`/scene.html` inherits them without any change to `web/src/scene-bench.ts`:

| param       | values                                   | default                     |
|-------------|------------------------------------------|-----------------------------|
| `?gpu=`     | `auto` \| `off` \| `raw`                 | `auto`                      |
| `?q=`       | `low` \| `medium` \| `high` \| `ultra`   | `caps.maxQuality`           |
| `?backend=` | `webgpu` \| `webgl2`                     | `auto` (let three probe)    |
| `?mood=`    | `torchlit` \| `deep_dark` \| `flooded` \| `lava` \| `ice` | `null` (drive from level)   |

`GlViewportOptions` accepts explicit overrides for each; the constructor
falls back to the query defaults when a field is missing. F8 flips
`auto|off|raw` locally between styled and raw for the current session
without touching the URL.

## Camera and lantern

The GPU scene has its own `THREE.PerspectiveCamera` (from `three/webgpu`)
placed at `(pose.x, EYE_HEIGHT, pose.y)` with rotation `(CAMERA_PITCH,
-pose.yaw, 0, 'YXZ')` and `fov = vFovDeg` — the same numbers the legacy
camera uses (`gl-viewport.ts` exports `EYE_HEIGHT`, `CAMERA_PITCH`,
`LANTERN_INTENSITY`, `LANTERN_DISTANCE`; the GPU path reuses them). A
`WG.PointLight(GPU_LANTERN_COLOR, LANTERN_INTENSITY, LANTERN_DISTANCE, 1)`
is parented to the camera.

`sun` is `null`: dungeons have no shaft light and `GodraysNode` throws
on a light with no shadow map. The god-ray tier skips the branch when
`sun === null`, which is the normal case (`docs/gpu.md` §3).

## Rendering is rAF-driven

Only from `requestAnimationFrame`. Calling `pipeline.render()` in a
synchronous loop returns an all-black frame once TRAA or DOF is in the
graph. `GlViewport.render()` is already invoked from the render loop in
`web/src/main.ts` (and `web/src/scene-bench.ts`), so this is a "do not
'optimise' it into a sync loop" warning — the first frames after a mood
change are legitimately empty while TRAA fills its history.

## `debugInfo()`

Extended with `path` (`legacy | styled | raw`), `gpuReady`, `backend`
(`webgpu | webgl2 | null`), `quality`, and `mood`. Paste
`window.__asciihack.gl.debugInfo()` into the console to see which path a
frame actually ran through — that is the PM's only window into the
decision at review time.

## What I could not verify

Every ticket in this wave is bound by `docs/gpu.md` §9 — the worker
container has no GPU and no way to look at a rendered frame. Specifically:

- **No visual verification of the composite.** The pure decision helpers
  (`choosePath`, `backendFor`, `gpuCanvasSize`, `moodFor`, `styledLook`,
  `rawLook`, `parseGpuQueryOptions`) are exercised in
  `tests/gpu-compose.test.ts`; the `GpuCompositor` blit itself, the
  actual `WebGPURenderer` construction (real vs. WebGL2 fallback), the
  first-frame throw + retry sequence, and the `CanvasTexture → StyleRenderer`
  round-trip need a browser and are the PM's eyeball review to sign off
  on. The reference is `.tigerteam/shots/reference-torch.png` and the
  `/gpu-probe.html?stack=voxel` frame that produced it.
- **No timing.** The docs/gpu.md §8 budget (16 ms/frame at 640×360 on
  `high`, 33 ms at 1600×900 raw on `high`) is stated but not measured
  here; the tuning ticket the PM already flagged (T-0045) is the right
  place to reconcile the numbers.
- **No `device.lost` reproduction.** The listener is wired but I have no
  way to induce a device loss in the worker; the fallback code path is
  reasoned about, not exercised. Same for `uncapturederror`.
- **F8 handler.** F1–F7 are the only F-key bindings in `src/ui/app.ts`
  (grep-verified); F8 is added at capture in `web/src/main.ts` and calls
  `gl.toggleRaw()`. In a real browser I did not press it.
