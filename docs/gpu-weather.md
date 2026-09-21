# Dungeon-air overlay (`web/src/gpu/weather.ts`)

Companion note to `docs/gpu.md`. Owned by the T-0044 delivery, adjusted by
T-0055. Ports `vendor/afterburn/src/render/weather.js` into a dungeon-shaped
overlay: an independent `THREE.Scene` composited additively **after** the
lighting stack by `createPipeline({ overlay })`, so transparent particle quads
never touch the G-buffer that SSGI/SSR read
(`docs/gpu-pipeline.md` "Pass order").

Three emitters exist in the machinery:

- **drips** falling from the ceiling in wet rooms,
- **dust motes** drifting in torchlight,
- **embers** rising from a torch or lava.

**Every one is silent by default (T-0055).** Afterburn's overlay was tuned for
an open valley in the rain; the ported motes and drips read as "particles all
over" when the level is a sealed stone dungeon, so `createWeather()` allocates
**zero** instances on every emitter unless the caller passes counts:
`createWeather(W, { drips, motes, embers })` (see "Emit nothing by default"
below). The mood plumbing, the tint uniforms and the overlay pass wiring all
still exist, so a later ticket (embers over a lava pool; a monsoon room) is a
single-number change, not a rebuild.

## Shape

One `InstancedMesh` per emitter, three total. Each mesh:

- carries a `MeshBasicNodeMaterial` with `transparent: true`, `depthWrite:
  false`, `fog: false`, `blending: THREE.AdditiveBlending`, `renderOrder` in
  `20..22` so the overlay pass draws them in the same order every frame;
