/**
 * Tile-art tests: the inline text-format parser plus lookups against the
 * generated `src/render/tiles.json` (NetHack's 16×16 tile art).
 */
import { describe, it, expect } from 'vitest';
import {
  parseTileFile,
  splitMonsterName,
  splitObjectName,
  encodePixels,
} from '../scripts/gen-tiles.js';
import { loadTiles, monsterTile, objectTile, otherTile } from '../src/render/tiles.js';

const SNIPPET = `A = (0, 0, 0)
B = (255, 0, 0)
# a comment line
# tile 0 (jackal,male)
{
  AAAAAAAAAAAAAAAA
  AAAAAAAAAAAAAAAA
  AAAAAAAAAAAAAAAA
  AAAAAAAAAAAAAAAA
  AAABBBAAAAAAAAAA
  AAABBBAAAAAAAAAA
  AAABBBAAAAAAAAAA
  AAABBBAAAAAAAAAA
  AAABBBAAAAAAAAAA
  AAABBBAAAAAAAAAA
  AAABBBAAAAAAAAAA
  AAABBBAAAAAAAAAA
  AAABBBAAAAAAAAAA
  AAABBBAAAAAAAAAA
  AAAAAAAAAAAAAAAA
  AAAAAAAAAAAAAAAA
}
# tile 1 (dagger)
{
  AAAAAAAAAAAAAAAA
  AAAAAAAAAAAAAAAA
  AAAAAAAAAAAAAAAA
  AAAAAAAAAAAAAAAA
  AAAAAAAAAAAAAAAA
  AAAAAAAAAAAAAAAA
  AAAAAAAAAAAAAAAA
  AAAAAAAAAAAAAAAA
  AAAAAAAAAAAAAAAA
  AAAAAAAAAAAAAAAA
  AAAAAAAAAAAAAAAA
  AAAAAAAAAAAAAAAA
  AAAAAAAAAAAAAAAA
  AAAAAAAAAAAAAAAA
  AAAAAAAAAAAAAAAA
  AAAAAAAAAAAAAAAA
}
`;

describe('tile text parser', () => {
  it('parses palette, names and 16x16 rows from an inline 2-tile snippet', () => {
    const f = parseTileFile(SNIPPET, 'snippet');
    expect(f.palette).toEqual([
      [0, 0, 0],
      [255, 0, 0],
    ]);
    expect(f.tiles.map((t) => t.comment)).toEqual(['jackal,male', 'dagger']);
    for (const t of f.tiles) {
      expect(t.rows).toHaveLength(16);
      for (const r of t.rows) expect(r).toHaveLength(16);
    }
    // Transparent index 0 ('A' here): first tile's row 0 is all index 0.
    const idx = new Map(f.paletteChars.map((c, k) => [c, k]));
    expect(f.tiles[0]!.rows[0]).toBe('AAAAAAAAAAAAAAAA');
    expect(idx.get('A')).toBe(0);
    expect(splitMonsterName('jackal,male')).toEqual({ base: 'jackal', gender: 'm' });
    expect(splitObjectName('vulgar polearm / partisan')).toEqual({
      name: 'partisan',
      descr: 'vulgar polearm',
    });
    expect(encodePixels([0, 1, 63])).toBe('AB/');
  });
});

describe('tile lookups', () => {
  it("monsterTile('jackal') is 16x16 with opaque rows 4-13 and a blank row 0", () => {
    const set = loadTiles();
    const tile = monsterTile(set, 'jackal');
    expect(tile).not.toBeNull();
    expect(tile!.w).toBe(16);
    expect(tile!.h).toBe(16);
    expect(tile!.pixels).toHaveLength(256);
    const row = (r: number): number[] => [...tile!.pixels.slice(r * 16, r * 16 + 16)];
    expect(row(0).every((v) => v === 0)).toBe(true);
    for (let r = 4; r <= 13; r++) {
      expect(row(r).some((v) => v !== 0)).toBe(true);
    }
  });

  it("monsterTile('elven monarch', true) differs from the male tile", () => {
    const set = loadTiles();
    const male = monsterTile(set, 'elven monarch')!;
    const female = monsterTile(set, 'elven monarch', true)!;
    expect(female).not.toBeNull();
    expect([...female.pixels].join(',')).not.toBe([...male.pixels].join(','));
  });

  it("objectTile('partisan') matches objectTile(undefined, 'vulgar polearm')", () => {
    const set = loadTiles();
    const byName = objectTile(set, 'partisan')!;
    const byDescr = objectTile(set, undefined, 'vulgar polearm')!;
    expect(byName).not.toBeNull();
    expect(byDescr).not.toBeNull();
    expect([...byDescr.pixels].join(',')).toBe([...byName.pixels].join(','));
    expect(otherTile(set, 'stone')).not.toBeNull();
  });

  it('unknown names return null', () => {
    const set = loadTiles();
    expect(monsterTile(set, 'no such monster')).toBeNull();
    expect(objectTile(set, 'no such object')).toBeNull();
    expect(objectTile(set, undefined, 'no such descr')).toBeNull();
    expect(otherTile(set, 'no such feature')).toBeNull();
  });
});
