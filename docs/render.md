# First-person raycaster (`src/render/raycast.ts`)

Turns the remembered NetHack level into a coloured-ASCII first-person scene.
Pure and deterministic — no I/O, no globals — so it can be golden-tested in
plain node (architecture.md §5.2, §9).

## Interface

```ts
renderFirstPerson(level, pose, sprites, fb, opts?)
```

- `level: LevelView` — the remembered map (PM-owned, §4).
- `pose: Pose` — camera position in cell units and yaw (`x` east, `y` south,
  0 = north, +π/2 = east; §7).
- `sprites: Sprite[]` — billboards to overlay (monsters/objects).
- `fb: FrameBuffer` — the buffer to fill (rgb, depth, overlay planes).
- `opts?: RaycastOptions` — `vFovDeg` (60), `horizonFrac` (0.42), `fovDeg`
  (optional, back-compat: fixes the horizontal FOV), `maxDepth` (24),
  `cellAspect` (2), `fogK` (0.14), `detail` (true, see “Surface detail”).

## Algorithm

1. **Camera.** By default the vertical FOV is fixed (`vFovDeg`, 60°) and the
   horizontal one is derived from the aspect:
   `hFov = 2·atan(tan(vFov/2) · cols / (rows · cellAspect))`, so a landscape
   terminal sees more sideways. If the caller passes `fovDeg` explicitly it is
   kept as the horizontal FOV and the vertical one is derived as before
   (`vFov = hFov × rows·cellAspect / cols`, back-compat for tests). The horizon
   row is `rows · horizonFrac` (default 0.42) — the camera pitches down a
   little so the near floor is on screen at any aspect (the bottom row looks
   `(1−0.42)·60° ≈ 35°` down, so the nearest visible floor is `0.5/tan 35° ≈
   0.7` cells). The camera sits at height 0.5 (eye in the middle of a
   1-cell-tall wall) and its forward vector is `(sin yaw, −cos yaw)`,
   perpendicular camera plane of length `tan(hFov/2)`.
2. **Walls.** One grid-DDA ray per column (Wolfenstein-style). A ray stops at
   the first `isSolid` cell; `unexplored` counts as solid so the world ends
   where knowledge ends. Doorways and open doors are passable — the
   ray continues and the floor under them is tinted in the door colour
   (approximating the spec's "thin frame", which cannot carry door orientation
   through the `CellKind` model). Perpendicular distance is used for the wall
   projection (no fish-eye). A wall cell's draw rows are
   `horizon ± (fV · 0.5 / d)` with `fV = rows / (2·tan(vFov/2))`.
3. **Face shade.** Walls hit on a y boundary (N/S face) render at 100 %, walls
   hit on an x boundary (E/W face) at 70 %.
4. **Ceiling.** Pure black (`[0,0,0]`), no gradient — poorly lit, nothing to see
   up there.
5. **Floor.** Classic floor-casting: each row's distance is fixed by its
   elevation (`rowDist = posZ / (y − horizon)`), and the horizontal step picks
   the floor cell under each column. The floor cell is coloured by its kind
   and fogged with `exp(−fogK·d)`.
6. **Fog & depth.** Colour is attenuated by `exp(−fogK·d)`. `depth` holds the
   perpendicular wall distance for wall cells and the floor-row distance for
   floor/ceiling cells; it is `Infinity` only where no wall was hit (the ray
   left the map or exceeded `maxDepth`).
7. **Sprites.** Sorted far-to-near, transformed into camera space, clipped per
   cell against `fb.depth` (a nearer wall/floor hides them). Monsters (classes
   `mon`, `pet`, `ridden`, `detected`, `invisible`, `statue`), items (`obj`)
   and corpses (`body`) draw as billboards standing on the floor row for their
   distance, sized by `s.height` in cells: a sprite with `tile` samples its
   16×16 tile (see “Sprites” below), one without keeps the ellipse figure at
   `s.height`. Other sprite classes keep a rectangular billboard 0.7 × 0.9.
   A sprite on the camera cell (the hero) is skipped.

## Surface detail

