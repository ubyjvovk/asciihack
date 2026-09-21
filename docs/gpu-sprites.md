# Sprite billboards on the GPU path (`web/src/gpu/sprites.ts`)

*PM contract: `docs/gpu.md` §4–6. Sibling doc: `docs/gpu-dungeon.md`, which
turns `LevelView` cells into voxel geometry — this file covers the layer that
puts monsters, items and the hero back into that scene.*

The ported afterburn stack lights a **voxel dungeon** (T-0039/T-0046) but
NetHack's living things live in `Sprite[]`, not in voxel models. Hand-building
a voxel model for each of NetHack's ~400 monsters is a different project.
`SpriteLayer` bridges the gap: one camera-facing quad per `Sprite`, drawn
through a `MeshStandardNodeMaterial` so the same SSGI/SSR/god-ray stack that
draws the walls also draws the goblins.

The legacy WebGL path continues to draw its own `THREE.Sprite`s from
`web/src/gl/scene-builder.ts::updateSprites`; those are untouched. This file
is only for the GPU render path — the module lives in `web/src/gpu/sprites.ts`
and `GlViewport`'s `GpuPath` owns one instance.

## Public surface

- `class SpriteLayer` — owns a `Group` (attach to the GPU scene) plus caches
  of `DataTexture`s (per tile key) and `MeshStandardNodeMaterial`s (per tile +
  tint + glow key). Methods: `update(sprites, camera): Mesh[]` (rebuilds the
  mesh pool from a fresh sprite list and yaws each toward the camera),
  `dispose(): void` (frees every GPU-side resource).
- `tileToDataTexture(tile)` — rasterises a NetHack 16×16 tile into a
  nearest-filtered `DataTexture`, sRGB. Exported so tests can inspect the
  path a real tile takes; the layer uses it internally.
- `applyYawTowardsCamera(mesh, camera)` — the Y-axis billboard rotation.
  Exported for the same reason: unit tests can pin the yaw independently.

## Why billboards, not voxel models

`docs/gpu.md` §5 lists the choice: sprites are camera-facing quads carrying
the tile art, drawn through a `MeshStandardNodeMaterial` so they inherit the
scene's lighting rather than being pasted on top of a finished frame. Voxel
monster models would look more like the walls, but there are ~400 of them and
the tile art is what the game already carries. A billboard is what a sprite is.

## Y-axis billboarding

For each mesh, every frame:

```
dx = camera.position.x − mesh.position.x
dz = camera.position.z − mesh.position.z
mesh.rotation.y = atan2(dx, dz)
mesh.rotation.x = 0
mesh.rotation.z = 0
```

Three's `PlaneGeometry(1, 1)` sits in the XY plane with a normal of `+Z`;
rotating about `+Y` by `atan2(dx, dz)` aims that normal at the camera in the
XZ plane. The pitch and roll stay zero on purpose (§5, docs/gpu.md): a
monster standing under an ortho camera looking straight down must **not** lie
on its back — the ticket's rule "yaw toward the camera, never pitch."

## Material — alpha-tested, not blended

