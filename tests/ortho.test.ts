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

describe('ortho/terrain', () => {
  it('a wall block at k = 2 is 3k rows taller than its floor diamond with the top brighter than the right face brighter than the left face', () => {
    // A flat stone block (no brick) so the face ordering is exact.
    const stone: LevelView = {
      width: 5,
      height: 5,
      kindAt(x, y) {
        if (x === 2 && y === 2) return 'stone';
        if (x === 1 && y === 1) return 'floor';
        return 'unexplored';
      },
      cellAt: () => null,
    };
    const fb = makeFrameBuffer(120, 56); // k = 2
    renderOrtho(stone, { x: 1, y: 1 }, [], fb);
    // hero (1,1) at 120×56 → origin {60, 24, 2}; block cell (2,2) → sx 60, sy 34
    const sx = 60;
    const sy = 34;
    const k = 2;
    const h = 3 * k;
    const base = 0.12; // KIND_COLORS.stone[0]
    const atten = Math.exp(-0.04 * 1);
    // top face (flat ×1.0) at (sx, 28), right face (×0.75) at (sx+2, 33), left (×0.55) at (sx−2, 33)
    const top = rgbAt(fb, sx, sy - k - h + 2)[0];
    const right = rgbAt(fb, sx + 2, sy - 1)[0];
    const left = rgbAt(fb, sx - 2, sy - 1)[0];
    expect(top).toBeCloseTo(base * atten, 4);
    expect(right).toBeCloseTo(base * 0.75 * atten, 4);
    expect(left).toBeCloseTo(base * 0.55 * atten, 4);
    expect(top).toBeGreaterThan(right);
    expect(right).toBeGreaterThan(left);
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
  it('a wall south-east of a figure covers it', () => {
    // figure on floor (2,2); walls at (3,2) and (2,3), both south-east (sum 5 > 4)
    const lvl = levelFromAscii(['      ', ' .    ', ' ..#  ', '  #   ', '      ']);
    const sprite: Sprite = { x: 2, y: 2, ch: 'M', rgb: [0.9, 0.1, 0.1], cls: 'mon' };
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

  it('matches the committed zoom golden render of ROOM at 120×56 (k = 2)', () => {
    const fb = makeFrameBuffer(120, 56);
    const sprites: Sprite[] = [
      { x: 7, y: 3, ch: '@', rgb: [0.95, 0.95, 0.95], cls: 'mon' },
      { x: 5, y: 3, ch: 'k', rgb: [0.9, 0.1, 0.1], cls: 'mon' },
      { x: 9, y: 3, ch: '*', rgb: [0.9, 0.9, 0.2], cls: 'obj' },
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
    const sprites: Sprite[] = [
      { x: 6, y: 5, ch: 'k', rgb: [0.9, 0.9, 0.9], cls: 'mon' },
      { x: 5, y: 4, ch: '*', rgb: [0.9, 0.9, 0.2], cls: 'obj' },
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
