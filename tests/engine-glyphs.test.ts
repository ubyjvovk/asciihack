import { describe, expect, it } from 'vitest';
import { cellKindOf, classifyCmap, isTerrainGlyph } from '../src/engine/glyphs.js';
import type { CellKind, GlyphInfo } from '../src/model/types.js';

// One synthesised S table that assigns each S_* name a unique index. Real
// hello messages have this same shape; the exact indices don't matter here.
function makeS(names: readonly string[]): Record<string, number> {
  const s: Record<string, number> = {};
  names.forEach((n, i) => { s[n] = i + 1; });
  return s;
}

/** Every row of the §4.2 table by S_* name → expected CellKind. Keep this in
 *  lockstep with docs/architecture.md §4.2 — a mismatch here is a spec drift. */
const TABLE: ReadonlyArray<readonly [string, CellKind]> = [
  ['S_stone', 'stone'],
  ['S_vwall', 'wall'],
  ['S_hwall', 'wall'],
  ['S_tlcorn', 'wall'],
  ['S_trcorn', 'wall'],
  ['S_blcorn', 'wall'],
  ['S_brcorn', 'wall'],
  ['S_crwall', 'wall'],
  ['S_tuwall', 'wall'],
  ['S_tdwall', 'wall'],
  ['S_tlwall', 'wall'],
  ['S_trwall', 'wall'],
  ['S_lavawall', 'wall'],
  ['S_ndoor', 'doorway'],
  ['S_vodoor', 'door_open'],
  ['S_hodoor', 'door_open'],
  ['S_vcdoor', 'door_closed'],
  ['S_hcdoor', 'door_closed'],
  ['S_bars', 'bars'],
  ['S_tree', 'tree'],
  ['S_room', 'floor'],
  ['S_darkroom', 'floor'],
  ['S_engroom', 'floor'],
  ['S_corr', 'corridor'],
  ['S_litcorr', 'corridor'],
  ['S_engrcorr', 'corridor'],
  ['S_upstair', 'stairs_up'],
  ['S_brupstair', 'stairs_up'],
  ['S_dnstair', 'stairs_down'],
  ['S_brdnstair', 'stairs_down'],
  ['S_upladder', 'ladder_up'],
  ['S_brupladder', 'ladder_up'],
  ['S_dnladder', 'ladder_down'],
  ['S_brdnladder', 'ladder_down'],
  ['S_altar', 'altar'],
  ['S_grave', 'grave'],
  ['S_throne', 'throne'],
  ['S_sink', 'sink'],
  ['S_fountain', 'fountain'],
  ['S_pool', 'water'],
  ['S_water', 'water'],
  ['S_ice', 'ice'],
  ['S_lava', 'lava'],
  ['S_vodbridge', 'drawbridge'],
  ['S_hodbridge', 'drawbridge'],
  ['S_vcdbridge', 'wall'],
  ['S_hcdbridge', 'wall'],
  ['S_air', 'air'],
  ['S_cloud', 'cloud'],
  ['S_poisoncloud', 'cloud'],
];

describe('engine/glyphs — classifyCmap', () => {
  it('maps every row of the §4.2 table to the documented CellKind', () => {
    const names = TABLE.map(([n]) => n);
    const S = makeS(names);
    for (const [name, expected] of TABLE) {
      const idx = S[name]!;
      expect(classifyCmap(idx, S), `${name} → ${expected}`).toBe(expected);
    }
  });

  it('returns "other" for an unmapped symbol name', () => {
    const S = { S_something_new: 42 };
    expect(classifyCmap(42, S)).toBe('other');
  });

  it('returns "other" when the index is not present in the S table at all', () => {
    expect(classifyCmap(999, { S_stone: 0 })).toBe('other');
  });
});

describe('engine/glyphs — cellKindOf / isTerrainGlyph', () => {
  const S = makeS(['S_room', 'S_vwall']);

  it('resolves cmap glyphs through classifyCmap', () => {
    const gi: GlyphInfo = { glyph: 0, ch: '.', color: 7, cls: 'cmap', idx: S.S_room!, flags: 0 };
    expect(cellKindOf(gi, S)).toBe('floor');
    expect(isTerrainGlyph(gi)).toBe(true);
  });

  it('resolves trap glyphs to "trap" regardless of idx', () => {
    const gi: GlyphInfo = { glyph: 0, ch: '^', color: 3, cls: 'trap', idx: 7, flags: 0 };
    expect(cellKindOf(gi, S)).toBe('trap');
    expect(isTerrainGlyph(gi)).toBe(true);
  });

  it('returns null for non-terrain glyphs (monsters, objects, …)', () => {
    const mon: GlyphInfo = { glyph: 0, ch: 'd', color: 3, cls: 'mon', idx: 1, flags: 0 };
    const obj: GlyphInfo = { glyph: 0, ch: '(', color: 7, cls: 'obj', idx: 2, flags: 0 };
    expect(cellKindOf(mon, S)).toBeNull();
    expect(cellKindOf(obj, S)).toBeNull();
    expect(isTerrainGlyph(mon)).toBe(false);
    expect(isTerrainGlyph(obj)).toBe(false);
  });
});
