# Third-person view on the GPU render path (browser viewport)

*T-0052. Read `docs/gpu.md` §4–§7, `docs/gpu-ortho.md` and
`vendor/afterburn/docs/ART_BIBLE.md` §6 first — this file only describes
what changes when the browser hosts afterburn's long-lens diorama follow
camera as a third view alongside fps (`F2`) and ortho (`F3`).*

## Why

`docs/gpu-ortho.md` gave the browser a 3/4 overhead ortho view; that is
a **projection** change, not the diorama look afterburn actually ships.
Afterburn's readable "photographed tabletop" feel comes from a
**perspective long-lens follow camera** behind and above the subject.
This ticket adds that camera as a third view so the user can have the
same look inside the dungeon.

## What ships

`web/src/gpu/thirdperson.ts` — a pure module (no `three`, no DOM) with
two callables the viewport uses, plus the constants that pin the look:

| helper                | what it does                                                                    |
|-----------------------|---------------------------------------------------------------------------------|
| `thirdPersonPose`     | Camera position + look target + FOV + focus for a hero at `(x, y)`, given yaw/dist |
| `dampPose`            | Exponential-decay spring pulling `current` toward `wanted` over `dt` seconds    |
| `wrapYawSteps`        | Folds any yaw-step count into `[0, 8)` (Q/E can walk indefinitely)              |
| `clampThirdDist`      | Clamps a wheel-driven distance into the converted min/max band                  |

## ART_BIBLE §6 — the numbers

Verbatim: *"Perspective, FOV ≈ 28–32°, pitch ≈ 38–46°, distance 22–34 m,
follows the player with a soft spring. Depth of field focused on the
player, gentle (diorama, not mush)."*

Afterburn's rig defaults (from the PM's reading of
`vendor/afterburn/src/game/camera.js` — that file is not in the vendored
tree):

| knob          | afterburn default    | notes                                     |
|---------------|----------------------|-------------------------------------------|
| FOV           | 30° vertical         | inside the ART_BIBLE 28–32° band          |
| pitch         | 42° above horizon    | inside the 38–46° band                    |
| distance      | 26 m (clamped 18–34) | camera-to-target                          |
| look-at height| 0.95 m above feet    | so DOF lands on the hero's chest          |
| yaw           | snapped to 45° steps | Q/E walks steps, not continuous heading   |
| spring        | position, yaw, dist  | soft, "diorama" (not mush)                |

## Scale conversion — the one thing that must not be copied literally

Afterburn is metres with a ~1.7 m character; here one cell is one unit
and `HERO_SPRITE_HEIGHT = 0.7` cells. The relationship
`THIRD_SCALE = HERO_SPRITE_HEIGHT / AFTERBURN_HERO_M = 0.7 / 1.7 ≈ 0.41`
is applied to **distances only** — angles (FOV, pitch, 45° yaw step) are
dimensionless and copied verbatim.

| afterburn (m) | here (cells)                                        |
|---|---|
| distance 26 (default) | **~10.7** (`THIRD_DIST_DEFAULT_CELLS`)          |
| distance 18 (min)     | **~7.4** (`THIRD_DIST_MIN_CELLS`)               |
| distance 34 (max)     | **~14.0** (`THIRD_DIST_MAX_CELLS`)              |
| look-at height 0.95   | **~0.39** (`THIRD_LOOK_HEIGHT_CELLS`)           |

Angles that stay the same:

- FOV **30°**, pitch **42°** — copied verbatim, no scale. Scaling an angle
  by a length ratio is a category error; the frame would come out with
  the wrong lens on the same subject.

## Controls

- **`F9`** switches to the third-person view. F4 was the ticket's first
  choice, but `src/ui/app.ts:362` already binds it to the minimap toggle,
  so per the ticket's fallback rule this ships on F9. F1–F3 stay on
  classic/fps/ortho; F5–F8 stay on style cycle / FOV / raw toggle. F9 is
  free everywhere.
