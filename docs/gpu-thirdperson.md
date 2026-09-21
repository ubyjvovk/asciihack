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

## Fog

At the default distance of ~10.7 cells and the mood table's
`torchlit.fog.density = 0.10`, fog survival is `e^(−0.10·10.7) ≈ 34 %`,
which is atmospheric rather than black. **This is the measurement the
ticket asked for.** The ortho helper's `moodFogDensityForView` therefore
passes `'fps'` for `view === 'third'` — no rescale — because the mood
tuning already lands in a comfortable range at this distance. The two
knobs in `web/src/gpu/ortho.ts` (`FPS_FOG_DENSITY = 0.10`,
`ORTHO_FOG_DENSITY = 0.01`) remain the only fog constants.

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
