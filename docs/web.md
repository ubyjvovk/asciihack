# Browser client (`web/`, `server/`)

The same TypeScript client that drives the terminal also runs in a
browser. Instead of speaking to a local `nh-bridge` over pipes, the
browser talks to a **Node WebSocket server** that spawns one bridge per
connection and relays its JSON lines. Rendering happens in the page: the
`Screen` writer paints a `ScreenGrid` into a `<pre>` of coloured spans
via a browser-side `TermIO`.

In the `fps` and `ortho` modes the same page also hosts a **WebGL
viewport** (see "WebGL viewport" below) — a three.js scene rendered
through AsciiCity's shader styles, mounted under the `<pre>` grid so
the message line, status bar, minimap and compass keep painting on top.

## Run

```sh
npm ci
bash scripts/nethack-build.sh lib     # once
bash scripts/nethack-build.sh bridge  # once
npm run web:server      # ws://127.0.0.1:8790/play?name=<name>
npm run web:dev         # http://127.0.0.1:5173/
```

Open `http://127.0.0.1:5173/?name=mia`. `?theme=amber|gloom|solarized|cyber`,
`?mode=fps|ortho|classic` and `?render=<style-id>` (see the WebGL
viewport section) are also honoured.

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

## WebGL viewport

Only mounted in `fps` and `ortho` modes. `web/src/gl/gl-viewport.ts`
owns a `<canvas>` positioned absolutely under the DOM terminal's
viewport rectangle (the region between the message line at row 0 and
the two status rows at the bottom); the canvas has
`pointer-events: none` so keyboard focus stays on `<pre id="term">`.

```
┌──────────────────────────────────────────────┐  message line   (<pre>)
├──────────────────────────────────────────────┤
│                                              │
│         three.js scene + style shader        │  (<canvas>)
│                                              │  <pre> viewport cells
│                                              │  paint on top: minimap,
│                                              │  compass, prompts, HUD
├──────────────────────────────────────────────┤
├──────────────────────────────────────────────┤  two status rows (<pre>)
└──────────────────────────────────────────────┘
```

The vendored render-style pipeline is in `web/src/asciicity/render/`
(see the file's `README.md`; do not edit those files here — improve
them in AsciiCity and re-copy).

**Transparency rule.** When the GL viewport is mounted, `App` runs with
`externalViewport: true` and the fps/ortho modes skip their CPU dungeon
render, leaving the viewport cells as spaces on black `(0,0,0)`.
`DomTerm.paintGrid` treats a cell whose `bg` is exactly `[0,0,0]` as
transparent (it never emits a `background-color`), so the page's black
body colour shows the WebGL canvas underneath through those cells. The
HUD (minimap arrow/dots, compass ribbon, ortho rose, message line,
status, menus, prompts) keeps painting with non-black backgrounds and
stays opaque above the shader.

### Scene mapping

`web/src/gl/scene-builder.ts` builds one `THREE.InstancedMesh` per
material from a `LevelView`; the geometry rebuilds only when the set of
known cells' `CellKind` actually changes (a per-cell hash gates the
work). Coordinates follow architecture.md §7 / AsciiCity: map `x` grows
east, map `y` grows south, three's `x` = east, `z` = south, `y` = up.
Cell (cx, cy) covers the box `(cx…cx+1, 0…1, cy…cy+1)`; centre at
`(cx + 0.5, 0.5, cy + 0.5)`.

| Cell kind                       | Geometry                                              |
|---------------------------------|-------------------------------------------------------|
| solid, not `door_closed`        | unit `BoxGeometry` (wall cube), centred on the cell   |
| any passable kind               | unit `PlaneGeometry` (floor quad) at `y = 0`          |
| `door_closed`                   | thin `1×1×0.2` slab, rotated with the neighbours      |
| `door_open` / `doorway`         | floor quad + two `0.2×1×0.2` vertical posts           |
| `stairs_up` / `stairs_down`     | floor quad + a lit stair quad at `y = 0.02`           |
| `unexplored`                    | nothing — the fog does the darkness                   |