- **`Q` / `E`** rotate the camera by ±45° (afterburn's yaw snap). Only
  active while the third view is up so `q` remains the NetHack "quaff"
  key in fps/ortho.
- **Mouse wheel** zooms between the min/max distance
  (`clampThirdDist` bounds each notch, so a fast scroll never lands out
  of range).
- **`?view=third`** in the URL selects the view once the viewport is
  mounted, matching the existing `?view=fps|ortho` in `scene-bench`.

## The pose helper

`thirdPersonPose(hero, yawSteps, dist, opts)` returns four fields:

- `position` — camera in world (cell) coordinates. Sits on a sphere of
  radius `dist` around `target`, azimuth `yawSteps · π/4`, pitch
  `THIRD_PITCH_RAD` above the horizon. Azimuth 0 places the camera
  **north** of the hero (behind, in `Pose.yaw = 0` terms), which matches
  the fps camera facing.
- `target` — `(hero.x + 0.5, THIRD_LOOK_HEIGHT_CELLS, hero.y + 0.5)`.
  The look-at point is the hero cell centre lifted by the converted
  0.95 m so DOF and rotation pivot on the hero's chest, not their feet.
- `fov` — `THIRD_FOV_DEG` (30°) unless `opts.fov` overrides.
- `focus` — equals `dist` by construction. `‖position − target‖ = dist`
  because the position is placed on a sphere of that radius, so the DOF
  focus lands on the hero exactly as ART_BIBLE §6 asks.

## The spring

`dampPose(current, wanted, dt)` is a first-order exponential-decay
spring: `next = current + (wanted − current) · (1 − e^(−dt/tau))`, with
`tau = SPRING_TAU_SEC = 0.18 s`. That reads as "soft, diorama" because
the input is a step function — the hero cell only moves once per NetHack
turn — so the camera arrives at 63 % of the remaining distance every
0.18 s. A full mass–spring integrator is overkill for a step response;
critical damping is achieved by keeping the input a single time
constant.

The damper state (`ThirdPersonFrame`) is held by `GlViewport`. Entering
the third view via `setView('third')` drops the damped state so the
first frame starts from the wanted pose (no snap-in from a stale
position). Leaving the third view also drops the state — a re-enter
starts fresh, again matching afterburn's rig.

## Where it wires in

- `GlViewport.setView('third')` widens the view union to
  `'fps' | 'ortho' | 'third'` (the type ships through `debugInfo`,
  `currentView`, `render` and the `GpuPath.render` signature).
- The legacy render branch computes the damped pose with
  `stepThirdPose(heroCell)`, writes it onto `this.camera` and calls
  `style.render(this.scene, this.camera)`. The lantern is a child of
  `this.camera` in the legacy setup (docs/web.md); in the third view it
  therefore rides with the camera and lights it from behind rather than
  from the hero. This is a known limitation of the legacy path and does
  not apply to the GPU path (see below).
- The GPU render branch passes the pose through `GpuPath.render(view,
  thirdFrame)` — a new parameter — and the ortho-specific setCamera
  rebuild is skipped: `pipelineCameraForView(view === 'ortho' ? 'ortho'
  : 'fps', ...)` hands the graph the perspective camera reference (same
  as fps), so `handle.setCamera` no-ops. No SSGI demotion, no fog
  rescale.
- **Ceiling.** The third-person camera sits at
  `y = target.y + dist · sin(42°) ≈ 7 cells` — above the 1-cell ceiling
  — so the ceiling is hidden in the third view for the same reason it
  is in ortho (`view === 'fps' ? visible : hidden`).
- **Lantern.** On the GPU path the lantern is a scene child, not a
  camera child (docs/gpu.md §5), so it stays anchored at the hero cell
  in the third view — the light behaves exactly like the fps view.
- **DOF focus** is pushed to `thirdFrame.focus` (equal to the requested
  distance) after each render step, and the mood's `focusRange` is left
  alone so the sharp slab is only a few cells wide — ART_BIBLE §6
  "gentle, diorama, not mush".

## Motion

*Added by T-0060, extended by T-0062 — the hero and every other sprite
glide between cells instead of teleporting.*

Four things are damped every browser frame, all with the same
first-order exponential shape (`1 − e^(−dt/τ)`, framerate-independent):

- **The third-person camera** — already there since T-0052. `dampPose`
  (§"The spring") pulls the wanted camera pose toward the follow rig at
  `SPRING_TAU_SEC = 0.18 s`.
- **The hero cell centre** — added by T-0060. `createPoseSmoother` in
  `src/ui/view3d.ts` holds the displayed position and eases it toward the
  true cell each frame at `POSE_SMOOTH_CELL_SECONDS = 0.12 s`.
  `GlViewport.render` calls `smoother.update(heroCell, yaw, dt)` before
  touching any camera; the smoothed pose then drives the fps eye, the
  GPU-path camera and the third-person spring's input.
- **The lantern** — a scene child of the same smoothed camera on the GPU
  path (`GpuPath.render` writes `this.lantern.position` at the smoothed
  hero cell), so the pool of light glides with the character.
- **Every sprite** — added by T-0062. `SpriteLayer.update` takes the
  smoothed hero pose and draws the `@` avatar at `(pose.x, pose.y)`
  instead of its integer cell centre. Every other sprite (pet, monsters,
  items) has no smoother of its own, so `SpriteLayer` runs the same
  exponential damper per sprite: sprites are matched between frames by
  `(ch, cls)` + nearest position, an unmatched sprite is placed directly
  at its cell (no ease from an unrelated neighbour), and the ease shares
  `POSE_SMOOTH_CELL_SECONDS` with the hero smoother so the whole scene
  reads as one motion.

Before T-0060 the pose fed into `dampPose` was a step function — the
hero snapped a whole cell the instant NetHack acknowledged a move — and
the spring lurched. Before T-0062 the fix only reached the camera and
the lantern: the avatar itself was still drawn at its raw integer cell,
so the model teleported a whole cell every turn while the camera glided
after it. Smoothing every visible position first turns the step into a
ramp, so the follow reads as "the character (and the goblin, and the
kitten) walked one tile", not "the tile appeared under them".

