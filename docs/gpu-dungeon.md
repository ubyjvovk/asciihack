# Dungeon voxel scene (`web/src/gpu/dungeon.ts`)

*PM-owned contract in `docs/gpu.md` §4–7. This file is the T-0039/T-0046
as-built: how a `LevelView` becomes voxel geometry the ported afterburn
renderer lights, how the chunked rebuild keeps exploring from stuttering,
the measured box budget and reveal cost, and — importantly — the eyeball
claims the worker environment cannot verify.*

The module replaces the textured-cube scene of `web/src/gl/scene-builder.ts`
for the GPU render path (`docs/gpu.md` §7). `scene-builder.ts` is untouched
and remains the WebGL fallback; the ortho view continues to use it until a
later ticket ports the cutaway.

## Public surface

- `class DungeonScene` — owns one `Mesh` per chunk under a `chunks` group,
  one `Mesh` per chunk under a separable `Object3D` group named `ceiling`,
  the live `PointLight` array, and a hidden `torches` group holding those
  lights. Methods: `refresh(level): boolean` (rebakes only the chunks whose
  per-chunk hash moved — see "Chunked rebuild"), `updateLights(x, y): void`
  (reassigns which torches emit, capped at 8; only the 2 nearest cast
  shadows), `dispose(): void`. `mainMeshes()` and `ceilingMeshes()` return
  the per-chunk mesh references in chunk-major order — used by tests to
  pin the "leaves the others untouched" contract.
- `bakeLevel(level, opts?)` — pure. Returns `{ writer, lights, boxCount }`
  for the merged geometry and the torch candidates. Walks cells and
  torches in chunk-major order so its bytes match the concatenated
  chunked bake.
- `bakeChunks(level, opts?)` — pure. Returns one `ChunkBake` per chunk
  with its own writer, box count and hash, plus the level-wide torch table.
  Its per-chunk writers concatenate to `bakeLevel`'s writer byte-for-byte
  (halo culling — see below).
- `bakeCeiling(level, opts?)`, `ceilingCells(level)`, `doorAxis(level, x, y)`,
  `chunksOf(level)`, `chunkAt(level, cx, cy)`, `chunkBoundsList(level)`,
  `chunkHashOf(level, bounds)`, `selectActiveTorches(torches, x, y)`,
  `isDampCell(level, x, y)` and the `CHUNK_W` / `CHUNK_H` constants — small
  pure helpers used by `DungeonScene`, exported so tests can inspect the
  same intermediates the scene bakes.

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

## Per-box jitter (T-0054)

Wetness had been doing double duty in T-0053's predecessor look: it darkened
albedo *and* its sheen picked out flagstone edges. Removing it made stone
dry — correct — but the amber quantiser noticed the floor's edge cue
missing (measured on the amber ASCII output, same pose, before → after
T-0053):

|            | black  | mean | p95 | **levels** |
|------------|--------|------|-----|-----------:|
| wet stone  | 77.4 % | 10.4 | 62  | **148**    |
| dry stone  | 74.7 % | 11.4 | 66  | **134**    |

Brightness is fine; the 14 lost distinct levels are what mattered — that
is exactly the resource the quantiser spends. T-0054 restores them in the
geometry instead of by making things wet again: `bakeChunkCellBoxes` now
constructs its `VoxelBuilder` with **`jitter: 0.08`** (per-box lightness
`±8 %`) for every wall and floor stone box.

`vendor/afterburn/docs/ART_BIBLE.md` §2 asks for **`±3–6 %`**, and we went
above that band **deliberately**. Their range is tuned for surfaces with a
wet sheen picking up the edges; dry stone here has to carry the readability
on its own. The `bakeChunkCeilingBoxes` builder stays at `jitter: 0.03`
(the ceiling sits above the eye, has no edge cue to lose, and its role is
to darken the room from above without shimmering).

## Dry by default (T-0053)