- `MeshStandardNodeMaterial` (three r185, browser-only). `colorNode = tile ×
  tint`, `opacityNode = tile.a`, `alphaTest = 0.5`, `transparent = false`,
  `depthWrite = true`. Alpha testing means:
  - the sprite **writes depth** (SSR reflects the goblin in the wet floor;
    SSGI's bounce hitting the goblin contributes to nearby cells);
  - no blend queue, no back-to-front sort, no pipeline state churn.
- `roughness = 0.85`, `metalness = 0`. Sprites are not shiny mirrors.
- Emissive is off by default; classes that **glow** — `zap`, `explosion`,
  `warning`, `swallow` — earn a small `emissiveNode = tint × tile × 0.9`,
  which reads as a rim of light under the surrounding torches.
- `side = DoubleSide` so a wide-angle camera behind a sprite still sees it
  (the two sides render the same image; the tile has no back).

The `.map` fallback is not used — with `colorNode` set, three ignores it and
the tint × sample happens on the shader side.

## Textures and materials — keyed cache

The legacy path's T-0031 bug was that a `CanvasTexture` was rebuilt on every
frame and pushed to the driver, and that eats ~20 ms once you have more than
a handful of monsters. `SpriteLayer` keeps two `Map`s across frames:

- `textureCache: Map<string, DataTexture>` keyed by a
  `${w}×${h}#<pixels+palette hash>` string, so two sprites carrying byte-
  identical tile art (say, two goblins) share one upload. The hash covers
  both `pixels` and `palette` — palette-only differences must move the key
  or a repainted tile would silently share the old texture (a mistake the
  legacy hash makes, kept as-is there because it doesn't matter for
  NetHack's tile art in practice — but this module is stricter).
- `materialCache: Map<string, MeshStandardNodeMaterial>` keyed by
  `${tileKey}#${rgbKey}#${glowFlag}`. Two goblins with the same tint share a
  material; a tinted variant gets its own.
- `meshes: Map<string, Mesh>` keyed by `${x},${y}:${ch}` — the pooled
  camera-facing quad for a given cell-and-glyph. Cells that stop hosting a
  sprite drop their mesh from the group; new cells build a fresh mesh
  pointing at the (probably cached) material.

`dispose()` walks all three maps and frees everything.

## Coordinates and height class

Cell `(cx, cy)` covers `(cx…cx+1, 0…1, cy…cy+1)` (`docs/gpu.md` §4). A sprite
of `height = h` cells is:

- centred at `(x + 0.5, h / 2, y + 0.5)` — feet on the floor, midriff at half
  height;
- scaled to `(h × aspect, h, 1)` where `aspect = tile.w / tile.h` (1 for the
  16 × 16 NetHack tiles, so the quad is square);
- height defaults to `0.7` cells when the `Sprite` omits one, which matches
  `HERO_SPRITE_HEIGHT` and the legacy path.

Size classes (0.3 tiny … 1.3 gigantic) come from `spritesFromMap`
(`src/ui/view3d.ts`) via the monster's `MonsterInfo.size`. Sprites of the
1.3-cell "gigantic" class will clip the ceiling voxels at `y = 1`; that is
accepted, documented in `docs/gpu-dungeon.md`, and not this module's job to
fix.

## Wiring

`GpuPath` (in `web/src/gl/gl-viewport.ts`) constructs one `SpriteLayer` in
its `create()` factory, adds `layer.root` to the GPU scene, and calls
`layer.update(sprites, camera)` from `GpuPath.render(...)` right after the
dungeon geometry refresh. `dispose()` frees the layer alongside the dungeon
and compositor.

The legacy path is untouched: `gl-viewport.ts` still calls
`this.builder.updateSprites(...)` on the legacy branch, so switching to
`?gpu=off` reverts to the T-0031 sprite code exactly as before.

## What I could not verify

Worker containers have no GPU, no display and no browser: every claim on
this list has to be eyeballed on the host through `/scene.html` or a
`web-shot.mjs` capture (see `docs/gpu.md` §9). Tests pin the pure rules,
but they cannot pin **the look**.

- **Whether a lit sprite reads better than a pasted one.** SSGI's bounce off
  a monster's face and SSR's reflection of a torch-lit corpse in the wet
  floor are the whole point of using a node material rather than a plain
  sprite. The unit tests only pin that the material is alpha-tested and
  writes depth; whether the resulting frame *looks* like a diorama needs the
  PM's eye.
- **Whether the alpha-test cut leaves a fringe.** `alphaTest = 0.5` is the
  ticket's value; NetHack tiles are palette-indexed with index 0 = transparent
  and everything else opaque, so the cut should be hard-edged. A blurry
  fringe would only show up under some filtering path (mipmaps, linear
  min/mag) that the layer explicitly disables — but "disabled" and "invisible"
  are different, and the eyeball review is the check.
- **Whether the Y-axis billboard reads correctly in ortho.** The ortho camera
  currently rides the legacy path (`docs/gpu.md` §7) so this module never
  runs under it. When the ortho ticket lands on the GPU path, whether
  monsters read as standing (never lying down) is a look call.
- **Whether the small emissive on `zap`/`explosion`/`warning`/`swallow`
  reads correctly.** The material sets `emissiveNode = tint × tile × 0.9` on
  those classes so they carry a rim of their own light; whether that pool
  reads as "a bolt of light" or as "a glowing square" is a tuning call the
  PM can send a follow-up on.
- **Frame time under a full stack of ~40 sprites.** The ticket calls the
  count "≤ ~40 on screen" and one `Mesh` per sprite is fine at those
  numbers, but the actual frame budget on a real GPU is unverified — every
  number in `docs/gpu.md` §3.3 is SwiftShader.
- **Whether the hero fallback (`ch === '@'`, no tile) reads.** The GPU path
  only runs in fps mode, where the hero is not in the sprite list, so the
  fallback (a solid opaque white texture tinted by the sprite's rgb) is
  effectively unused today. When the ortho port lands and starts drawing
  the hero on this path, "coloured square" may or may not read — likely a
  tuning follow-up.