### Constants

| constant                     | value | why                                                            |
|------------------------------|-------|----------------------------------------------------------------|
| `POSE_SMOOTH_CELL_SECONDS`   | 0.12  | Time constant τ. One cell in 120 ms so it finishes with the fps mode's 120 ms turn animation. |
| `POSE_SNAP_CELLS`            | 1.9   | Cell-space distance beyond which the smoother snaps instead of gliding. |

### Snap rule

Level changes, `<`/`>` and teleports jump the hero by many cells at
once. Easing across that distance would send the avatar skating over the
whole map for a full second — worse than the teleport it replaced. When
the target is more than `POSE_SNAP_CELLS` cells from the displayed
position, `update` writes the new cell centre directly and returns it
unmodified. The threshold is `>` (not `≥`), so a legal diagonal walk
(distance √2 ≈ 1.41) still glides. **`SpriteLayer` applies the same rule
per sprite** — a monster shifted more than `POSE_SNAP_CELLS` from its
previous frame's eased position snaps to its new cell rather than
skating across the room, and a sprite that appears for the first time
(no match in the previous frame) is placed directly at its cell.

### Yaw

Yaw passes through the smoother unchanged. `FpsMode.advance` already
animates the facing over its own 120 ms in the terminal fps mode, and
the browser reads that same current-yaw every frame, so damping it a
second time here would double up.

### Terminal fps mode

`src/ui/modes/fps.ts` renders the terminal viewport straight from
`poseFor(hero, this.yaw)` — the smoother is a browser-only wire, added
inside `GlViewport.render`. The terminal path is untouched; its existing
tests still pass unchanged.

