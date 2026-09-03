# Terminal core: quantizer, screen writer, key parser

Module notes for `src/render/ascii.ts`, `src/term/screen.ts` and
`src/term/input.ts` (docs/architecture.md §5.4, §6.1, §6.2). These are the
pure building blocks every terminal mode uses; they do no I/O themselves.

## ASCII quantizer (`src/render/ascii.ts`)

Turns a linear-RGB `FrameBuffer` (one sample per terminal cell) into a
`ScreenGrid` using AsciiCity's ramp / exposure / gamma formulas.

### Formulas

For a cell with **no** overlay glyph:

```
c    = rgb * exposure                       // exposure = 1.7
v    = max(c.r, c.g, c.b)                   // hue-independent brightness
dens = clamp(v, 0, 1) ^ gamma               // gamma = 0.45
idx  = clamp(floor(dens * (ramp.length - 1) + 0.5), 0, ramp.length - 1)
ch   = ramp[idx]
tint = c / max(v, 0.02) * clamp(dens * 0.7 + 0.4, 0, 1)
fg   = round(clamp(tint, 0, 1) * 255) ; bg = black
```

- `glyphIndex(lum, count, gamma)` is the density→index step (`dens` from `lum`,
  then the clamped rounding above), exposed for testing.
- `clamp(v, 0, 1)^gamma` with `gamma = 0.45` lifts midtones so the ramp is
  used across its whole length.
- The tint normalises the colour by its brightness and re-boosts by density,
  so a saturated colour keeps its hue while the glyph density tracks
  luminance. The `max(v, 0.02)` guard avoids a divide-by-zero on black cells.
- The index is clamped to `[0, ramp.length - 1]`, so a non-overlay cell can
  **never** produce a character outside the ramp.

A cell **with** an overlay glyph (a monster/object letter, `overlayCh !== 0`)
prints `overlayCh` verbatim with `fg = overlayRgb × exposure`, clamped to 0..1
then ×255, on black — no ramp is consulted.

### `DEFAULT_RAMP`

AsciiCity's ramp, sparsest to densest, starting with a space and ending with
`$` (copied exactly from architecture.md §5.4 — note that despite the doc's
"68-glyph" label the literal string is 70 characters):

```
 .'`^",:;Il!i><~+_-?][}{1)(|\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$
