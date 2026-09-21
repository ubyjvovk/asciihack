# Voxel material and dungeon moods

Companion note to `docs/gpu.md`. Owned by the T-0038 delivery; the PM may
edit tuning numbers in the mood table without touching the code contract.

The GPU path uses **one** node material — `createVoxelMaterial()` in
`web/src/gpu/materials.ts` — for every voxel in the scene, plus an
`Atmosphere` rig in `web/src/gpu/moods.ts` that blends between five fixed
dungeon lighting states. Both are ported from `vendor/afterburn/src/render/`
(the sibling project's WebGPU/TSL renderer); the port drops the outdoor
weather (sun, sky, stars, ringed planet) and swaps the mood table for a
dungeon-shaped one.

## The `W` uniform block (`materials.ts`)

`W` is a top-level uniform record shared by every voxel material. Values are
read from the shader on every fragment and written each frame by
`Atmosphere._apply()`.

| Uniform | Range | Effect in the shader |
|---|---|---|
| `W.wetness` | 0..1 | Non-`FLAG_DRY` surfaces darken (porous ×0.58) and drop in roughness (×0.42 on up-facing, less on sides); stone tops get a thin water film (~0.18–0.28 roughness, jittered per box). |
| `W.puddles` | 0..1 | Threshold for the low-frequency puddle noise on `FLAG_GROUND` up-faces. Below the threshold: dark damp ring. Above: mirror water (colour `#333c3e`, roughness 0.07, metalness biased to 0.82). |
| `W.rain` | 0..1 | Reserved for a rain-ripple / weather-overlay wiring; not read by the current material shader. Kept in the block so upstream code has a stable place to write it. |
| `W.glow` | ≥ 0 (~0..2) | Multiplier for the `FX_PULSE` and `FX_TWINKLE` emissive gain. Lets the mood breathe living emitters. |
| `W.lampGain` | ≥ 0 (~0.5..3) | Final multiplier on the emissive term — exposure compensation so lamps read at a similar apparent brightness across bright and dark moods. |
| `W.wind` | ≥ 0 (~0..2) | Vertex-sway amplitude multiplier for `FX_SWAY` boxes (banners, hanging chains). |

**Dropped vs afterburn.** The `W.hollowAO` uniform and the Crystal Hollow
`aoNode` special case (a smoothstep box in world space around `x∈[50,80]`,
`z∈[-14,25]`, `y<2.4` that strangled ambient occlusion inside a specific
open-topped cavern) are removed: that is a place in afterburn's world, not
ours. Nothing in this repo needs a per-region AO override.

## fx codes and flag bits

The last byte of each voxel's `aMat.a` packs an fx code (low 5 bits, values
0..31) and three flag bits (bits 5..7):

| Constant | Value | Meaning |
|---|---:|---|
| `FX_FLICKER` | 1 | Noisy per-voxel intensity flicker (torch, ember). |
| `FX_PULSE` | 2 | Slow sinusoidal breath, per-voxel phase (crystal). |
| `FX_SWAY` | 3 | Vertex sway in world space, driven by `W.wind`. |
| `FX_TWINKLE` | 4 | Brief bright twinkle, per-voxel phase (glow flora, LEDs). |
| `FLAG_STONE` | 32 | Surface gets the thin water-film roughness override. |
| `FLAG_GROUND` | 64 | Up-facing floor; eligible for puddles. |
| `FLAG_DRY` | 128 | Surface never receives wetness/puddles (interior faces, emitters). |

The pure helper `fxByte(fx, { stone, ground, dry })` composes the byte. It
lives in `moods.ts` so tests can import it (see "File split" below).

## The five dungeon moods (`MOODS`)

The mood record shape is exactly what the ticket specifies:

```ts
interface Mood {
  key:  { color: number; intensity: number };
  fill: { sky: number; ground: number; intensity: number };
  fog:  { color: number; density: number };
  weather: { wetness: number; puddles: number; wind: number };
  look: Partial<LookValues>;
  glow: number; lampGain: number;
}
```

Colours are 24-bit sRGB hex. `look` overrides a subset of the pipeline's
grade uniforms (`exposure`, `contrast`, `saturation`, `tintAmount`,
`vignette`, `grain`, `bloomStrength`, `ssrIntensity`, `giIntensity`,
`focus`, `focusRange`, `bokeh`); every mood in the table sets the same
twelve so blends are structurally uniform. `focus`/`focusRange`/`bokeh` are
in metres (one cell = one metre, `docs/gpu.md` §4) — the pipeline's outdoor
defaults (`focus: 30`, `focusRange: 38`) sit outside the whole dungeon, so
without a per-mood override every frame renders permanently defocused.