## Camera azimuth — which side the camera sits on

Azimuth 0 puts the camera **due south of the hero, looking north**, matching
afterburn's rig ("0 = camera south of the subject looking north"). South is
`+z` here (`docs/gpu.md` §4), so the placement is
`z = target.z + dist·cos(pitch)`.

This is not cosmetic. Put the camera *north* instead and the world is
mirrored on screen: map-east renders to the left, map-north renders down, and
every movement key appears reversed even though the key handling is correct.
That shipped briefly and the user caught it immediately — the original code
reasoned that `Pose.yaw = 0` means facing north so "behind" must be north,
but behind a north-facing hero is *south*.

## Fog

*Rewritten by T-0054. T-0052's "34 % survival is atmospheric" call was made
on paper; the PM's shot revoked it.*

Mean luminance over the same frame, same pose, same mood, measured after
T-0053 landed:

| view      | mean |
|-----------|------|
| fps       | 54.0 |
| ortho     | 28.8 |
| **third** | **8.0** |

At the default `THIRD_DIST_DEFAULT_CELLS ≈ 10.7` cells and the mood
table's `torchlit.fog.density = 0.10`, `FogExp2` survival is
`e^(−0.10·10.7) ≈ 34 %` — that number is correct, but 34 % *plus* the
ported pipeline's inverse-square falloff over ~10 cells left the diorama
in a cave: `mean 8.0` vs the raw dungeon's `54.0` in fps.

`web/src/gpu/ortho.ts` therefore gains a third knob,
**`THIRD_FOG_DENSITY = 0.04`**, and `moodFogDensityForView` now maps
`'third'` to it. `e^(−0.04·10.7) ≈ 65 %` — atmospheric rather than
black. The value sits between `ORTHO_FOG_DENSITY = 0.01` and
`FPS_FOG_DENSITY = 0.10`, keeping the natural ordering
`fps > third > ortho` by camera distance.

Scaling follows the ortho pattern exactly: the mood's raw density is
multiplied by `THIRD_FOG_DENSITY / FPS_FOG_DENSITY = 0.4`, so
`deep_dark`'s heavier fog stays proportionally heavier than
`torchlit`'s. No per-view magic number — the three knobs above are the
only fog constants.

## SSGI, SSR, TRAA, DOF

The third-person camera is a `PerspectiveCamera` throughout, so unlike
the ortho path it needs no SSGI demotion and no projection-branch
switch. Every node in the graph reads
`camera.isPerspectiveCamera === true` and takes the perspective branch
it already used in fps.

## What I could not verify

- The **spring feel** was not measured in a real browser tab. The
  `dampPose` unit is pure and its arithmetic is pinned by the FOV/DOF
  test cases, but "soft, diorama" is a subjective look that only the
  eyeball review can confirm. The PM should open
  `/scene.html?view=third` and press Q/E a few times.
- No **frame-rate measurement** — the WebGPU probe from T-0040 is not
  re-run here and every measurement in `docs/gpu.md` §3 came from
  SwiftShader.
- **Camera occlusion** — the ticket explicitly notes that a wall
  between the camera and the hero is a later ticket. If the hero is in
  a room with a north wall directly behind them, the third-person
  camera will sit inside the wall (or through it); the visual is
  "diorama with X-ray", not "diorama". A follow-up ticket needs a raycast
  from the target back toward the camera and a shorter distance where a
  wall is crossed.
- **Legacy lantern behaviour** — the legacy fallback keeps the lantern
  parented to the perspective camera, so in third-view the light rides
  with the camera rather than the hero. This is a scope-safe limitation
  (touching the legacy scene graph is out of scope), and the GPU path
  behaves correctly.
- **F9 discoverability** — F4 is a common expectation for "third
  camera" and it now shows `?` to the user (it toggles the minimap and
  does not print a message). A small on-screen HUD hint is a later UI
  polish ticket.
