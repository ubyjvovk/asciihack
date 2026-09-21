# Voxel avatars — hero and pet on the GPU render path

Contract for `web/src/gpu/avatar.ts` and its wiring into `web/src/gpu/sprites.ts`.
The hero and pet are voxel models built from the shared kit
(`web/src/voxel/kit.ts`) and lit by the same stack as the dungeon; the rest
of the sprite pool (monsters, items) stays on camera-facing quads (T-0042).

## What was taken from afterburn's pilot

`vendor/afterburn/src/models/pilot.js` is a chunky-humanoid voxel model
(1.45 m tall, 29 units, 700+ boxes, real anims). What survived the port:

- **The rig layout** — head over torso over hips over paired legs; paired
  arms with a shoulder + forearm split; a small pack on the back. Every
  box the game will look at is placed by hand on a small integer grid,
  the way the pilot builds itself.
- **`Faces +Z`.** The models are authored with their front along +Z so a
  single facing helper (`applyAvatarFacing`) works for both, and matches
  the pilot's convention if we ever import its animation later.
- **The palette-first rule** (afterburn `ART_BIBLE.md` §3). Boxes reference
  palette keys, never raw hexes; a re-grade lands in one file.

## What changed

- **No orange flight suit and no visor.** The pilot's `suit0/suit1` (orange
  suit) and `helmet/visor` cream shell would clash with the NetHack world.
  The hero wears cloth and leather instead: `moss1` green tunic, `wood0`
  brown belt and cloak, `canvas` sleeves and skin tone, `strap` pants,
  `rubber` soles, `wood1` accents, `brass` buckles, `black` eyes.
- **No anims, no lamp, no beacon, no crash-wear system.** T-0056 is a
  static pose; T-0057 owns any input/facing plumbing. `pilot.js`'s IK,
  gait code and `scuffed` wear scaffolding did not come along.
- **A fraction of the box count.** The pilot is ~700 boxes on a 29-unit
  rig; the hero here is **49 boxes** (well under the 400 budget) because
  he stands **0.7 cells** tall on screen, not "hero prop" size.
- **A completely new pet.** `pip.js` is a floating companion robot;
  `critters.js` and `body.js` gave shape but no direct source. The pet is
  a small four-legged animal in the same palette family: brown fur, cream
  belly, teal `eye` iris, brass collar.

## Unit / scale conversion

Afterburn is authored in metres (`unit: 0.05 m`, the pilot 1.45 m tall).
Here **one cell is one world unit**, not a metre, and
`HERO_SPRITE_HEIGHT = 0.7` cells (`web/src/gl/ortho-camera.ts`). So the
builder's `unit` is in cells:

| Model | `VoxelBuilder.unit` (cells) | Top of head (units) | Top of head (cells) |
|-------|----------------------------|---------------------|---------------------|
| Hero  | `0.7 / 28 ≈ 0.025`         | 28.0                | 0.700               |
| Pet   | `0.03`                     | 15.0                | 0.450               |