`RaycastOptions.detail` (default **true**) turns on procedural surface detail
so depth and structure read in ASCII instead of one flat glyph per surface.
The pure pattern functions live in `src/render/texture.ts` (`brickShade`,
`plankShade`, `barsShade`, `gridShade`, `floorShade`) and are unit-tested
there; `raycast.ts` only calls them. With `detail: false` the renderer is
byte-identical to the pre-detail flat renderer (this is what the original
`raycast-golden.txt` commits); the default is covered by
`raycast-textured-golden.txt`.

- **Wall texture.** For a wall hit, `u` is the fraction along the hit face
  (`posY + perp·rdy` for a vertical/E-W face, `posX + perp·rdx` for a
  horizontal/N-S one, fractional part), and per row `v = (y − top)/(bot − top)`
  (0 at the wall top, 1 at the bottom). `brickShade(u, v, seed)`: rows 0.25
  tall, bricks 0.5 wide, every other row offset by 0.25, 0.05-wide mortar at
  the `MORTAR` sentinel (the renderer paints seams at the absolute brightness
  `0.05`, fogged), and a brick body of 1.0 ± 0.03 hashed by (row, column,
  `seed`) where `seed = hitY·80 + hitX` keeps bricks stable frame to frame. It
  multiplies the wall colour after the N/S vs E/W face factor and before fog.
  `wall` gets the brick; `bars` gets `barsShade(u)` (0.2 bars at 1.0, 0.3 gaps
  at 0.25). The face base colours are dark (`wall` `[0.18,0.18,0.19]`) so a
  wall reads as a sparse dark field — only the mortar seams and the bright
  edge lines are dense. With `fogK 0.14` the wall body at 3 cells is ≈ 0.12
  (sparse glyphs above the quantizer's post-T-0028 black point), at 6 ≈ 0.08
  (faint) and gone by 10 — the wall bodies stay visible where the previous
  0.28 knocked them below the black point.
- **Edge lines (absolute, half-fog).** The wall's top edge row, bottom
  contact row, corner columns and door posts are painted at absolute
  brightness (not multiples of the base) with **half-strength fog**
  (`· e^(−0.5·fogK·d)`), so silhouettes read at distance but do not glow at
  any depth: wall top edge `0.75`, bottom contact `0.30`, corner columns
  `0.55`, door/doorway frame posts `0.70`, floor grid `0.30`. In a wall
  column the precedence is top edge > corner > bottom contact > body. The
  top edge at 10 cells is still ≈ 0.37 (a line, not a blur). A **corner
  column** fires only where the hit **face** changes (N/S ↔ E/W) or the
  perpendicular depth jumps by more than 0.5 cells between adjacent columns —
  so a flat wall's cell seams stay dark mortar and the face no longer reads
  as a row of pillars. `stone` (known rock) gets only the flat grey body
  plus the (half-fogged) top edge line, no mortar or corners.
- **Doors.** `door_closed`: `plankShade(u)` = vertical planks 0.2 wide
  alternating 1.0 / 0.82 with a 0.05 dark seam at the `MORTAR` sentinel; the
  outer 0.12 of the face (`u < 0.12 || u > 0.88`) is an absolute `0.70` frame
  post. `doorway` / `door_open` stay passable, but the ray treats the outer
  0.12 of the cell's width (its posts) as solid frame, and in the floor pass
  the doorway threshold is drawn with an absolute `0.70` frame around the
  passable door colour `[0.28,0.22,0.14]` — so a doorway reads as an opening
  in a wall rather than a gap in the floor colour.

### Floor

The floor pass is described in the algorithm; this is the detail (readable)
look. `floor` is a poorly-lit dark-grey flagstone floor: base
`[0.10,0.10,0.11]` with `floorShade(fX, fY)` giving each 0.5-cell stone a
brightness 0.85–1.15 (hashed by its `(floor(2fX), floor(2fY))` index, stable
per stone) and thin seams (within 0.04 of a stone edge) at 0.6. On top, the
perspective grid lines at cell edges are painted at the absolute brightness
`0.30` under half-strength fog (like every absolute edge line) so they read
as the converging depth lines and still fade with distance. `corridor` is
neutral rough rock: base `[0.07,0.07,0.07]` with `floorShade(fX, fY, 1.0,
false)` (side-1.0 stones, no seams) and no grid — its previous warm cast
read as yellow under the T-0028 quantizer. `ice`, `stairs_*`, `altar`,
`throne` keep the multiplier `gridShade` grid (edge 0.7, or 0.5 for
stairs). Fog is `fogK` default `0.14`, so wall bodies stay visible out to
around 6–8 cells and only truly distant features fade — that fade is the
depth cue. Sprites, water, lava and the unknown veil are unchanged.

### Lighting (`MapCell.lit`)

Floor cells with `lit === false` (remembered dark rooms) dim the stone
body ×0.45; corridor cells with `lit === true` (lit corridors) brighten
theirs ×1.4. Grid lines and the door-frame posts keep their absolute
brightness so dark rooms still show perspective — only the stone body
darkens. Walls are unaffected (the hero's lantern lights them in the
fiction), and `lit === undefined` means "no info" and leaves the render
unchanged. The lit information comes from the session's `print_glyph`
handling (see docs/engine.md "Cell lighting").

### The unknown

Never-explored (`unexplored`) cells stay opaque — rays still stop at them —
but they paint as a dark **neutral-grey** veil, not masonry. The face is the
flat base colour `[0.03, 0.03, 0.03]` with **no brick texture, no top/bottom
edge lines and no corner lines**, plus `veilShade(u, v, seed)` added to the
base: `0` for most samples and, for ≈ 8 % of them, one of two discrete
speckle levels in `0.05–0.10` chosen by the hash over an 8×8 sample grid and
the cell `seed`. The base was previously `[0.03,0.03,0.05]` (a blue cast that
read as a blue wall under the T-0028 quantizer) and the speckle was 12 % at
0.10–0.22 (dense enough to blend into masonry once the quantizer's black
point moved); the sparser, dimmer, neutral-grey tuning here comes out as
rare `.` glyphs. The speckle is stable per cell and per sample (no flicker).
Depth is still written for these cells, so sprites and fog behave as if the
veil were a wall. Known rock (`stone`, an `S_stone` glyph NetHack actually
displayed) stays a flat neutral grey `[0.12, 0.12, 0.12]` with the top edge
line — solid and known, distinct from both bricks and the veil. Corridor
sides and dead ends are `unexplored` in NetHack's own model, so a corridor
reads as a lit path through darkness, exactly the information the game
gives.

### Sprites

Monsters (`mon`, `pet`, `ridden`, `detected`, `invisible`, `statue`), items
(`obj`) and corpses (`body`) draw as billboards standing on the floor row for
their distance `floorY = horizon + 0.5·fV/tY`, sized by the sprite's `height`
in cells (attached by `spritesFromMap` from the monster size class or object
kind — see `src/ui/view3d.ts`).

A sprite with `tile` art samples its 16×16 tile as a **square** billboard
(width = height cells; the cell-aspect correction makes it square on screen):
each screen cell in the billboard maps to a tile pixel
`(floor(u·16), floor(v·16))` with `u, v ∈ [0,1]`. Transparent pixels (palette
index 0) are skipped so the floor shows through; an opaque pixel writes the
sprite's letter in that pixel's own palette colour (`palette/255`, linear-ish)
times fog and a slight vertical shading `0.85 + 0.15·(1 − v)` (top brighter).
The depth test is per cell as before. When the billboard is shorter than 2
rows or narrower than 2 columns it collapses to a single letter in the
sprite's colour (today's far rule).