- has `frustumCulled = false` — the wrap volume tracks the camera, so a
  three.js frustum test against the mesh's bounding sphere would clip the
  volume prematurely (see afterburn's original, which sets the same flag);
- has an instance count fixed at construction — **zero by default** (T-0055),
  and otherwise whatever the caller passed in `CreateWeatherOptions`.

| Emitter | Default count | Afterburn-scale (opt-in) | Wrap radius (cells) | Vertical extent (m) |
|---|---:|---:|---:|---:|
| `drips`  | **0** | `DRIP_COUNT = 400` | ±7 | 4.0 |
| `motes`  | **0** | `MOTE_COUNT = 560` | ±8 | 2.5 |
| `embers` | **0** | `EMBER_COUNT = 300` | ±5 | 2.5 |

The afterburn-scale counts are still exported so a caller can spell the intent
without hard-coding the magic number:
`createWeather(W, { embers: EMBER_COUNT })`. The instance count is the number
the shader graph derives all positions from — `positionNode` uses
`instanceIndex`, `time`, `hash()` and the `focus` uniform to place each
particle. There is no per-frame JS particle loop and no per-frame allocation
(afterburn's rule: "everything is GPU-animated from instance ids — zero
per-frame CPU work"). `update()` only writes small scalar uniforms.

## Emit nothing by default (T-0055)

The user's verdict on T-0044's first cut: *"stop the particles all over, makes
no sense in the dungeon"*. Afterburn's motes and drips belong to an open
valley in the rain, not a sealed stone room, so the dungeon's default is
silence:

```ts
createWeather(W);                              // 0 drips / 0 motes / 0 embers
createWeather(W, { embers: EMBER_COUNT });     // opt one emitter back in
```

The mood table (`DRIPS_PER_MOOD`, `MOTES_PER_MOOD`, `EMBERS_PER_MOOD`), the
tint tables, the `emitterTargets` mapping and the `pass(overlay, camera)`
wiring inside `createPipeline` are all unchanged: turning an emitter back on
is one number in the call site, and the existing per-mood intensities light
up as they always did (`emitterTargets('lava', W).embers` is still `0.9`).

The mesh count is a construction-time knob, so a mood transition never
reallocates — a lava level that opted its embers in with `EMBER_COUNT`
instances keeps those instances even when the atmosphere fades into
`torchlit`; the intensity uniform simply falls to `0.20 · (0.4 + 0.6 · glow)`
and the mesh hides itself under `VISIBLE_EPS`. A per-frame recount is out of
scope on purpose (`docs/gpu.md` §3, "no per-frame allocation").

## Wrap volume — `wrapAround(base, focus, halfExtent)`

Every emitter's `positionNode` uses the same trick to keep particles inside
a box centred on the camera:

```
rel = mod(base + focus − halfExtent, 2·halfExtent) − halfExtent + focus
```

The pure JS mirror is exported as `wrapAround(base, focus, halfExtent)` so
`tests/gpu-weather.test.ts` can pin the two invariants:

1. **Boundedness.** The result always lies within `focus ± halfExtent`.
2. **Camera follow.** Shifting `focus` by `delta` shifts the wrapped result
   by exactly `delta` (up to one period) — particles don't pop when the
   hero walks; the whole volume rides along.

The tests exercise the pure helper across radii and focus points; the GPU
shader implements the same expression in TSL (see the `mod(...)` node
inside `buildDrips` / `buildMotes` / `buildEmbers`).

## Intensity per (mood, W) — `emitterTargets`

The mood id sets the baseline emission for each emitter; the shared
`W` block (`docs/gpu-materials.md` "The `W` uniform block") modulates it.

```
drips  = MOOD_BASE.drips  × clamp01(W.wetness + W.rain × 0.5)
motes  = MOOD_BASE.motes                                       (mood-only)
embers = MOOD_BASE.embers × (0.4 + 0.6 × clamp01(W.glow))
```

`update()` calls `emitterTargets(mood, {wetness, rain, glow, wind})` once
per frame and eases each `intensity` uniform toward the returned target
(exponential smoothing at `FADE_RATE = 1.5/s`, so a doorway mood change
fades over ~1 s rather than snapping). The tint uniform is `.lerp`'d with
the same coefficient so a mood transition doesn't punch a colour change.

### Baseline table

|            | drips | motes | embers | tint (drip / mote / ember) |
|---|---:|---:|---:|---|
| `torchlit` | 0.35  | 0.55  | 0.20   | `#a8bccb` / `#ffe2b8` / `#ffb45e` |
| `deep_dark`| 0.00  | 0.80  | 0.00   | `#6a7078` / `#cfd8dc` / — |
| `flooded`  | 1.00  | 0.10  | 0.00   | `#a8bccb` / `#9fc0d0` / — |
| `lava`     | 0.00  | 0.15  | 0.90   | — / `#ffb090` / `#ff6a2a` |
| `ice`      | 0.05  | 0.30  | 0.00   | `#bfe4ff` / `#bfe4ff` / — |

Intent per row (ticket rules, expanded):

- `torchlit` — the default lit room: light drips (some seepage), a healthy
  dust drift in the warm light, faint embers from the torches themselves.
- `deep_dark` — still and dusty: no rain, no fire; motes lifted so an
  unlit corridor still has *something* in the air. Reads as "held breath".
- `flooded` — drips at maximum, motes suppressed (the air is too wet for
  suspended dust), no embers.
- `lava` — no water anywhere; motes ride the heat but heavily colour-shift
  toward warm; embers dominate the frame.
- `ice` — a hint of drips (occasional melt), pale motes (rime dust), no
  embers.

When a mood collapses an emitter to zero baseline (e.g. `deep_dark.drips`),
no amount of `W.wetness` will make it rain: the mood is the fence and the
`W` block is the scale. That's the invariant `emitterTargets` pins and the
test asserts (`emitterTargets('deep_dark', soaked).drips === 0`).

### Visibility gate

`update()` hides a mesh whose eased intensity drops below `VISIBLE_EPS =
0.004`. The pipeline's overlay `pass()` still runs, but the hidden mesh
contributes nothing, so `deep_dark`'s overlay pass costs a bloom-sized
attachment clear plus one dust-mote InstancedMesh with 560 near-transparent
discs — no drips or embers on the wire.

## Wiring into `GpuPath` (`web/src/gl/gl-viewport.ts`)

The overlay lives inside `GpuPath` next to `sprites` and `dungeon`. Build
order at boot:

1. `createWeather(W)` — constructs the scene, the three (default: zero-count)
   InstancedMeshes and the uniforms. Reads the shared `W` block by reference;
   no dependency on the pipeline or the atmosphere. The default zero counts
   (T-0055) mean the current call site emits nothing; a future level type
   that wants a specific emitter passes `{ drips, motes, embers }` here.
2. `createPipeline({ …, overlay: weather.scene })` — the pipeline reads
   `overlay` at graph-build time (`docs/gpu-pipeline.md` "Pass order") and
   adds one `pass(overlay, camera)` after `godrays` and before the firefly
   clamp / TRAA / DOF / bloom / grade.
3. Per frame in `GpuPath.render`: `weather.update(dt, focus, mood)` after
   the atmosphere advance, before `pipeline.render()`. `focus` is a scratch
   `Vector3` (`WEATHER_FOCUS_SCRATCH`) reused each frame so the update loop
   stays allocation-free.
4. `GpuPath.dispose` drops the three geometries + materials — the meshes
   themselves are garbage-collected when the scene is torn down.

## Budget

Ticket target: **under 1 ms at 640×360 on `high`**. On paper the overlay is
`400 + 560 + 300 = 1260` instances of a `PlaneGeometry(1, 1)`, additive
alpha-blended, no shadow, no depth write, no fog. Each fragment does ~10
TSL ops (hash, mod, dot, smoothstep, mix). The pass reads no G-buffer
targets, so the MRT footprint is unchanged. The overlay never blocks
SSGI/SSR (it runs after them), so its cost does not propagate up the
tier ladder.

## The tests

`tests/gpu-weather.test.ts` covers three cases and nothing else. Every case
is node-only; three r185's `InstancedMesh` and `MeshBasicNodeMaterial`
construct fine without a renderer (T-0042's `SpriteLayer` tests exercise the
same pattern).

- **"the mood id and W uniforms choose which emitters are active and how
  strong"** — pins `emitterTargets` across the five moods for four `W`
  states (dry, soaked, bright-and-dry, shower); then constructs a handle
  and runs `update` twice with mutating `W` values to confirm the eased
  intensity uniforms and the `visible` flags track the mapping.
- **"the particle buffer is allocated once and wraps around the camera"** —
  builds a handle with the afterburn-scale counts (`{ drips: DRIP_COUNT,
  motes: MOTE_COUNT, embers: EMBER_COUNT }`), pins the InstancedMesh counts
  before and after twenty updates with a moving focus, checks the geometry /
  material identities survive, and proves the pure `wrapAround` helper (which
  the GPU shader implements) keeps particles bounded and follows the camera.
- **"no emitter produces particles by default"** (T-0055) — a plain
  `createWeather()` allocates zero instances on every emitter, and a full
  ease-in on a mood that would normally drip hard does not reallocate.
  Confirms that the mood plumbing survives (a soaked `lava` mood still maps
  to `embers = 0.9`) and that a targeted opt-in (`{ embers: EMBER_COUNT }`)
  reaches only the emitter it asks for.

## What I could not verify

Workers cannot see a rendered frame and this container has no GPU
(`docs/gpu.md` §9). The following claims rest on the ticket + afterburn's
vendored source + the type signatures at three r185:

- **The shader graph actually builds and links.** The three `positionNode`
  compositions here are structurally the same as afterburn's (which the
  PM sees rendered under `~/afterburn`), but a TSL type mismatch in any
  of the `hash / mod / mix / smoothstep / cross / normalize` chains would
  only surface on the first `pipeline.render()`. The graph is small and
  each emitter compiles independently; if one fails, the fallback is
  hiding just that mesh (`drips.visible = false`), not tearing the pass
  down.
- **The 1 ms/frame budget at 640×360 on `high`.** The instance counts and
  fragment complexity match afterburn's rain/motes (which cost < 1 ms on
  its target hardware there) but this is unmeasured on any GPU the
  project has. If the PM's shot shows the overlay stealing frame time,
  the knobs are `DRIP_COUNT / MOTE_COUNT / EMBER_COUNT` and the wrap
  radii.
