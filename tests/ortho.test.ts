/**
 * Golden + unit tests for the ortho / isometric renderer v2 (docs/render.md,
 * architecture.md §5.3). Like the raycaster tests, the ASCII quantizer (T-0006)
 * is deliberately NOT imported: these tests use a tiny test-local 10-glyph ramp
 * so the goldens are independent of it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderOrtho, cellToScreen, screenToCell, type Origin } from '../src/render/ortho.js';
import { loadTiles, monsterTile, objectTile } from '../src/render/tiles.js';
import { makeFrameBuffer, type FrameBuffer, type LevelView, type Sprite } from '../src/model/types.js';
import { levelFromAscii, ROOM } from './fixtures/levels.js';

const GOLDEN = fileURLToPath(new URL('./ortho-golden.txt', import.meta.url));
const ZOOM_GOLDEN = fileURLToPath(new URL('./ortho-zoom-golden.txt', import.meta.url));

/** Test-local quantizer: a 10-glyph ramp over max(r,g,b). Do not import ascii.ts. */
function quantize(fb: FrameBuffer): string {
  const ramp = ' .:-=+*#%@';
  const { width, height } = fb;
  const lines: string[] = [];
  for (let y = 0; y < height; y++) {
    let line = '';
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const oc = fb.overlayCh[i];
      if (oc !== 0) {
        line += String.fromCharCode(oc!);
        continue;
      }
      const o = i * 3;
      const v = Math.max(fb.rgb[o]!, fb.rgb[o + 1]!, fb.rgb[o + 2]!);
      const dens = Math.max(0, Math.min(1, v));
      let idx = Math.floor(dens * (ramp.length - 1) + 0.5);
      idx = Math.max(0, Math.min(ramp.length - 1, idx));
      line += ramp[idx]!;
    }
    lines.push(line);
  }
  return lines.join('\n') + '\n';
}

/** RGB of one screen cell. */
function rgbAt(fb: FrameBuffer, c: number, r: number): [number, number, number] {
  const o = (r * fb.width + c) * 3;
  return [fb.rgb[o]!, fb.rgb[o + 1]!, fb.rgb[o + 2]!];
}

/** Count how many cells carry a given overlay glyph. */
function overlayCount(fb: FrameBuffer, ch: string): number {
  let n = 0;
  for (let i = 0; i < fb.overlayCh.length; i++) if (fb.overlayCh[i] === ch.charCodeAt(0)) n++;
  return n;
}

/** Bounding box of cells carrying a given overlay glyph. */
function figureExtent(
  fb: FrameBuffer,
  ch: string,
): { top: number; bottom: number; left: number; right: number; width: number; height: number } {
  const code = ch.charCodeAt(0);
  let top = Infinity;
  let bottom = -Infinity;
  let left = Infinity;
  let right = -Infinity;
  for (let r = 0; r < fb.height; r++) {
    for (let c = 0; c < fb.width; c++) {
      if (fb.overlayCh[r * fb.width + c] === code) {
        if (r < top) top = r;
        if (r > bottom) bottom = r;
        if (c < left) left = c;
        if (c > right) right = c;
      }
    }
  }
  return { top, bottom, left, right, width: right - left + 1, height: bottom - top + 1 };
}

/** One floor cell beside its hero; hero on the floor keeps fog at 1. */
const ONE_FLOOR = levelFromAscii(['     ', ' .   ', '     ']);
/** A hero `@` sprite on a floor cell. */
const HERO_SPRITE: Sprite = { x: 1, y: 1, ch: '@', rgb: [0.9, 0.9, 0.9], cls: 'mon' };

describe('ortho/projection', () => {
  it('screenToCell inverts cellToScreen for every cell of a 79×21 level at k = 1, 2, 4', () => {
    for (const k of [1, 2, 4]) {
      const origin: Origin = { ox: 37, oy: 9, k };
      for (let x = 0; x < 79; x++) {
        for (let y = 0; y < 21; y++) {
          const { sx, sy } = cellToScreen(x, y, origin);
          const back = screenToCell(sx, sy, origin);
          expect(back.x).toBe(x);
          expect(back.y).toBe(y);
        }
      }
    }
  });

  it('every screen cell of a 120×56 viewport maps to a cell whose diamond contains it', () => {
    const origin: Origin = { ox: 44, oy: 8, k: 2 }; // renderOrtho's origin for hero (7,3) at 120×56
    for (let c = 0; c < 120; c++) {
      for (let r = 0; r < 56; r++) {
        const { x, y } = screenToCell(c, r, origin);
        expect(Number.isInteger(x)).toBe(true);
        expect(Number.isInteger(y)).toBe(true);
        const { sx, sy } = cellToScreen(x, y, origin);
        expect(c).toBeGreaterThanOrEqual(sx - 2 * origin.k);
        expect(c).toBeLessThanOrEqual(sx + 2 * origin.k);
        expect(r).toBeGreaterThanOrEqual(sy - origin.k);
        expect(r).toBeLessThanOrEqual(sy + origin.k);
      }
    }
  });
});

