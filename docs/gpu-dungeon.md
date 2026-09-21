# Dungeon voxel scene (`web/src/gpu/dungeon.ts`)

*PM-owned contract in `docs/gpu.md` §4–7. This file is the T-0039 as-built:
how a `LevelView` becomes voxel geometry the ported afterburn renderer
lights, what falls back to what, the measured box budget, and — importantly —
the eyeball claims the worker environment cannot verify.*

The module replaces the textured-cube scene of `web/src/gl/scene-builder.ts`
for the GPU render path (`docs/gpu.md` §7). `scene-builder.ts` is untouched
and remains the WebGL fallback; the ortho view continues to use it until a
later ticket ports the cutaway.

## Public surface

- `class DungeonScene` — owns the merged level `Mesh`, a separable
  `Object3D` group named `ceiling`, and the live `PointLight` array.
  Methods: `refresh(level): boolean` (rebuilds only when the kind-hash
  changes), `updateLights(x, y): void` (reassigns which torches emit,
  capped at 8; only the 2 nearest cast shadows), `dispose(): void`.
- `bakeLevel(level, opts?)` — pure. Returns `{ writer, lights, boxCount }`
  for the merged geometry and the torch candidates. Tests exercise every
  rule through this without a renderer.
- `bakeCeiling(level, opts?)`, `ceilingCells(level)`, `doorAxis(level, x, y)`
  and `selectActiveTorches(torches, x, y)` — small pure helpers used by
  `DungeonScene`, exported so tests can inspect the same intermediates the
  scene bakes.

## Kind → geometry

| kind                       | treatment                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `wall`, `stone`, `tree`, `bars` and any other solid | stacked stone blocks filling the cell, one corner-cap dropped for a chipped silhouette, optional slate chip band and moss crumb, `stone` flag set (~4–7 boxes) |
| `floor`                    | four 4×1×4 flagstone tiles at y = 0 (each 10 % chance of missing), occasional mud pebble, `ground` flag set (~3–5 boxes) |
| `corridor`                 | single rough basalt slab, no seams, `ground` flag set (~1–2 boxes)                                             |
| `doorway`, `door_open`     | floor + two vertical posts + a lintel across the top; axis inferred from the neighbouring walls (~7–9 boxes)   |
| `door_closed`              | posts + lintel + plank door slab + two brass hinges + a brass handle, axis inferred from the neighbouring walls (~10–13 boxes) |
| `stairs_up`, `ladder_up`   | four stepped slate boxes climbing toward +z + a faint emissive nosing (5 boxes)                                |
| `stairs_down`, `ladder_down` | four stepped slate boxes descending into the floor + a faint emissive nosing (5 boxes)                       |
| `water`                    | flat surface at y ≈ 0.1, `rough 0.05 / metal 0.9` (1 box; SSR reflects the torches)                            |
| `lava`                     | flat surface at y ≈ 0.1, emissive 6, `fx = pulse`, `dry` (1 box)                                               |
| `ice`                      | flat surface at y ≈ 0.1, roughness 0.18, cooler `crystalCold0` (`#6fc3ff`) — tuned to stop the slab blowing out (T-0045) (1 box) |
| `fountain`                 | small basin: rim (4 slate slabs) + pooled water + central spout (~7 boxes)                                     |
| `altar`                    | squat slate plinth + lighter cap + tiny emissive candle (~4 boxes)                                             |
| `grave`                    | headstone slab + a mound of turned earth (~3 boxes)                                                            |
| `sink`                     | metal frame + porcelain basin + brass faucet (~4 boxes)                                                        |
| `throne`                   | seat + backrest + two brass finials (~5 boxes)                                                                 |
| everything else (`air`, `cloud`, `drawbridge`, `trap`, `other`) | **falls back to `floor`** — see `docs/gpu.md` §4                                                             |
| `unexplored`               | contributes **nothing** — the darkness is the fog's job                                                        |

The palette keys come from `web/src/voxel/palette.ts`: walls `basalt1`/`basalt2`
with `slate0` chips and `moss0`/`lichen` in the damp corners, floors
`basalt0`/`basalt1` flagstones with `mud` in the cracks, doors `wood0`/`wood1`
with `brass` hinges, stairs `slate1`, torches `fire`/`ember`, water `water`,
lava `ember`, ice `crystalCold0`.

## The ceiling group

`docs/gpu.md` §4 requires a ceiling above every known passable cell at
`y = 1`. It lives in a separate `Object3D` group named `ceiling`, a direct
child of `DungeonScene.root`. The first-person path shows it; a later ortho
ticket will hide the group, which is why it is separable rather than merged
into the main geometry.

- The ceiling material is a shade darker than the walls (`basalt0`).
- One 8×1×8 voxel-unit box (`= 1 × 0.125 × 1` metres) per passable cell.
- Sprites of the 1.3-cell "gigantic" size class will clip the ceiling; that
  is accepted and documented here so a reviewer does not chase it as a bug.

## Torches and shadows (`docs/gpu.md` §5 / STATE.md 2026-09-21)

