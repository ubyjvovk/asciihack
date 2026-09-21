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
- 2026-09-21 — Three PM decisions written into `docs/gpu.md` that the
  tickets now cite, each made to stop two workers diverging:
  (1) **§6.1 the grade fights the quantiser** — styled mode keeps AgX,
  split-tone, contrast and saturation but **zeroes vignette and grain** and
  scales the frame by `1/styleExposure` via a new `look.outputScale`, because
  the AsciiCity prelude applies its own exposure 1.7 + `pow(v, 0.45)` and
  per-pixel grain shimmers once it is averaged into cells;
  (2) **§3 the WebGL2 fallback is a first-class path**, measured with
  `/gpu-probe.html`: headless Chromium reaches the WebGPU backend but three
  r185 throws on a `GPUTextureViewDescriptor.swizzle` mismatch, while
  `forceWebGL: true` renders the same TSL graph in ~80 ms at 640×360;
  (3) **torch shadows**: only the two torches nearest the hero cast, the rest
  are lit flat and get their contact darkening from SSGI/AO.
- 2026-09-21 — User: "a sibling project in ~/afterburn has a really really
  cool renderer, pls port it for asciihack; copy code and resources from
  there freely, and make it look as good; prefer opus workers". Decision:
  **port afterburn's WebGPU/TSL stack into the browser viewport**, contract
  written as **`docs/gpu.md`** (PM-owned; tickets cite it). The shape: vendor
  the voxel kit (`web/src/voxel/`), port renderer + post pipeline + voxel
  material + moods (`web/src/gpu/`), bake the dungeon as voxels, and compose
  the GPU frame into the *untouched* vendored AsciiCity style pass by blitting
  its canvas through a full-screen quad (a WebGPURenderer cannot run their
  raw GLSL). Hard rules: no new npm dependency (three r185 already ships
  `three/webgpu` + `three/tsl` + the TSL display addons — verified); the
  legacy WebGL path stays as the fallback and serves `needsDepth` styles
  (only `edges`); `?gpu=auto|off|raw`, `?q=`, F8 for raw. Wave: T-0036..T-0040,
  all `capability: [frontier]` (opus).
- 2026-09-21 — **opus lane was dead and the cause was ours**: the board's
  scaffolded `.tigerteam/scripts/in-container.sh` predated tigerteam T-0201
  (prompt off argv → stdin transport), so `docker run` never got `-i` and
  every claude attempt died in 0.6 s with "Input must be provided either
  through stdin or as a prompt argument when using --print". Fixed by
  copying the current asset over the board copy. `ds`/`muse` (pi engine,
  `at_file` transport) were unaffected — which is why only opus broke.
  **Refresh the board shims from the tigerteam assets after upgrading the
  tool.**
- 2026-09-04 — User went to bed with "fix the renderer, then monster/object
  polish, then browser, then idk" and left the browser architecture to the
  PM. Decision: **browser wave = WebSocket thin client first** (browser
  runs the same TS session + a three.js scene rendered through AsciiCity's
  vendored style shaders; a Node `ws` server spawns nh-bridge per
  connection), **static WASM later** as a second transport. Rationale: no
  emscripten risk on the critical path, the bridge protocol is reused
  byte-for-byte, and the rendering work (the bulk) is identical for both.
  AsciiCity's `src/render/*` vendored verbatim to `web/src/asciicity/render/`
  (PM commit); `three`, `ws`, `vite` added to package.json (PM-owned).
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
- 2026-09-21 03:25 — **39 done** (T-0038 moods/material accepted after
  diffing its constants against the vendored source — the only deltas are the
  deliberately-dropped Crystal Hollow block). Running: T-0039 (the dungeon
  bake, the biggest art ticket). **The three ports were proven to compose**:
  `/gpu-probe.html?stack=voxel` builds real kit geometry + the real voxel
  material + a real mood through the ported pipeline and renders the afterburn
  look with zero shader errors — saved as `.tigerteam/shots/reference-torch.png`
  and written up in `docs/gpu.md` §3.1. Numbers that came out of it:
  `PointLight(PAL.lamp, 8, 6, 2)` gives mean luminance 52 / 22.6 % black vs
  the legacy path's 1.5 / 94.8 %; an emissive box alone lights nothing.
  Draft T-0045 (look tuning) is waiting on the PM's eyeball review to fill in
  its table.