describe('ortho/zoom', () => {
  it('zoom picks k = 1 at 24 rows and k = 4 at 104 rows and opts.zoom overrides', () => {
    const at24 = makeFrameBuffer(80, 24);
    renderOrtho(ONE_FLOOR, { x: 1, y: 1 }, [HERO_SPRITE], at24);
    expect(figureExtent(at24, '@').width).toBe(1); // k = 1 → width 2k−1 = 1

    const at104 = makeFrameBuffer(80, 104);
    renderOrtho(ONE_FLOOR, { x: 1, y: 1 }, [HERO_SPRITE], at104);
    expect(figureExtent(at104, '@').width).toBe(7); // k = 4 → width 2k−1 = 7

    const override = makeFrameBuffer(80, 24);
    renderOrtho(ONE_FLOOR, { x: 1, y: 1 }, [HERO_SPRITE], override, { zoom: 3 });
    expect(figureExtent(override, '@').width).toBe(5); // opts.zoom = 3 → width 2·3−1 = 5
  });
});

describe('ortho/look', () => {
  it('a wall block keeps a dark face median while its top rim and corner read bright', () => {
    // Two wall cells on the ROOM-like strip: the far one (dist 4, full
    // brightness) owns depth-6 cells with the 0.75 lid rim, the 0.55 corner
    // column and the dark faces; the face median stays below 0.16.
    const lvl = levelFromAscii(['          ', ' .#  #    ', '          ']);
    const fb = makeFrameBuffer(80, 104); // k = 4
    renderOrtho(lvl, { x: 1, y: 1 }, [], fb, { fogK: 0 });
    // far wall (5,1) → depth 6, not cutaway (|dx| = 4 > 2)
    let rimMax = 0;
    let cornerMax = 0;
    const faceVals: number[] = [];
    for (let r = 0; r < fb.height; r++) {
      for (let c = 70; c <= 74; c++) {
        if (fb.depth[r * fb.width + c] !== 6) continue;
        const cell = rgbAt(fb, c, r);
        const v = Math.max(cell[0], cell[1], cell[2]);
        if (c === 72) cornerMax = Math.max(cornerMax, v);
        else {
          rimMax = Math.max(rimMax, v);
          if (v > 0.01 && v < 0.2) faceVals.push(v);
        }
      }
    }
    faceVals.sort((a, b) => a - b);
    const median = faceVals.length % 2 === 1
      ? faceVals[(faceVals.length - 1) / 2]!
      : (faceVals[faceVals.length / 2 - 1]! + faceVals[faceVals.length / 2]!) / 2;
    expect(faceVals.length).toBeGreaterThan(0);
    expect(median).toBeLessThan(0.16);
    expect(rimMax).toBeGreaterThan(0.6);
    expect(cornerMax).toBeGreaterThan(0.4);
  });

  it('floor tiles vary per stone while the 0.30 seams read brighter', () => {
    // All-floor level with the hero at distance 0 (fog = 1): stones come from
    // `floorShade` (±20 %), seams paint at the absolute 0.30 level.
    const lvl: LevelView = { width: 9, height: 9, kindAt: () => 'floor', cellAt: () => null };
    const fb = makeFrameBuffer(160, 104); // k = 4
    renderOrtho(lvl, { x: 4, y: 4 }, [], fb, { fogK: 0 });
    const stones = new Set<number>();
    let seamMax = 0;
    let stoneMax = 0;
    for (let r = 0; r < fb.height; r++) {
      for (let c = 0; c < fb.width; c++) {
        // only the hero's own tile (depth 8): unfogged, no walls, no sprites
        if (fb.depth[r * fb.width + c] !== 8) continue;
        const v = rgbAt(fb, c, r)[0];
        if (Math.abs(v - 0.3) < 1e-6) seamMax = Math.max(seamMax, v);
        else {
          stones.add(Math.round(v * 1e4));
          stoneMax = Math.max(stoneMax, v);
        }
      }
    }
    expect(stones.size).toBeGreaterThanOrEqual(3);
    expect(seamMax).toBeGreaterThan(stoneMax);
  });

  it('a rim 6 cells from the hero is dimmer than one 1 cell away', () => {
    // The adjacent wall (2,1, dist 1, cutaway ghost at 0.35, rim crisp) versus
    // a wall 6 east (dist 6, full brightness, rim fogged): same 0.75 absolute
    // line, one crisp and ghosted (≈0.26), one fogged (0.75·e^−0.36 ≈ 0.52).
    // The ticket's comparison is fog-vs-crisp at full brightness: unfog the
    // ghost (÷0.35) and the far rim still reads dimmer.
    const lvl = levelFromAscii(['             ', ' .#    #     ', '             ']);
    const fb = makeFrameBuffer(160, 104); // k = 4
    renderOrtho(lvl, { x: 1, y: 1 }, [], fb);
    // lid-rim maxima per block: adjacent (2,1) → depth 3, far (7,1) → depth 8
    const rimOf = (depthVal: number): number => {
      let m = 0;
      for (let i = 0; i < fb.depth.length; i++) {
        if (fb.depth[i] !== depthVal) continue;
        m = Math.max(m, fb.rgb[i * 3]!);
      }
      return m;
    };
    const near = rimOf(3); // 0.75 crisp, ghosted ×0.35 → ≈0.26
    const far = rimOf(8); // 0.75 fogged at dist 6 → ≈0.52
    expect(near).toBeCloseTo(0.75 * 0.35, 2);
    expect(far).toBeCloseTo(0.75 * Math.exp(-0.06 * 6), 2);
    expect(far / 1).toBeLessThan(near / 0.35); // fog dims the far rim below crisp
  });
});