```

### API

- `quantize(fb, opts?)` — allocate a fresh `ScreenGrid`, one cell per sample.
- `quantizeInto(fb, grid, opts?)` — quantize into a caller-owned grid,
  **reusing its cell objects** (no per-frame allocation). `width`/`height`
  are overwritten; existing cells are mutated in place.
- `QuantizeOptions { ramp?, exposure?, gamma? }` — defaults are the ramp
  above, `1.7` and `0.45`. The later render styles (gloom/amber/matrix) only
  vary these.

## Screen writer (`src/term/screen.ts`)

### `diff(prev, next)` — minimal ANSI strategy

`diff(prev: ScreenGrid | null, next: ScreenGrid): string` emits the shortest
escape-sequence stream that turns the currently displayed `prev` into `next`:

- **Full repaint** — when `prev` is `null` (first paint / `invalidate()`) or
  its size differs from `next`: emit `CSI 2 J` once, then paint every cell.
- **Cursor moves** — `CSI row;col H` is emitted only when the cursor is not
  already where the next cell to paint lives. The writer tracks a virtual
  cursor (starting unknown, so the first write always positions) and advances
  it after each written char with autowrap at the last column. Unchanged cells
  are skipped without moving the cursor, which is what creates the gaps that
  moves bridge.
- **Colour** — `CSI 38;2;r;g;b m` / `CSI 48;2;r;g;b m` are emitted only when
  fg/bg change from the currently applied SGR, so a run of same-coloured cells
  costs one SGR pair.
- Always ends with `CSI 0 m` (reset) when any output was produced; identical
  grids yield the empty string.

### Worked example

`prev` is a 1×3 row of white `a`s; `next` is `a X a` (the middle cell turned
red `X`):

```
prev:  a a a   (fg 255;255;255)
next:  a X a   (cell 1 → ch 'X', fg 255;0;0)
```

The writer skips cell 0 (unchanged), then needs cell 1. The virtual cursor is
unknown, so it emits a move, then the fg/bg SGRs, then the char, then skips
cell 2. Output:

```
ESC[1;2H        move to column 2
ESC[38;2;255;0;0m   fg → red
ESC[48;2;0;0;0m     bg → black (was unknown)
X
ESC[0m          reset
```

That is one move, two SGRs, one char — minimal, and exactly what a full
repaint would not be.

### `Screen` class

Wraps `diff` over an injectable `TermIO { write, columns, rows, onResize,
onKey }` so tests use a fake:

- `paint(grid)` — writes `diff(prev, grid)`, then copies `grid` into a
  **private buffer** (reusing that storage frame to frame) rather than storing
  the caller's grid object. This means a grid mutated in place by
  `quantizeInto` (the intended per-frame loop) still diffs correctly on the
  next `paint` — the screen compares against its own snapshot, not against the
  caller's now-changed grid. The private copy grows/shrinks with the painted
  grid: if a grid with a different cell count is painted while the buffer is
  live (a resize that skips `invalidate()`), the copy is reallocated to the
  new size, so the steady state (same size frame to frame) stays
  allocation-free.
- `invalidate()` — forgets `prev` so the next paint is a full repaint.
- `enter()` — `CSI ?1049 h` (alternate screen) + `CSI ?25 l` (hide cursor).
- `leave()` — `CSI ?1049 l` (leave alt screen) + `CSI 0 m` (reset SGR) +
  `CSI ?25 h` (show cursor).
- A `TermIO.onResize` callback is wired to `invalidate()`, so a resize forces
  a redraw.

## Key parser (`src/term/input.ts`)

`parseKeys(buf: Uint8Array, pending: Uint8Array): { events, rest }` is a pure,
incremental raw-stdin decoder. `pending` is the leftover from the previous
call (a lone ESC or an incomplete sequence); `buf` is newly arrived bytes.
All complete events are returned; anything not yet decodable is returned as
`rest` for the next call.

### Grammar

| input | event |
|---|---|
| printable ASCII (0x20–0x7e) | `key` = the character |
| UTF-8 multi-byte (0x80+) | one event, `key` = the decoded char |
| bytes 0x01–0x1a | `Ctrl+<letter>` (`key` lower-case, `ctrl: true`) |
| 0x0d | `Enter` |
| 0x09 | `Tab` |
| 0x7f, 0x08 | `Backspace` |
| `ESC x` | `Alt+x` (`alt: true`) |
| `ESC [ <final>` / `ESC [ <n>~` / `ESC O <final>` | arrows, `Home`, `End`, `PageUp`, `PageDown`, `Insert`, `Delete`, `F1`–`F12` |
| `;2` / `;3` / `;5` modifier params | `shift` / `alt` / `ctrl` (xterm bitmask: `;6` = shift+ctrl, `;7` = alt+ctrl) |
| lone `ESC` at the end of the buffer | kept in `rest` — the caller waits ~25 ms, then calls `flushEscape(rest)` |

**Unknown sequences are dropped whole.** A CSI/SS3 whose final byte is not a
recognised key (mouse reports `ESC [ M …` and `ESC [ <…M/m`, focus events
`ESC [ I` / `ESC [ O`, DA responses, …) is consumed up to and including its
final byte and produces **no** event — the bytes never leak as printable
keystrokes. `ESC [ M` additionally consumes the three mouse-payload bytes
that follow it. An incomplete unknown sequence is held in `rest` until its
final byte arrives.

**Invalid UTF-8 is skipped, not held.** A byte that is not a valid UTF-8 lead
(bare continuation 0x80–0xBF, 0xC0/0xC1, 0xF8+) or a sequence with a bad
continuation is skipped one byte at a time, so a stray byte never wedges the
parser; only a *genuinely partial* UTF-8 sequence at the buffer end is held in
`rest`.

The named keys are exactly: `Escape Enter Tab Backspace Up Down Left Right
Home End PageUp PageDown Insert Delete F1 … F12`. `KeyEvent` carries `key`,
`ctrl`, `shift`, `alt` and the raw `seq`.

`flushEscape(pending)` consumes a leading ESC held in `rest` and returns the
`Escape` event (plus the remaining `rest`), resolving the 25 ms ambiguity
between a real Escape press and the start of a longer sequence.
