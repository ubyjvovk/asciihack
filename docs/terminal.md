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
vc   = clamp((v - blackPoint) / (1 - blackPoint), 0, 1)   // blackPoint = 0.10
dens = vc ^ gamma                           // gamma = 0.9
idx  = clamp(floor(dens * (ramp.length - 1) + 0.5), 0, ramp.length - 1)
ch   = ramp[idx]                            // vc = 0 → space
raw  = c / max(v, 0.02)                     // hue at unit brightness
grey = 0.299·raw.r + 0.587·raw.g + 0.114·raw.b
sat  = clamp(dens * 1.5, 0, 1)              // darkness-dependent desaturation
tint = grey + (raw - grey) * sat            // dark cells fade to grey
fg   = round(clamp(tint * clamp(dens * 0.7 + 0.4, 0, 1), 0, 1) * 255)
                                            // bg = theme background
```

- `glyphIndex(lum, count, gamma)` is the density→index step for the un-clipped
  luminance path (`dens = lum^gamma`), exposed for testing.
- The black-point `blackPoint` cuts near-black inputs (post-exposure) to `vc = 0`
  so faint noise renders as the space glyph, not a smudge of dots. The default
  `0.10` clears the sub-`v ≈ 0.10` band; `blackPoint = 0` restores the
  pre-black-point mapping (`dens = v^gamma`).
- `gamma = 0.9` is near-linear: the `vc → dens` curve leaves midtones roughly
  where the brightness put them, so dark surfaces stay sparse instead of being
  lifted into mid-density glyphs by the old `v^0.45`.
- The desaturation fold pulls faint cells toward their per-channel grey (weight
  `1 - sat`) while bright cells (`dens ≥ 2/3`) keep their full hue (`sat = 1`).
  Combined with the black-point/gamma change, this stops thin colour casts in
  dark cells (e.g. a barely-lit corridor floor) from quantizing to saturated
  hues.
- The tint then folds by the same brightness boost `clamp(dens * 0.7 + 0.4)` as
  before, so mid-density cells keep the softly-lit look.
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
- `QuantizeOptions { ramp?, exposure?, gamma?, blackPoint?, theme? }` —
  defaults are the ramp above, `1.7`, `0.9`, `0.10` and `'cyber'`. `theme`
  picks one of four looks (see the Themes subsection). Setting
  `blackPoint: 0, gamma: 0.45` reproduces the pre-black-point density
  mapping (glyph selection only; the desaturation fold is always applied).

### Worked example (T-0023 render levels)

Cyber theme, defaults (exposure 1.7, blackPoint 0.10, gamma 0.9, 70-glyph
ramp so idx-max 69). Input given in linear 0..1 per channel; `v` is the
exposed max-channel brightness.

| surface        | rgb               | v     | vc    | dens  | idx | glyph  |
|----------------|-------------------|------:|------:|------:|----:|--------|
| unseen veil    | `[0.03,0.03,0.03]`| 0.051 | 0.000 | 0.000 |   0 | ` ` (space) |
| corridor floor | `[0.10,0.10,0.11]`| 0.187 | 0.097 | 0.122 |   8 | `,`    |
| wall body      | `[0.14,0.14,0.15]`| 0.255 | 0.172 | 0.205 |  14 | `~`    |
| floor grid     | `[0.30,0.30,0.30]`| 0.510 | 0.456 | 0.500 |  35 | `n`    |
| wall edge      | `[0.75,0.75,0.75]`| 1.000 | 1.000 | 1.000 |  69 | `$`    |

Dark surfaces render as sparse dots or nothing; only the built-in bright
edges climb into the dense end of the ramp.

### Themes

The `theme` option ports the shader looks from AsciiCity's `ascii.frag` to
the terminal. The mixers live in `src/render/themes.ts` as pure functions
(`themeMix`, `amberMix`, `amberDensity`) and are called from `ascii.ts`.

In a shader the glyph coverage `mask` is a per-pixel value; in a terminal
the glyph is drawn by the terminal, so **`mask = 1` gives the foreground
colour of a cell and `mask = 0` gives the background colour of the same
cell**. For `cyber`/`gloom`/`solarized` the glyph choice is the same shared
`vc^gamma` curve; `amber` uses its own steeper density curve
(`clamp((v - blackPoint) / (1 - blackPoint))^(gamma·1.5)`, same `blackPoint`
as the shared path) for the ramp index too. The darkness-dependent
desaturation fold documented in Formulas is applied on every theme before
the theme mixer runs.

- `cyber` (default) — the original look: folded tint over a black bg. The
  glyph mapping under `blackPoint: 0, gamma: 0.45` reproduces the pre-theme
  ramp selection; foreground colours are always desaturated in dark cells.
- `gloom` — a low-contrast wash of the cell's hue on a bright grey ground
  `[184, 186, 191]` (`0.72/0.73/0.75 × 255`). Hot cells (`v` near 1) burst
  back toward the raw tint.
- `solarized` — solarized `base00` ink on solarized `base3` paper
  `[253, 246, 227]`; hot cells bloom toward solarized yellow
  `(0.71, 0.54, 0)`.
- `amber` — warm monochrome phosphor: black background, glyph shades amber
  `(1.0, 0.62, 0.18)` up to a nearly-white hot bloom `≈[255, 224, 148]`.

Overlay glyphs (monsters/objects) keep their own colour as fg and take the
theme's `mask = 0` background, so they sit on the paper/ground rather than
on black.

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
