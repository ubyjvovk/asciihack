# asciihack

Play real NetHack 5.0 in a terminal, rendered as coloured-ASCII: a
first-person view (raycaster) or an ortho/isometric view by default, with
the classic top-down map as a mode and a minimap.

## Build

The client is TypeScript on Node 22+ (zero runtime dependencies). NetHack is a
git submodule built out-of-tree into `build/`.

```
# once: populate the submodule (also done by the build script if needed)
bash scripts/nethack-src.sh

# build the NetHack library, then the JSON bridge binary
bash scripts/nethack-build.sh lib
bash scripts/nethack-build.sh bridge
```

Each build is idempotent and safe to re-run; `lib` needs network once to fetch
Lua.

## Play

```
npm start -- --name=tester
```

The first run copies the bridge's playground to `~/.asciihack/playground` so
your saves persist and the build directory stays clean.

## Flags

| flag | default | meaning |
|---|---|---|
| `--mode=` | `fps` | `classic`, `fps` or `ortho` |
| `--theme=` | `cyber` | render theme for fps/ortho: `cyber`, `gloom`, `solarized`, `amber` |
| `--no-minimap` | – | hide the minimap overlay in fps/ortho |
| `--name=` | `asciihack` | character name |
| `--bridge=` | `build/nethack/bridge/nh-bridge` | path to the bridge binary |
| `--playground=` | `build/nethack/bridge/playground` | source dir copied to `~/.asciihack/playground` on first run |
| `--options=` | – | extra `NETHACKOPTIONS` (comma-separated) |

## Key bindings

- **Classic mode**: every key goes straight to NetHack (`hjkl` to move, `i`
  inventory, `S` save, `#` extended commands, …).
- **Fps mode**: `Left`/`Right` turn, `Up`/`Down` walk forward/back, `Shift`+arrows
  strafe; typing a vi-key (`hjklyubn`) moves that way and turns to face it.
- **Ortho mode**: arrows are plain moves (`h`/`l`/`k`/`j`); vi-keys work too.
- `F1` classic · `F2` fps · `F3` ortho · `F4` toggle minimap · `F5` cycle theme
  (cyber → gloom → solarized → amber).
- `Ctrl+L` redraw.
- `Ctrl+P` show the last 20 messages.
- `--More--`: any key continues.

Menus, text windows, `yn`/`getlin` prompts and extended-command lines appear as
boxed overlays centred on the viewport.

## Layout

- `src/engine/` — bridge process + `NethackSession` model.
- `src/ui/` — the app shell, classic/fps/ortho modes, minimap, overlays,
  status rows (see `docs/ui.md`).
- `src/term/` — screen writer, key parser, real tty adapter.
- `docs/` — architecture and per-module notes (`docs/architecture.md` first).

## Test

```
bash scripts/test.sh            # unit tests (vitest)
bash scripts/check.sh           # full gate: typecheck + unit + build + bridge smoke
```
