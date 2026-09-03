# Engine client (`src/engine/`)

The TypeScript half of the bridge protocol. Three files:

- `src/engine/bridge.ts` — spawn `nh-bridge`, split its stdout into JSON
  lines, write replies. Injectable spawn function so tests feed a fake
  child. Details: docs/architecture.md §3.
- `src/engine/glyphs.ts` — glyph → `CellKind` classification, the §4.2
  table.
- `src/engine/session.ts` — `NethackSession`: the level, hero, messages,
  status, windows and pending request. Details: docs/architecture.md §4.

`src/engine/protocol.ts` is the PM-owned wire type file — imported here,
never edited.

## Bridge process

```ts
import { spawnBridge } from './engine/bridge.js';

const bridge = spawnBridge({
  binary: 'build/nethack/bridge/nh-bridge',
  playgroundDir: '/home/me/.asciihack/pg',
  name: 'me',
  // options?: string[] — comma-joined into NETHACKOPTIONS.
  //   Default: ['!tutorial', `name:<name>`]. See docs/bridge.md for the
  //   set observed on a real startup.
});

for await (const batch of bridge.batches) {
  session.handleBatch(batch);
}
```

`bridge.messages` yields one `BridgeMsg` per line; `bridge.batches` yields
one array per stdout chunk (that's how `session.handleBatch` gets its
one-`change`-per-chunk coalescing). Iterate one, not both — they share the
underlying stdout reader.

`bridge.reply(msg)` writes a single LF-terminated JSON object; the
`RetMsg` shape lives in `src/engine/protocol.ts` (`ret` for the primary
return, `selected` for menus, `x/y/mod` for a click). `bridge.exited`
resolves with the child's exit code.

## Session model

`NethackSession` consumes bridge messages and keeps the model. It handles
the plumbing (`create_nhwindow` id assignment, `player_selection` = 0,
`player_selection_or_tty` = false, `askname` from the hello) automatically;
everything that actually asks the user something is surfaced as
`session.pending` and answered with `session.answer(...)`.

```ts
import { NethackSession, runSession } from './engine/session.js';

const session = new NethackSession((r) => bridge.reply(r));
session.on('change', () => redraw());
session.on('request', (req) => promptUser(req));
session.on('exit',    (code) => shutdown(code));

await runSession(bridge, session);
```

State the UI reads:

- `session.map: LevelView` — `kindAt(x, y)` for renderers, `cellAt` for
  the raw `MapCell` (terrain glyph, top glyph, `CellKind`).
- `session.hero: {x, y} | null` — from `curs` on the map window; the
  `MG_HERO` flag on `print_glyph` is used as a cross-check.
- `session.messages: readonly string[]` — every game message, in order:
  `putstr` NetHack sent to `WIN_MESSAGE` **and** `raw_print`/`raw_print_bold`
  (see “Where messages come from”).
- `session.status: ReadonlyMap<blIdx, string | number>` — raw
  `status_update` values (numbers for `BL_CONDITION`, strings otherwise;
  `BL_FLUSH`/`BL_RESET` nulls are dropped).
- `session.statusLines(): [string, string]` — the classic two tty lines
  assembled from `status`. See `nethack/win/tty/wintty.c` for the field
  order; `BL_GOLD` has its `\G` glyph escape stripped
  (`stripGlyphEscape`).
- `session.windows: ReadonlyMap<winId, WindowState>` — text/menu content
  for windows the client did not consume yet.
- `session.pending: PendingRequest | null` — see below.

## Request / answer cycle

Every NetHack call that would block the game on user input is packaged as
a `PendingRequest` and emitted as a `request` event. There is only ever
one pending request; `answer(...)` sends the reply and clears it.

```
NetHack               nh-bridge                  NethackSession
  |                        |                          |
  |--yn_function()--------->                          |
  |                        |--call {yn_function,id}-> |
  |                        |                          |-- pending = {kind:'yn', id, query, choices, def}
  |                        |                          |-- emit('request', pending)
  |                        |                          |
  |                        <--reply {id,ret:'y'}------|<-- session.answer({kind:'yn', ch:'y'.charCodeAt(0)})
  |<--returns 'y'----------|                          |
```

Request kinds and the answer payloads they accept:

| pending.kind      | source call             | `answer(...)` payload                       |
|-------------------|-------------------------|---------------------------------------------|
| `key`             | `nhgetch`               | `{kind:'key', key: number}`                 |
| `pos`             | `nh_poskey`             | `{kind:'pos', key}` or `{kind:'pos', x,y,mod}` |
| `yn`              | `yn_function`           | `{kind:'yn', ch: number}`                   |
| `getlin`          | `getlin`                | `{kind:'getlin', text: string}`             |
| `menu`            | `select_menu`           | `{kind:'menu', selected: [{i,count}]}` or `{kind:'menu', cancelled: true}` |
| `display`         | `display_nhwindow(_,true)` | `{kind:'dismiss'}` or `{kind:'display'}` |
| `file`            | `display_file`          | `{kind:'file'}` (or `{kind:'file', ret}`)   |
| `extcmd`          | `get_ext_cmd`           | `{kind:'extcmd', index: number}`            |
| `message-menu`    | `message_menu`          | `{kind:'message-menu', ch: number}`         |

`answer(...)` throws if nothing is pending or if the payload kind doesn't
match the pending kind. An unknown payload kind also throws (a `default:`
guard in `buildRetMsg`), so no malformed answer can ever reach the bridge.
`{kind:'display'}` is accepted as a synonym for `{kind:'dismiss'}` on a
pending `display` request.

## Where messages come from

NetHack's `pline()` (src/pline.c:239) falls back to `raw_print` while
`iflags.window_inited` is false, and the shim port never sets that flag — so
real game messages arrive as `raw_print`/`raw_print_bold`, not as
`putstr(WIN_MESSAGE)`. `NethackSession` treats `raw_print` and
`raw_print_bold` exactly like a `putstr` on `WIN_MESSAGE`: it appends the
text to `session.messages` and emits `message`. Early text (the welcome
blurb) and late text (“Saving…”, errors) still come through `raw_print`
even after `iflags.window_inited` is set (ticket T-0012), so nothing is
ever lost. The UI should show everything in `session.messages` that arrived
since the previous key request.

Menu building: `start_menu` clears the window's item list, each `add_menu`
appends an item (header rows arrive with `identIndex === -1`, keep them —
they're unselectable), and `end_menu` records the prompt. `select_menu`
emits the `menu` request with a snapshot of the items and the prompt; the
UI assigns accelerators to selectable items whose `accel` is empty (see
docs/architecture.md §4.4). Answer with the identifier indices the user
picked and their counts (`-1` = "all").

Cancelled vs empty menu: NetHack's `select_menu` returns `-1` for a
cancelled prompt and `0` for "nothing selected" (docs/architecture.md
§3.3), and it behaves differently for the two on some questions. The
session mirrors that split — answer ESC-cancel with
`{kind:'menu', cancelled: true}` (→ `{id, ret: -1}`, no `selected`) and
Enter-with-nothing-picked with `{kind:'menu', selected: []}` (→ `{id,
ret: 0, selected: []}`).

## Fixtures and record-bridge

Session tests replay recorded bridge streams from
`tests/fixtures/bridge/*.jsonl`. Each file mixes real bridge lines with
`{"reply": …}` lines that record the reply the client sent — the test
loader skips reply rows and feeds the rest into `session.handle`, so the
model advances the same way it would against a live bridge.

To (re)record a fixture:

```
bash scripts/nethack-build.sh bridge          # once
npx tsx scripts/record-bridge.ts --out tests/fixtures/bridge/start.jsonl
npx tsx scripts/record-bridge.ts --out tests/fixtures/bridge/walk.jsonl \
      --stop-at save-confirmed --keys 'hjklyubn hjklhjkl'
```

Flags:

- `--out FILE` — output path (required).
- `--keys 'STRING'` — key sequence sent one character at a time whenever
  the bridge asks for a key. Space/etc. are literal characters.
- `--stop-at first-key | save-confirmed | eof` — when to stop recording.
  `first-key` finishes after the first `nhgetch`/`nh_poskey` (the "start"
  fixture); `save-confirmed` sends `S` and confirms the save prompt so
  the bridge emits an `exit` line (the "walk" fixture).
- `--name`, `--role`, `--race`, `--gender`, `--align` — character setup
  forwarded via `NETHACKOPTIONS`.

Fixtures must stay under 1 MB and are committed as-is (no post-processing).

### Note on the "≥ 200 non-unexplored cells" acceptance criterion

The T-0003 ticket asked `start.jsonl` replay to show ≥ 200 non-`unexplored`
cells. NetHack's `docrt()` only forwards non-`GLYPH_UNEXPLORED` glyphs on
startup (`src/display.c` ~L2221), so a fresh level draws only the starting
room + hero/pet — ~30–50 cells in practice. The T-0002 bridge report set
the same floor at 30 for exactly this reason (docs/bridge.md, T-0002
deviations). The engine test therefore asserts ≥ 30 for start.jsonl and
still verifies that a hero position and a pending key request are present.
