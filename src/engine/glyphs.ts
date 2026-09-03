/**
 * Glyph → terrain classification for the session model (docs/architecture.md
 * §4.2). Everything here is pure: the tables are S_* symbol names from
 * NetHack's include/defsym.h, resolved through the `S` name→index map that
 * the bridge ships in its `hello` line.
 */
import type { CellKind, GlyphInfo } from '../model/types.js';

/** Groups of `S_*` cmap symbol names sharing one CellKind, in the order the
 * §4.2 table lists them. First match wins. */
const TERRAIN_TABLE: ReadonlyArray<readonly [readonly string[], CellKind]> = [
  [['S_stone'], 'stone'],
  [
    [
      'S_vwall',
      'S_hwall',
      'S_tlcorn',
      'S_trcorn',
      'S_blcorn',
      'S_brcorn',
      'S_crwall',
      'S_tuwall',
      'S_tdwall',
      'S_tlwall',
      'S_trwall',
      'S_lavawall',
    ],
    'wall',
  ],
  [['S_ndoor'], 'doorway'],
  [['S_vodoor', 'S_hodoor'], 'door_open'],
  [['S_vcdoor', 'S_hcdoor'], 'door_closed'],
  [['S_bars'], 'bars'],
  [['S_tree'], 'tree'],
  [['S_room', 'S_darkroom', 'S_engroom'], 'floor'],
  [['S_corr', 'S_litcorr', 'S_engrcorr'], 'corridor'],
  [['S_upstair', 'S_brupstair'], 'stairs_up'],
  [['S_dnstair', 'S_brdnstair'], 'stairs_down'],
  [['S_upladder', 'S_brupladder'], 'ladder_up'],
  [['S_dnladder', 'S_brdnladder'], 'ladder_down'],
  [['S_altar'], 'altar'],
  [['S_grave'], 'grave'],
  [['S_throne'], 'throne'],
  [['S_sink'], 'sink'],
  [['S_fountain'], 'fountain'],
  [['S_pool', 'S_water'], 'water'],
  [['S_ice'], 'ice'],
  [['S_lava'], 'lava'],
  [['S_vodbridge', 'S_hodbridge'], 'drawbridge'],
  // A raised drawbridge blocks the way, so it maps to wall (see §4.2).
  [['S_vcdbridge', 'S_hcdbridge'], 'wall'],
  [['S_air'], 'air'],
  [['S_cloud', 'S_poisoncloud'], 'cloud'],
];

const UNKNOWN_LOGGED = new Set<string>();

/**
 * Map an `S_*` cmap symbol index to a `CellKind` using the hello `S` table
 * (name → index). Unknown/missing names → `'other'` (logged once per name).
 */
export function classifyCmap(symIdx: number, S: Readonly<Record<string, number>>): CellKind {
  for (const [names, kind] of TERRAIN_TABLE) {
    for (const name of names) {
      if (S[name] === symIdx) return kind;
    }
  }
  // Log the name (if known) once, so hello sends us a symbol we forgot about.
  for (const [name, idx] of Object.entries(S)) {
    if (idx === symIdx && !UNKNOWN_LOGGED.has(name)) {
      UNKNOWN_LOGGED.add(name);
      // eslint-disable-next-line no-console
      console.warn(`classifyCmap: unmapped S_* symbol ${name} (${symIdx}) → 'other'`);
      break;
    }
  }
  return 'other';
}

/** Return the `CellKind` for a terrain glyph (`cmap`/`trap`), else `null`. */
export function cellKindOf(info: GlyphInfo, S: Readonly<Record<string, number>>): CellKind | null {
  if (info.cls === 'cmap') return classifyCmap(info.idx, S);
  if (info.cls === 'trap') return 'trap';
  return null;
}

/** True when the glyph describes terrain (cmap or trap). */
export function isTerrainGlyph(info: GlyphInfo): boolean {
  return info.cls === 'cmap' || info.cls === 'trap';
}
