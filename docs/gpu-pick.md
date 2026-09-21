# Click to move on the browser 3D view

*T-0061. Read `docs/web.md` "WebGL viewport" and `docs/gpu.md` §4 first —
this file only documents the click-to-move feature the ticket adds on top
of the ported afterburn renderer.*

## Why

The third-person "diorama follow" view (T-0052, `docs/gpu-thirdperson.md`)
shows the dungeon in an overhead perspective; the natural input there is
"click where I want to go", the same way Diablo works. This ticket wires it
up as pure BFS over the remembered map plus a ray/floor unprojection at
the click site.

The 3D views are the only ones that get this — the classic terminal mode
already accepts vi-keys, and no click event routes to the classic layout.
Fps clicking is not disabled here, but the resulting BFS is normally
short (you can only click cells you can see) and the interrupts below stop
anything surprising from happening.

## The two halves

The picking and the pathing are separate modules so the pure maths can be
unit-tested in node without a renderer:

| module                    | pure | contract                                                |
|---------------------------|------|---------------------------------------------------------|
| `web/src/gpu/pick.ts`     | half | `cellUnderRay(origin, dir)` is pure; `pickCellFromEvent` wraps `three.Raycaster` around it |
| `src/ui/travel.ts`        | yes  | `findPath(level, from, to)` is BFS; `stepKey(dx, dy)` maps a step to a vi-key |
| `web/src/gl/gl-viewport.ts` | no | `GlViewport.pickCell(ev)` picks the live camera and delegates to `pickCellFromEvent` |
| `web/src/main.ts`         | no   | click listener + rAF-driven traveler state machine     |

`tests/travel.test.ts` exercises the pure side; the browser wiring is not
tested here (no DOM in the vitest run) — see "what I could not verify".

## Picking maths (`cellUnderRay`)

The GL canvas is `pointer-events: none` (docs/web.md "WebGL viewport") so
the DOM terminal keeps focus. `main.ts` therefore listens for `click` on
`<pre id="term">`, not on the canvas. From the event we take
`clientX`/`clientY` relative to the canvas's `getBoundingClientRect()`,
turn them into normalised device coordinates `(x, y) ∈ [-1, 1]²`, feed
them into three's `Raycaster.setFromCamera` and hand the resulting ray's
origin and direction to `cellUnderRay`.

`cellUnderRay(origin, dir)` is plain arithmetic:

1. If `dir.y === 0` the ray is parallel to the floor — miss.
2. Solve `origin.y + t · dir.y = 0` → `t = -origin.y / dir.y`. If `t ≤ 0`
   the intersection is behind the camera — miss.
3. The hit point in world space is `(origin.x + t·dir.x, 0, origin.z + t·dir.z)`.
4. Map coordinates: `x = floor(hit.x)`, `y = floor(hit.z)` — cell
   `(cx, cy)` occupies `[cx, cx+1) × [cy, cy+1)` on the floor plane
   (`docs/architecture.md` §7, `docs/gpu.md` §4).

Off-map coordinates are returned as-is; `findPath` bounds-checks them.

`pickCellFromEvent` picks the camera to unproject with by asking
`GlViewport` — the ortho view uses `this.orthoCamera`, the fps/third views
use `this.camera`. In the ortho case `pickCell` re-runs `placeOrthoCamera`
first so a click after a GPU-path frame (which leaves the legacy ortho
camera untouched) still gets a live pose. In the third case `pickCell`
copies the *current damped* pose onto the legacy camera without advancing
the spring — reading it must not perturb the follow behaviour.

## BFS rules (`findPath`)

BFS over the level width × height grid, starting at the hero cell:

- **Passable = known floor.** `kindAt !== 'unexplored'` **and**
  `!isSolid(kind)`. `unexplored` is a hard "no": the ticket says never path
  through territory the player has not seen, even if we happen to know it
  would be floor (a doorway peek, a magic-mapping fringe, a lit corridor
  the light range brushed).
- **8-way movement.** Cardinals + diagonals, one turn each. Uniform-cost:
  BFS gives us shortest-in-steps, not shortest-Euclidean; Dijkstra would be
  correct if we cared about √2 diagonals, but NetHack's turn counter
  charges the same for both, so BFS is enough.
- **No diagonal squeeze.** A step from `(x, y)` by `(dx, dy)` with
  `dx·dy ≠ 0` also requires `(x+dx, y)` and `(x, y+dy)` to be passable —
  the classic "you cannot slip between two adjacent walls" rule. Without
  it, click-to-move plans a path NetHack would reject at the first step.

Return shape: the sequence of cells to visit, excluding the start
(so `path[0]` is the first step). `null` means unreachable **or** the
target is not passable itself — the caller does nothing in both cases (no
beep, no message: silence is the right feedback per the ticket).

## Sending the moves (one-key-per-frame policy)

Each step is one vi-key from the 8-way table (`h j k l y u b n`); `stepKey`
maps `(dx, dy)` to the letter. We send them through the existing `sendKey`
path in `src/ui/view3d.ts`, one at a time. The traveler in `main.ts` runs
inside the rAF loop so the throttle is naturally the browser's refresh
rate: **at most one vi-key per animation frame**. A queued burst is
tempting but wrong — NetHack is turn-based and can interrupt for a hundred
reasons, and a queue that ignores the result would walk the player into a
monster or a trap.

The traveler advances state *before* the `session.answer`: `answer` runs
listeners synchronously, and one of them (`repaint`) can indirectly
re-enter `tick`. Bumping `expectedNext` / `msgSnapshot` first keeps the
state consistent through that reentry.

### Interrupts (any one aborts the walk, silently)

1. **The hero did not arrive at `expectedNext`.** After a step we
   remember the cell we asked to walk into; on the next `key` request we
   check that `session.hero` matches it. If it does not — a monster
   blocked, a door refused, we were stunned — abort.
2. **The message line changed.** `session.messages.length` grew since the
   last step: NetHack wants the player to notice something ("You see a
   fountain here."). Abort so the player can read it.
3. **Any non-modifier key was pressed.** The player is taking over;
   dropping the queue is the least surprising behaviour. Shift/Ctrl/Alt/Meta
   on their own do not count.
4. **The pending request is not a `key` ask.** A menu, yn-prompt, getlin,
   display or pos-cursor means the game wants something specific from the
   player — driving those with vi-keys is user-hostile, so abort.

We deliberately do **not** use NetHack's own `_` travel command: driving
its cursor prompt over the bridge is a bigger and more fragile job than
"send vi-keys one at a time", and reusing the vi-key path keeps every
existing safeguard (message pager, overlay routing, animation lock in
`FpsMode`) live.

## What I could not verify

- **The click experience on a real page.** The vitest run has no DOM;
  `pickCellFromEvent`, `GlViewport.pickCell` and the traveler in
  `main.ts` are exercised only by the pure `cellUnderRay` tests and by
  reading. The eyeball review (PM) needs to open the browser and confirm
  that a click in the third view walks the hero to the target, that the
  message-line interrupt stops the walk on a "You see …" line, and that a
  keypress mid-walk drops the queue.
- **The `pointer-events` layering.** The docs say the canvas is
  `pointer-events: none` and the `<pre>` receives clicks; this ticket
  listens on the `<pre>` accordingly and does not touch the canvas
  attribute. If the layering has drifted, the click listener will never
  fire — a browser check is the only way to catch that.
- **BFS cost weights.** BFS treats a cardinal and a diagonal as one turn
  each. If a future ticket wants Euclidean distances (√2 for diagonals),
  it needs Dijkstra or A*. That is a look change, not a bug.
