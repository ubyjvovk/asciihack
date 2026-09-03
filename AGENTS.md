# Agent orientation

<!-- Maintained by the Tiger Team PM. Workers and agent CLIs read this first;
     workers never edit it. -->

## What this project is

**AsciiHack** — play real NetHack 5.0 in a terminal (locally or over ssh),
rendered as a coloured-ASCII first-person view (raycaster) or an ortho /
isometric view, with the classic map as a mode and minimap. NetHack itself
is the unmodified `nethack/` git submodule, built as `libnethack.a` with its
own "shim" window port; a small C bridge (`bridge/nh-bridge.c`) turns the
shim's window-procedure callbacks into JSON lines; the TypeScript client
(Node 22+, zero runtime deps) keeps the model, renders and drives the tty.
The design contract is **`docs/architecture.md`** — tickets cite it by
section; read the cited section before writing code, and if the ticket and
the doc disagree, flag it in your report instead of guessing.

## Layout

- `nethack/` — git submodule (NetHack 5.0). **Never edit, never build in
  place**: `scripts/nethack-build.sh` copies it to `build/nethack/<variant>/`.
  In a fresh worktree the directory is empty until
  `bash scripts/nethack-src.sh` (or `git submodule update --init`) runs.
- `bridge/` — the C bridge and its Makefile/tests (architecture.md §3).
- `src/model/types.ts` — PM-owned model types; `src/engine/protocol.ts` —
  PM-owned wire types. Import, do not edit.
- `src/engine/` — bridge process + session model; `src/render/` — pure
  renderers (raycast, ortho, ascii quantizer); `src/term/` — screen writer,
  key parser, tty adapter; `src/ui/` — modes and overlays; `src/cli.ts`.
- `tests/` — vitest, `tests/<module>.test.ts`; `tests/fixtures/` (recorded
  bridge streams, synthetic levels). `docs/` — architecture + module notes.
- `scripts/` — `test.sh` (unit entry), `check.sh` (full gate),
  `nethack-*.sh` (submodule checkout, builds, play the plain tty game).
- `build/` — gitignored build outputs (`build/nethack/{tty,lib,bridge}/`).

## Conventions

- TypeScript `strict`, ESM with NodeNext resolution: **relative imports end
  in `.js`** (`import { x } from '../model/types.js'`). Named exports only,
  no `export default`, no `any` (use `unknown` + narrowing). Node 22 APIs
  only (the worker image has node 22; the host has 24).
- Pure logic is separated from I/O: renderers and parsers take/return plain
  data and are unit-tested in node; tty/process wrappers are thin and
  injectable (`TermIO`, spawn function) so tests use fakes.
- No runtime npm dependencies. `package.json`/lockfile are PM-owned: need a
  package → block with a `## Questions` entry, never `npm install <pkg>`.
- C (bridge): C99, `-Wall -Wextra -Werror`, no JSON library, compile with
  the same CFLAGS as `libnethack.a` (struct layouts depend on them).
- Tests: vitest `describe/it/expect`, one file per module, numbers via
  `toBeCloseTo`. Every ticket lists the cases its tests must cover — cover
  them all, by name, so the reviewer can find them. Tests must not need
  the C build unless guarded with `describe.skipIf(!bridgeBuilt)`.
- Docs: a one-line JSDoc on every exported function/class; each ticket
  names the `docs/*.md` file to write or update.
- Commits: `[T-NNNN] <title>`, only files inside the ticket's scope.

## Config

- Project config is root `tigerteam.toml` (optional `~/.tigerteam.toml` for
  machine-local facts).
- `test_cmd = "bash scripts/test.sh"` — the runner injects it as
  `TIGERTEAM_TEST_CMD`; `run-tests.sh` forwards your path arguments to
  `vitest run`.

## Commands

- Unit tests: `bash .tigerteam/scripts/run-tests.sh [tests/foo.test.ts]` —
  the ONLY way to run tests. The first run in a fresh worktree does `npm ci`
  (10–30 s), then vitest.
- Full gate: `bash scripts/check.sh` — install → `tsc --noEmit` → vitest →
  `tsc` build (+ NetHack/bridge stages once they land). Run it before
  finishing any ticket that touches build/config files or `src/cli.ts`.
- NetHack: `bash scripts/nethack-build.sh tty|lib|bridge` (out-of-tree,
  idempotent, ~2 min; needs network once for Lua). Plain console game:
  `bash scripts/nethack-play.sh`. Our client: `npm start -- --mode=classic`.

## Landmarks & gotchas

- A fresh worktree has no `node_modules` and an **empty `nethack/`**;
  `scripts/test.sh` installs from the lockfile automatically, and
  `scripts/nethack-src.sh` populates the submodule (do not `npm install`
  or `git clone` by hand).
- The shim window port is `nethack/win/shim/winshim.c`; the reference
  implementation of every window proc is `nethack/win/tty/wintty.c`, the
  semantics `nethack/doc/window.txt`. Glyph classes come from the
  `glyph_is_*` macros in `nethack/include/display.h`; symbol indices from
  `nethack/include/defsym.h` (X-macro file — read its header comment).
- Coordinates: map `x` = column (1..79, east), `y` = row (0..20, south);
  `Pose.yaw` 0 = north, +π/2 = east. Getting the y sign wrong mirrors the
  whole dungeon — see architecture.md §7.
- A terminal cell is twice as tall as wide; renderers must aspect-correct
  (architecture.md §5.2).
- The bridge is single-threaded: exactly one outstanding request at a
  time; never send a reply NetHack did not ask for.
- Worker containers have gcc 12, make, ncurses-dev, node 22, git, network;
  no docker, no emscripten.
- Visual-verification steps: if your model cannot view a rendered frame,
  verify through the golden ASCII dumps and say so in the report — the PM
  does the eyeball review. Never fail a ticket over that.