The door axis is inferred from neighbouring walls: north/south walls →
door swings east-west (posts on the north and south corners); east/west
walls → the mirror case; otherwise east-west by default.

### Materials

Plain `MeshLambertMaterial` with small procedural `CanvasTexture`s
generated at start-up: brick 64×64 with mortar and speckles for walls,
flagstone 64×64 for floors, vertical planks with hinges for doors,
stairs get an emissive glow. Textures use `NearestFilter` and repeat
per cell so the style shader gets flat, chunky pixels to quantise.

The tints are picked bright — walls `0x9a9a9e`, floors `0x6a6a70`,
doors/posts `0x8a6a3a`, stairs `0xd0a040` (with a warm emissive) —
because AsciiCity's shaders are built for bright surfaces they then
thin out. Dark stone materials fall below the shader's black point and
disappear (T-0031 rework 2). Procedural textures are built exactly once
and cached; they are never resized, so the `THREE.CanvasTexture` is
committed immutable and no `glTexStorage2D: Texture is immutable`
warning appears on redraw.

### Sprites

Every `Sprite` from `src/ui/view3d.ts:spritesFromMap` becomes a
`THREE.Sprite` billboard: position `(x + 0.5, height / 2, y + 0.5)`
(feet at `y = 0`, centre at the cell centre), scale `(height, height,
1)` in cells. When the sprite carries `Tile` art the sprite material's
`map` is a nearest-filtered `CanvasTexture` built from the tile pixels
(palette index 0 → alpha 0 = transparent); otherwise the material is a
flat-colour sprite tinted with `Sprite.rgb`. The style shader turns the
coloured pixels into glyph density — the AsciiCity trick — so letters
are never drawn here.

### Camera