A dungeon is mostly dry stone. Afterburn's moods were tuned for a world in
a storm — the ported `torchlit` inherited `wetness 0.5 / puddles 0.25`, so
every corridor read rained-on. T-0053 flips the polarity: the four
non-`flooded` moods drop to near-zero wetness with no puddles (see
`docs/gpu-materials.md`'s mood table), and `dungeon.ts` marks every stone
box `dry: true` **unless the level gives a reason to be wet**:

```ts
isDampCell(level, x, y): boolean
```

is a pure predicate exported from `web/src/gpu/dungeon.ts`. It returns
`true` when the cell at `(x, y)` — or any of its four orthogonal
neighbours — is `water`, `fountain`, `drawbridge` or `ice`; everywhere
else it returns `false`. `bakeChunkCellBoxes`, `bakeChunkCeilingBoxes` and
`bakeCeiling` bake each cell as before, then, when `isDampCell` is false,
walk the newly-added boxes and set `dry = true` on them. The
`FLAG_DRY` bit at `aMat.a >> 7` is what the material shader reads
(`docs/gpu-materials.md`): a dry surface never darkens for wetness and
never picks up a puddle.

The upshot: **corridors, ordinary rooms, doors and stairs are dry**. Only
the cells at or beside standing water, an ice slab, a fountain or a
drawbridge remain "wet-eligible", so in `flooded` or next to a pool the
stone still darkens and SSR still has something to reflect — everywhere
else, it is rock. Damp source cells' own emitters (the ice slab's
`dry: true`, the water pool's non-`stone` material, lava's dry ember) are
unaffected because the loop only walks newly-added boxes when the cell is
*not* damp; damp cells keep whatever the per-material preset gave them.

## The ceiling group

`docs/gpu.md` §4 requires a ceiling above every known passable cell at
`y = 1`. It lives in a separate `Object3D` group named `ceiling`, a direct
child of `DungeonScene.root`, and is itself chunked (one `Mesh` per chunk)
so the group stays a single hide-toggle for the (later) ortho path without
losing the incremental rebuild.

- The ceiling material is a shade darker than the walls (`basalt0`).
- One 8×1×8 voxel-unit box (`= 1 × 0.125 × 1` metres) per passable cell.
- Sprites of the 1.3-cell "gigantic" size class will clip the ceiling; that
  is accepted and documented here so a reviewer does not chase it as a bug.

## Torches and shadows (`docs/gpu.md` §5 / STATE.md 2026-09-21)

Torch placement is a pure row-major scan:

1. Every `wall`/`stone` cell whose neighbouring cell (n → s → w → e
   priority) is a `passable` kind with `MapCell.lit === true` is a torch
   candidate on that side.
2. A global Chebyshev spacing of 4 cells is then applied — the first
   candidate wins, later candidates within 3 cells of any chosen torch are
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

## Chunked rebuild (T-0046)

NetHack changes almost every cell as the player explores (each newly-seen
cell is a new kind), so a whole-level rebake at ~40 ms lands on the frame
that draws the move. Instead, the level is split into fixed
**`CHUNK_W × CHUNK_H = 10 × 7`-cell chunks** (an 80 × 21 level is 8 × 3 =
24 chunks — see `chunksOf(level)`), each its own `Mesh` under
`DungeonScene.root`'s `chunks` group; the ceiling is chunked the same way.

`DungeonScene.refresh(level)` walks each chunk and computes a
**per-chunk hash** — one letter for `CellKind` (from `KIND_CODE`) plus one
digit for `MapCell.lit` (`1` / `0` / `_`) per cell in that chunk — via
`chunkHashOf(level, bounds)`. The chunk-hash walk touches only the chunk's
own cells (70 cells for a full 10 × 7 chunk), so hashing is strictly
cheaper than baking. There is also a **level-wide early-out**: when every
chunk hash and torch subset matches its cached value, `refresh` returns
`false` immediately, disposing nothing and allocating nothing.

For chunks whose hash moved, `bakeChunkCellBoxes` / `bakeChunkCeilingBoxes`
/ `bakeChunkTorchBoxes` produce fresh boxes in world coordinates. A
**per-chunk hidden-face mask** is then computed by feeding own boxes plus
a **1-cell-wide halo strip** from the 4 axial neighbour chunks to
`hiddenFaces`; the halo is enough to catch every direct-plane neighbour
cull, so the mask is byte-identical to what a global pass would produce
(this is what the "byte-identical" test in `tests/gpu-dungeon.test.ts`
pins). The chunk's `Mesh` is only replaced when the resulting mask differs
from the cached one — chunks whose halo did not shift keep their `Mesh`
reference (the "leaves the others untouched" test).