The two grids do not share a step: the pet uses `0.03 cells/unit` (a hair
larger than the hero's grid) so its 15-unit rig lands cleanly at `0.45`
cells tall without redesigning the pilot-style humanoid.

Feet sit at `y = 0` for both — the sprite pipeline places the avatar at
the cell centre with the avatar's own y as-is, so the y-min must be zero
for the character to stand on the floor rather than through it.

## Palette keys used

All colours come from `web/src/voxel/palette.ts` — no invented hexes.

**Hero (cloth + leather adventurer palette):**

| Part                        | Palette key(s)        |
|-----------------------------|-----------------------|
| Skin / face                 | `canvas` (`0xb9ad8e`) |
| Hair cap + belt + boots     | `wood0` (`0x6a5138`)  |
| Cloak lining, pack, accents | `wood1` (`0x85684a`)  |
| Tunic body + shoulders      | `moss1` (`0x5f7852`)  |
| Trousers                    | `strap` (`0x3a3f42`)  |
| Boot soles                  | `rubber` (`0x2a2c2d`) |
| Buckles, toe caps, hooks    | `brass` (`0xa9823c`)  |
| Eyes, mouth line            | `black` (`0x0b0d0e`)  |

**Pet (fur + collar palette):**

| Part                     | Palette key(s)        |
|--------------------------|-----------------------|
| Fur (body, head, tail)   | `wood0` (`0x6a5138`)  |
| Belly + snout + chin     | `canvas` (`0xb9ad8e`) |
| Rump highlight           | `wood1` (`0x85684a`)  |
| Inner ears               | `rust0` (`0x8a4b2d`)  |
| Paws                     | `strap` (`0x3a3f42`)  |
| Eye whites (teal irises) | `eye`   (`0x9ff5e0`)  |
| Nose + pupils            | `black` (`0x0b0d0e`)  |
| Collar                   | `brass` (`0xa9823c`)  |

## Box counts

- **Hero: 49 boxes** (budget: ≤ 400).
- **Pet: 31 boxes** (budget: ≤ 200).

Both are far under the art bible's 900-box character budget on purpose:
they are 0.45–0.7 cells on screen, not 1.45 m props, so surface detail
past ~50 boxes disappears into the AsciiCity quantiser.

## Facing

`Pose.yaw` (radians, 0 = north = −Z; +π/2 = east = +X — architecture.md §7)
is applied by `applyAvatarFacing(obj, yaw)` in `avatar.ts`:

```ts
obj.rotation.set(0, Math.PI - yaw, 0);
```

The `π - yaw` compensates for the models being authored facing +Z: at
`yaw = 0` the model must point at −Z (north), which is a π turn about Y.
Only the Y axis moves — pitch and roll stay pinned so an adventurer under
the ortho camera does not lie on his back.

`SpriteLayer.update(sprites, camera, pose)` reads `pose.yaw` and uses it
for **both** the hero and the pet. The pet has no direction of its own in
the `Sprite` model, and the ticket's cheap option ("face it the same way
as the hero") is what T-0056 ships. A future ticket may thread last-move
direction or "look at master" through `sprites.ts`; the note is in-repo
so it does not get lost.

## Wiring

- `SpriteLayer` grew a `voxelMaterial` option. When set (as it is in
  `gl-viewport.ts`, sharing the dungeon's `createVoxelMaterial` output),
  hero (`Sprite.ch === '@'`) and pet (`Sprite.cls === 'pet'`) sprites are
  rerouted through `createHeroAvatar` / `createPetAvatar`. The two
  `Object3D`s are **built lazily on first sight and reused every frame** —
  only `position` and `rotation.y` change. If a level has no hero or no
  pet, the avatar is detached from the layer's root that frame and
  re-attached the next time it appears.
- When `voxelMaterial` is **not** given (the constructor default, and what
  the existing `tests/gpu-sprites.test.ts` uses), every sprite continues
  to get a camera-facing quad — no behaviour change for the legacy path.

## What I could not verify

- **The frame.** Worker containers have no display and no `playwright`;
  the render is judged by the PM. Hero and pet were built to structural
  criteria only (`tests/gpu-avatar.test.ts`): height, box budget, facing
  math, "built once and reused across frames". Whether the adventurer
  reads as an adventurer and the pet as a companion is a PM screenshot,
  not a green suite.
- **Silhouette from the diorama camera.** The third-person distance and
  pitch (`docs/gpu-thirdperson.md`) plus the AsciiCity quantiser strip
  most detail; a design pass "at the intended size" needs the PM.
- **Palette against the dungeon mood.** All colours come from
  `web/src/voxel/palette.ts`, but whether `moss1` reads as tunic-green
  under `torchlit` (which pushes the whole scene warm) is a
  frame-review question, not a test.
- **The pet's facing.** It is currently `pose.yaw`; whether that looks
  right when the pet trails behind the hero is unknowable without a
  moving frame. If it looks wrong, the fix is either "face the pet
  towards the hero cell" (very cheap given both are `Sprite`s) or
  "carry a last-move vector on the pet" (needs a small session change).
