# AsciiHack — architecture & module contract

PM-owned design contract. Tickets cite sections by number; if a ticket and
this document disagree, flag it in your report instead of guessing.

## 1. What it is

**AsciiHack** lets you play real NetHack (5.0, the `nethack/` git submodule)
in a terminal — locally or over ssh — but instead of the classic top-down
letter map the dungeon is rendered as a coloured-ASCII **first-person view**
(a raycaster, in the style of AsciiCity) or an **ortho / isometric view**
(old Diablo / Fallout style). The classic 2D map stays available as a mode
and as a minimap. A browser build reusing AsciiCity's three.js render styles
comes later; nothing in the terminal stack may depend on a browser.

Pieces:

1. **The engine** — unmodified NetHack, built from the submodule with its
   own `SHIM_GRAPHICS` window port as `libnethack.a`.
2. **The bridge** — `bridge/nh-bridge.c`, a ~500-line C program that links
   `libnethack.a`, registers the shim callback, and speaks a JSON-lines
   protocol on stdin/stdout (§3).
3. **The client** — TypeScript on Node 22+: spawns the bridge, keeps the
   session model (§4), renders (§5) and drives the terminal (§6).

## 2. Stack (locked)

- Node ≥ 22, TypeScript `strict`, ESM (`"type": "module"`, NodeNext
  resolution — relative imports carry the `.js` suffix), **named exports
  only**, no `any` (use `unknown` + narrowing). Tests: vitest, plain node.
- **Zero runtime npm dependencies** for the terminal client (raw-mode stdin,
  hand-written ANSI). Dev deps only: typescript, vitest, tsx, @types/node.
  `package.json`/lockfile are PM-owned: need a package → block with a
  `## Questions` entry.
- C: C99, gcc, no libraries beyond libc/libm and what `libnethack.a` needs
  (lua, ncurses/tinfo for termcap symbols). No JSON library — the bridge
  hand-writes its JSON output and parses the small reply subset (§3.2).
- Builds are out-of-tree: the submodule is never modified and never gets
  generated files. `scripts/nethack-build.sh` copies it into
  `build/nethack/<variant>/` first (§9).

## 3. Engine bridge (`bridge/`)

### 3.1 Why the shim port

`nethack/win/shim/winshim.c` is a NetHack-maintained fake window port: every
window procedure (`putstr`, `print_glyph`, `nhgetch`, menus, status, …) is
forwarded to a single callback registered with
`shim_graphics_set_callback(cb)` where
`void cb(const char *name, void *ret_ptr, const char *fmt, ...)` — `name` is
the window-proc name (`shim_putstr`), `fmt` describes the return type (first
char) and the varargs (`i` int, `s` `char *`, `p` pointer, `c` char, `b`
boolean, `0`/`1`/`2` = 1/2/4-byte ints, all promoted to `int` through
varargs, `v` void). The full list of calls, formats and argument orders is
`winshim.c` lines ~117–235; semantics are `nethack/doc/window.txt` with
`nethack/win/tty/wintty.c` as the reference implementation. `libnethack.a`
is produced by `make WANT_LIBNH=1` (hints `linux.500`), which compiles the
game with `-DSHIM_GRAPHICS -DNOTTYGRAPHICS -DLIBNH` and exports
`int nhmain(int argc, char **argv)`.

### 3.2 Process and framing

- The client spawns `build/nethack/bridge/nh-bridge` with
  `NETHACKDIR=<playground dir>` in the environment and NetHack's own argv
  (`-u <name>`, `-D`, …). Options come from `NETHACKOPTIONS` /
  `$NETHACKDIR/.nethackrc` as usual; the client sets what it needs.
- **stdout**: one JSON object per line (LF terminated, no pretty-printing),
  UTF-8. Strings are escaped as JSON requires; every byte below 0x20 and
  every byte at or above 0x80 is emitted as a `\u00XX` escape (NetHack
  strings are ASCII/Latin-1, so the line is always valid UTF-8). Message
  shapes: `src/engine/protocol.ts` (`hello`, `call`, `exit`, `log`).
