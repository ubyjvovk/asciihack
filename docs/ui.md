# Terminal UI (`src/ui/`, `src/term/tty.ts`, `src/cli.ts`)

Module notes for the app shell, modes, overlays, status rows, the real tty
adapter and the CLI entry (docs/architecture.md §6, §8). `npm start`
(default `--mode=fps`) runs NetHack through the bridge + session model with
the first-person raycaster view; `--mode=ortho` is the isometric view and
`--mode=classic` the top-down map.

## The App loop (`src/ui/app.ts`)

`App` takes `{ session, term, mode, theme, minimap }` and owns the compose-and-paint
loop. It subscribes to the session's `change`, `request` and `message` events
and to the term's `onKey`/`onResize`, and on each trigger rebuilds a
`ScreenGrid` and paints it through `Screen` (`src/term/screen.ts`).

Composition for a terminal ≥ 80×24 (docs/architecture.md §6.3):

```
row 0            message line (latest message, --More-- when it overflows)
rows 1..H-3      viewport — the mode's paintViewport (classic: 80×21 map;
                 fps: raycaster + minimap; ortho: isometric + minimap)
rows H-2..H-1    the two status rows from session.statusLines()
overlay          the pending request's boxed overlay, painted last
```

Below 80×24 the app paints a "terminal too small" screen instead and recovers
on the next repaint once the terminal grows back.

`App` exposes `lastGrid` (the last composed `ScreenGrid`), `screenWriter`
(the `Screen`) and `activeMode` for tests, plus `enter()`/`leave()` to switch
the alternate screen. `requestFrame()` asks for one more frame: while the
active mode's optional `tick(nowMs)` returns `true`, the app repaints at
≤ 30 fps (`FRAME_MS = 33`, `setTimeout`, never a busy loop); `leave()`
cancels any pending frame.

Shutdown auto-dismiss. NetHack's `dosave()` prints `Saving...` and then does
a blocking `display_nhwindow(WIN_MESSAGE, TRUE)` — a `--More--` on a game
that has already committed to exiting. When a blocking message-window
display arrives whose newest message is exactly `Saving...`, the App
answers `dismiss` from the `request` handler so the shutdown proceeds
without a keypress. Death messages, DYWYPI and every other blocking
display keep pausing for a key. As a safety net, the App also drops a
lingering `display` overlay if the session ever emits `exit` while one is
still pending, and `TtyTerm.restore()` removes its stdin/stdout listeners
and unrefs stdin so the process exits within 500 ms even if a listener is
still registered elsewhere.

After `app.leave()` restores the terminal, `cli.ts` echoes the last two
messages (`Saving...  Be seeing you...` on a clean save) on stdout so the
player gets the farewell tty shows on exit. The session picks up the
farewell string from NetHack's `exit_nhwindows(str)` call (docs/engine.md).

## Key routing

Keys are routed in `App.handleKey`, in priority order:

1. **Global keys** — `F1`/`F2`/`F3` switch the mode (classic/fps/ortho);
   `F4` toggles the minimap in fps/ortho; `F5` cycles the render theme
   (cyber → gloom → solarized → amber); `Ctrl+L` invalidates the screen
   (full repaint); `Ctrl+P` opens the last 20 `session.messages` as a text
   overlay.
2. **The overlay** — while an overlay is open it consumes every key.
3. **The message pager** — while the message line is paging an overflowing
   batch (`--More--`), any key reveals the next chunk *before* it reaches
   NetHack.
4. **The mode** — otherwise the active mode's `handleKey` decides (classic
   forwards every key to NetHack).

### The message rule (PM, 2026-09-03)

NetHack does not pause between messages in this port: several `message` events
can arrive between two key requests. The app accumulates `pendingMsgs` (from
the session `message` event) and the message line shows everything that arrived
since the previous key request, joined with two spaces. If the joined text does
not fit the width, the line shows the first fitting chunk with `--More--` and
any key reveals the next chunk before keys reach NetHack. The buffer is reset
when a key is answered. A blocking `display` request on the message window is
NetHack's own `--More--` (`MoreOverlay`) and is answered with `dismiss` on any
key.

