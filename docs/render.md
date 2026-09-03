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
- `opts?: RaycastOptions` — `fovDeg` (70), `maxDepth` (24), `cellAspect` (2),
  `fogK` (0.18).

## Algorithm

1. **Camera.** Horizontal FOV 70°. Because a terminal cell is twice as tall as
   wide, the vertical FOV is aspect-corrected: `vFov = hFov × (rows·2) / cols`.
   The camera sits at height 0.5 (eye in the middle of a 1-cell-tall wall) and
   its forward vector is `(sin yaw, −cos yaw)`, perpendicular camera plane of
   length `tan(hFov/2)`.
2. **Walls.** One grid-DDA ray per column (Wolfenstein-style). A ray stops at
   the first `isSolid` cell; `unexplored` counts as solid so the world ends in
   dark stone where knowledge ends. Doorways and open doors are passable — the
   ray continues and the floor under them is tinted in the door colour
   (approximating the spec's "thin frame", which cannot carry door orientation
   through the `CellKind` model). Perpendicular distance is used for the wall
   projection (no fish-eye). A wall cell's draw rows are
   `horizon ± (fV · 0.5 / d)` with `fV = rows / (2·tan(vFov/2))`.
3. **Face shade.** Walls hit on a y boundary (N/S face) render at 100 %, walls
   hit on an x boundary (E/W face) at 70 %.
4. **Ceiling.** Black `[0.03,0.03,0.04]` above each wall, fading linearly to
   black at the top row.
5. **Floor.** Classic floor-casting: each row's distance is fixed by its
   elevation (`rowDist = posZ / (y − horizon)`), and the horizontal step picks
   the floor cell under each column. The floor cell is coloured by its kind
   and fogged with `exp(−fogK·d)`.
6. **Fog & depth.** Colour is attenuated by `exp(−fogK·d)`. `depth` holds the
   perpendicular wall distance for wall cells and the floor-row distance for
   floor/ceiling cells; it is `Infinity` only where no wall was hit (the ray
   left the map or exceeded `maxDepth`).
7. **Sprites.** Sorted far-to-near, transformed into camera space, clipped per
   cell against `fb.depth` (a nearer wall/floor hides them). Each sprite is a
   billboard 0.7 cells wide × 0.9 tall standing on its cell; its screen
   rectangle gets `overlayCh = sprite.ch` and `overlayRgb = sprite.rgb ×
   attenuation`. A sprite on the camera cell (the hero) is skipped.

## Colour table

Exported as `KIND_COLORS` (linear RGB 0..1, before exposure) so the ortho
renderer can reuse it. `CEILING_COLOR` is the ceiling base colour.

| kind | colour |
|---|---|
| wall | `[0.55,0.53,0.50]` |
| door_closed | `[0.55,0.35,0.15]` |
| door_open / doorway | `[0.45,0.30,0.12]` |
| tree | `[0.15,0.45,0.15]` |
| bars | `[0.30,0.60,0.65]` |
| stone / unexplored | `[0.06,0.06,0.07]` |
| floor | `[0.40,0.37,0.33]` |
| corridor | `[0.28,0.22,0.16]` |
| water | `[0.10,0.25,0.60]` |
| lava | `[0.85,0.35,0.05]` |
| ice | `[0.55,0.75,0.85]` |
| stairs_up / stairs_down | `[0.85,0.85,0.40]` |
| altar | `[0.70,0.70,0.75]` |
| fountain | `[0.30,0.50,0.90]` |
| trap | `[0.60,0.20,0.60]` |
| anything else | floor colour |

## Aspect correction

A terminal cell is twice as tall as wide, so a square wall face projects to a
column twice as tall as it is wide. The vertical FOV is set to
`70° × (rows·2) / cols`, which makes `fV` and `fH` consistent with the cell
aspect and keeps square world features square on screen.

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
