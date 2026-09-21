# Ortho view on the GPU render path (browser viewport)

*T-0043. Read `docs/gpu.md` §4–§7, `docs/gpu-compose.md` and
`web/src/gl/ortho-camera.ts` first — this file only describes what changes
when the 3/4 overhead camera and its cutaway ride the ported afterburn
stack instead of the legacy WebGL renderer.*

## Why

`docs/gpu.md` §7 parked the ortho camera on the legacy `SceneBuilder` while
the first-person view moved to the GPU path (T-0040). That left the two
views out of sync: fps was AgX-graded, SSGI-lit, DOF-focused; ortho was
a Lambert diorama under one point light. This ticket puts both on the same
lighting, so switching F3 changes camera pose, not look.

## What ships

The ortho maths in `web/src/gl/ortho-camera.ts` is **reused unchanged** —
`orthoPlacement`, `placeOrthoCamera`, `cutawayCellsFor` and the constants
they read (`ORTHO_DISTANCE_CELLS`, `HERO_SPRITE_HEIGHT`, `CUTAWAY_RADIUS`,
`ORTHO_AZIMUTH_RAD`, `ORTHO_ELEVATION_RAD`) all stay. The GPU side layers
three helpers on top, in `web/src/gpu/ortho.ts`:

| helper                       | what it does                                                      |
|------------------------------|-------------------------------------------------------------------|
| `applyOrthoPlacementTo`      | Copies an `OrthoPlacement` onto a `three/webgpu` ortho camera     |
| `cutawayKey(hero)`           | Memoisation key so the ghost mesh rebuilds only when hero moves   |
| `orthoDofFocus(placement)`   | DOF focus + range that tracks the ortho camera-to-target distance |

All three are pure (no `three`, no DOM) so `tests/gpu-ortho.test.ts` pins
them down in node.

## The camera rebuild

*Superseded by T-0050. T-0043 shipped a "copy the ortho projection matrix
onto the pipeline's `PerspectiveCamera`" trick that rendered a completely
black frame at every quality tier — the PM's eyeball review of
`?gpu=raw&view=ortho` caught it after the accept. The section below
describes what actually ships now; the "projection copy" approach is kept
here only long enough to explain why it does not work.*

`createPipeline` binds one camera at construction time — `pass(scene,
camera)` and every projection-aware TSL node (SSGI/SSR/TRAA/DOF/godrays)
hold that reference and derive their own uniforms (projection, inverse,
`isPerspectiveCamera`-dependent depth maths) from it. Hand-copying the
projection matrix onto a camera that still reports itself as perspective
is not a supported configuration:

- `pass(scene, camera)` re-reads the projection from that reference every
  frame — a `Camera.updateProjectionMatrix()` call anywhere in three's
  internals silently throws the copy away;
- SSR reads `camera.isPerspectiveCamera` (`SSRNode.js:833`, `:1036`,
  `:1079`) and picks the perspective depth-reconstruction branch, which
  produces NaN when the actual projection is ortho;
- TRAA reads `camera.isOrthographicCamera` (`TRAANode.js:544`) and takes
  the perspective velocity branch for the same reason.

Zero of these check `projectionMatrix` directly, so the perspective
reference wins and the ortho projection sitting inside it is never used.
Result: a completely black frame at `q=low` (only bloom, FXAA, grade — no
depth reconstruction at all), and the same at every richer tier.

**The fix — stop faking it, rebuild the graph against the real camera on
F3.** `createPipeline`'s `build()` was already rebuild-friendly (that is
what `setQuality` uses). `PipelineHandle.setCamera(cam)` rebinds `camera`
in the closure and calls `build(state.quality)` — a no-op when the
reference is unchanged, otherwise identical in cost to a quality change.
`PipelineOptions.camera` widens from `PerspectiveCamera` to
`PerspectiveCamera | OrthographicCamera` so both flavours are valid at
construction and at rebuild.

`GpuPath` keeps two cameras — `this.camera` (`WG.PerspectiveCamera`) for
fps, `this.orthoCamera` (`WG.OrthographicCamera`) for the overhead view.
Only on a view change (F3), before the next `handle.render()`:

```ts
if (view !== this.lastView) {
  this.handle.setCamera(pipelineCameraForView(view, {
    perspective: this.camera,
    orthographic: this.orthoCamera,
  }));
  // ceiling toggle, ghost mesh reset, lastView = view …
}
```