## The mode interface (`src/ui/modes/classic.ts`)

```ts
interface Mode {
  readonly name: string;
  onEnter(): void;
  onLeave(): void;
  paintViewport(grid: ScreenGrid, rect: Rect): void;
  handleKey(e: KeyEvent, queueKey: (e: KeyEvent) => void): void;
}
```

- `paintViewport` draws the play area (rows 1..H-3). Classic paints the whole
  80×21 map from `session.map` — `top` glyph char + `clrToRgb(color)`, the hero
  cell in inverse video (ink black on the glyph colour) — centred when the
  terminal is wider. Fps paints the raycaster (`renderFirstPerson`) from the
  hero's facing plus the minimap (`src/ui/minimap.ts`, hero as a facing arrow)
  and the compass ribbon (`src/ui/compass.ts`); ortho paints
  `renderOrtho` with the hero as an `@` sprite plus the minimap and a compass
  rose.
- `handleKey` receives a key once no overlay or message pager consumed it.
  Classic answers a pending `key`/`pos` request with the key code via
  `session.answer`; if none is pending it hands the key to `queueKey`, which the
  app stores and flushes when NetHack next asks. Fps/ortho translate facing
  keys (see below) and likewise queue moves when NetHack is not waiting.
- A mode may expose an optional `tick(nowMs): boolean`: `true` asks for
  another frame. The fps mode interpolates its yaw toward the facing yaw
over 120 ms on a turn (`TURN_MS`), so the world swings instead of snapping;
  ortho has no `tick` (no camera rotation).

## Fps/ortho controls (§6.4)

Only in fps/ortho, and only translated while NetHack waits for a key
(`session.pending` is a key/pos request); otherwise keys are queued or flow
to the overlay/prompt exactly as in classic mode:

- Fps `Left`/`Right`: turn to the next facing (consumed, never sent to
  NetHack); `Up` sends the facing's vi-key, `Down` the opposite facing's key
  (walk backwards); `Shift+Left/Right`: strafe (facing ±90°) — the sidestep
  key is sent, the facing is unchanged.
- A vi-key (`hjklyubn` + capitals) or number-pad digit typed directly is sent
  unchanged and sets the facing to that direction, so the next `Up` follows it.
- Facing is one of 8 compass directions (`FACINGS` in `src/ui/view3d.ts`:
  N `k`, NE `u`, E `l`, SE `n`, S `j`, SW `b`, W `h`, NW `y`), shared with
  the ortho sprite sync; `turn`/`opposite`/`strafe` step it with wrap-around.
- Ortho `Left`/`Right`/`Up`/`Down` are plain NetHack moves (west/east/north/
  south); there is no facing.
- Everything else passes through unchanged. `F1/F2/F3` switch modes, `F4`
  toggles the minimap, `F5` cycles the theme, `Ctrl+L` redraws.

## Minimap (`src/ui/minimap.ts`)

`paintMinimap(grid, rect, session, facing?)` draws a 40×11 window of the
classic map (`MINIMAP_WIDTH`/`MINIMAP_HEIGHT`), centred on the hero and
clamped to the map bounds, top-right over the viewport. One-cell `-`/`|`
border (dim grey, `+` corners), glyph colours from `clrToRgb`, unexplored
cells as spaces, the hero cell inverse-video. When `facing` is given the hero
prints its facing arrow (`↑ ↗ → ↘ ↓ ↙ ← ↖` for N…NW, all BMP one-cell) instead
of `@`. Shown by default in fps/ortho; `F4` hides it. The fps mode passes its
`Facing`, so the arrow matches the compass ribbon; ortho/classic pass none and
stay `@`.

## Heading cues

Three always-visible, cheap facing cues (none in classic mode; nothing here
touches the renderers):