- **Tuning numbers.** Every value in the mood baseline table is within
  the ticket's stated intent, but "drips hard", "still and dusty" and
  "throws embers" are subjective. Expect a follow-up tuning ticket after
  the PM shoots `/scene.html` with a soaked mood, a lava mood, and a
  deep-dark corridor.
- **`focus.y = 0.5` vs `focus.y = 0`.** `GpuPath` hands the eye-height
  (`EYE_HEIGHT = 0.5`) as the focus Y, so the drip volume covers
  `focus.y + [0, 4]` — anchored on the hero's head, with the ceiling one
  cell above catching the top of the streaks. If the drip streaks read
  as "coming from the sky" instead of "from the ceiling", pass `pose.y`
  as the y-focus instead (a one-line change in `GpuPath.render`).
- **The tint fade interacts with `atmosphere.blendTo`.** Both eased
  transitions run at their own rates (`MOOD_BLEND_SECONDS = 1.5` for the
  atmosphere; `FADE_RATE = 1.5/s` here). They should agree closely
  enough that a doorway from `torchlit` into `flooded` produces one
  smooth increase in drips without a mid-transition flicker, but that is
  a PM-eyeball question.
- **The overlay under the ortho camera.** The ortho path binds a
  `WG.OrthographicCamera`; the overlay `pass(overlay, camera)` follows
  whatever the pipeline is currently bound to. `positionNode` uses
  `cameraPosition` for the billboard basis; from an overhead camera the
  motes should still read as camera-facing discs and the drip streaks as
  short vertical lines. Untested from either angle.
