# Browser client (`web/`, `server/`)

The same TypeScript client that drives the terminal also runs in a
browser. Instead of speaking to a local `nh-bridge` over pipes, the
browser talks to a **Node WebSocket server** that spawns one bridge per
connection and relays its JSON lines. Rendering happens in the page: the
`Screen` writer paints a `ScreenGrid` into a `<pre>` of coloured spans
via a browser-side `TermIO`.

The three.js viewport that mirrors AsciiCity's shader styles is a
follow-up (T-0031); today the browser can play the classic map and the
CPU raycaster in a DOM terminal.

## Run

```sh
npm ci
bash scripts/nethack-build.sh lib     # once
bash scripts/nethack-build.sh bridge  # once
npm run web:server      # ws://127.0.0.1:8790/play?name=<name>
npm run web:dev         # http://127.0.0.1:5173/
```

Open `http://127.0.0.1:5173/?name=mia`. `?theme=amber|gloom|solarized|cyber`
and `?mode=fps|ortho|classic` are also honoured.

`npm run web:build` produces the static bundle under `dist-web/`. The
site still needs a running WS server; the browser bundle contains no
NetHack code.

## Architecture

```
                            Node                             Browser
+------------------+   +----------------+   ws://.../play   +---------------+
| nh-bridge (C)    |<->| server/        | <---------------> | web/src/      |
| stdin/stdout     |   |   ws-server.ts |    JSON frames    |   ws-bridge.ts|
| JSON lines       |   |                |                   |   dom-term.ts |
+------------------+   +----------------+                   |   main.ts     |
                                                            +---------------+
                                                                  |
                       one BridgeTransport implementation each    v
                                                            src/engine/session.ts
                                                            src/ui/app.ts
                                                            src/render/*
                                                            src/term/screen.ts
                                                            src/term/input.ts
```

- `src/engine/bridge.ts` exports `BridgeTransport` — the interface both
  the Node bridge (`spawnBridge`) and the browser transport
  (`WsBridge`) implement: `messages`/`batches` async iterables of
  `BridgeMsg`, `reply(msg)`, `kill()` and `exited: Promise<number>`.
  `NethackSession` and `runSession` take either.
- `web/src/ws-bridge.ts` — `WsBridge` opens a `WebSocket` and turns each
  incoming text frame into one `BridgeMsg`; `reply()` sends one text
  frame; closing the socket resolves `exited`.
- `web/src/dom-term.ts` — `DomTerm` implements `TermIO`: renders a
  `ScreenGrid` into a `<pre>` as **one `<span>` per run of equal-colour
  cells** (never per cell), listens for `keydown` events and maps them
  to the same `KeyEvent` tokens as the tty parser (`ArrowLeft` → `Left`,
  `F5`, `Escape`, Ctrl-letters as lowercase with `ctrl: true`, `Home`,
  …). `TermIO.write` is a no-op for the DOM path; the App calls
  `Screen.paint`, which — thanks to the optional `paintGrid?(grid)` on
  `TermIO` — hands the whole grid to `DomTerm.paintGrid` and skips the
  ANSI diff.

## The transport interface

```ts
export interface BridgeTransport {
  readonly messages: AsyncIterable<BridgeMsg>;
  readonly batches: AsyncIterable<BridgeMsg[]>;
  reply(msg: RetMsg): void;
  kill(signal?: string): void;
  readonly exited: Promise<number>;
}
```

Both transports pace with the underlying producer. On the Node side,
`spawnBridge` batches per stdout chunk (so `session.handleBatch` fires
one `change` per render tick). On the browser side, each WS text frame
holds one bridge line, so a batch is a single-message array — good
enough for the classic tty rate; the server bundles nothing.

## The WS server (`server/ws-server.ts`)

