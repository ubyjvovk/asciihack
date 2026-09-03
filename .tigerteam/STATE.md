# Tiger Team state

Written for a cold-start PM who has read nothing else. Keep it current: update
after every review cycle and before ending any session, then commit.

## Mission
Play real NetHack 5.0 in a terminal (locally or over ssh) rendered as an ASCII
first-person view (raycaster, AsciiCity look) or an ortho/isometric view, with
the classic map as a mode and minimap. Later: a browser build reusing
AsciiCity's three.js render styles. "Done" for wave 1 = `npm start` plays
NetHack in classic mode through our own stack; wave 2 = fps and ortho modes
playable; wave 3 = ssh deployment + render styles; wave 4 = browser.

Design contract: `docs/architecture.md` (PM-owned). PM-owned code:
`src/model/types.ts`, `src/engine/protocol.ts`, `package.json` + lockfile,
`AGENTS.md`.

## Configuration notes
- Mode: single-branch (accepts merge into `master`; no staging worktree).
- Fleet (`tigerteam.toml`): `opus` ×2 (claude login_auth, C3, `frontier`),
  `ds` ×4 (pi → DeepSeek V4 Flash on DeepInfra, C2), `grok` ×0 (C3,
  `frontier`, parked). `max_concurrent = 8`. Copied from the asciicity board.
- Secrets in `<root>/.env` (copied from ~/asciicity: DEEPINFRA_KEY,
  GITHUB_TOKEN). The supervisor must be restarted after `.env` changes.
- `test_cmd = bash scripts/test.sh` (vitest; self-installs node_modules);
  `verify_cmds = bash scripts/check.sh` (typecheck + unit + build; the
  NetHack lib/bridge stages get appended by T-0002).
- Worker image `tigerteam-agents:base`: node 22, gcc 12, make, ncurses-dev,
  git, network; no docker, no emscripten. Host: node 24, docker (an
  `emscripten/emsdk:latest` image is pulled but unused — WASM was rejected
  for the console build, see decision log).
- GitHub: `[github] repo = ubyjvovk/asciihack`, `sync = true`, `watch = false`.
- The cockpit tmux session is `tigerteam-asciihack`; web on 127.0.0.1:8787,
  MCP on 8765 (defaults). `[pm] nudge = true` → push mode: read digests from
  `.tigerteam/digests/` via `tigerteam events --latest`; never arm
  `events --wait`.
- `nethack/` is a git submodule (NetHack-5.0 branch, commit 04834a931,
  2026-09-01). Worktrees get it via `scripts/nethack-src.sh` (T-0001).

## Decision log (append-only)
- 2026-09-03 — Engine integration = native `libnethack.a` (NetHack's own
  `SHIM_GRAPHICS` window port, `make WANT_LIBNH=1`) + a small C bridge
  speaking JSON lines, not the emscripten/WASM build — the user asked "why
  WASM on a Linux host"; native needs no emsdk, keeps real save files, and
  the TS client consumes the same shim call stream either way (WASM can be
  added later for a static browser build).
- 2026-09-03 — Client in TypeScript on Node (zero runtime deps), not C: the
  renderer/model code is meant to be shared with the browser build that
  reuses AsciiCity's TypeScript render styles; Node behind an ssh login
  shell is fine.
- 2026-09-03 — Terminal first ("console build first", user). Browser wave
  comes after fps + ortho work in the terminal.
- 2026-09-03 — NetHack is a submodule pinned at the NetHack-5.0 branch head
  (has the June-2026 shim fixes; the 5.0.0 release tag is 577 commits
  behind). Never modified; builds are out-of-tree copies under `build/`.
- 2026-09-03 — PM wrote the scaffold (package.json, tsconfig, vitest,
  scripts/test.sh, scripts/check.sh, PM-owned types) so preflight passes
  before the first ticket.

## Board snapshot
- 2026-09-03 16:55 — wave 1 planned: T-0001 (build scripts, P0) → T-0002
  (C bridge, P0/C3 frontier) → T-0003 (TS engine client) → T-0004 (classic
  terminal UI, also needs T-0006); T-0005 (raycaster) and T-0006
  (quantizer/screen/input) run in parallel from the start. Nothing accepted
  yet.

## Next actions
1. Smoke one worker (`tigerteam worker run ds --once` on T-0005/T-0006),
   check the report lands in review/ sanely, then `rm .tigerteam/STOP`.
2. Review T-0001 as soon as it lands (the whole chain waits on it); run
   `bash scripts/nethack-build.sh tty` on the host and actually play a few
   turns of the console game.
3. After T-0002: reconcile `docs/architecture.md` §3 with `docs/bridge.md`
   deviations before T-0003 starts (T-0003 is told to follow the bridge).
4. Wave 2 tickets to write once T-0004 + T-0005 land: T-0007 fps mode
   (viewport painter + controls §6.4 + minimap overlay), T-0008 ortho
   renderer + mode (§5.3), T-0009 ssh serving (`ForceCommand`/login-shell
   script + docs), T-0010 render styles (gloom/amber/matrix in the
   quantizer), T-0011 lit/dark room lighting from NetHack glyph info.

## How to resume
1. Read this file.
2. `tigerteam status` (or `bash .tigerteam/scripts/board-status.sh`).
3. `tigerteam events --latest` — process review/ first (oldest first), then
   blocked/.
4. `git worktree list` — tigerteam/* entries are unmerged ticket branches.
5. Workers: the supervisor runs in the cockpit (`tigerteam up`); `touch
   .tigerteam/STOP` drains it, `rm` resumes.
6. Continue planning from Next actions.