describe('ortho/terrain', () => {
  it('a wall block at k = 2 is 3k rows taller than its floor diamond', () => {
    // Geometry only (levels move to ortho/look): a flat stone block's lid
    // sits 3k rows above its floor diamond.
    const stone: LevelView = {
      width: 7,
      height: 7,
      kindAt(x, y) {
        if (x === 4 && y === 4) return 'stone';
        if (x === 1 && y === 1) return 'floor';
        return 'unexplored';
      },
      cellAt: () => null,
    };
    const fb = makeFrameBuffer(120, 56); // k = 2
    renderOrtho(stone, { x: 1, y: 1 }, [], fb, { fogK: 0.06 });
    // hero (1,1) at 120×56 → block cell (4,4) → sx 60, sy 42.
    // The block is 3 cells south-east (|dx| = |dy| = 3 > 2), so it is NOT cutaway.
    const sx = 60;
    const sy = 42;
    const k = 2;
    const h = 3 * k;
    // the block is 3k rows taller than its floor diamond: nothing above it
    expect(fb.depth[sx + (sy - k - h - 1) * fb.width]).toBe(Number.POSITIVE_INFINITY);
    expect(fb.depth[sx + (sy - k - h) * fb.width]).not.toBe(Number.POSITIVE_INFINITY);
  });

  it('unexplored cells carry the lattice (seam cells brighter than interior cells, both dim)', () => {
    const allUnexplored = levelFromAscii(['     ', '     ', '     ']);
    const fb = makeFrameBuffer(80, 104); // k = 4 so the diamond seams are sampled
    renderOrtho(allUnexplored, { x: 1, y: 1 }, [], fb);
    let lit = 0;
    let dark = 0;
    let maxV = 0;
    for (let i = 0; i < fb.rgb.length; i++) {
      const v = Math.max(fb.rgb[i * 3]!, fb.rgb[i * 3 + 1]!, fb.rgb[i * 3 + 2]!);
      if (v > 0) lit++;
      else dark++;
      if (v > maxV) maxV = v;
    }
    expect(lit).toBeGreaterThan(0); // the diamond lattice seams are lit
    expect(dark).toBeGreaterThan(0); // interiors stay black
    expect(maxV).toBeLessThan(0.2); // both are dim
  });
});

