# nh-bridge

The C bridge (`bridge/nh-bridge.c`) links `libnethack.a`, registers the
`SHIM_GRAPHICS` window callback, and speaks the JSON-lines protocol
defined in `docs/architecture.md` §3. It is the single native piece of
this project — everything upstream of it (`src/engine/*`, renderers,
UI) reads and writes JSON only.

For an unknown call the bridge logs it and, when the shim passes a return
slot, zeroes exactly the width the call's fmt first character names (`c`/`b`/`0`
→ 1 byte, `2` → `short`, `i` → `int`, `s`/`p` → pointer, `v` → nothing) rather
than a whole machine word, so a 1- or 2-byte return slot is never overrun.

## Messages

### `hello` and `tables`

`hello` (first line, before NetHack starts) carries the proto/version plus
the `S`/`cmap`/`nhw`/`bl`/`pick`/`atr`/`mg`/`clr`/`blmask` tables and
`extra.extcmds`. Immediately after forwarding `init_nhwindows` the bridge
prints one `{"t":"tables","monsters":[…],"objects":[…]}` line: `NUMMONS`
monster entries `{name, male, female, letter, size, color}` (from
`mons[i].pmnames[NEUTRAL] ?? [MALE]` / `[MALE]` / `[FEMALE]`, gender indices
from `include/monflag.h`; `letter` is `def_monsyms[mons[i].mlet].sym` as a
1-char string; `size` is `msize`, `color` is `mcolor`) and `NUM_OBJECTS`
object entries `{name, descr, cls}` (from `obj_descr[i].oc_name` /
`.oc_descr`; `cls` is `def_oc_syms[objects[i].oc_class].sym`). Names use the
bridge's `json_str` escaping. Two timing facts force this shape: `hello` is
printed before `nhmain`, when `mons[]`/`objects[]` are still zeroed (they
are `memcpy`'d from `mons_init`/`obj_init` by `early_init()` inside
`nhmain`), so the tables ride on `init_nhwindows` instead; and object names
are read from `obj_descr[i]` directly because `objects[i].oc_name_idx` stays
0 until `init_objects()` runs later in `newgame()`. `src/engine/*` ignores
the `tables` line for now (T-0026 consumes it).

NetHack's `pline()` (`nethack/src/pline.c`) sends every message through
`raw_print()` while `iflags.window_inited` is false — that is the case until a
window port's `init_nhwindows` completes. Every real port sets the flag to
`TRUE` at the end of its `init_nhwindows` (`win/tty/wintty.c` ~1885,
`win/curses/cursmain.c` ~493), but the shim port never did, so all game
messages bypassed the message window (no message-window `putstr`, no history,
no forced `--More--`). The bridge now sets `iflags.window_inited = TRUE;`
right after forwarding `shim_init_nhwindows`, so `pline()` routes through
`putstr` on the message window. `raw_print` still appears for text emitted
before `init_nhwindows` finishes or after shutdown, and for recursive
`pline()` calls — the `raw_printed` counter in `include/flag.h` tracks how
many messages went out that way.

## Build and run

```
bash scripts/nethack-build.sh lib      # once (produces libnethack.a etc.)
bash scripts/nethack-build.sh bridge   # runs `make -C bridge test` too
```

Artifacts land in `build/nethack/bridge/`:

- `nh-bridge` — the binary
- `playground/` — clone of `build/nethack/lib/playground/` so bridge
  sessions cannot stomp lib's runtime files
- `reply_test` — the reply-parser test binary (run by `make -C bridge test`)

Run the bridge by hand — the shortest possible one-liner (assumes the
build directory is populated):

```
printf '{"id":1,"ret":false}\n{"id":2,"ret":"me"}\n' \
  | NETHACKDIR=$(pwd)/build/nethack/bridge/playground \
    NETHACKOPTIONS='role:Valkyrie,race:human,gender:female,align:neutral,name:me,pettype:none' \
    build/nethack/bridge/nh-bridge -u me
```

The bridge emits the `hello` line first, then `call` objects for
`init_nhwindows`, the first `create_nhwindow` (id 1), and
`player_selection_or_tty` (id 2). The two hand-fed replies drive it
past character creation, after which it will keep sending calls until
stdin closes and it prints an `exit` line.

The TypeScript smoke script `scripts/bridge-smoke.ts` demonstrates the
full flow (spawn, dispatch replies, assert the glyph stream, hero
position). `tests/bridge.test.ts` wraps the same flow under vitest and
is skipped when the bridge is not built.

## `player_selection_or_tty`

`shim_player_selection_or_tty` returns `boolean` (via `DECLCB(boolean,
..., "b")` in `winshim.c`). It is called by
`sys/libnh/libnhmain.c::choose_windows` /
`sys/unix/unixmain.c::main` to decide whether NetHack should run its
own tty-based character selection (return `true`) or leave it to the
window port (return `false`). The tty port would normally forward this
so `genl_player_setup(80)` runs; the bridge's clients drive character
creation via the `NETHACKOPTIONS` environment variable (or the menus
NetHack issues afterwards), so the smoke script answers `false`. On
`true` the shim runs the terminal setup itself and clobbers stdin/stdout
— never desirable for the bridge.