Numbers below are the PM-tunable starting point; the PM eyeballs the frame
and may send a follow-up tuning ticket without changing the shape.

| Mood | Key colour · int | Fill sky/gnd · int | Fog colour · density | wet · pud · wind | exposure · contrast · sat · tint · vign · grain · bloom · ssr · gi | focus · focusRange · bokeh | glow · lampGain |
|---|---|---|---|---|---|---|---|
| `torchlit` | `#ffb060` · 1.4 | `#263140`/`#080a0d` · 0.05 | `#0b0d10` · 0.10 | 0.10 · 0.00 · 0.0 | 1.00 · 1.08 · 1.00 · 0.18 · 0.42 · 0.030 · 0.22 · 0.6 · 8.0 | 5.0 · 9.0 · 0.7 | 1.0 · 1.0 |
| `deep_dark` | `#ffb060` · 0.0 | `#000000`/`#000000` · 0.00 | `#05070a` · 0.20 | 0.06 · 0.00 · 0.0 | 1.00 · 1.10 · 0.75 · 0.10 · 0.75 · 0.030 · 0.20 · 0.5 · 6.0 | 3.5 · 9.0 · 0.7 | 1.0 · 1.2 |
| `flooded`  | `#ffb060` · 1.8 | `#2b4a52`/`#0f181c` · 0.08 | `#0c1416` · 0.14 | 1.00 · 1.00 · 0.2 | 1.00 · 1.06 · 0.95 · 0.22 · 0.45 · 0.028 · 0.28 · 1.4 · 8.0 | 5.0 · 9.0 · 0.9 | 1.0 · 1.0 |
| `lava`     | `#ff6a2a` · 3.2 | `#2a1410`/`#1a0806` · 0.10 | `#1a0a06` · 0.11 | 0.00 · 0.00 · 0.4 | 1.05 · 1.08 · 1.20 · 0.22 · 0.42 · 0.028 · 0.55 · 0.2 · 10.0 | 5.0 · 9.0 · 0.7 | 1.4 · 1.8 |
| `ice`      | `#bfe4ff` · 1.2 | `#9fc8ea`/`#2a3a48` · 0.10 | `#8ca8bc` · 0.09 | 0.10 · 0.00 · 0.2 | 1.05 · 1.02 · 0.92 · 0.08 · 0.30 · 0.010 · 0.24 · 0.4 · 9.0 | 5.0 · 9.0 · 0.7 | 1.0 · 1.6 |

**Dry by default (T-0053).** A dungeon is mostly dry stone, so the four
non-`flooded` moods carry near-zero `wetness` and zero `puddles` — the
small residual (0.06..0.10) keeps a hint of sheen on stone under torchlight
rather than a bone-dry matte, and is not meant to read as wet.  Only
`flooded` — the mood that *is* the reason — leaves stone properly soaked.
Which cells still receive that residual is decided per-cell in `dungeon.ts`
by the `FLAG_DRY` bit: every stone box gets `dry: true` **unless** the
level gives a reason (the cell or one of its orthogonal neighbours is
`water`, `fountain`, `drawbridge` or `ice`; see `docs/gpu-dungeon.md`).
This way the wet residual paints only where SSR has something to
reflect — beside a fountain, on a drawbridge, or across a flooded room —
and everywhere else the dungeon reads as rock.

Intent per row (verbatim from the ticket, expanded with the tuning above):

- `torchlit`: the default lit room — warm lamp key at moderate strength, a
  very dim cool hemisphere fill, dry stone with only a faint residual sheen
  (`wetness 0.10`, no puddles — T-0053 dry-by-default), thin smoke-grey
  fog, mild vignette. The reference "we're inside somewhere lit" look.
- `deep_dark`: corridors and unlit rooms — the mood key drops to 0 so the
  hero's lantern (added by the scene builder) is the only real light, fog
  doubles, saturation drops and vignette climbs to 0.75. Reads as "just off
  the map."
- `flooded`: everything soaked — max wetness and puddles, cool teal shadow
  tint (via `tintAmount`), high SSR intensity so the mirror water carries
  reflections of torches. Wind picks up slightly for hanging chains.
- `lava`: warm and dry — hot ember key from a fixed direction, no water,
  saturated grade (`saturation` 1.20) and strong bloom (0.55). See "What I
  could not verify" for the "from below" caveat.