- **Compass ribbon** (`src/ui/compass.ts`, pure `paintCompass(grid, rect,
  yawRad)`): a 41-column strip on the first row of the fps viewport, centred,
  over the rendered scene, drawn with the interpolated `yaw` so it slides
  during a turn. The headings `N NE E SE S SW W NW` are placed at
  `centre + round(Δ·20/45°)` columns where Δ is the signed heading − yaw
  wrapped to (−180°, 180°]; only headings inside the 41-column span (within
  45°: the facing heading and its two adjacent diagonals) are drawn, so the
  facing heading sits at the centre with `NE`/`NW` at ±20 columns. A `·` tick
  marks every 15°, with a `|` facing notch at the centre column. The nearest
  heading is bright white, the others dim grey, the ticks darker, all on a
  black background.
- **Minimap facing arrow** (`src/ui/minimap.ts`): the hero cell prints an
  arrow instead of `@` when `facing` is given (see above).
- **Ortho rose** (`src/ui/modes/ortho.ts`): a fixed 5×3 legend at the
  top-left of the ortho viewport — `W N` / `+` / `S E` — because in the
  locked projection north is up-right (cell (x, y−1) → screen (sx+2, sy−1)),
  east down-right, south down-left, west up-left. Dim grey with the `+`
  bright.

## Overlays (`src/ui/overlays.ts`)

One overlay object per pending request, built by `createOverlay(pending,
session)`; `paint` draws a boxed overlay centred on the viewport and `handleKey`
either keeps the overlay open or answers the request and returns `false` so the
app closes it. The app keeps the same overlay instance while `session.pending`
is unchanged, so editor/menu state survives repaints.

| pending kind | overlay | behaviour |
|---|---|---|
| `menu` | `MenuOverlay` | paging with `>`/`<`, accelerators (`a-zA-Z` assigned to empty ones), PICK_NONE any-key dismiss, PICK_ONE accelerator answers, PICK_ANY toggles then Enter, ESC cancels (`{cancelled:true}` → `ret -1`; Enter with nothing picked stays `ret 0`) |
| `display` (menu/text) | `TextOverlay` | paged lines, any key pages, ESC dismisses |
| `display` (message) | `MoreOverlay` | `--More--`, any key → `dismiss` |
| `file` | `TextOverlay` | paged file text, ESC dismisses |
| `yn` | `YnOverlay` | shows `query [choices] (def)` (default in parens only when it is a printable ASCII char, 0x21–0x7e); only offered choices accepted; ESC → `q`/`n`/default rule from `wintty.c` |
| `getlin` | `GetlinOverlay` | line editor (Backspace, Enter commits, ESC → `""`) |
| `extcmd` | `ExtCmdOverlay` | `#` line with prefix completion over `hello.extra.extcmds`, Enter → index, ESC → −1 |
| `message-menu` | `MessageMenuOverlay` | shows the message, any key answers its code |
| `key` / `pos` | none | handled by the active mode, not an overlay |

## Status rows (`src/ui/status.ts`)

`paintStatus(grid, session, x, y)` draws `session.statusLines()` — the two
classic tty lines assembled from the `BL_*` fields — at rows `y`/`y+1`,
truncated to the grid width.

## Real tty adapter (`src/term/tty.ts`)

`TtyTerm` is the only `TermIO` implementation, and the only module that touches
`process.stdin`/`process.stdout` directly. It puts stdin in raw mode, feeds raw
bytes to `parseKeys` (resolving a lone ESC after a 25 ms timeout), forwards
resizes from `SIGWINCH`, and restores the terminal on exit, on SIGTERM and on
uncaught exceptions.

## CLI (`src/cli.ts`)

```
npm start -- --mode=fps --name=tester
```

`parseFlags` reads `--mode=classic|fps|ortho` (default `fps`), `--theme=`
(cyber|gloom|solarized|amber, default `cyber`), `--no-minimap` (hide the
minimap in fps/ortho), `--name=`, `--bridge=` (default
`build/nethack/bridge/nh-bridge`), `--playground=` and `--options=` (extra
`NETHACKOPTIONS`). `preparePlayground` copies the build's playground to `~/.asciihack/playground` on first run so saves persist and the
build dir stays clean. `main` errors helpfully if the bridge binary is missing,
spawns the bridge, wires the session to it, enters the alternate screen, and
runs `runSession` until the bridge closes stdout (restoring the terminal in a
`finally`).