- **stdin**: one reply line per `call` that carried an `id`, in order. Reply
  grammar (the only JSON the bridge parses): a flat object with keys `id`
  (int, required), `ret` (int | JSON string | `true`/`false` | `null`),
  `selected` (array of `{"i":int,"count":int}` objects), `x`, `y`, `mod`
  (ints). Unknown keys are skipped. Anything else → the bridge prints a
  `log` line and treats the reply as `ret: null`.
- **stderr**: free-form diagnostics only; never protocol.
- **Buffering**: stdout is fully buffered (≥ 256 KiB); the bridge flushes
  before blocking on a reply, in `delay_output` (which also sleeps 50 ms),
  `mark_synch`, `wait_synch`, and at exit. A full map redraw is ~1700
  `print_glyph` lines; the client must cope with bursts of ~300 KB.
- **Exit**: when `nhmain` returns the bridge prints `{"t":"exit","code":N}`
  and exits with N. On stdin EOF or a parse failure while waiting for a
  reply the bridge exits 2 after printing an `exit` line with `reason`.
- Ids are increasing integers starting at 1, per process.

### 3.3 Per-call shapes

`name` is the window-proc name without the `shim_` prefix. `args` follow the
C order. "→ reply" marks calls that carry an `id` and block until the reply.
Window ids are whatever the client returned from `create_nhwindow`
(NetHack uses `WIN_ERR = -1` for failure; return ≥ 0).