- One process, one port. On `/play?name=<name>`:
  - the name is validated (`[A-Za-z0-9_-]{1,20}` — mirrors
    `bin/asciihack-lib.sh:asciihack_valid_name` and the CLI),
  - the per-player playground is copied from
    `build/nethack/bridge/playground` to `<playgrounds>/<name>/` on
    first use (default `<playgrounds>` = `~/.asciihack/players/`),
  - `nh-bridge` is spawned via `spawnBridge` with `NETHACKDIR` set,
  - every bridge stdout line goes out as one text frame,
  - every text frame goes in as one reply on the bridge's stdin,
  - closing the socket sends `SIGTERM` to the bridge; the bridge
    exiting closes the socket cleanly.
- One session per socket. No sharing, no auth.
- Log lines: `session start name=<name> target=<dir>` and
  `session end   name=<name> durationMs=<n>`.

Flags:

| flag | default | meaning |
|---|---|---|
| `--host=` | `127.0.0.1` | interface to bind |
| `--port=` | `8790` | TCP port |
| `--bridge=` | `build/nethack/bridge/nh-bridge` | bridge binary |
| `--playgrounds=` | `~/.asciihack/players` | per-player playground root |
| `--playground-src=` | `build/nethack/bridge/playground` | first-use source |

Env overrides use `ASCIIHACK_WS_HOST`, `ASCIIHACK_WS_PORT`,
`ASCIIHACK_BRIDGE`, `ASCIIHACK_PLAYGROUNDS`, `ASCIIHACK_PLAYGROUND_SRC`.

## The Vite dev server (`web/vite.config.ts`)

- Root: `web/`.
- `server.proxy['/play']` forwards WebSocket upgrades to `ws://127.0.0.1:8790`
  (overrideable with `ASCIIHACK_WS_URL`).
- Build output: `dist-web/`.

## Security

The WS server binds to `127.0.0.1` by default and has **no authentication**
— treat it like the terminal client: only reachable through your ssh
tunnel or over localhost. Exposing it on `0.0.0.0` is a foot-gun; if you
need multi-player, put an ssh tunnel or an authenticated reverse proxy
in front and mirror `bin/asciihack-lib.sh`'s name rules there too.

## Smoke test

```sh
npx tsx scripts/ws-smoke.ts
```

Starts the server on a random port, opens a client to
`/play?name=smoke`, answers just enough startup calls to reach the first
`nhgetch`/`nh_poskey`, then closes the socket and verifies the paired
`nh-bridge` process exits within 1 s. Needs the bridge build; the
container has no browser, so the PM does the actual page playtest.

## Shared code is browser-clean

`src/engine/session.ts`, `src/ui/*`, `src/render/*`, `src/term/screen.ts`
and `src/term/input.ts` import nothing from `node:*`. The Node-only
helpers live outside:

- `src/settings-io.ts` — `settingsPath` / `loadSettings` / `saveSettings`
  (`src/ui/settings.ts` keeps only the pure parse/serialize helpers).
- `src/tiles-load.ts` — `loadTiles` (`src/render/tiles.ts` keeps only
  the pure `TileFile`/`TileSet` decoders).
- `src/engine/bridge.ts`, `src/term/tty.ts`, `src/cli.ts` — the CLI-only
  Node entry paths; excluded from `web/tsconfig.json`'s include set.

`App`'s persistence went from `settingsFile: string` (which pulled Node
`fs` into the shared graph) to a callback pair — `settings?: Settings`
plus `onSettingsChange?(s)`. The CLI wires these to
`load/saveSettings`; the browser today passes just an initial `Settings`
and no persistence (a future ticket may wire it to `localStorage`).

## Coming next

- **T-0031** — three.js viewport that replaces the fps/ortho DOM
  renderer with the AsciiCity styles vendored under `web/src/asciicity/`.
- **T-0032** — ortho camera on top of the three.js scene.
- **T-0033 (later)** — WASM transport for static hosting: an emscripten
  build of `libnethack.a` replaces the WS server so the page runs
  standalone.
