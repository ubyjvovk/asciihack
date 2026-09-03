# Tile art data

NetHack ships 16×16 tile art as text in `nethack/win/share/` (NetHack licence
— see below): `monsters.txt` (789 tiles), `objects.txt` (483), `other.txt`
(243, walls/furniture/effects). AsciiHack commits a generated subset as
`src/render/tiles.json`; `src/render/tiles.ts` decodes and looks it up.
Rendering consumes it in the next ticket — this file is data only.

## Text format

Each file starts with a palette header of lines `X = (r, g, b)` (one char per
entry; `. = (71, 108, 108)` is the transparent background), then per tile:

```
# tile 24 (jackal,male)
{
  ................      ← 16 rows of 16 palette chars (indented in the file)
  ...
}
```

Only lines starting with `# tile ` open a tile; every other `#` line is a
comment. Monster names are `base,male` / `base,female` (one oddball:
`invisible monster, nogender`). Object names are either a bare name
(`dagger`) or `descr / name` (`vulgar polearm / partisan`, `emerald /
polymorph control`). `other.txt` names are bare feature names (`stone`,
`main walls vertical`, …).

## JSON format (`src/render/tiles.json`)

```json
{
  "palette": [[71, 108, 108], [0, 0, 0], "..."],
  "monsters": { "jackal": { "m": "<256 chars>", "f": "<256 chars>" } },
  "objects": { "dagger": "<256 chars>", "partisan": "<256 chars>" },
  "objectsByDescr": { "vulgar polearm": "<256 chars>" },
  "other": { "stone": "<256 chars>" }
}
```

- `palette` is the shared table (all three files use the same one — the
  generator verifies this and fails loudly on mismatch). Index 0 (`.`) is
  transparent, matching the `Tile` contract in `src/model/types.ts`.
- Monster keys are lower-cased base names; the variant key is `m` (male),
  `f` (female), or `n` (ungendered, e.g. `invisible monster`). When both
  genders exist (most monsters), `m` and `f` are stored separately even if
  identical — the generator keeps the first tile per (name, variant) and
  ignores later duplicates (e.g. the repeated `werejackal` tiles).
- Object keys are lower-cased names; `objectsByDescr` maps the lower-cased
  left side of `descr / name` entries to the same pixels (first wins).
- `other` keys are lower-cased feature names.

## Pixel encoding

Each 256-char string is one palette index per pixel, row-major (row 0 = top),
encoded as a single base-64 character (`A`=0 … `/`=63). The palette has 29
entries so one char per pixel suffices. Example: `A` = transparent,
`B` = palette entry 1 (black). Decoding is `B64.indexOf(ch)` per char —
see `decodeTile` in `src/render/tiles.ts`.

## Regenerate

The submodule must be populated first; never edit `nethack/` itself:

```
bash scripts/nethack-src.sh
npx tsx scripts/gen-tiles.ts   # rewrites src/render/tiles.json
```

The generator sorts all keys, so running it twice yields a byte-identical
file (`git diff` empty). Result: 392 monster names, 454 object names, 243
other names (~480 KB; marked `linguist-generated` in `.gitattributes`).

## Lookup module (`src/render/tiles.ts`)

- `loadTiles(): TileSet` — parses the JSON once, lazily; later calls return
  the cached set.
- `monsterTile(set, name, female?)` — male variant by default, female when
  asked, falling back to the other variant (and to `n` when ungendered).
- `objectTile(set, name?, descr?)` — name first, then descr.
- `otherTile(set, name)` — direct feature lookup.
- All names are matched lower-cased; unknown names return `null`. Decoded
  `Tile` objects are cached per (kind, name, variant).

## Bridge monster/object tables

The glyph stream only carries numeric monster/object indices, so the bridge
emits the name tables the client needs to map them to tiles: right after the
`init_nhwindows` call it prints one `{"t":"tables","monsters":[…],"objects":[…]}`
line with `NUMMONS` (383) monster entries
`{name, male, female, letter, size, color}` (from `mons[i].pmnames`,
`def_monsyms[mons[i].mlet].sym`, `msize`, `mcolor`) and `NUM_OBJECTS` (481)
object entries `{name, descr, cls}` (from `obj_descr[i]` and
`def_oc_syms[objects[i].oc_class].sym`). Two timing gotchas, both documented
in code: the tables ride on `init_nhwindows` (not `hello`, which is printed
before `nhmain` populates `mons[]`), and object names come from
`obj_descr[i]` directly because `objects[i].oc_name_idx` is still 0 until
`init_objects()` runs later in `newgame()`.

## Licence note

The pixel art in `tiles.json` is NetHack's tile art (notably the
DawnHack-derived tiles by their respective artists; see the `# Contributing
artist` comments in the source files), distributed under the NetHack General
Public License like the rest of `nethack/`. Keep this file and the generated
JSON under the same licence terms; do not relicense.
