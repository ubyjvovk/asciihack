# GPU post-processing pipeline (`web/src/gpu/{renderer,pipeline}.ts`)

Strict-TypeScript port of
`vendor/afterburn/src/render/pipeline.js` and `.../renderer.js`
(afterburn commit `8492a00`). The stack is what makes afterburn look like a
photographed diorama; here it lights the browser dungeon viewport.
`vendor/afterburn/` is read-only reference — the port lives entirely under
`web/src/gpu/`.

## Pass order

```
scenePass = pass(scene, camera)
  MRT slots:  output
              diffuseColor   (SSGI tier only)
              normal         (packNormalToRGB(normalView); needed by SSGI/SSR)
              metalrough     (vec2(metalness, roughness); SSR tier)
              velocity       (TRAA tier)
              depth          (implicit)

  → SSGI (ultra, high)           |  or  GTAO (medium)   |  or nothing (low)
  → SSR                           (medium+, adds `node.rgb + r.rgb`)
  → god rays                      (high+, needs a sun-like light;
                                    bilateralBlur → depthAwareBlend with edgeRadius/edgeStrength)
  → weather overlay pass          (opts.overlay, additive)
  → min(node.rgb, look.maxRadiance)     # firefly clamp before TRAA
  → TRAA                          (medium+)
  → DOF                           (medium+; focus / focusRange / bokeh)
  → bloom                         (all tiers; strength/radius/threshold from look)
  → renderOutput(vec4(node.rgb * look.exposure, 1.0))   # AgX + sRGB
  → FXAA                          (low only, on the display-space image)
  → grade:  split-tone   tint = mix(shadowTint, highlightTint, smoothstep(0, 0.75, luminance))
                         c = mix(c, c * tint * 1.9, look.tintAmount)
            contrast     c = (c - 0.5) * look.contrast + 0.5
            saturation   c = mix(vec3(luminance(c)), c, look.saturation)
  → vignette              d = |screenUV - 0.5| * (1.0, 0.85)
                          c *= mix(1.0, smoothstep(0.85, 0.2, d), look.vignette)
  → grain                 n = interleavedGradientNoise(screenCoord + time.mul(61).floor()*(37,17)) - 0.5
                          c += n * look.grain * mix(1.0, 0.35, luminance)
  → fade                  c = clamp(c, 0, 1) * look.fade
pipeline.outputNode = vec4(c, 1.0)
pipeline.outputColorTransform = false   // we tone-mapped ourselves above
```

## Quality tiers (`QUALITY` table)

Ported one-for-one from afterburn. Fields absent from a tier stay absent
(afterburn's `{ ...tier, ...override }` semantics — do not fill missing keys
with sentinel numbers). `qualityPlan(name, override?)` merges an optional
dev override on top; overrides win field-by-field.

| field       | low    | medium  | high    | ultra   | notes |
|-------------|--------|---------|---------|---------|-------|
| `gi`        | `none` | `ao`    | `ssgi`  | `ssgi`  | GI kind: SSGI ≥ GTAO ≥ none |
| `slices`    | —      | —       | 1       | 2       | SSGI slices (per pixel) |
| `steps`     | —      | —       | 12      | 10      | SSGI samples per slice |
| `ssr`       | false  | true    | true    | true    | screen-space reflections |
| `ssrQ`      | —      | 0.35    | 0.5     | 0.75    | SSR ray quality (0…1) |
| `ssrScale`  | —      | 0.5     | 0.5     | 1       | SSR resolution scale (1 = full-res) |
| `rays`      | false  | false   | true    | true    | god rays through sunlight |
| `raySteps`  | —      | —       | 40      | 72      | godray raymarch steps |
| `aa`        | `fxaa` | `traa`  | `traa`  | `traa`  | AA kind |
| `dof`       | false  | true    | true    | true    | depth-of-field bokeh |
| `bloom`     | true   | true    | true    | true    | HDR bloom |
| `shadow`    | 2048   | 2048    | 4096    | 4096    | shadow-map resolution |
| `scale`     | 1      | 1       | 1       | 1       | reserved (frame scale) |
| `giScale`   | —      | —       | —       | —       | optional override; SSGI target = beauty × giScale |

## Look uniforms (`createLook`)

`createLook()` returns a plain-value POJO (numbers and `0xRRGGBB` hex);
`createPipeline` wraps every field in `uniform(...)` internally so
`moods.ts` can animate them via `.value = ...` at runtime. Defaults are
afterburn's — do not adjust without a matching change in the vendored
source.