- 2026-09-21 03:00 — **38 done**; T-0041 (SSR stochastic gate) landed and was
  verified empirically. The probe work this session is the important part:
  `/gpu-probe.html` now builds the *real* ported pipeline at any tier, and
  proved (a) three r185's `SSRNode` cannot link on the WebGL2 backend unless
  `stochastic: true` (→ T-0041), (b) `GodraysNode` throws unless its light
  casts shadows, (c) TRAA/DOF return an **all-black frame** unless rendering
  is driven from `requestAnimationFrame`, and (d) with those three known,
  `medium`/`high`/`ultra` all build, link and draw. All four are written into
  `docs/gpu.md` §3 and cited by T-0040. Running: T-0038.
- 2026-09-21 02:40 — **T-0036 (voxel kit) and T-0037 (renderer + pipeline)
  accepted; 37 done.** T-0037 took one rework: attempt 1 was written from my
  spec because `~/afterburn` is not mounted in worker containers; attempt 2 is
  a verified line-for-line port (I diffed `QUALITY`, every `createLook`
  default and the whole grade block against the vendored source myself).
  T-0036's worker blocked on the same gap and was right to. Fix: the sources
  are now **vendored at `vendor/afterburn/`** (read-only, committed) and every
  ticket points there. Running: T-0038 (moods/material). Then T-0039 (dungeon
  bake) → T-0040 (wiring). Drafts ready in `.tigerteam/board/drafts/`:
  T-0042 sprites, T-0043 ortho on the GPU path, T-0044 dungeon air.
  Note: only one worker container runs at a time, which is **correct** — the
  wave's `depends_on` chain leaves only one claimable ticket. Revisit the
  `scale = 4` supervisor restart when T-0042/43/44 go in together.
- 2026-09-21 01:50 — T-0035 (raycaster refinement) accepted after
  re-running the full suite in its worktree: 248 pass, docs updated, in
  scope. **35 done.** Queued the afterburn port wave T-0036..T-0040 and
  committed `docs/gpu.md` + the AGENTS.md `web/` layout note. Running:
  T-0036 (opus-1), T-0037 (opus-2). Note on T-0035's tests: the
  `corridor cell beyond a doorway is visible` case measures any cell at
  depth 2..3, which ordinary floor also satisfies — it passes but does not
  actually pin the corridor colour. Not worth a rework; fold a real
  assertion into the next raycaster ticket.
- 2026-09-04 06:40 — T-0032 (browser ortho camera; one rework: per-view
  fog, debug handle `window.__asciihack.gl.debugInfo()`), T-0033 (lattice
  fade + docs), T-0034 (lit/dark rooms) accepted; **34 done, board empty**.
  Browser wave complete for the thin-client transport. Open decisions for
  the user: static WASM build for GitHub-Pages hosting; deploying the ws
  server + ssh on a host; what next.
- 2026-09-04 05:20 — T-0031 accepted after one rework: the browser now
  renders the three.js dungeon through AsciiCity's amber shader (verified
  headless with SwiftShader; page + canvas screenshots). 31 done. Queued:
  T-0032 (browser ortho camera, + F5 repaint nit). Manual `worker run`
  for the claude engine fails here (see memory); rely on supervisor spawns.
- 2026-09-04 04:30 — T-0029 (raycaster tidy) and T-0027 (ortho look; PM
  resolved the golden conflict by regenerating on master) accepted; 30
  done. README screenshots refreshed in the amber look. Running: T-0031
  (WebGL viewport, opus-2). Queued: T-0032 (browser ortho). Polish notes
  for a later ortho pass: the unexplored lattice fades with the fog
  (visible only ~8 cells around the hero); consider a weaker fog for it.
- 2026-09-04 03:45 — T-0024, T-0028, T-0026 (PM fixed a `!` in its test),
  T-0030 (browser scaffold; verified with Playwright from ~/asciicity's
  chromium) accepted; 28 done. PM hotfix after the T-0030 merge: `loadTiles`
  is now a static JSON import in `src/render/tiles.ts` (browser-clean;
  `tsconfig resolveJsonModule`), because T-0026's callers used the loader
  T-0030 had moved to Node-only `src/tiles-load.ts`. Running: T-0027 (ortho
  look, muse), T-0029 (raycaster tidy, opus-2). Claimable: T-0031 (WebGL
  viewport). README screenshots still pre-look — refresh after T-0029.