Per-frame the ortho branch just runs `applyOrthoPlacementTo(this.orthoCamera,
orthoPlacement(hero, cols, rows))` — the placement math is unchanged. A
graph rebuild when the player presses F3 is fine; it is a mode switch, not a
hot path. Never call `setCamera` per frame.

`pipelineCameraForView(view, cams)` is a pure helper in
`web/src/gpu/ortho.ts` — its whole shape mirrors `pipelineOptionsWithEnv`
so `tests/gpu-ortho.test.ts`' "switching to the ortho view rebuilds the
graph against an orthographic camera" can inject a `setCamera` stub, hand
it the value the helper returns, and pin the wiring without a real
`WebGPURenderer`.

**SSGI vs. an ortho camera.** `SSGINode.setSize` reads `camera.fov`
(`SSGINode.js:348`) and would compute NaN on an `OrthographicCamera`, so
`build()` demotes SSGI to GTAO when the bound camera is orthographic — same
MRT footprint (still needs the normal target, no `diffuseColor`), and GTAO
is projection-agnostic in three r185. `q=high` and `q=ultra` on the ortho
view therefore render through GTAO + SSR + TRAA + DOF + bloom instead of
SSGI + SSR + …; the frame is one bounce dimmer than fps, which is a look
tuning question, not a black-frame one.

`orthoPlacement`'s `left/right/top/bottom/near/far` land byte-for-byte on
the `OrthographicCamera` — that is what `tests/gpu-ortho.test.ts`'s "the
ortho frustum from `placeOrthoCamera` is applied unchanged to the GPU
camera" pins down.

## Lantern reparenting

The T-0040 wiring parented the hero's `PointLight` to the perspective
camera so its world position rides at `(pose.x, EYE_HEIGHT, pose.y)`
without extra bookkeeping. That breaks in ortho: the camera moves 40 cells
NW-above the hero, and the lantern moves with it. So the GPU path now
attaches the lantern to the **scene**, not the camera, and repositions
it to the hero cell every frame in both views. The lantern's world
position is unchanged in fps, so this is not a look regression there.

## The cutaway — option (a), and what it does not fix

The ticket asks us to pick between:

- **(a)** a second, small "ghost" mesh built from the cutaway cells;
- **(b)** a clip volume in the material driven by the hero cell.

**We ship (a).** Reasons:

1. `web/src/gpu/materials.ts` is not in this ticket's scope; option (b)
   would need to add a clip-volume uniform + a `discard`/`clip` in the
   voxel material's TSL graph. That is where option (b) belongs, but it is
   a separate ticket.
2. Adding a mesh to the scene is a two-line change; the pure part
   (memoisation key, ghost-cell set) is unit-testable.
3. The `docs/gpu.md` §8 budget is generous — the cutaway set is at most
   `CUTAWAY_RADIUS² · 2 - 1 = 7` cells, so the ghost group holds ≤ 7
   `Mesh` instances, one shared 1×1×1 `BoxGeometry`, one shared
   `MeshBasicMaterial`. Rebuilds happen once per hero move (memoised by
   `cutawayKey`), not once per frame.

### What (a) delivers

- `DungeonScene.ceiling` — already a separate group by `docs/gpu.md` §4 —
  gets `visible = false` while ortho is active. Torchlight bounces off the
  ceiling in fps, so this is a visible win for the overhead view: the
  rooms open up, and the hero reads.
- A translucent grey (`0x9a9a9e`, `opacity = 0.35`, `depthWrite = false`,
  `renderOrder = 999`) `Mesh` sits at every solid cell inside the cutaway
  triangle in front of the hero. It writes a colour tint over the wall in
  those cells and marks the cutaway zone for the player.

### What (a) does not deliver — and the follow-up

The GPU dungeon is **one merged geometry per chunk** (`docs/gpu-dungeon.md`
"Chunked rebuild"): individual wall cells cannot be hidden the way the
legacy `InstancedMesh` hides them by collapsing their matrix to `scale = 0`.
So the ghost mesh in option (a) is an **overlay**, not a replacement: the
opaque wall geometry underneath is still drawn, and the hero remains
partially occluded when a wall sits exactly in front of it.

In practice the impact is mild: the ceiling is off, the ortho camera looks
down at 35°, and walls are 1 unit tall — the hero (0.7 units) reads over
the top of most walls in the cutaway zone. But this is not the full "walls
in front of the hero go transparent" behaviour the legacy path delivers,
and the docs must not overclaim.