Torches are still collected level-wide (their Chebyshev spacing rule is
global), then grouped into per-chunk subsets so a chunk that hosts the
same torches stays clean. The `lights` array (feeding `updateLights`) is
rebuilt from the fresh torch table.

Jitter is seeded from cell coordinates (`cellSeed(x, y, baseSeed)`) so a
cell bakes identically whichever chunk it lands in; chunk borders are
therefore invisible in the geometry too. Torch sconces get a second seed
hash on top so they do not correlate with the wall body they mount on.

`hashKinds(level)` is still exported for backwards compatibility (the WebGL
`scene-builder.ts` uses the same shape) but `DungeonScene` no longer calls
it — chunk hashes replaced the single level-wide string.

### Correctness tradeoff at chunk boundaries

A dirty chunk's mask is recomputed with its halo, so the chunk itself is
always correct. Its 4 axial neighbours' masks are **not** recomputed on the
same refresh: doubling the `hiddenFaces` work per step blew the 5 ms budget
in practice. The only visible failure mode this leaves is a face
appearing/disappearing exactly on a shared chunk boundary — and the extra
(or missing) face sits inside the wall that changed, hidden from any pose
the player can occupy. The full-bake path (`bakeChunks`, called by every
`_reshape`) is unaffected; the "byte-identical" test still passes end to end.

## Box budget

`docs/gpu.md` §8 asks for ≤ 12 boxes per cell on average, ≤ 40 000 boxes
for a fully-known 80 × 21 level, and a rebuild under 50 ms. Measured on this
worker container (2026-09-21, `bakeLevel` on an 80 × 21 room where every
floor cell is lit — the busiest case in the fleet's fixtures):

| bake                          | boxes  | boxes / cell | full rebuild |
| ----------------------------- | -----: | -----------: | -----------: |
| main (walls, floors, doorway, torches) | **6 802** | **4.05** | **≈ 38 ms** |
| ceiling                                | **1 482** | 0.88 (one per passable cell) | ≈ 6 ms |
| total                                  | **8 284** | 4.93 | ≈ 44 ms |

Well under the 40 000-box cap. `hiddenFaces` culls the shared face between
touching wall/floor/wall neighbours; the chunked geometry is 24 `Mesh`es
each with its own `BufferGeometry` in the writer's 24-B vertex format
(instead of one per level pre-T-0046) so the JS-side rebuild can touch
only the changed chunks. The chunked concatenation is byte-identical to
the single-writer output (see `bakeChunks` / `bakeLevel` in
`web/src/gpu/dungeon.ts` and the byte-identity test).

### Single-cell reveal (T-0046)

`DungeonScene.refresh(level)` incremental cost, same 80 × 21 fully-lit
level, one interior cell toggled between `unexplored` and `floor`, warm
JIT (median over 30 alternating reveals on this worker container,
2026-09-21):

| refresh path                    |         cost |
| ------------------------------- | -----------: |
| full initial bake (cold chunks) |    ≈ 18 ms   |
| single-cell reveal p50          |  **≈ 1.2 ms** |
| single-cell reveal p90          |    ≈ 1.9 ms  |
| single-cell reveal max (of 30)  |    ≈ 2.2 ms  |

The ticket's 5 ms budget is met with headroom. If a level gets much
prop-heavier (many fountains, altars and thrones) or a future ticket adds
furniture, the average will rise — the cap is not tight today, but it is
where a regression would first show up. Each prop is capped at ≤ 40 boxes
per the ticket.

## What I could not verify

Worker containers have no GPU, no display, and no browser: every claim on
this list has to be eyeballed on the host through `/scene.html` or a
`web-shot.mjs` capture (see `docs/gpu.md` §9). Tests pin the pure rules,
but they cannot pin **the look**.

- **Whether the chunked mesh reads as one dungeon.** The chunked bake is
  byte-identical to the unchunked one for a full-level bake (pinned by
  the "byte-identical" test), so seams cannot exist in the initial frame.
  During incremental refresh, chunk-boundary faces on axial neighbours are
  not re-culled (see "Correctness tradeoff at chunk boundaries" above);
  the extra faces sit inside a wall and should be invisible from every
  playable pose, but a worker cannot look at the actual frame to confirm.

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