Torch placement is a pure row-major scan:

1. Every `wall`/`stone` cell whose neighbouring cell (n → s → w → e
   priority) is a `passable` kind with `MapCell.lit === true` is a torch
   candidate on that side.
2. A global Chebyshev spacing of 6 cells is then applied — the first
   candidate wins, later candidates within 5 cells of any chosen torch are
   dropped.

Each accepted torch produces one emissive flame voxel (`fire`, `emissive 12`,
`fx = flicker`, `dry`) plus a `TorchLight` record. `DungeonScene.updateLights(x, y)`
sorts the torch list by squared XZ distance to the hero cell centre, keeps
the nearest 8 as `THREE.PointLight`s, and marks **only the 2 nearest** as
`castShadow = true`. The rest have their `castShadow` cleared as they fall
out of range so a light that used to shadow does not keep doing so from a
distance.

The merged level mesh gets `castShadow = true` **and** `receiveShadow = true`;
the ceiling mesh gets `receiveShadow = true` only (a ceiling that shadows
its own room is contact darkening from below, which the SSGI/AO term handles).

The tradeoff is unchanged from `.tigerteam/STATE.md` decision log 2026-09-21:
a cube shadow map per point light is six passes and eight of them would blow
the frame budget, so eight lights but only two cube maps.

## Rebuild gate

`DungeonScene.refresh(level)` hashes each cell's `CellKind` (`hashKinds`,
matching the shape of `web/src/gl/scene-builder.ts`) and returns `false`
when nothing has changed — no dispose, no bake, no `Mesh` reallocation.
When the hash flips, the whole main geometry and the whole ceiling are
rebuilt in one pass; the torch table is likewise rebaked because their
placement depends on cells' `lit` flags.

Jitter is seeded from the cell coordinates (`cellSeed(x, y, baseSeed)`) so
the same level bakes byte-identically twice and nothing shimmers between
frames. Torch sconces get a second seed hash on top so they do not
correlate with the wall body they mount on.

## Box budget

`docs/gpu.md` §8 asks for ≤ 12 boxes per cell on average, ≤ 40 000 boxes
for a fully-known 80 × 21 level, and a rebuild under 50 ms. Measured on this
worker container (2026-09-21, `bakeLevel` on an 80 × 21 room where every
floor cell is lit — the busiest case in the fleet's fixtures):

| bake                          | boxes  | boxes / cell | rebuild time |
| ----------------------------- | -----: | -----------: | -----------: |
| main (walls, floors, doorway, torches) | **6 770** | **4.03** | **≈ 38 ms** |
| ceiling                                | **1 482** | 0.88 (one per passable cell) | ≈ 6 ms |
| total                                  | **8 252** | 4.91 | ≈ 44 ms |

Well under the 40 000-box cap. `hiddenFaces` culls the shared face between
touching wall/floor/wall neighbours; the merged geometry is one
`BufferGeometry` in the writer's 24-B vertex format.

If a level gets much prop-heavier (many fountains, altars and thrones) or a
future ticket adds furniture, the average will rise — the cap is not tight
today, but it is where a regression would first show up. Each prop is
capped at ≤ 40 boxes per the ticket.

## What I could not verify

Worker containers have no GPU, no display, and no browser: every claim on
this list has to be eyeballed on the host through `/scene.html` or a
`web-shot.mjs` capture (see `docs/gpu.md` §9). Tests pin the pure rules,
but they cannot pin **the look**.

- **Whether the port actually reads as afterburn.** ART_BIBLE §2 is
  paraphrased into `docs/gpu.md` §5 and into this file, but the mixed-size
  slabs, chipped silhouettes and per-box jitter are only asserted through
  their box counts and palette keys here — no pixel comparison to
  `key_art_night.png` or `key_art_gold.png` is possible from within a worker.
- **Whether torches pool the right amount of light.** Intensity 3.5,
  distance 7 metres, flicker 0.3 and colour `#ffb060` — the pool was tuned
  down from the ART_BIBLE lantern reference (intensity 6 / distance 8) in
  T-0045 after the PM's first-light review showed basalt reading as pale
  plaster. The PM eyeballs the actual pool through `/scene.html?render=amber`
  and may send a tuning follow-up ticket.
- **Whether "only two shadow casters" reads correctly.** The rule is
  covered by a unit test on `PointLight.castShadow`; whether the resulting
  frame looks like "torches near you cast real shadows and further ones
  glow flat" needs the eye.
- **Ceiling darkness.** The ceiling colour is one palette key darker than
  the walls (`basalt0`); whether that reads as "ceiling" or "same as
  wall" cannot be judged headlessly.
- **Sprite clip against the ceiling.** Sprites up to 1.3 cells tall are
  accepted as clipping the ceiling. Whether this looks natural or
  distracting is a look call; no test in this ticket touches it.
- **Fountain, altar, grave, sink, throne readability.** Each is under 40
  boxes and uses distinctive palette + material choices, but "does this
  read as a throne from the doorway" is a subjective test the PM makes on
  the frame, not something a worker can pin.