describe('ortho/sprites', () => {
  it('a wall south-east of a figure far from the hero covers it', () => {
    // figure on floor (5,5), far from the hero (1,1) so the cutaway does not
    // apply; walls at (6,5) and (5,6) are south-east of the figure (sum 11 > 10)
    const lvl = levelFromAscii([
      '         ',
      ' .       ',
      '         ',
      '         ',
      '         ',
      '     .#  ',
      '     #   ',
      '         ',
    ]);
    const sprite: Sprite = { x: 5, y: 5, ch: 'M', rgb: [0.9, 0.1, 0.1], cls: 'mon' };
    const fb = makeFrameBuffer(80, 24); // k = 1
    renderOrtho(lvl, { x: 1, y: 1 }, [sprite], fb);
    expect(overlayCount(fb, 'M')).toBe(0);
  });

  it('the hero figure at k = 4 is 14 rows tall and 7 wide', () => {
    const fb = makeFrameBuffer(80, 104); // k = 4
    renderOrtho(ONE_FLOOR, { x: 1, y: 1 }, [HERO_SPRITE], fb);
    const ext = figureExtent(fb, '@');
    expect(ext.height).toBe(14); // 3.5k rows
    expect(ext.width).toBe(7); // 2k−1 columns
  });

  it('ortho draws a tiled jackal on its tile with a transparent top row', () => {
    // All-floor level, hero far from the jackal so nothing occludes it. k = 2.
    const lvl: LevelView = { width: 8, height: 6, kindAt: () => 'floor', cellAt: () => null };
    const jackalTile = monsterTile(loadTiles(), 'jackal')!;
    const sprite: Sprite = { x: 6, y: 4, ch: 'd', rgb: [0.9, 0.1, 0.1], cls: 'mon', height: 0.5, tile: jackalTile };
    const fb = makeFrameBuffer(120, 56); // k = 2
    renderOrtho(lvl, { x: 1, y: 1 }, [sprite], fb, { zoom: 2 });
    // hero (1,1) at 120×56 → origin {60, 24, 2}; jackal (6,4) → sy 46. Height 0.5
    // → rows = round(0.5·3.5·2/0.9) = 4, topmost drawn row = ceil(sy − 4) = 42.
    const topRow = 46 - 4;
    let top = 0;
    for (let c = 0; c < fb.width; c++) {
      if (fb.overlayCh[topRow * fb.width + c] === 'd'.charCodeAt(0)) top++;
    }
    expect(top).toBe(0); // the jackal tile's top rows are transparent
    // body rows below carry the letter
    let body = 0;
    for (let r = topRow + 1; r <= 45; r++) {
      for (let c = 0; c < fb.width; c++) {
        if (fb.overlayCh[r * fb.width + c] === 'd'.charCodeAt(0)) body++;
      }
    }
    expect(body).toBeGreaterThan(0);
  });
});

describe('ortho/cutaway', () => {
  it('a wall south-east of and adjacent to the hero is painted at <= 0.4 of its normal brightness while a wall 4 cells away keeps full brightness', () => {
    const lvl = levelFromAscii(['          ', ' .#  #    ', '          ']);
    const fb = makeFrameBuffer(80, 104); // k = 4
    renderOrtho(lvl, { x: 1, y: 1 }, [], fb, { fogK: 0 });
    // wall (2,1) is adjacent south-east of the hero (sum 3 > 2, |dx|,|dy| <= 2)
    // -> cutaway ghost at 0.35; wall (5,1) is 4 cells east (|dx| = 4) -> full.
    // Compare the brightest lid-rim cell per block (the 0.75 line): the
    // ghost peaks at 0.75·0.35, the full block at 0.75.
    const rimOf = (depthVal: number): number => {
      let m = 0;
      for (let i = 0; i < fb.depth.length; i++) {
        if (fb.depth[i] !== depthVal) continue;
        m = Math.max(m, fb.rgb[i * 3]!);
      }
      return m;
    };
    const adj = rimOf(3);
    const far = rimOf(6);
    expect(adj).toBeLessThanOrEqual(0.4 * far);
    expect(adj).toBeLessThan(far);
    expect(far).toBeCloseTo(0.75, 2); // the bright lid rim, kept full
  });

  it('the hero figure centre cell still carries the hero letter when a wall block covers it', () => {
    const lvl = levelFromAscii(['      ', ' .#   ', '      ']);
    const HERO: Sprite = { x: 1, y: 1, ch: '@', rgb: [0.9, 0.9, 0.9], cls: 'mon' };
    const fb = makeFrameBuffer(80, 104); // k = 4
    renderOrtho(lvl, { x: 1, y: 1 }, [HERO], fb, { fogK: 0 });
    // the adjacent wall (2,1) covers the hero's centre cell (40,50); the cutaway
    // keeps the hero letter there, dimmed to 0.7 of its colour
    const i = 50 * fb.width + 40;
    const o = i * 3;
    expect(fb.overlayCh[i]).toBe('@'.charCodeAt(0));
    expect(fb.overlayRgb[o]).toBeCloseTo(0.9 * 0.7, 2);
  });

  it('a monster 1 cell from the hero behind a wall corner keeps its letter', () => {
    const lvl = levelFromAscii(['      ', ' ..#  ', '      ']);
    const HERO: Sprite = { x: 1, y: 1, ch: '@', rgb: [0.9, 0.9, 0.9], cls: 'mon' };
    const J: Sprite = { x: 2, y: 1, ch: 'j', rgb: [0.9, 0.1, 0.1], cls: 'mon' };
    const fb = makeFrameBuffer(80, 104); // k = 4
    renderOrtho(lvl, { x: 1, y: 1 }, [HERO, J], fb, { fogK: 0 });
    // the wall (3,1) is south-east of the monster (sum 4 > 3) and within 2 cells
    // of it, so it is cut away and the jackal keeps its letter
    expect(overlayCount(fb, 'j')).toBeGreaterThan(0);
  });
});