| uniform          | default    | consumed by | what it does |
|------------------|-----------:|-------------|--------------|
| `giIntensity`    |     `9.0`  | SSGI        | multiplier on the bounce term |
| `aoIntensity`    |     `1.35` | SSGI        | multiplier on the AO term |
| `giRadius`       |     `7.0`  | SSGI        | trace radius (scene units) |
| `ssrIntensity`   |     `0.85` | SSR         | overall reflection strength |
| `rayDensity`     |     `0.0035`| godrays    | volumetric density |
| `rayMax`         |     `0.3`  | godrays     | density clamp |
| `rayColor`       |  `0xffd9ac`| godrays     | tint blended in via `depthAwareBlend.blendColor` |
| `focus`          |    `30.0`  | DOF         | focal distance (scene units) |
| `focusRange`     |    `38.0`  | DOF         | focal-length knob for the CoC |
| `bokeh`          |     `1.0`  | DOF         | bokeh scale |
| `bloomStrength`  |     `0.22` | bloom       | overall bloom mix |
| `bloomRadius`    |     `0.55` | bloom       | blur radius |
| `bloomThreshold` |     `1.0`  | bloom       | HDR high-pass cutoff |
| `exposure`       |     `1.0`  | grade (pre-`renderOutput`) | multiplier on the beauty pass before tone map |
| `contrast`       |     `1.06` | grade       | contrast around 0.5 |
| `saturation`     |     `1.02` | grade       | saturation around luminance |
| `shadowTint`     |  `0x0e2a33`| grade       | cool teal pulled toward in shadows |
| `highlightTint`  |  `0xfff1dc`| grade       | warm amber pulled toward in highlights |
| `tintAmount`     |     `0.16` | grade       | mix factor between the tinted and untinted image |
| `vignette`       |     `0.42` | grade       | strength of the radial darkening |
| `grain`          |     `0.028`| grade       | amplitude of `interleavedGradientNoise` grain |
| `maxRadiance`    |     `8.0`  | firefly clamp | pre-TRAA `min(color, vec3(...))` cap |
| `fade`           |     `1.0`  | grade       | final multiply (drop to `0` for fade-to-black) |

## The `clampQuality` / `qualityPlan` split

Two pure exports live next to the impure builder so
`tests/gpu-pipeline.test.ts` can pin behaviour without touching a GPU:

- **`clampQuality(requested, caps)`** — enforces the backend rule from
  `docs/gpu.md` §3. A non-WebGPU backend, or a WebGPU adapter reporting
  `maxColorAttachmentBytesPerSample < 64`, cannot run the full MRT stack
  and is capped at `'medium'`. `caps.maxQuality` (produced by
  `createRenderer`) is honoured as an additional configured ceiling; the
  tighter of the two caps wins.
- **`qualityPlan(name, override?)`** — resolves the named tier into the
  flat `QualitySettings` record, applying a dev override on top.
  `createPipeline` calls this once at construction and again inside
  `setQuality(name)` when the resolved name changes.

`setQuality` rebuilds the graph only when the resolved name actually
changes: `setQuality('ultra')` twice in a row is a no-op.

## SSR backend gate — three r185 shader bug

three r185's `SSRNode.js` builds its step count as
`trunc( … ).max( int( 1 ) )`. WGSL coerces the mismatch and the pass runs
fine on **WebGPU**; the GLSL backend emits `max( int( trunc( … ) ), 1.0 )`,
which GLSL ES 3.0 rejects as an `int`/`float` mismatch. On the **WebGL2**
backend the fragment shader never links, the pass silently contributes
nothing, and the console fills with `INVALID_OPERATION` (isolated with
`/gpu-probe.html?backend=webgl2&stack=ssr&stochastic=0` vs `stochastic=1`;
see `docs/gpu.md` §3).

