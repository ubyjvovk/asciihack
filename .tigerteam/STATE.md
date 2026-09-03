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
- `muse` lane (pi → OpenRouter meta/muse-spark-1.3-contributor, C2, scale 1)
  was added by the user 2026-09-03 to test it on T-0007 (`assignee: muse`);
  the supervisor spawns it when T-0007 becomes claimable (after T-0004). Needs `OPENROUTER_KEY` in `.env` (present) and the OpenRouter
  privacy setting that allows paid-model training.
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
  MCP on 8765 (defaults). `[pm] nudge = true` (push_digests off): the supervisor
  types a nudge into the PM pane; the PM then reads/consumes the digest with
  `tigerteam events --wait` (returns immediately when a backlog exists) —
  keep exactly one armed in the background.
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
- 2026-09-03 23:20 — **T-0016 accepted; board drained, 16/16 done.** Master:
  166 tests, tsc clean. Deliverable state: `npm start` = first-person
  NetHack with textured walls, F3 ortho, F1 classic, F4 minimap, F5 themes;
  `docs/ssh.md` for ssh serving. Total engine spend ≈ $24 (of which $23 the
  opus bridge ticket); muse lane baked well.
- 2026-09-03 23:00 — T-0015 (polish: Saving... auto-dismiss + farewell) and
  T-0014 (ssh: bin/asciihack-login, scripts/ssh-serve.sh, docs/ssh.md)
  accepted; 15 done. `--playground` now means the per-player target dir
  (copied from the build on first use). Doc debt: docs/ui.md CLI section
  still describes the old --playground meaning (fold into the next UI
  ticket). In progress: T-0016 (surface detail, ds-1, ~30 min).
- 2026-09-03 22:15 — **T-0007 accepted: fps + ortho modes playable** (muse,
  2 attempts, $0.11 + rework). 13 done. `npm start` = first-person NetHack.
  In progress: T-0016 (surface detail, ds-1). Claimable: T-0014 (ssh),
  T-0015 (polish).
- 2026-09-03 21:50 — T-0007 (muse lane, first bake): fps + ortho modes work
  in the PM playtest; reworked once for 45° turns (PM's acceptance line was
  inconsistent with the Context — muse flagged it) and the obsolete classic
  placeholder test. muse: 31 min, $0.11, honest report, solid code — keep
  at C2, consider scale 2. Flat untextured walls look like a uniform block
  up close → T-0016 (procedural textures, floor grid, door frames).
- 2026-09-03 21:20 — **T-0004 accepted: NetHack is playable in classic mode
  through our stack** (PM playtested in tmux: intro text overlay, messages,
  movement, inventory menu, save, restore, exit 0). 12 done. Supervisor
  restarted 19:09 with OPENROUTER_KEY; T-0007 (fps+ortho, assignee muse) is
  now claimable. UI polish backlog for a later ticket: yn overlay prints
  `[]` for the default when it is a control char; menu cancel should send
  ret −1 (needs a session path); consider auto-dismissing the final
  `--More--` when the bridge has already exited.
- 2026-09-03 20:35 — T-0003 (engine client) accepted after two reworks
  (raw_print → messages, answer() guard, switch fall-through); T-0012
  (window_inited) and T-0013 (tsc fix) accepted. 11 done. Master type-checks
  and passes 88+ tests. T-0004 (classic UI) is now claimable; T-0007 waits
  on it. Wave-3 candidates: ssh serving, lit/dark rooms, message history.
- 2026-09-03 19:40 — T-0010 (bridge hardening) and T-0011 (themes gloom/
  solarized/amber) accepted; 8 done. T-0003 (engine client) still with
  opus-1. T-0004 next; then write T-0007 (fps mode) against T-0004's mode
  interface.
- 2026-09-03 19:05 — T-0002 (bridge, opus, ~$?) and T-0008 (ortho) accepted;
  6 done. T-0003 claimed by opus-1. Host has `build/nethack/{lib,bridge}`
  built and the smoke passing. architecture.md §3 now carries the as-built
  facts + bridge hardening backlog.
- 2026-09-03 18:20 — T-0006 accepted after one rework; its leftover edge
  (private copy not reallocated on grid growth) filed as T-0009 (C1). T-0008
  (ortho renderer) claimed by ds-3. T-0002 (bridge) still with opus-1 (~25 min).
  Supervisor quirk: idle lanes exit after 8×15 s; a newly eligible ticket then
  waited 5 min unclaimed until a busy lane freed up — if that recurs, run
  `tigerteam worker run ds --once` by hand.
- 2026-09-03 18:00 — T-0005 accepted after one rework (buffer pre-fill). T-0006
  reworked once (Screen.paint aliasing, UTF-8 wedge, unknown CSI leak); ds-3
  on it. T-0002 with opus-1 (~10 min in). Spend ≈ $0.15.
- 2026-09-03 17:35 — T-0001 accepted (build scripts; vanilla NetHack 5.0 verified
  playable in a pty by the PM). T-0005 reworked once (stale overlay plane +
  unpainted horizon row for odd heights). T-0002 claimed by opus-1, T-0006 by
  ds-3. Spend so far ≈ $0.11.
- 2026-09-03 16:55 — wave 1 planned: T-0001 (build scripts, P0) → T-0002
  (C bridge, P0/C3 frontier) → T-0003 (TS engine client) → T-0004 (classic
  terminal UI, also needs T-0006); T-0005 (raycaster) and T-0006
  (quantizer/screen/input) run in parallel from the start. Nothing accepted
  yet.

## Next actions
- Wave 4 needs a user decision before planning: browser build as static
  WASM (emscripten build of libnethack + three.js/AsciiCity styles, no
  server) vs thin client (browser talks WebSocket to the native bridge on
  a host). Candidate wave-3b tickets meanwhile: ortho textures; lit/dark
  room lighting (needs a `lit` flag on MapCell — PM type change); tutorial
  prompt handling in the UI; docs/ui.md `--playground` doc sync;
  `nethack-build.sh` excluding the submodule's `.git` file from src-tree;
  message history overlay polish; performance pass on the 215-col loop.
0a. (done 19:09) Before T-0007 can be claimed (i.e. right after accepting T-0004 while no
    attempt runs): restart the supervisor so it loads `OPENROUTER_KEY`
    (`.env` changed 18:36, supervisor started 17:03) — `tigerteam down
    --keep-services`, then `tmux split-window -v -t tigerteam-asciihack:0.1 -c
    /home/d/asciihack 'tigerteam up'`. Then the muse lane (scale 1) claims
    T-0007 on its own.
0. Review checklist addition (2026-09-03): run `npx tsc --noEmit` (or
   `bash scripts/check.sh`) in the worktree before accepting any ticket that
   touches TypeScript — vitest does not type-check, and T-0009 slipped a
   TS2345 through (fixed by T-0013).
1. Review T-0006 and the T-0005 rework when they land.
2. Note for T-0004/T-0007: `libnethack.a` bakes `SYSCF_FILE` and `HACKDIR`
   as absolute paths into `build/nethack/lib/playground/`; the bridge's
   playground copy under `~/.asciihack/` must keep the build dir's `sysconf`
   reachable (or pass `-d`/`NETHACKDIR` and confirm SYSCF still resolves).
   Also `nethack-build.sh` copies the submodule's `.git` file into src-tree
   (harmless; exclude it in a later cleanup).
3. (done) §3 reconciled with `docs/bridge.md`; T-0003's Context carries
   the live-bridge observations.
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