**The follow-up ticket** is option (b): a clip volume in the voxel material,
driven by the hero cell centre and the cutaway box extents, applied as a
per-fragment `discard` inside the box. That ticket touches
`web/src/gpu/materials.ts` (and possibly `dungeon.ts` to feed the hero
uniform through). It composes on top of option (a) without discarding
anything shipped here.

## DOF follows the ortho camera

Afterburn's DOF (`three/addons/tsl/display/DepthOfFieldNode`) blurs
everything outside `focus ± focusRange` metres from the camera. The mood
table pins `focus ≈ 5 m` for the fps view, matching the near-close dungeon
walls. The ortho camera sits `ORTHO_DISTANCE_CELLS = 40 m` from the
target, so those fps values would render the entire board out of focus.

Each ortho frame, after mood + styled/raw grade overrides, the GPU path
writes:

```ts
const dof = orthoDofFocus(orthoPlacement);
handle.look.focus.value = dof.focus;              // = camera-to-target
handle.look.focusRange.value = dof.focusRange;    // = focus (wide enough)
```

`orthoDofFocus` computes the distance from `placement.position` to
`placement.target`, which is `ORTHO_DISTANCE_CELLS` by the construction of
`orthoPlacement`. Setting `focusRange = focus` keeps the whole
`[0.1, 200]` near/far slab inside the sharp region (the dungeon fits in ~
50 m of depth from the ortho camera).

`tests/gpu-ortho.test.ts`' "DOF focus follows the ortho camera distance"
pins the formula: `focus === camera-to-target distance`, and the derived
distance across two different hero cells stays constant — so the DOF
override is stable across the frames a moving hero produces.

## docs/gpu.md §7 is now stale

`docs/gpu.md` is PM-owned (`.tigerteam/PROTOCOL.md` §6) and not in this
ticket's scope, so it stays untouched here. Its §7 says:

> *`web/src/gl/scene-builder.ts`, its materials and the cutaway stay
> exactly as they are: they are the fallback path (§3, §6) and the ortho
> view keeps using them until a later ticket ports the cutaway to the GPU
> scene. `GlViewport` owns both paths and decides per frame.*

That "later ticket" is this one. The scene-builder / legacy path is still
the fallback (depth styles, `?gpu=off`, GPU init failure), so the first
sentence remains true; only the last clause is now historical. Flagged in
the Worker report so the PM can rewrite §7 in the next `docs/gpu.md` edit.

## Params, F3, and the path decision

Nothing changes in `parseGpuQueryOptions`. What changed is `render()`:
before T-0043, `this.view === 'ortho'` short-circuited to
`path = 'legacy'`. Now the ortho view runs through `choosePath()` on the
same terms as fps — GPU when ready, legacy on depth styles / `?gpu=off` /
GPU-not-ready. `debugInfo().path` therefore reads `styled` on an ortho
frame under `?gpu=auto`, not `legacy`, which is a change that any harness
watching that field will see.

## Verification

Everything in this ticket that runs in node is exercised by
`tests/gpu-ortho.test.ts` (four cases):

1. `the ortho frustum from placeOrthoCamera is applied unchanged to the GPU camera`
2. `the cutaway set changes only when the hero cell changes`
3. `switching to the ortho view rebuilds the graph against an orthographic camera` (T-0050)
4. `DOF focus follows the ortho camera distance`

## What I could not verify

The rules `docs/gpu.md` §9 sets on this whole wave apply here too. The
worker container has no GPU and cannot look at a rendered frame, so:

- **No visual verification.** The ceiling-hide, ghost overlay, F3 pipeline
  rebuild against the real `OrthographicCamera`, and the DOF override
  running through the full afterburn stack are written to specification and
  unit-tested at their pure boundaries; the actual frame — including
  whether `?gpu=raw&view=ortho` now renders anything at all — is the PM's
  eyeball review, through `/scene.html?view=ortho` and `scripts/web-shot.mjs`
  (`docs/gpu.md` §9).
- **No timing.** `docs/gpu.md` §8's 16 ms/frame budget still stands
  unverified. The F3 rebuild is one `build()` call — a full graph
  reconstruction, on par with a quality change — which is fine as a one-off
  on a mode switch but has not been measured; if a real device shows a
  visible hitch on F3, holding two pipelines (one per camera) is the
  fallback the ticket accepted.
- **The ghost overlay is not a real cutaway** (see "What (a) does not
  deliver" above). If the PM's review shows a hero fully occluded behind
  cutaway walls in the ortho view, the follow-up ticket for option (b) is
  the fix, not a rework of this one.