- 2026-09-04 02:10 — T-0022 (cutaway), T-0025 (tile data, muse), T-0023
  (readable look: fixed vertical FOV + horizon 0.42, dark stone surfaces,
  absolute-brightness edges, flagstone floor, fog 0.28) accepted; 24 done.
  Running: T-0024 (FOV keys, settings, amber default), T-0026 (tile-shaped
  size-classed sprites). Queued: T-0027 (ortho look). `events --wait` gets
  killed externally now — rely on the supervisor nudges.
- 2026-09-04 01:00 — T-0020 reinstated + merged (user), T-0021 (ortho v2)
  accepted; 21 done. README screenshots refreshed (fps + new ortho) and
  pushed. Queued: T-0022 (ortho cutaway). Board otherwise empty; browser
  wave still awaits the user's WASM-vs-thin-client decision.
- 2026-09-04 00:20 — T-0019 (opaque panels, muse, fast and clean) and T-0017
  (veil for the unknown + shaped sprites) accepted; 19 done. T-0021 (ortho
  v2) claimable. TODO after T-0021: refresh docs/screenshot-fps.png (kitten
  now a figure) + add an ortho screenshot, push.
- 2026-09-03 23:50 — T-0018 (compass/minimap arrow/rose) accepted; T-0020
  (resize repaint) cancelled by the user after landing (record in drafts/,
  branch deleted). README rewritten with docs/screenshot-fps.png
  (scripts/term-shot.py renders tmux colour captures); pushed to GitHub.
  In progress: T-0017 (darkness + shaped sprites, ds-1). Queued: T-0019
  (opaque panels, muse). Draft T-0021 (ortho v2: zoom, 3/4 walls, lattice)
  to promote after updating architecture §5.3.
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
- **Queued as drafts, promote after T-0040 lands** (in this order):
  T-0045 look tuning (fill its table from the eyeball review first),
  T-0046 chunked dungeon rebuild — *this one matters*: `DungeonScene`
  rebakes the whole level on any cell-kind change, which in NetHack is almost
  every step while exploring, so a ~50 ms rebake lands on the move frame;
  then T-0042 sprites, T-0043 ortho on the GPU path, T-0044 dungeon air.
  T-0042/43/44/45/46 are mutually independent — that is when the fleet needs
  more than one opus lane. The supervisor only reloads `scale` on restart, so
  **add lanes with backgrounded `tigerteam worker run opus --once`** instead
  of restarting it mid-ticket (never wrap that in `timeout`).
- **The afterburn port (T-0036..T-0040) is the live wave.** Order:
  T-0036 (voxel kit) ∥ T-0037 (renderer + pipeline) → T-0038 (material +
  moods) → T-0039 (dungeon bake) → T-0040 (compose + viewport wiring).
  Review each against `docs/gpu.md`; nobody in the fleet can see a frame,
  so every report must carry a "what I could not verify" section and the
  **eyeball review is the PM's**.
- PM to write (outside every ticket's scope): `scripts/web-shot.mjs` — the
  headless screenshot instrument, ported from `~/afterburn/tools/shot.mjs`.
  Playwright is NOT a dependency here; resolve it from
  `~/asciicity/node_modules` (browsers are in `~/.cache/ms-playwright`).
  Without it the port cannot be judged.
- After first light (T-0040 accepted): screenshot the fps view in raw mode
  and in the amber ASCII style, then send a tuning ticket (mood numbers,
  torch density, DOF focus, grain) — the look will need one or two passes.
- Deferred to later tickets, in rough order: monster/item sprites in the
  GPU scene; the ortho camera + cutaway on the GPU path; a weather overlay
  (drips, dust motes) from `~/afterburn/src/render/weather.js`; then the
  open question the user still owes an answer on — static WASM build for
  GitHub-Pages hosting vs. keeping the ws thin client.
- Housekeeping: `.tigerteam/logs/workers/` is **16 GB** (one 9.4 GB
  `ds-1.log`). Truncate the old per-worker logs before the next long run.

## How to resume
1. Read this file.
2. `tigerteam status` (or `bash .tigerteam/scripts/board-status.sh`).
3. `tigerteam events --latest` — process review/ first (oldest first), then
   blocked/.
4. `git worktree list` — tigerteam/* entries are unmerged ticket branches.
5. Workers: the supervisor runs in the cockpit (`tigerteam up`); `touch
   .tigerteam/STOP` drains it, `rm` resumes.
6. Continue planning from Next actions.