- `ice`: cold and bright — pale cyan key, hemisphere fill goes up (bounced
  light off ice), high-key grade (low contrast, low saturation, low grain,
  small vignette). Residual wetness drops to `0.10` with no puddles under
  T-0053: ice cells and their orthogonal neighbours are still classed as
  damp in `dungeon.ts`, so the stone next to a slab stays properly wet
  while the rest of the level reads dry.

## Environment map — `moodEnvironment(mood)` and `Atmosphere.environment`

The GPU pipeline's SSR pass samples an equirectangular environment map for
rays that leave the screen (screen-edge fade and misses fall back to it).
`SSRNode.setEnvMap` requires a **plain equirectangular `DataTexture` with
CPU-side `image.data`** — PMREM render targets and `scene.environment`
cubemaps are explicitly rejected. Afterburn built one from its `_envScene`
sky dome; the port dropped the sky dome (a dungeon has none) which left the
stochastic path calling `sampleEnvironmentBRDF` on `null` and spewing
`TypeError` at `SSRNode.js:1051` every frame. `moodEnvironment` closes that
hole.

```ts
export function moodEnvironment(mood: Mood): THREE.DataTexture;
```

- **Shape.** 32 × 16 texels, `RGBAFormat`, `HalfFloatType`, mapping
  `THREE.EquirectangularReflectionMapping`. 512 texels is enough — SSR only
  reads it as a low-frequency miss colour, not as a diffuse IBL source.
- **Gradient.** Vertical only, no horizontal variation. Row 0 of the data
  array is equirect V = 0 (bottom pole, "looking down") and carries
  `mood.fill.ground`; row 15 is V = 1 (top pole, "looking up") and carries
  `mood.fill.sky`. Every channel is pre-multiplied by `mood.fill.intensity`,
  so the pipeline can hand the texture to SSR as-is (no separate uniform to
  wire).
- **`flipY = false` and no colour-space conversion.** Matches `DataTexture`
  defaults; the raw half-float values are what SSR reads in linear space.

`Atmosphere` caches one env texture per named mood and exposes it via a
read-only accessor:

```ts
readonly get environment: THREE.DataTexture | null;
```

Rebuilt (with the previous texture disposed) in the constructor, in
`atm.set(id)`, and in `atm.blendTo(id, s)` — i.e. whenever `atm.name`
changes, but only once per distinct id. The environment does **not** blend
during a `blendTo` transition: it snaps to the destination mood's map when
the transition is armed. This is deliberate — SSR misses only see the
gradient as a dim fallback (dungeon moods use `fill.intensity` of
`0.05..0.10`); the visible reflection quality comes from the on-screen
part, not the miss colour.

`SSRNode` reads the environment map at construction time, so downstream
wiring passes `atmosphere.environment` into `createPipeline({ environment })`
once. Runtime mood changes will rebuild the atmosphere's cache but the SSR
node keeps its original map until the caller rebuilds the pipeline or
calls `state.nodes['ssr'].setEnvMap(atmosphere.environment)` explicitly.

## Blending — `blendMoods(a, b, t)`

Pure exported function, no TSL, no side effects. `t` is clamped to `[0, 1]`;
numbers lerp linearly, hex colours blend per RGB channel with `Math.round`
back to a byte. `blendMoods(a, b, 0)` returns a fresh clone of `a`;
`blendMoods(a, b, 1)` returns a fresh clone of `b` (every mood in the table
overrides the same nine `look` keys so this is exact).

## `createAtmosphere` / `Atmosphere`

Impure rig on top of the mood table. Constructor:

```ts
new Atmosphere({
  scene,            // THREE.Scene — receives the lights and fogNode
  look,             // Look — the pipeline's grade uniforms (structural)
  weather,          // Weather — the shared W block from materials.ts
  shadowSize = 2048,
  shadowRange = 24,
});
```

The `Look` type is a **local structural interface**
(`{ [K in keyof LookValues]?: { value: number } }`) — `Atmosphere` never
imports `web/src/gpu/pipeline.ts` (T-0037 may not have landed at the time of
this ticket; the caller wires the two together). Any subset of look keys the
caller passes in is written to; unknown keys the mood carries are ignored.

Runtime API:

- `atm.set(id)` — snap to `MOODS[id]` immediately.
- `atm.blendTo(id, seconds)` — smoothstep-eased blend over `seconds`
  real-time. `seconds <= 0` snaps.