describe('ortho/golden', () => {
  it('matches the committed golden render of ROOM at 80×24 (k = 1)', () => {
    const fb = makeFrameBuffer(80, 24);
    renderOrtho(ROOM, { x: 7, y: 3 }, [], fb);
    const out = quantize(fb);
    if (process.env.UPDATE_GOLDEN === '1') {
      writeFileSync(GOLDEN, out);
      return;
    }
    const expected = readFileSync(GOLDEN, 'utf8');
    expect(out).toBe(expected);
  });

  it('matches the committed zoom golden render of ROOM at 160×104 (k = 4)', () => {
    const fb = makeFrameBuffer(160, 104);
    const tiles = loadTiles();
    // a tiled jackal and a potion alongside the (untiled) hero; k = 4 so the
    // potion's thin bottle is wider than one screen column and actually shows
    const sprites: Sprite[] = [
      { x: 7, y: 3, ch: '@', rgb: [0.95, 0.95, 0.95], cls: 'mon' },
      { x: 5, y: 3, ch: 'd', rgb: [0.9, 0.1, 0.1], cls: 'mon', height: 0.5, tile: monsterTile(tiles, 'jackal')! },
      { x: 9, y: 3, ch: '!', rgb: [0.9, 0.9, 0.2], cls: 'obj', height: 0.35, tile: objectTile(tiles, undefined, 'potion')! },
    ];
    renderOrtho(ROOM, { x: 7, y: 3 }, sprites, fb);
    const out = quantize(fb);
    if (process.env.UPDATE_GOLDEN === '1') {
      writeFileSync(ZOOM_GOLDEN, out);
      return;
    }
    const expected = readFileSync(ZOOM_GOLDEN, 'utf8');
    expect(out).toBe(expected);
  });
});

describe('ortho/performance', () => {
  it('renders 200×60 (k = 2) in under 8 ms on average over 20 runs', () => {
    const fb = makeFrameBuffer(200, 60);
    const tiles = loadTiles();
    // three tiled sprites in view
    const sprites: Sprite[] = [
      { x: 6, y: 5, ch: 'd', rgb: [0.9, 0.9, 0.9], cls: 'mon', height: 0.5, tile: monsterTile(tiles, 'jackal')! },
      { x: 5, y: 4, ch: '!', rgb: [0.9, 0.9, 0.2], cls: 'obj', height: 0.35, tile: objectTile(tiles, undefined, 'potion')! },
      { x: 7, y: 5, ch: 'k', rgb: [0.9, 0.9, 0.9], cls: 'mon', height: 0.5, tile: monsterTile(tiles, 'kitten')! },
    ];
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      renderOrtho(ROOM, { x: 7, y: 3 }, sprites, fb);
      times.push(performance.now() - t0);
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    // eslint-disable-next-line no-console
    console.log(`ortho 200×60 average: ${avg.toFixed(3)} ms over 20 runs`);
    expect(avg).toBeLessThan(8);
  });
});