A `THREE.PerspectiveCamera` (created by
`web/src/asciicity/render/scene.ts:makeCamera`, then tightened to
`near = 0.05`, `far = 60`) with vertical FOV taken from the fps mode's
`vFovDeg` and aspect from the viewport rectangle. It sits at
`(hero.x + 0.5, EYE_HEIGHT = 0.5, hero.y + 0.5)` and its `yaw` is the
fps mode's animated `currentYaw`, mapped to three's Y-rotation with a
sign flip (three's default forward is `−z ≈ north`). The T-0023 horizon
offset (`horizonFrac 0.42`) is approximated by a small negative pitch
(`CAMERA_PITCH ≈ −0.08 rad`). A `PointLight` attached to the camera
plays the lantern (`LANTERN_INTENSITY = 12`, `LANTERN_DISTANCE = 14`
cells, decay `1`); an `AmbientLight(0xffffff, 0.35)` keeps distant
surfaces above the shader's black point, and
`scene.fog = FogExp2(0x000000, 0.10)` fades the far end of the corridor
without swallowing the near walls (T-0031 rework 2).

### Styles

`StyleRenderer` (from `web/src/asciicity/render/post.ts`) owns the
low-res target and swaps `RenderStyle`s at runtime. The full registry
is `web/src/asciicity/render/style.ts:STYLE_ORDER` — `ascii`, `gloom`,
`solarized`, `amber`, `braille`, `blocks`, `teletext`, `dither`,
`gameboy`, `pico8`, `edges`, `hatch`, `matrix`. The tty client's four
themes (`cyber`/`gloom`/`solarized`/`amber`) are a subset.

Default is `amber`; `?render=<id>` picks another; **F5** (Shift-F5 for
previous) cycles through `STYLE_ORDER`. `F5` is intercepted at capture
before the App sees it (the App also uses `F5` for its terminal-theme
cycle — that still happens, since the DOM terminal is what the HUD
paints into).

### Ortho view

`GlViewport.setView('fps' | 'ortho')` swaps between the first-person
perspective camera and a 3/4 overhead `OrthographicCamera` — the
"Diablo/Fallout" view of the same three.js scene. `F3` in the browser
selects ortho, `F2` returns to fps; both key bindings mark the render
loop dirty immediately (fixes the T-0031 nit where `F5` needed a game
event before the change showed). `main.ts` intercepts F5/F2/F3 at the
document level in the capture phase so the viewport reacts before the
App consumes them.

The maths lives in `web/src/gl/ortho-camera.ts`. `placeOrthoCamera(cam,
hero, cols, rows, cellAspect)` positions the camera at azimuth 225°
(NW of the hero cell centre) and elevation 35° above the horizon, and
sizes the frustum so `viewHeight = 7 · HERO_SPRITE_HEIGHT` world units
(the hero fills ≈ 1/7 of the viewport height), with width = height ·
`cols / (rows · cellAspect)`. The DOM terminal's cells are twice as
tall as wide, so `cellAspect = 2`; the arithmetic returns plain numbers
(`orthoPlacement`) so the tests assert positions and frustum sides
without WebGL. The frustum is `near = 0.1`, `far = 200` (a modest far
plane keeps depth-based styles from going black across the ortho box).

**Per-view fog.** The exponential scene fog must be weaker in ortho than
in fps: the fps camera sits at the hero cell (depths 1–10, so density
`0.10` just fades the far corridor), but the ortho camera is ~40 cells
away, where density `0.10` gives a fog factor of ≈ 1 and blackens the
whole frame. `setView` therefore switches `scene.fog.density` between
`FPS_FOG_DENSITY = 0.10` and `ORTHO_FOG_DENSITY = 0.01`, so the 3/4 view
keeps only a faint depth cue instead of vanishing.

**Debug handle.** When the GL viewport is mounted, `main.ts` exposes
`window.__asciihack = { gl }`; calling `gl.debugInfo()` returns a
plain-number snapshot (`view`, the active `camera`'s `type`/`position`/
`target`/`near`/`far`/frustum sides, `meshes.walls/floors/sprites`,
`styleId`) for diagnosing camera or frustum issues from the page
console.

The hero is invisible in fps (the camera sits at the hero cell) and
visible in ortho: `renderFrame` includes it in the sprite list and pins
its height to `HERO_SPRITE_HEIGHT`. `tiles.json` does not carry the
player role's tile on every build, so the hero sprite falls back to a
generated `@` canvas texture (lazy, cached), tinted with the sprite's
palette colour.

**Cutaway.** Walls strictly in front of the hero (greater `x + y`) and
within 2 cells on each axis — the same rule as the terminal ortho
(`src/render/ortho.ts:isCutaway`) — swap for a translucent ghost cube
(`opacity: 0.35`, `depthWrite: false`) so the hero stays visible
through them. `applyCutaway` collapses the corresponding wall
`InstancedMesh` instances to zero scale and mirrors them into a
separate `cutawayMesh` with the ghost material; the swap is memoised
on `hero cell + wall count` so we only touch GPU state when something
actually changed. `cutawayCellsFor(hero)` is pure and returns the set
of cell keys.

The compass rose is still painted by `OrthoMode` into the DOM
terminal's viewport rectangle (the terminal-ortho "W N / + / S E"
layout at the top-left); the ortho GL scene shows through the
transparent viewport cells underneath it.

### The frame loop

`requestAnimationFrame` drives the render loop, but three.js is only
invoked when there is something new to draw: the session emits `change`
or `request` (map, hero, pending prompt), the fps mode is animating a
turn (`FpsMode.isTurning`), or a caller marks the loop dirty (F5/F2/F3
in `main.ts`). Idle frames skip WebGL entirely, so a paused game costs
zero GPU work. Every frame that does render calls
`SceneBuilder.refresh(level)` (rebuilds only when the kind grid
changed), `updateSprites(spritesFromMap(session, hero, …))`, positions
the active camera, then hands the scene + camera to `StyleRenderer.render`
which renders into the low-res target and paints the style quad to the
canvas.

`resize(cols, rows, cellW, cellH)` runs on start and on every DOM-side
resize (a `ResizeObserver` on `#term`); it recomputes the canvas size,
the low-res scene target and the perspective camera aspect (the ortho
frustum is derived from `cols × rows × cellAspect` on every ortho
frame).

## Coming next

- **T-0033 (later)** — WASM transport for static hosting: an emscripten
  build of `libnethack.a` replaces the WS server so the page runs
  standalone.
