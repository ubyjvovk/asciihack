# GPU post-processing pipeline (`web/src/gpu/{renderer,pipeline}.ts`)

Ported from `~/afterburn/src/render/{renderer.js, pipeline.js}` per
`docs/gpu.md` §1–3, §8. The stack is what makes afterburn look like a
photographed diorama; here it lights the browser dungeon viewport.

## Pass order

```
MRT (color · emissive · normal · depth · velocity)
    → SSGI (ultra/high) | GTAO (medium)
    → SSR (medium+; full-res on ultra)
    → god rays (high+, sun optional)
    → clamp(radiance, look.maxRadiance)      # firefly clamp before TRAA
    → TRAA (medium+)
    → DOF (medium+)
    → bloom (all tiers)
    → renderOutput()  # AgX tone map + sRGB; pipeline.outputColorTransform = false
    → grade  (split-tone shadow→highlight by luminance / tintBalance)
             (contrast around midGrey)
             (saturation around per-pixel luminance)
    → vignette (radial, vignetteFalloff × vignette)
    → grain    (interleavedGradientNoise() − 0.5, × look.grain)
    → fade     (multiply)
    → FXAA (low only)
```

## Quality tiers (`QUALITY` table)

Named tiers resolve via `qualityPlan(name, override?)`. Every field can be
overridden individually; overrides win field-by-field.

| flag            | low     | medium  | high    | ultra   | notes |
|-----------------|---------|---------|---------|---------|-------|
| `ssgi`          | false   | false   | true    | true    | screen-space bounce GI |
| `ssgiSlices`    | 0       | 0       | 1       | 2       | more slices = fewer artefacts |
| `ssgiSteps`     | 0       | 0       | 12      | 16      | samples per slice |
| `ssr`           | false   | true    | true    | true    | wet-floor reflections |
| `ssrFullRes`    | false   | false   | false   | true    | half-res otherwise |
| `godRays`       | false   | false   | true    | true    | needs a sun-like light |
| `godRaySteps`   | 0       | 0       | 36      | 72      | raymarch steps |
| `traa`          | false   | true    | true    | true    | temporal reprojection AA |
| `dof`           | false   | true    | true    | true    | depth-of-field bokeh |
| `bloom`         | true    | true    | true    | true    | HDR bloom |
| `gtao`          | false   | true    | false   | false   | fallback AO when no SSGI |
| `fxaa`          | true    | false   | false   | false   | cheap AA on low |
| `giScale`       | 1.0     | 1.0     | 1.0     | 1.0     | SSGI intensity knob |
| `maxRadiance`   | 8.0     | 8.0     | 8.0     | 8.0     | firefly clamp before TRAA |

## Grade uniforms (`createLook`)

Every field is wrapped in a `uniform()` by the pipeline builder and read
inside the grade block. The defaults are afterburn's; overrides win
per-field. `shadowTint`/`highlightTint` are copied on read so callers can
mutate the returned tuple without affecting the module defaults.

| uniform           | default             | what it does |
|-------------------|---------------------|--------------|
| `exposure`        | 1.0                 | multiplied on top of `AgXToneMapping` exposure; keeps mid-grey where AgX puts it |
| `shadowTint`      | `[0.86, 1.00, 1.08]` | RGB tint applied where luminance ≪ `tintBalance` (cool teal in shadows) |
| `highlightTint`   | `[1.10, 1.04, 0.92]` | RGB tint where luminance ≫ `tintBalance` (warm amber in highlights) |
| `tintBalance`     | 0.5                 | luminance value at which the split-tone crosses over |
| `contrast`        | 1.05                | mix factor between `midGrey` and the tinted image |
| `midGrey`         | 0.18                | 18 % grey — the pivot of the contrast operator |
| `saturation`      | 1.08                | mix factor between per-pixel luminance and the tinted image |
| `vignette`        | 0.35                | strength of the radial darkening |
| `vignetteFalloff` | 1.20                | curve of the radial darkening (higher = tighter) |
| `grain`           | 0.03                | amplitude of `interleavedGradientNoise()` grain |
| `fade`            | 1.0                 | final multiply — pull to 0 for a fade-to-black transition |

## The `clampQuality` / `qualityPlan` split

Two pure exports live next to the impure builder:

- **`clampQuality(requested, caps)`** — enforces the backend rule from
  `docs/gpu.md` §3. A non-WebGPU backend, or a WebGPU adapter reporting
  `maxColorAttachmentBytesPerSample < 64`, cannot run the full MRT stack
  and is capped at `'medium'`. `caps.maxQuality` is honoured as an
  additional configured ceiling (created by `createRenderer`).
- **`qualityPlan(name, override?)`** — resolves the named tier into the
  flat `QualitySettings` record, applying a dev override on top.
  `createPipeline` calls this once at construction and again inside
  `setQuality(name, override)` when the resolved name changes.

The split exists because the tests in `tests/gpu-pipeline.test.ts` must
not touch a GPU (the container has none), so all decision-making that
matters — tier selection and the tier’s effect on the flags — lives in
pure functions. The graph builder only *consumes* those flags.

`setQuality` rebuilds the graph only when the resolved name changes (or an
override is supplied): renaming from `'ultra'` to `'ultra'` is a no-op.

## What I could not verify

Workers cannot see a rendered frame and this container has no GPU
(`docs/gpu.md` §9). The following claims about the impure builder rest on
the ticket + `docs/gpu.md` spec and the type signatures of `three/webgpu`
+ `three/tsl` + `three/addons/tsl/display/*` at three r185.1; they need
the PM's eyeball review on the host:

- **The graph actually compiles.** The addon nodes chained above have
  never been exercised end-to-end here. TSL type unions require several
  `unknown as Node<'vec4'>` casts in `pipeline.ts` where the fluent chain
  crosses addon boundaries; if a node's real output type conflicts, the
  first `postProcessing.render()` will throw.
- **Per-pass cost / whether we hit the 16 ms budget at 640×360 on
  `high`.** Untested; the tier presets are picked from `docs/gpu.md` §3
  (SSGI 1/2 slices, godray step count 36/72, half/full-res SSR) but the
  measurable cost is a host thing.
- **Whether the WebGL2 fallback backend runs SSGI at all.** Three's
  `WebGPURenderer` falls back to a WebGL2 backend when `navigator.gpu` is
  absent; `caps.webgpu` is set to `false` in that path and `clampQuality`
  caps the tier at `'medium'`, so SSGI never enters the graph on WebGL2.
  If the fallback backend can *technically* run some of the higher-tier
  nodes, the current rule is intentionally conservative.
- **God rays without a sun.** `createPipeline` skips the god-ray node when
  no `sun` option is supplied, even on `high`/`ultra`. Afterburn's
  original may keep an internal default light; that behaviour needs
  confirmation against `~/afterburn/src/render/pipeline.js`.
- **`ssgi` `.giIntensity`, `.sliceCount`, `.stepCount` uniform writes.**
  The addon exposes these as `UniformNode`s; the code writes `.value`
  directly, which is the r185 API but has not been GPU-exercised here.

### Provenance note

At the time this ticket was executed the worker container did not have
`~/afterburn/` mounted, so the port was driven by the ticket spec plus
`docs/gpu.md` §1–3, §8 and the addon type signatures under
`node_modules/@types/three/examples/jsm/tsl/display/`, rather than by
copying afterburn line-for-line. Any drift from the JS original — pass
ordering, tier flag names, look uniforms and their defaults — should be
reconciled with `~/afterburn/src/render/pipeline.js` on the host when
that source is available.