| call | args | reply |
|---|---|---|
| `init_nhwindows` | `[argv: string[]]` | – |
| `player_selection_or_tty` | `[]` | → `ret` boolean (see `libnhmain.c` / `role.c` for what `true` means; document it) |
| `player_selection` | `[]` | → `ret` 0 after the client has finished (the client picks via the menu calls NetHack issues, or forces role/race/gender/align through options) |
| `askname` | `[]` | → `ret` string; the bridge copies it into NetHack's player-name global (`plname`, `PL_NSIZ`) |
| `get_nh_event`, `resume_nhwindows`, `status_init`, `nhbell`, `mark_synch`, `wait_synch`, `delay_output` | `[]` | – |
| `exit_nhwindows`, `suspend_nhwindows`, `raw_print`, `raw_print_bold`, `update_positionbar`, `preference_update` | `[str or null]` | – |
| `create_nhwindow` | `[type]` (NHW_*) | → `ret` winid |
| `clear_nhwindow`, `destroy_nhwindow` | `[win]` | – |
| `display_nhwindow` | `[win, blocking]` | → `ret` 0 **only when `blocking` is true** (the client waits for the user to dismiss); otherwise no id |
| `curs` | `[win, x, y]` | – (on the map window this is the hero position, §4.3) |
| `putstr` | `[win, attr, str]` | – |
| `display_file` | `[name, complain, text or null]` — the bridge reads the file through `dlb_fopen` and ships its text | → `ret` 0 after dismissal |
| `start_menu` | `[win, mbehavior]` | – |
| `add_menu` | `[win, glyph or null, identIndex, accel, groupAccel, attr, color, str, itemflags]` — `identIndex` is the 0-based position of this item's identifier in the bridge's per-window table, or **−1 when the identifier is all-zero** (unselectable header) | – |
| `end_menu` | `[win, prompt or null]` | – |
| `select_menu` | `[win, how]` (PICK_*) | → `ret` count (−1 cancelled, 0 none), `selected: [{i, count}]` with `count` −1 = "all"; the bridge mallocs the `MENU_ITEM_P` array from its identifier table |
| `message_menu` | `[let, how, mesg]` | → `ret` char code |
| `cliparound` | `[x, y]` | – |
| `print_glyph` | `[win, x, y, glyph, background or null]` (§3.4) | – |
| `nhgetch` | `[]` | → `ret` key code |
| `nh_poskey` | `[]` | → `ret` key code, or 0 with `x`, `y`, `mod` for a click |
| `doprev_message` | `[]` | → `ret` 0 |
| `yn_function` | `[query, resp or null, def]` (`def` = char code) | → `ret` char code |
| `getlin` | `[query]` | → `ret` string; `""` cancels (the bridge copies at most `BUFSZ − 1` bytes into NetHack's buffer) |
| `get_ext_cmd` | `[]` | → `ret` index into `extcmdlist` (−1 cancel); the list is in `hello.extra.extcmds` |
| `number_pad` | `[state]` | – |
| `change_color` | `[color, rgb, reverse]` | – |
| `change_background` | `[white_or_black]` | – |
| `putmsghistory` | `[msg, restoring]` | – |
| `status_enablefield` | `[fieldidx, name, fmt, enable]` | – |
| `status_update` | `[fldidx, value, chg, percent, color]` — `value` is a number for `BL_CONDITION` (the `long` mask), `null` for `BL_FLUSH`/`BL_RESET`, else the string | – |
| `update_inventory` | `[arg]` | – |

Not forwarded (the bridge answers itself): `getmsghistory` → `NULL`,
`get_color_string` → `NULL`, `set_shim_font_name` → 0, `ctrl_nhwindow` →
`NULL`.

**As built (T-0002, 2026-09-03) — facts the client relies on**, details in
`docs/bridge.md`:

- Startup order: `init_nhwindows` → `create_nhwindow(NHW_MESSAGE)` →
  `status_init` → `create_nhwindow(NHW_MAP)` → (tutorial prompt as an
  `NHW_MENU` window + `select_menu`, unless `!tutorial`) →
  `display_nhwindow` message + map → `player_selection` (reply `0`; with
  role/race/gender/align unset NetHack picks at random itself) →
  `cliparound`/`curs` → `status_update`s → `print_glyph`s → `nhgetch`.
  **No `NHW_STATUS` window is created**; status arrives only via
  `status_update`. A fresh level sends only the *seen* cells (~40–100
  `print_glyph`s), not 1700.
- Messages: the shim never sets `iflags.window_inited`, so until T-0012
  lands `pline()` delivers messages through `raw_print`; afterwards
  through `putstr(WIN_MESSAGE)`. The client treats both as messages and
  paces them itself (§6.3): NetHack never waits between messages except
  for an explicit blocking `display_nhwindow(WIN_MESSAGE, true)`.
- `player_selection_or_tty`: reply `false` always (`true` would make
  NetHack run its tty character setup on the bridge's stdio).
- `BL_GOLD` arrives as `\GXXXXXXXX:<amount>` (NetHack's glyph escape);
  strip the escape.
- `hello.mg`: `MG_BW_SINK`, `MG_BW_ENGR`, `MG_BW_ICE` share one bit.
- The bridge `chdir`s to `NETHACKDIR` before `nhmain` (the lib is built
  without `CHDIR`), and the installed `sysconf` has `GDBPATH` disabled.
- `exit` carries `reason: "atexit"` (code 0) when NetHack calls `exit()`
  itself; `reason` otherwise only on the error path.
- Hardened in T-0010: `start_menu`'s `mbehavior` is read as `unsigned
  long`; the unknown-call fallback zeroes only the return width named by
  `fmt`; `select_menu` bounds-checks the window id.

### 3.4 Glyph info

Every `glyph_info *` becomes an object matching `GlyphInfo` in
`src/model/types.ts`:

```json
{"glyph":2431,"ch":"@","color":15,"cls":"mon","idx":331,"flags":4}
```

`ch` is `glyphinfo->ttychar`; `color` is `glyphinfo->gm.sym.color`; `flags`
is `gm.glyphflags`; `cls` is computed **in C** with the `glyph_is_*` macros
from `include/display.h`, tested in this order: `unexplored`, `nothing`,
`pet`, `ridden`, `detected`, `invisible`, `body`, `statue`, `mon`
(`glyph_is_monster`), `trap`, `cmap`, `obj` (`glyph_is_object`), `warning`,
`swallow`, `zap`, `explosion`, else `other`. `idx` is `glyph_to_cmap` for
`cmap`, `glyph_to_mon` for the monster classes, `glyph_to_obj` for `obj`,
`glyph_to_trap` for `trap`, `glyph_to_warning` for `warning`, else 0. A
`NULL` pointer becomes JSON `null`. The hero's own glyph carries `MG_HERO`
in `flags`.

### 3.5 Hello

Printed before `nhmain` runs; shape `HelloMsg` in `protocol.ts`. `S` maps
every `S_*` name in `include/defsym.h` to its index (use the file's X-macro
protocol — read its header comment); `cmap[i]` is `defsyms[i]` (`sym`,
`explanation`, `color`); `nhw`, `bl`, `pick`, `atr`, `mg`, `clr`, `blmask`
are name→value tables of the corresponding `#define`s; `extra.extcmds` is
`[{name, desc, flags}]` from `extcmdlist[]` (stop at the `NULL` entry).

## 4. Session model (`src/engine/`)

### 4.1 Session

`NethackSession` owns the bridge process and the model. It consumes
`BridgeMsg`s and exposes:

- `map: LevelView` + `hero: {x, y} | null` (§4.3), `level` info from the
  status `BL_LEVELDESC`;
- `messages: string[]` (append-only log of the message window; the UI
  decides what is "current"), `status: Map<BL index, string | number>`;
- `windows`: id → `{type, lines: [{attr, text}], menu?: MenuState}`;
- `pending: null | KeyRequest | YnRequest | GetlinRequest | MenuRequest |
  PosRequest | BlockingDisplayRequest | TextFileRequest` — exactly one
  outstanding request at a time (the bridge is single-threaded), answered
  with `session.answer(reply)`; the session serialises the `RetMsg`;
- an event emitter (`on('change' | 'message' | 'request' | 'exit')`) — the
  UI redraws on `change` and reacts to `request`.

Client-assigned window ids start at 1. The first three windows NetHack
creates are message, status and map (it tells you the type); keep
`WIN_MESSAGE/STATUS/MAP` from those.

### 4.2 CellKind classification (`src/engine/glyphs.ts`)

From a `GlyphInfo` with `cls: 'cmap'` and the `S` table from hello:

| `S_*` names | kind |
|---|---|
| `S_stone` | `stone` |
| `S_vwall S_hwall S_tlcorn S_trcorn S_blcorn S_brcorn S_crwall S_tuwall S_tdwall S_tlwall S_trwall S_lavawall` | `wall` |
| `S_ndoor` | `doorway` |
| `S_vodoor S_hodoor` | `door_open` |
| `S_vcdoor S_hcdoor` | `door_closed` |
| `S_bars` | `bars` |
| `S_tree` | `tree` |
| `S_room S_darkroom S_engroom` | `floor` |
| `S_corr S_litcorr S_engrcorr` | `corridor` |
| `S_upstair S_brupstair` | `stairs_up` |
| `S_dnstair S_brdnstair` | `stairs_down` |
| `S_upladder S_brupladder` | `ladder_up` |
| `S_dnladder S_brdnladder` | `ladder_down` |
| `S_altar` `S_grave` `S_throne` `S_sink` `S_fountain` | `altar` `grave` `throne` `sink` `fountain` |
| `S_pool S_water` | `water` |
| `S_ice` | `ice` |
| `S_lava` | `lava` |
| `S_vodbridge S_hodbridge` | `drawbridge` |
| `S_vcdbridge S_hcdbridge` | `wall` (a raised drawbridge is a wall) |
| `S_air` | `air` |
| `S_cloud S_poisoncloud` | `cloud` |
| any `cls: 'trap'` glyph | `trap` |
| `S_vibrating_square S_magic_portal S_goodpos` and anything else | `other` (log the name once) |

Rules: a `cmap`/`trap` glyph sets both `terrain` and `kind`. A non-terrain
glyph (monster, object, …) sets `top` only; if the cell's `kind` is still
`unexplored`, set it to `floor` (something is standing there, so it is
passable). `clear_nhwindow(WIN_MAP)` resets every cell to `unexplored`
(level change). Names missing from `S` are treated as absent.

### 4.3 Hero position

`curs(WIN_MAP, x, y)` — NetHack positions the cursor on the hero at every
screen flush. Also usable: the glyph with `MG_HERO` in `flags`. Use `curs`
as the primary source, the flag as a cross-check.

### 4.4 Menus, prompts, text windows

- `NHW_MENU` windows: `start_menu` resets the item list; `add_menu` appends
  `{identIndex, accel, groupAccel, attr, color, text, glyph, selected:false,
  count:-1}`; `end_menu` stores the prompt; `select_menu` → `MenuRequest`.
  Items with `identIndex === -1` are headers. The UI assigns accelerators
  `a-zA-Z` to selectable items whose `accel` is the NUL character.
- `NHW_TEXT` / `NHW_MENU` shown with `display_nhwindow(win, true)` →
  `BlockingDisplayRequest` (the UI pages the lines and replies on dismissal).
- `NHW_MESSAGE` with `display_nhwindow(WIN_MESSAGE, true)` = a forced
  `--More--`.
- `yn_function` → `YnRequest{query, choices | null, def}`; `getlin` →
  `GetlinRequest{query}`; `nhgetch`/`nh_poskey` → `KeyRequest`;
  `get_ext_cmd` → `ExtCmdRequest` (the UI reads a `#` command line with
  completion from `hello.extra.extcmds` and answers the index).

## 5. Renderers (`src/render/`)

### 5.1 FrameBuffer

`FrameBuffer` (PM-owned, `src/model/types.ts`): one sample per terminal
cell, linear RGB 0..1 **before** exposure, a depth plane, and an overlay
glyph plane the quantizer prints verbatim (used for monsters/objects so a
jackal is a `d`, not a blob). Renderers write; the quantizer (§5.4) reads.

### 5.2 First-person raycaster (`src/render/raycast.ts`)

`renderFirstPerson(level: LevelView, pose: Pose, sprites: Sprite[], fb:
FrameBuffer, opts?: RaycastOptions)`:

- Grid DDA (Wolfenstein-style), one ray per column, FOV 70° horizontal,
  camera height 0.5, wall height 1 cell. The aspect correction assumes a
  terminal cell is **twice as tall as wide**: vertical FOV = 70° ×
  (rows·2) / cols.
- A ray stops at the first cell where `isSolid(kind)`; `unexplored` counts
  as solid so the world ends where knowledge ends (dark stone).
- Wall colour by kind (`wall` grey stone, `door_closed` brown, `tree` green,
  `bars` cyan, `stone`/`unexplored` near-black); N/S faces at 100 %, E/W
  faces at 70 %; distance attenuation `exp(−0.18·d)` with `d` the
  perpendicular distance (no fish-eye).
- Floor: flat shaded by the floor cell's kind under each screen row
  (`floor` warm grey, `corridor` dark brown, `water` blue, `lava` orange,
  `ice` pale cyan, stairs highlighted) using the classic floor-casting
  per-row distance; ceiling: black with a faint gradient. Everything
  beyond `opts.maxDepth` (default 24) is black.
- Sprites: each `Sprite` is a billboard 0.7 cells wide × 0.9 tall at the
  cell centre, depth-tested per column against the wall depth, projected
  with the same camera; its screen rectangle gets `overlayCh = sprite.ch`
  and `overlayRgb = sprite.rgb × attenuation`. Near sprites are a block of
  the same letter; far ones a single letter. The hero's own sprite is never
  drawn.
- Doorways (`doorway`, `door_open`) are passable and rendered as a thin
  frame: the ray continues, but the floor under them is drawn in the door
  colour.
- Pure: no I/O, no globals; deterministic for a given input. Tested with a
  golden ASCII dump of a synthetic room (see §9).

### 5.3 Ortho renderer (`src/render/ortho.ts`) — wave 2

`renderOrtho(level, hero, sprites, fb, opts)`: 2:1 isometric projection
(classic "diamond" tiles, 4 cells wide × 2 rows tall per map cell) centred
on the hero, walls extruded 1 cell up with a lit top and a shaded east face,
sprites standing on their tile via the overlay plane. Specified in detail by
the wave-2 ticket; the interface above is fixed.

### 5.4 ASCII quantizer (`src/render/ascii.ts`)

A CPU port of AsciiCity's `ascii` style (its theme 0). For each cell with
no overlay glyph:

```
c    = rgb * exposure                       // exposure = 1.7
v    = max(c.r, c.g, c.b)                   // hue-independent brightness
dens = clamp(v, 0, 1) ^ gamma               // gamma = 0.45
idx  = clamp(floor(dens * (ramp.length - 1) + 0.5), 0, ramp.length - 1)
ch   = ramp[idx]
tint = c / max(v, 0.02) * clamp(dens * 0.7 + 0.4, 0, 1)
fg   = round(clamp(tint, 0, 1) * 255) ; bg = black
```

`DEFAULT_RAMP` is AsciiCity's 70-glyph ramp, sparsest to densest:

```
 .'`^",:;Il!i><~+_-?][}{1)(|\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$
```

(the first glyph is a space). Cells with an overlay glyph print
`overlayCh` with `fg = overlayRgb` mapped the same way (exposure, clamp,
×255) and a black bg. Output: `ScreenGrid`. Alternate looks (`gloom`,
`amber`, `matrix`) are a later ticket; the `QuantizeOptions {ramp,
exposure, gamma}` parameters exist from day one.

## 6. Terminal (`src/term/`, `src/ui/`)

### 6.1 Screen writer (`src/term/screen.ts`)

`Screen` keeps the last `ScreenGrid` it painted and emits the minimal ANSI
to reach the next one: cursor moves (`CSI row;col H`), 24-bit SGR
(`CSI 38;2;r;g;b m`, `CSI 48;2;r;g;b m`) only when fg/bg change, runs of
unchanged cells skipped. First paint after `resize()` or `invalidate()`
redraws everything. Enter/leave: alternate screen (`CSI ?1049 h/l`), hide
cursor, raw mode. Pure core (`diff(prev, next): string`) is unit-tested;
the tty wrapper is thin. `TermIO` is the injectable interface (`write`,
`columns`, `rows`, `onResize`, `onKey`) so tests use a fake.

### 6.2 Input (`src/term/input.ts`)

Raw stdin bytes → `KeyEvent {key: string, ctrl, shift, alt, seq}`: printable
chars, `Escape` (lone ESC — use a 25 ms timeout to disambiguate from
sequences), arrows (`Up/Down/Left/Right`, with `;2`/`;5` modifiers), `F1–F4`,
`Enter`, `Backspace`, `Tab`, and `Ctrl+<letter>` (bytes 1–26). Pure parser
function + a thin stdin adapter.

### 6.3 Modes and layout

Three modes, switchable with `F1` classic, `F2` first-person, `F3` ortho
(also `--mode=` on the CLI; default `fps`). Layout for any terminal ≥ 80×24:

```
row 0            message line (latest message, --More-- when NetHack blocks)
rows 1..H-3      viewport (fps/ortho) — or the 80×21 classic map in classic mode
                 top-right: minimap overlay (classic map, 40×11 window centred on the hero) in fps/ortho
rows H-2..H-1    the two NetHack status lines assembled from the BL_* fields
```

Menus, text windows, `getlin` and `yn` prompts draw as boxed overlays
centred on the viewport; a `--More--` pause shows on the message line.
Below 80×24 the client prints "terminal too small" and waits for a resize.

### 6.4 Controls

- **Classic mode**: every key goes to NetHack unchanged (vi-keys, number
  pad if `number_pad` was requested, `#` extended commands).
- **fps / ortho**: `Left`/`Right` turn the camera 45° (free — no NetHack
  turn); `Up` moves forward = the vi-key for the facing direction; `Down`
  moves backward; `Shift+Left/Right` (when the terminal reports them)
  strafe. Any other key goes to NetHack unchanged; a vi-key or number-pad
  move also sets the facing to that direction. Facing is one of 8
  compass directions; the raycaster interpolates the yaw over ~120 ms for
  a smooth turn.
- `Ctrl+L` redraw, `F1–F3` mode. NetHack's `Ctrl+C`/`Ctrl+Z` are passed
  through in classic mode only.

## 7. Coordinate system

Map cell `(x, y)`: `x` = column 1..79 east, `y` = row 0..20 south, as
NetHack prints them. World space for the 3D renderers: `x` east, `y` south
(same numbers), height up; the hero stands at `(hx + 0.5, hy + 0.5)`.
`Pose.yaw` = 0 north (−y), +π/2 east, clockwise from above. The 8 facing
directions map to NetHack's vi-keys: N `k`, NE `u`, E `l`, SE `n`, S `j`,
SW `b`, W `h`, NW `y`.

## 8. Layout & module map

```
nethack/            git submodule — NetHack 5.0, never modified, never built in place
bridge/             nh-bridge.c (+ its Makefile and C tests)
scripts/            nethack-build.sh, nethack-play.sh, test.sh, check.sh
src/model/types.ts  PM-owned model (§4, §5.1)
src/engine/         protocol.ts (PM-owned), bridge.ts (process + JSONL), session.ts, glyphs.ts
src/render/         raycast.ts, ortho.ts, ascii.ts
src/term/           screen.ts, input.ts, tty.ts
src/ui/             classic.ts, fps.ts, ortho.ts, overlays.ts (menus/prompts), status.ts
src/cli.ts          entry: parse flags, spawn bridge, run the UI loop
tests/              vitest, one file per module; tests/fixtures/ recorded bridge streams
docs/               this file + per-module notes tickets ask for
build/              gitignored: build/nethack/{tty,lib,bridge}/, build/lua-*.tar.gz
```

## 9. Testing strategy & gates

- Unit tests (`bash scripts/test.sh` via `run-tests.sh`) run in plain node,
  never need the C build, and finish in seconds. Renderers are tested with
  golden ASCII dumps (`tests/__shots__/*.txt` are artifacts, committed
  goldens live next to the tests). The session model is tested by replaying
  recorded bridge streams (`tests/fixtures/bridge/*.jsonl`, recorded with
  `scripts/record-bridge.ts`).
- Integration tests that need `nh-bridge` use `describe.skipIf(!bridgeBuilt)`
  and are exercised by the full gate.
- Full gate `bash scripts/check.sh`: install → typecheck → unit → build; the
  NetHack tickets append `nethack-lib` and `bridge` stages.
- `scripts/nethack-build.sh <tty|lib|bridge>` is idempotent and safe to
  rerun; it needs network once (`make fetch-lua` → cached in `build/`).

## 10. Performance budget

Terminal render loop target: 30 fps at 200×60 cells on one core (raycast
≈ 1 ray per column, floor rows per cell, quantize 12k cells, diff-paint).
Never block the loop on the bridge: input requests resolve asynchronously.