A sprite **without** a tile keeps the ellipse figure, but at the sprite's
`height` (no longer a fixed 0.9): a monster is an ellipse
(`halfW = fH·(h/2)/(2·tY)`, `halfH = fV·h/(2·tY)`), an item a low shape
(`halfW = fH·(h·4/3)/(2·tY)`, `halfH = fV·h/(2·tY)`). Within the screen
bounding box, a cell with normalised offset `(dx, dy)` from the figure centre
is:

- part of the body when `dx² + dy² ≤ 1`, shaded `1 − 0.45·(dx² + dy²)`
  (`1.0` at the centre, `0.55` at the edge) times the sprite colour before fog;
- a dark rim when `1 < dx² + dy² ≤ 1.35`, the letter at brightness `0.22`;
- skipped otherwise.

Every figure and rim cell prints the sprite's letter. Far sprites (fewer than
2 cells tall) collapse to a single letter at full brightness with no rim.
Other sprite classes keep a rectangular billboard 0.7 × 0.9. A sprite on the
camera cell (the hero) is skipped.

Detail costs a little per-pixel hashing but stays well under the 8 ms budget
for a 200×60 frame (measured ~1.7 ms with three tiled sprites).

## Colour table

Exported as `KIND_COLORS` (linear RGB 0..1, before exposure) so the ortho
renderer can reuse it. `CEILING_COLOR` is the ceiling base colour.

