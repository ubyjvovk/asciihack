# Terminal UI (`src/ui/`, `src/term/tty.ts`, `src/cli.ts`)

Module notes for the app shell, modes, overlays, status rows, the real tty
adapter and the CLI entry (docs/architecture.md §6, §8). This is the first
playable milestone: `npm start -- --mode=classic` runs NetHack through the
bridge + session model in the terminal.

## The App loop (`src/ui/app.ts`)

`App` takes `{ session, term: TermIO, mode }` and owns the compose-and-paint
loop. It subscribes to the session's `change`, `request` and `message` events
and to the term's `onKey`/`onResize`, and on each trigger rebuilds a
`ScreenGrid` and paints it through `Screen` (`src/term/screen.ts`).

Composition for a terminal ≥ 80×24 (docs/architecture.md §6.3):

```
row 0            message line (latest message, --More-- when it overflows)
rows 1..H-3      viewport — the mode's paintViewport (classic: 80×21 map)
rows H-2..H-1    the two status rows from session.statusLines()
                 (+ the fps/ortho "not yet" banner at the top of the viewport)
overlay          the pending request's boxed overlay, painted last
```

Below 80×24 the app paints a "terminal too small" screen instead and recovers
on the next repaint once the terminal grows back.

`App` exposes `lastGrid` (the last composed `ScreenGrid`) and `screenWriter`
(the `Screen`) for tests, plus `enter()`/`leave()` to switch the alternate
screen.

## Key routing

Keys are routed in `App.handleKey`, in priority order:

1. **Global keys** — `F1`/`F2`/`F3` switch the mode (fps/ortho show a "not yet
   implemented" banner and stay in classic, the hook for T-0007/T-0008);
   `Ctrl+L` invalidates the screen (full repaint); `Ctrl+P` opens the last 20
   `session.messages` as a text overlay.
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
  terminal is wider.
- `handleKey` receives a key once no overlay or message pager consumed it.
  Classic answers a pending `key`/`pos` request with the key code via
  `session.answer`; if none is pending it hands the key to `queueKey`, which the
  app stores and flushes when NetHack next asks.

The fps (T-0007) and ortho (T-0008) modes will implement the same interface
with a different `paintViewport`.

## Overlays (`src/ui/overlays.ts`)

One overlay object per pending request, built by `createOverlay(pending,
session)`; `paint` draws a boxed overlay centred on the viewport and `handleKey`
either keeps the overlay open or answers the request and returns `false` so the
app closes it. The app keeps the same overlay instance while `session.pending`
is unchanged, so editor/menu state survives repaints.

| pending kind | overlay | behaviour |
|---|---|---|
| `menu` | `MenuOverlay` | paging with `>`/`<`, accelerators (`a-zA-Z` assigned to empty ones), PICK_NONE any-key dismiss, PICK_ONE accelerator answers, PICK_ANY toggles then Enter, ESC cancels (empty selection) |
| `display` (menu/text) | `TextOverlay` | paged lines, any key pages, ESC dismisses |
| `display` (message) | `MoreOverlay` | `--More--`, any key → `dismiss` |
| `file` | `TextOverlay` | paged file text, ESC dismisses |
| `yn` | `YnOverlay` | shows choices + default; only offered choices accepted; ESC → `q`/`n`/default rule from `wintty.c` |
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
npm start -- --mode=classic --name=tester
```

`parseFlags` reads `--mode=classic|fps|ortho` (default `fps`), `--name=`,
`--bridge=` (default `build/nethack/bridge/nh-bridge`), `--playground=` and
`--options=` (extra `NETHACKOPTIONS`). `preparePlayground` copies the build's
playground to `~/.asciihack/playground` on first run so saves persist and the
build dir stays clean. `main` errors helpfully if the bridge binary is missing,
spawns the bridge, wires the session to it, enters the alternate screen, and
runs `runSession` until the bridge closes stdout (restoring the terminal in a
`finally`).
