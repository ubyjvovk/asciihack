# AsciiHack

Play real **NetHack 5.0** in your terminal, rendered as coloured ASCII: a
first-person view in the style of [AsciiCity](https://github.com/ubyjvovk/asciicity),
an isometric view, and the classic map. Works locally and over ssh.

![First-person view of the starting room: brick walls in perspective, the
stairs, the kitten, the compass ribbon and the minimap](docs/screenshot-fps.png)

*The starting room, facing west. Top: message line and compass ribbon.
Top-right: minimap with the hero as a facing arrow. Bottom: NetHack's
status lines.*

![Isometric view of the same room: raised brick walls with lit tops and
shaded faces, the hero and the kitten as figures, a faint lattice over
unexplored space](docs/screenshot-ortho.png)

*The same room in the ortho view (`F3`). Tiles scale with the terminal so
the hero stays about a seventh of the screen height.*

## What it is

- **Unmodified NetHack.** The game is the `nethack/` git submodule, built
  natively as `libnethack.a` with NetHack's own "shim" window port. Every
  rule, item, monster and message is the real thing; saves are real NetHack
  save files.
- **A small C bridge** (`bridge/nh-bridge.c`) turns the window-port
  callbacks into JSON lines on stdin/stdout.
- **A TypeScript client** (Node 22+, no runtime dependencies) keeps the map
  model and renders it: a CPU raycaster with procedural brick textures,
  floor grids and door frames for the first-person view; an isometric
  "brick" projection for the ortho view; the classic 80×21 map as a mode
  and as a minimap. Four looks ported from AsciiCity's shaders: cyber,
  gloom, solarized, amber.

Status (September 2026): playable end to end in all three modes, with
textured walls, shaped sprites, unknown space rendered as darkness, a
compass, opaque menu panels and a zoomable 3/4 ortho view. In progress:
cutaway walls so the hero is never hidden in the ortho view. The browser
build that reuses AsciiCity's three.js styles is not started.

## Build

```sh
bash scripts/nethack-src.sh          # populate the submodule (once)
bash scripts/nethack-build.sh lib    # NetHack as a library (needs network once, for Lua)
bash scripts/nethack-build.sh bridge # the JSON bridge binary
npm install
```

Builds are out-of-tree under `build/` and idempotent. The plain console
game is also there if you want vanilla NetHack:
`bash scripts/nethack-build.sh tty && bash scripts/nethack-play.sh`.

## Play

```sh
npm start -- --name=mia            # first-person view (default)
npm start -- --mode=ortho          # isometric
npm start -- --mode=classic        # the classic map
```

The first run copies NetHack's playground to `~/.asciihack/playground`, so
saves persist across builds. Terminal: at least 80×24, 24-bit colour.

| flag | default | meaning |
|---|---|---|
| `--mode=` | `fps` | `fps`, `ortho` or `classic` |
| `--theme=` | `cyber` | `cyber`, `gloom`, `solarized`, `amber` |
| `--no-minimap` | – | hide the minimap in fps/ortho |
| `--name=` | `asciihack` | character name |
| `--playground=` | `~/.asciihack/playground` | per-player NetHack directory |
| `--options=` | – | extra `NETHACKOPTIONS`, comma-separated |
| `--bridge=` | `build/nethack/bridge/nh-bridge` | bridge binary |

### Keys

- **First-person**: `Left`/`Right` turn 45°, `Up`/`Down` walk forward and
  back, `Shift`+`Left`/`Right` strafe. A vi-key (`hjklyubn`) moves that way
  and turns to face it. Everything else goes straight to NetHack.
- **Ortho**: arrows are plain moves; north is up-right on screen (see the
  rose in the corner).
- **Classic**: every key goes to NetHack.
- `F1` classic · `F2` first-person · `F3` ortho · `F4` minimap · `F5` theme ·
  `Ctrl+P` message history · `Ctrl+L` redraw.

Menus, text windows, prompts and `--More--` pauses are NetHack's own,
drawn as overlays.

## Play over ssh

`ssh play@host mia` drops straight into the game as `mia`, with her own
playground; without a name it asks. `bin/asciihack-login` is the login
shell, `scripts/ssh-serve.sh --check` prints the `sshd_config` block, and
[`docs/ssh.md`](docs/ssh.md) is the operator walk-through.

## How it works

`docs/architecture.md` is the design contract: the bridge protocol
(§3), the map model (§4), the renderers (§5), the terminal layer (§6).
Per-module notes: `docs/bridge.md`, `docs/engine.md`, `docs/render.md`,
`docs/terminal.md`, `docs/ui.md`, `docs/nethack-build.md`.

```
nethack/      NetHack 5.0 submodule (never modified, built out-of-tree)
bridge/       nh-bridge.c — shim window port → JSON lines
src/engine/   bridge process, NethackSession model, glyph classification
src/render/   raycaster, ortho renderer, textures, ASCII quantizer, themes
src/term/     screen writer (diff-painting ANSI), key parser, tty adapter
src/ui/       app shell, modes, overlays, minimap, compass
bin/          ssh login wrapper
```

Tests: `bash scripts/test.sh` (vitest, no C build needed);
`bash scripts/check.sh` runs typecheck, unit tests, build, the NetHack
library and bridge builds and a bridge smoke. Screenshots for this README
come from `scripts/term-shot.py` over a `tmux capture-pane -e` dump.

## Credits

NetHack is © the NetHack DevTeam, distributed under the NetHack General
Public License (see `nethack/dat/license`). The render look and the
ASCII quantizer formulas come from [AsciiCity](https://github.com/ubyjvovk/asciicity).
The project is built with a [tiger team](.tigerteam/) of cheap-model
workers directed by a PM; the ticket history is in `.tigerteam/board/done/`.

© 2026 [@ubyjvovk](https://github.com/ubyjvovk). License for this
project's own code: to be decided.