| kind | colour |
|---|---|
| wall | `[0.18,0.18,0.19]` |
| door_closed | `[0.20,0.15,0.10]` |
| door_open / doorway | `[0.32,0.26,0.18]` |
| tree | `[0.09,0.18,0.09]` |
| bars | `[0.14,0.20,0.21]` |
| stone | `[0.12,0.12,0.12]` |
| unexplored | `[0.03,0.03,0.03]` |
| floor | `[0.10,0.10,0.11]` |
| corridor | `[0.07,0.07,0.07]` |
| water | `[0.10,0.25,0.60]` |
| lava | `[0.85,0.35,0.05]` |
| ice | `[0.55,0.75,0.85]` |
| stairs_up / stairs_down | `[0.85,0.85,0.40]` |
| altar | `[0.70,0.70,0.75]` |
| fountain | `[0.30,0.50,0.90]` |
| trap | `[0.60,0.20,0.60]` |
| anything else | floor colour `[0.10,0.10,0.11]` |

## Ortho renderer (`src/render/ortho.ts`)

Turns the remembered level into a zoomable 2:1 isometric (old Diablo / Fallout
style) view, drawn into the same `FrameBuffer` so the same quantizer and screen
writer show it. Pure and deterministic; golden-tested exactly like the
raycaster. The projection is locked by T-0021 (architecture.md §5.3).

### Interface

```ts
renderOrtho(level, hero, sprites, fb, opts?)
cellToScreen(x, y, origin) -> { sx, sy }
screenToCell(c, r, origin) -> { x, y }
```