`createPipeline` therefore passes `stochastic: true` on the WebGL2 backend
and `stochastic: false` (afterburn's setting) on WebGPU. Backend detection
uses `renderer.backend?.isWebGPUBackend === true`, matching `renderer.ts`,
so `forceWebGL` is honoured. Every tier that turns SSR on also runs TRAA,
which is the temporal denoiser stochastic SSR expects. The `reflectNonMetals`
option is only consulted on the non-stochastic path.

The choice is a one-liner in `web/src/gpu/pipeline.ts`
(`ssrStochastic(isWebGPU)`), exported so `tests/gpu-pipeline.test.ts` can
pin it. Delete the gate when three upstream fixes `SSRNode.js` — the fix
is one character: `.max( int( 1 ) )` → `.max( 1 )`.

## Deviations from the vendored source

The port keeps runtime behaviour identical, but a strict-TypeScript
translation forces a small set of deviations from the JS original. Each
one is listed here so the reviewer knows what to look at.

- **Type-level casts.** TSL's fluent-node arithmetic loses precise types
  when an addon output (`ssr`, `traa`, `dof`, `bloom`) feeds back into
  `.rgb`/`.add`/`.mul`. `pipeline.ts` uses a handful of narrow
  `as WGNode<'vec4'>` / `as unknown as WGNode<'vec3'>` casts on those
  boundaries; every one is annotated where it appears and none of them
  changes the runtime shape of the node graph.
- **`createLook` splits into a pure and a wrapped form.** Afterburn's
  `createLook()` returns a POJO of `uniform(...)` nodes directly. We
  export it as a plain-number POJO (testable in Node) and wrap it into
  `LookUniforms` inside `createPipeline`. The uniforms handed to the
  graph, and the values `moods.ts` will animate, are identical to the
  original; only the module boundary moved.
- **Colour tints as hex, not `color()` nodes.** `Look.shadowTint`,
  `highlightTint`, `rayColor` are `0xRRGGBB` numbers in the POJO.
  `createPipeline` builds a `new Color(hex)` and passes it through
  `uniform(...)`, which is the same underlying `UniformNode<'color', Color>`
  afterburn produces via `uniform(color(0x...))`.
- **`opts.override = null` is normalised to `undefined`.** Afterburn
  accepts a nullable override; `qualityPlan` takes `Partial<...> |
  undefined`. `createPipeline` normalises internally.
- **DOM-typed `probe()` guarded for the Node build.** Root `tsconfig.json`
  omits DOM lib (the test file compiles with it), so `renderer.ts` reads
  `navigator.gpu` and `window.devicePixelRatio` behind `typeof` guards
  and a minimal `MinimalGpu`/`MinimalAdapter` shape (the `@webgpu/types`
  package isn't installed here). Runtime behaviour matches afterburn's.
- **State shape.** Afterburn attaches ad-hoc fields to `state`
  (`state.scenePass`, `state.overlayPass`); the port keeps everything
  under `state.nodes` so a single interface types it. Node lifetimes and
  identities are unchanged; only the access path differs.
- **`createPipeline` does not clamp `requested`.** `caps` used to live on
  `PipelineOptions` and was applied before `build()`. The port matches
  afterburn's behaviour (no clamping inside `createPipeline`); the
  caller is expected to run `clampQuality(requested, caps)` first — the
  test still pins that split.

Everything else — the `QUALITY` table, `createLook` defaults, MRT slot
names, pass ordering, uniform names, split-tone math, contrast pivot,
grain formula, `depthAwareBlend` `blendColor`/`edgeRadius`/`edgeStrength`
options, firefly clamp position — is copied verbatim from
`vendor/afterburn/src/render/pipeline.js`. I did a file-by-file diff
against the vendored source before handing off.

## What I could not verify

Workers cannot see a rendered frame and this container has no GPU
(`docs/gpu.md` §9). The following rest on the ticket + `docs/gpu.md` spec
plus the addon type signatures at three r185.1 and need the PM's eyeball
review on the host:

- **The graph actually compiles.** The addon nodes chained above have
  never been exercised end-to-end here; if a node's real output type
  conflicts with the following `.rgb`/`.add`/`.mul`, the first
  `pipeline.render()` will throw.
- **Per-pass cost and whether we hit the 16 ms budget at 640×360 on
  `high`.** The tier presets are afterburn's (SSGI 1/2 slices, godray
  step count 40/72, half-res SSR on medium/high, full-res on ultra) but
  measurable cost is a host thing.
- **Whether the WebGL2 fallback backend runs SSGI at all.** Three's
  `WebGPURenderer` falls back to a WebGL2 backend when `navigator.gpu` is
  absent; `caps.webgpu` becomes `false` and `clampQuality` caps at
  `'medium'`, so SSGI never enters the graph on WebGL2. If the fallback
  backend could technically run some of the higher-tier nodes, the
  current rule is intentionally conservative.
- **`setSize` monkey-patch for `giScale`.** The `gi.setSize = (w, h) =>
  base(w * giScale, h * giScale)` rebind matches the source's shape, but
  a full-frame render through it is untested. When `giScale === 1` (all
  four tiers today) the rebind is skipped.
- **Adapter `maxColorAttachmentBytesPerSample` reporting.** The renderer
  reads it via `(ad.limits as unknown as Record<string, number>)['…']`;
  we fall back to `32` when the field is absent, matching afterburn.
  Whether a real WebGPU adapter always reports a numeric value here is
  device-dependent.