- `atm.update(dtSeconds)` — advance the blend and write the current values
  to the key light (`DirectionalLight`), the hemisphere fill, the fog
  uniforms, `weather` (`W`) and `look`. Call once per frame.
- `atm.state` — a fresh clone of the current interpolated `Mood`.

`atm.keyLight` and `atm.fill` are exposed so the scene builder can, e.g.,
attach the lantern as a child of `keyLight.target` or clamp `keyLight` to
the player position.

## File split — what to import from where, and why

The ticket calls out that `tests/gpu-moods.test.ts` is compiled under the
root tsconfig (no DOM lib) and must be able to import `blendMoods`, the
`MOODS` table and `fxByte` without evaluating a TSL graph. The split we
landed:

- `web/src/gpu/moods.ts` **top half** — pure: `Mood`, `MoodId`, `MOODS`,
  `blendMoods`, `fxByte`, `FLAG_*`, `FX_*`. No `uniform()`, `mix()`,
  `float()` etc. run at module load. `fxByte` lives here (not in
  `materials.ts` as in afterburn) so the test can reach it without pulling
  in `materials.ts`'s top-level `W` uniforms.
- `web/src/gpu/moods.ts` **bottom half** — `Atmosphere`. Value-imports
  `three/webgpu` (for `DirectionalLight`, `HemisphereLight`, `Color`) and
  `three/tsl` (for `uniform`, `fog`, `densityFogFactor`) at the file top,
  but TSL nodes are only constructed inside the constructor. Loading the
  module in node is safe: `three/webgpu` and `three/tsl` import cleanly
  under node (used by the existing voxel tests since T-0036).
- `web/src/gpu/materials.ts` — browser-only. The shared `W` block is built
  at module top (matching afterburn), so any code path that imports
  `materials.ts` will construct those uniform nodes. Only imports from
  `moods.ts` are the pure `FX_*` constants.

No third file was added: the split is entirely within `moods.ts` (the
`materials.ts`/`moods.ts` boundary is the natural seam and stayed inside
scope).

## What I could not verify

Workers cannot see a rendered frame and containers have no GPU
(`docs/gpu.md` §9), so nothing below has been eyeballed. The unit tests
cover the pure surfaces (`blendMoods` interpolation, the mood table's
structural completeness and ranges, `fxByte` bit-packing); everything past
that needs the PM's eye on the host:

- **Tuning numbers.** Every value in the mood table above is within the
  ticket's stated intent, but "moderate", "very dim", "roughly double",
  "cool teal shadow tint" and "very low roughness" are subjective. Expect a
  follow-up tuning ticket after the PM shoots `/scene.html` in raw and
  amber-styled modes.
- **`lava` "from below".** The `Mood` schema is only `key: { color,
  intensity }` — no direction. The rig places the key light overhead by
  default; the "from below" lava character has to come from emissive lava
  geometry that the scene builder places (T-0039) or from a per-scene
  override on `atm.keyLight.position`. The mood's colour, contrast,
  saturation and bloom carry the *feel*; the direction is a scene-builder
  concern.
- **`ice` roughness.** The ticket asks for "wetness ≈ 0.3 with very low
  roughness". We set `weather.wetness = 0.30`; the material shader turns
  that into a wet stone film ~0.28 roughness (fresh, up-facing surfaces get
  0.18). "Very low" may want 0.5+; the PM tunes after seeing it.
- **Fog density units.** afterburn's densities are `~0.005..0.02` for
  outdoor haze; a dungeon corridor is spatially small and one three unit is
  one metre (`docs/gpu.md` §4), so we picked `0.09..0.20` for perceptible
  falloff at 4–8 cell depth. Whether that fights the vignette in
  `deep_dark` is a see-it question.
- **The Atmosphere class was constructed only by the type checker.** The
  test never runs the constructor (no scene, no renderer). Any wiring
  mistake in `_apply()` (e.g. writing to a `look` key with a typo, or a bad
  `fog(...)` argument) will only show up at the PM's first render. The
  runtime API surface (`set` / `blendTo` / `update` / `state`) matches the
  ticket and the afterburn original but has not been exercised.
- **Shadow camera defaults.** `shadowSize = 2048`, `shadowRange = 24`
  (afterburn used 4096 / 46 for outdoor scenes). A dungeon rarely needs
  more than a room's worth of shadow, but a large open lava chamber may
  need `shadowRange` bumped by the caller.