- `hero: {x, y}` — the cell the view is centred on (the caller passes the
  hero's `@` as a sprite, exactly like any monster).
- `opts?: OrthoOptions` — `zoom` (explicit `k`; default `clamp(round(rows/28),
  1, 6)`), `fogK` (0.06).

### Zoom

`k = clamp(round(fb.height / 28), 1, 6)` unless `opts.zoom` is given, so the
tile size scales with the viewport (hero ≈ 1/7 of the height at 104 rows, where
`k = 4`). A map cell is a **2:1 diamond** `4k` columns wide and `2k` rows tall;
wall blocks extrude `h = 3k` rows.

### Projection (locked)

The screen position of a map point `(X, Y)` (x east, y south) is
`c = ox + 2k·(X − Y)`, `r = oy + k·(X + Y)`. `(ox, oy)` is chosen so the hero's
cell centre lands at `(floor(cols/2), floor(rows·0.55))` (a little below centre
so walls above have room). `cellToScreen(x, y)` returns the screen position of
the cell centre `(x + 0.5, y + 0.5)`; `screenToCell(c, r)` is the exact inverse
through the cell's centre: `u = (c + 0.5 − ox)/(2k)`, `v = (r + 0.5 − oy)/k`,
`X = (u + v)/2`, `Y = (v − u)/2`, map cell `= (floor X, floor Y)`. Because the
diamond is the image of the unit square and the diamonds tile the plane, every
screen cell belongs to exactly one map cell.

### Painter's order

Map cells draw in increasing `x + y`, ties by increasing `x` (north-west to
south-east), so nearer (south-east) cells occlude. Every draw writes `rgb`,
`depth = x + y` and clears `overlayCh` for the cells it covers. The buffer is
pre-filled each frame (`rgb` 0, `depth` Infinity, overlay 0) the way
`renderFirstPerson` does — every cell is written every frame.

### Floor pass

One inverse mapping per screen cell, so the floor and the surrounding unknown
cover the whole viewport. `floor` is flagstone: each 0.5-cell stone varies
±20 % via `floorShade(X, Y)` (same texture as the raycaster, hashed per stone
so it is stable frame to frame) over the `KIND_COLORS.floor` base, and the
diamond tile seams — cells whose inverse-mapped `X` or `Y` lands within `0.2/k`
of a cell edge — paint at the absolute `0.30` level. The old checker is gone
(the stones carry the variation). `doorway`/`door_open` are floor in the door
colour with the two flanking wall (post) cells at the absolute `0.70` level;
`corridor` keeps `KIND_COLORS.corridor` with no seams. All other passable kinds
keep their `KIND_COLORS` base flat. Solid cells are left for the wall pass.
Faces and floor fade with fog `exp(−0.06·dist)` (Chebyshev distance from the
hero).

**The unknown:** `unexplored` cells are black `[0, 0, 0]` with the seam lines at
`[0.09, 0.09, 0.09]` — the faint diamond lattice — and the same applies outside
the 80×21 map, so the lattice covers the whole viewport and the player never
floats in pure black. The seams sit at `0.09` absolute (≈ 0.153 after the
exposure curve, above the quantizer's 0.10 black point) so they stay visible;
at the old `0.05` they quantized to space and the room floated in pure black
again. (The seam band is `0.2/k`, slightly wider than the spec's
`0.12/k`: cell-centre samples always land at least `1/(8k)` from an edge, so
`0.12/k` would make the lattice invisible.)

### Wall pass

For every `isSolid(kind)` cell except `unexplored` (`stone` is a block in its
flat grey, `door_closed` in the door colour), the tile's diamond D — rows
`sy−k … sy+k`, columns `sx−2k … sx+2k` — is extruded `h = 3k` rows. The lid
keeps the diamond's own depth rows: its upper edge row paints at the absolute
`0.75`, its lower edge row at `0.45`, the rows between at the flat dark lid
`0.16`. Per column `c` of D, the rows below the lid down to `bottom(c)`
(`bottom(c)` is D's lower boundary row at that column) are the side faces:
columns left of `sx` the south-west face at ×0.55, right of `sx` the
south-east face at ×0.75, both `brickShade(u, v, seed)`-textured (u across the
face, v down it, mortar seams at the absolute `0.05`) for walls, flat for
stone/door_closed. The vertical corner column at `sx` between the two faces
paints at the absolute `0.55`, and the block's bottom contact row at the
absolute `0.25` (precedence: top rim > corner > contact > body, like the
raycaster). The wall cells flanking a doorway / open door (post cells) paint
entirely at the absolute `0.70` level. Every painted cell writes depth and
clears `overlayCh`.

### Look

The ortho view shares the first-person readable grammar (dark surfaces that
quantize to sparse glyphs, bright edges at absolute brightness). Linear
levels, before exposure; the quantizer is unchanged. Wall block faces: base
from `KIND_COLORS` (wall 0.14 …) × 0.75 (SE) / 0.55 (SW) with the brick
texture body ±0.03 and mortar at `0.05` absolute; the top face `0.16` flat (a
dark lid). Rims and lines at absolute brightness: the top face's upper edge
`0.75`, its lower edge `0.45`, the vertical corner between the faces `0.55`,
the block's bottom contact line `0.25`. Floor tiles: base from
`KIND_COLORS.floor` with the flagstone texture (`floorShade` from
`texture.ts`, stones ±20 %), diamond seams `0.30` absolute; no checker (the
stones carry the variation); corridors `KIND_COLORS.corridor`, no seams.
Doorway / open door tiles: floor in the door colour with the two post cells at
`0.70`. Floor tiles with `MapCell.lit === false` are dimmed `×0.45` on the
stone body (seams keep their absolute `0.30`) — the tile shape still reads
in a remembered dark room. Unexplored lattice `0.09` absolute (see "The
unknown", raised from `0.05` so it clears the quantizer's black point); the
lattice fades with its own gentle `exp(−0.015·dist)` (not the floor's 0.06
fog) so a seam at the far edge of the viewport still reads; faces and floor
fade with `exp(−0.06·dist)` applied but not to rims within 3 cells of the
hero (near edges stay crisp), then normally beyond. Cutaway ghost blocks
keep their 0.35 factor applied to these levels.

### Sprites & occlusion

Sprites draw with their tile in the same painter step, so a nearer wall drawn
later clears their overlay cells (the occlusion). A sprite with `tile` art
draws as a **square billboard** sampled from its 16×16 tile:
`brows = round(height·3.5k/0.9)` rows tall and `2·brows` columns wide (×2
keeps it square on screen with the 2:1 cell aspect), the tile's bottom edge
(feet) on the tile centre row `sy`. Each cell maps to a tile pixel
`(floor(u·16), floor(v·16))`; transparent pixels leave the floor visible,
opaque ones write the sprite's letter in the pixel's palette colour times fog,
with no rim. **Monsters** (`mon`/`pet`/`ridden`/`detected`/`invisible`/
`statue`) and the **hero** without a tile are tall figures `2k−1` columns wide
and `3.5k` rows tall standing with their feet at the tile centre row `sy` (so
they overlap the tile behind, correct for 3/4), with an ellipse mask, radial
brightness `0.55 + 0.45·(1 − r²)`, a rim ring at 0.22 and the letter
everywhere. **Items** (`obj`/`body`) without a tile are low shapes `2k−1` wide
and `1.5k` tall centred on the tile. At `k = 1` every figure collapses to one
or two cells with no rim.

### Cutaway

A wall block drawn in front of the hero (or of a monster within 2 cells of the
hero) would otherwise paint over the figure and hide it, so such blocks are
**cut away**. A wall cell is *in front of* a figure when its `x + y` exceeds the
figure's and it is within 2 cells of it in both axes (`|dx| ≤ 2 && |dy| ≤ 2`).
Walls in front of the hero, or in front of a monster within 2 cells of the hero,
are painted as translucent ghost blocks — faces and top at `0.35` of their
normal brightness — and where they overlap a figure already drawn they keep the
figure's letter, dimmed to `0.7`, instead of clearing the overlay. After the
wall pass the hero is re-stamped: any cell of the hero figure that a later wall
overwrote gets the hero letter back at `0.6` brightness (an x-ray silhouette),
so the hero is never fully hidden even when the cutaway rule does not apply.

### Fog & depth

Every drawn colour is multiplied by `exp(−fogK · dist)` with `dist` the
Chebyshev distance from the hero cell. `depth = x + y` for every drawn cell;
unexplored stays at Infinity.

### Golden workflow

`tests/ortho.test.ts` renders the `ROOM` fixture with the hero at its centre at
80×24 (`k = 1`) and at 160×104 (`k = 4`, with the hero plus tiled jackal and
potion sprites), quantizes each with the test-local 10-glyph ramp, and
compares against `tests/ortho-golden.txt` and `tests/ortho-zoom-golden.txt`.
(k = 4 keeps the potion's thin 2-column bottle wider than one screen column so
it actually shows in the zoom golden.) Regenerate with
`UPDATE_GOLDEN=1 bash .tigerteam/scripts/run-tests.sh tests/ortho.test.ts`.

## Aspect correction

A terminal cell is twice as tall as wide, so a square wall face projects to a
column twice as tall as it is wide. By default the vertical FOV is fixed at
60° and the horizontal FOV is derived from the aspect (see “Camera”), which
keeps `fH` and `fV` consistent with the cell aspect (fH = 2·fV) and square
world features square on screen. If `fovDeg` is passed explicitly the vertical
FOV is instead derived as `vFov = hFov × rows·cellAspect / cols`.

## Golden workflow

`tests/raycast.test.ts` renders the `ROOM` fixture from its centre facing east
at 80×24, quantizes it with a **test-local** 10-glyph ramp
(`" .:-=+*#%@"` over `max(r,g,b)` — the real quantizer, T-0006, is deliberately
not imported) and compares against `tests/raycast-golden.txt`. On mismatch the
test fails with the diff; regenerate with:

```sh
UPDATE_GOLDEN=1 bash .tigerteam/scripts/run-tests.sh tests/raycast.test.ts
```

The golden is a committed artifact; change it only when the renderer's output
intentionally changes.