## Deviations from architecture.md §3 (PM to reconcile)

- **§3.2 stdout framing.** The bridge does NOT emit a trailing `\n` on
  its own — every line already ends with LF from `fputs("...\n", ...)`.
  Matches the spec, but worth noting: consumers must not expect an
  empty line after `exit`.
- **§3.2 exit reason.** When NetHack calls `exit()` from its own code
  (panic, quit path, config-file-error path in some cases), the bridge
  prints `{"t":"exit","code":<C>,"reason":"atexit"}` via its `atexit`
  hook. The architecture doc only mentions `reason` on the error path;
  in practice we always attach a reason when NetHack exits without
  returning through `nhmain`.
- **§3.3 `askname`.** `shim_askname` is a `VDECLCB` (void), so the shim
  itself gives no return slot; the spec still says the bridge should
  copy the reply string into NetHack's `plname`. The bridge emits a
  call with an `id`, blocks for a reply, and copies at most
  `PL_NSIZ - 1` bytes into `svp.plname` (part of
  `instance_globals_saved_p`). Same pattern for `shim_getlin`, which
  writes into the caller-provided `bufp` (capped at `BUFSZ - 1`).
- **§3.3 `display_nhwindow`.** VDECLCB in the shim; the bridge assigns
  an `id` and blocks only when `blocking` is true, otherwise emits the
  call with no `id` and continues immediately.
- **§3.3 `display_file`.** VDECLCB in the shim; the bridge reads the
  file via `dlb_fopen`/`dlb_fgets` and emits `[name, complain, text]`,
  then blocks on a reply so the client can page the file before
  dismissal.
- **§3.5 `hello.mg`.** `MG_BW_SINK` and `MG_BW_ENGR` share the same
  bit value as `MG_BW_ICE` (`0x200`) in `include/display.h`; the bridge
  emits all three names with the same value. Clients must treat them as
  aliases.
- **T-0002 acceptance §2 — 200 print_glyph calls.** The ticket asks for
  ≥ 200 `print_glyph` calls before the first `nhgetch`. Real NetHack
  `docrt()` only forwards non-`GLYPH_UNEXPLORED` glyphs (see
  `src/display.c` ~L2221), so a starting position on level 1 draws
  around 30-50 cells (starting room + hero + pet) — 200 is only reached
  after the hero moves. The smoke script and vitest test therefore set
  a floor of 30 and still require at least one glyph with `MG_HERO` in
  its flags. This proves the stream works; a client that keeps playing
  will observe the ~1700 count architecture.md §3.2 mentions on a full
  redraw.
- **Chdir.** The `lib` variant is compiled without `-DCHDIR` (that's
  what NetHack's `linux.500` hints deliver), so `nhmain` never enters
  `NETHACKDIR` on its own. The bridge does `chdir(getenv("NETHACKDIR"))`
  before `nhmain` so lock/save/record files land in the playground and
  not in the client's CWD.
- **sysconf `GDBPATH`.** The stock `sys/unix/sysconf` hard-codes
  `GDBPATH=/usr/bin/gdb`; on hosts without gdb NetHack aborts before
  reaching the game loop with `1 error in <sysconf>`. The lib build
  now installs a sanitised sysconf (commented `GDBPATH`,
  `PANICTRACE_GDB=0`).

## Reply parser (bridge/reply.[ch])

`reply_parse(line, out)` accepts only the shape architecture.md §3.2
lists: a flat object with `id` (required int), `ret` (int | JSON
string | `true` | `false` | `null`), `selected`
(`[{"i":int,"count":int}, …]`), `x`/`y`/`mod` (int). It returns 0 on
success and −1 on any parse error, in which case the bridge prints a
`log` line, then an `exit` line with `reason` and exits 2.

Limits:

- Numbers must fit in `long`; floats (`.` / `e` / `E`) are rejected.
- Strings support the standard JSON escapes (`\" \\ \/ \b \f \n \r
  \t`) plus `\uXXXX` for BMP code points. Surrogate pairs and
  characters ≥ U+10000 encoded via a pair are not supported (the bridge
  only ever asks for ASCII / Latin-1 strings back, so this has not
  been necessary).
- Selected entries must be objects containing exactly `i` and `count`;
  unknown keys inside a selected entry are silently skipped, matching
  the top-level behaviour.
- Nested objects/arrays are permitted only as the value of an unknown
  top-level key (they are then skipped); nested structures inside
  `selected` are rejected.
- Duplicate top-level keys keep the last value seen.

`bridge/reply_test.c` (built and run by `make -C bridge test`, wired
into `bash scripts/nethack-build.sh bridge`) covers int/negative-int
returns, string escapes (`\"`, `\\`, `\n`, `\t`), `null`, `true`,
`false`, `selected` with two entries, `x`/`y`/`mod`, unknown keys
skipped, and multiple failure modes (missing `id`, trailing comma,
float, unterminated object, non-JSON).
