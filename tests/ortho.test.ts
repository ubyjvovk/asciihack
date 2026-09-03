/**
 * Golden + unit tests for the ortho / isometric renderer (docs/render.md).
 * Like the raycaster tests, the ASCII quantizer (T-0006) is deliberately NOT
 * imported: these tests use a tiny test-local 10-glyph ramp so the golden is
 * independent of it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderOrtho, cellToScreen, screenToCell } from '../src/render/ortho.js';
import { makeFrameBuffer, type FrameBuffer, type Sprite } from '../src/model/types.js';
import { levelFromAscii, ROOM } from './fixtures/levels.js';

const GOLDEN = fileURLToPath(new URL('./ortho-golden.txt', import.meta.url));

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

/** The origin renderOrtho derives for a hero in an 80×24 buffer. */
const ORIGIN = { ox: 40, oy: 10 };

/** Count how many cells carry a given overlay glyph. */
function overlayCount(fb: FrameBuffer, ch: string): number {
  let n = 0;
  for (let i = 0; i < fb.overlayCh.length; i++) if (fb.overlayCh[i] === ch.charCodeAt(0)) n++;
  return n;
}

/** RGB of one screen cell (the red channel, plus full triple). */
function rgbAt(fb: FrameBuffer, c: number, r: number): [number, number, number] {
  const o = (r * fb.width + c) * 3;
  return [fb.rgb[o]!, fb.rgb[o + 1]!, fb.rgb[o + 2]!];
}

/** One floor cell beside its hero; hero on the floor keeps fog at 1. */
const ONE_FLOOR = levelFromAscii(['     ', ' .   ', '     ']);

describe('ortho/projection', () => {
  it('round-trips every cell of a 79×21 level through cellToScreen/screenToCell', () => {
    const origin = { ox: 37, oy: 9 };
    for (let x = 0; x < 79; x++) {
      for (let y = 0; y < 21; y++) {
        const { sx, sy } = cellToScreen(x, y, origin);
        const back = screenToCell(sx, sy, origin);
        expect(back.x).toBe(x);
        expect(back.y).toBe(y);
      }
    }
  });

  it('maps every screen cell of an 80×24 viewport to exactly one map cell whose brick contains it', () => {
    for (let c = 0; c < 80; c++) {
      for (let r = 0; r < 24; r++) {
        const { x, y } = screenToCell(c, r, ORIGIN);
        expect(Number.isInteger(x)).toBe(true);
        expect(Number.isInteger(y)).toBe(true);
        const { sx, sy } = cellToScreen(x, y, ORIGIN);
        expect(r).toBe(sy);
        expect(c).toBeGreaterThanOrEqual(sx - 2);
        expect(c).toBeLessThanOrEqual(sx + 1);
      }
    }
  });

  it('anchors the hero brick at the centre of the viewport', () => {
    const fb = makeFrameBuffer(80, 24);
    renderOrtho(ONE_FLOOR, { x: 1, y: 1 }, [], fb);
    const hero = screenToCell(40, 12, { ox: 40 - 2 * (1 - 1), oy: 12 - (1 + 1) });
    expect(hero.x).toBe(1);
    expect(hero.y).toBe(1);
  });
});

describe('ortho/terrain', () => {
  it('paints a floor brick of exactly 4 cells, outer two at 85 %', () => {
    const fb = makeFrameBuffer(80, 24);
    renderOrtho(ONE_FLOOR, { x: 1, y: 1 }, [], fb);
    const { sx, sy } = cellToScreen(1, 1, ORIGIN);
    // inner columns at 100 %, outer two at 85 %
    expect(rgbAt(fb, sx - 1, sy)[0]).toBeCloseTo(0.4, 4);
    expect(rgbAt(fb, sx, sy)[0]).toBeCloseTo(0.4, 4);
    expect(rgbAt(fb, sx - 2, sy)[0]).toBeCloseTo(0.4 * 0.85, 4);
    expect(rgbAt(fb, sx + 1, sy)[0]).toBeCloseTo(0.4 * 0.85, 4);
    // the two cells above the brick are untouched (the floor has no extrusion)
    expect(fb.depth[(sy - 1) * fb.width + sx]).toBe(Number.POSITIVE_INFINITY);
  });

  it('extrudes a wall wallRows + 1 rows with the top brighter than the face', () => {
    const wall = levelFromAscii(['     ', ' .#  ', '     ']);
    const fb = makeFrameBuffer(80, 24);
    renderOrtho(wall, { x: 1, y: 1 }, [], fb);
    const { sx, sy } = cellToScreen(2, 1, ORIGIN);
    const face = 0.55 * 0.6 * Math.exp(-0.06); // 60 %, fog distance 1
    const top = 0.55 * Math.exp(-0.06); // 100 %
    expect(rgbAt(fb, sx, sy - 2)[0]).toBeCloseTo(top, 4);
    expect(rgbAt(fb, sx, sy - 1)[0]).toBeCloseTo(face, 4);
    expect(rgbAt(fb, sx, sy)[0]).toBeCloseTo(face, 4);
    // one row above the top face is untouched
    expect(fb.depth[(sy - 3) * fb.width + sx]).toBe(Number.POSITIVE_INFINITY);
  });

  it('lets a wall south-east of a floor tile occlude half of that tile brick', () => {
    const lvl = levelFromAscii(['     ', ' .#  ', '     ']); // floor (1,1), wall (2,1) east
    const fb = makeFrameBuffer(80, 24);
    renderOrtho(lvl, { x: 1, y: 1 }, [], fb);
    const { sx, sy } = cellToScreen(1, 1, ORIGIN);
    // west half stays floor; east half is overwritten by the wall face
    expect(rgbAt(fb, sx - 2, sy)[0]).toBeCloseTo(0.4 * 0.85, 4);
    expect(rgbAt(fb, sx - 1, sy)[0]).toBeCloseTo(0.4, 4);
    const face = 0.55 * 0.6 * Math.exp(-0.06);
    expect(rgbAt(fb, sx, sy)[0]).toBeCloseTo(face, 4);
    expect(rgbAt(fb, sx + 1, sy)[0]).toBeCloseTo(face, 4);
  });

  it('fogs a far tile darker than a near tile of the same kind', () => {
    const lvl = levelFromAscii(['          ', ' .        ', '          ', '          ', '    .     ', '          ']);
    const fb = makeFrameBuffer(80, 24);
    renderOrtho(lvl, { x: 1, y: 1 }, [], fb);
    const { sx: nSx, sy: nSy } = cellToScreen(1, 1, ORIGIN);
    const { sx: fSx, sy: fSy } = cellToScreen(4, 4, ORIGIN);
    const near = rgbAt(fb, nSx, nSy)[0];
    const far = rgbAt(fb, fSx, fSy)[0];
    expect(near).toBeCloseTo(0.4, 4);
    expect(far).toBeCloseTo(0.4 * Math.exp(-0.06 * 3), 4); // Chebyshev dist 3
    expect(far).toBeLessThan(near);
  });

  it('leaves unexplored cells black at Infinity depth', () => {
    const allUnexplored = levelFromAscii(['     ', '     ', '     ']);
    const fb = makeFrameBuffer(80, 24);
    renderOrtho(allUnexplored, { x: 1, y: 1 }, [], fb);
    for (let i = 0; i < fb.depth.length; i++) {
      expect(fb.depth[i]).toBe(Number.POSITIVE_INFINITY);
      expect(fb.rgb[i * 3]).toBe(0);
    }
  });
});

describe('ortho/sprites', () => {
  it('writes a sprite in the open as 2 overlay cells, and hides one behind walls', () => {
    const open = levelFromAscii(['     ', ' .   ', '     ']);
    const fo = makeFrameBuffer(80, 24);
    renderOrtho(open, { x: 1, y: 1 }, [{ x: 1, y: 1, ch: '@', rgb: [0.9, 0.9, 0.9], cls: 'mon' }], fo);
    expect(overlayCount(fo, '@')).toBe(2);

    // Sprite on floor (2,2) fully covered by walls east (3,2) and south (2,3),
    // both drawn after it (sum 5 > 4); each wall covers one of the two cells.
    const lvl = levelFromAscii(['      ', ' .    ', ' ..#  ', '  #   ', '      ']);
    const sprite: Sprite = { x: 2, y: 2, ch: 'M', rgb: [0.9, 0.1, 0.1], cls: 'mon' };
    const fb = makeFrameBuffer(80, 24);
    renderOrtho(lvl, { x: 1, y: 1 }, [sprite], fb);
    expect(overlayCount(fb, 'M')).toBe(0);
  });
});

describe('ortho/determinism', () => {
  it('writes every cell of the buffer each frame (pre-fill −1 probe)', () => {
    const lvl = levelFromAscii(['     ', ' .#  ', '     ']);
    const cases: Array<[number, number]> = [
      [80, 21],
      [33, 15],
    ];
    for (const [w, h] of cases) {
      const fb = makeFrameBuffer(w, h);
      fb.rgb.fill(-1);
      fb.depth.fill(-1);
      fb.overlayCh.fill(999);
      renderOrtho(lvl, { x: 1, y: 1 }, [], fb);
      for (let i = 0; i < fb.rgb.length; i++) expect(fb.rgb[i]).not.toBe(-1);
      for (let i = 0; i < fb.depth.length; i++) expect(fb.depth[i]).not.toBe(-1);
      for (let i = 0; i < fb.overlayCh.length; i++) expect(fb.overlayCh[i]).not.toBe(999);
    }
  });
});

describe('ortho/golden', () => {
  it('matches the committed golden render of ROOM with the hero at its centre', () => {
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
});

describe('ortho/performance', () => {
  it('renders 200×60 in under 40 ms on average over 20 runs', () => {
    const fb = makeFrameBuffer(200, 60);
    const sprite: Sprite = { x: 6, y: 5, ch: 'k', rgb: [0.9, 0.9, 0.9], cls: 'mon' };
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      renderOrtho(ROOM, { x: 7, y: 3 }, [sprite], fb);
      times.push(performance.now() - t0);
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    // eslint-disable-next-line no-console
    console.log(`ortho 200×60 average: ${avg.toFixed(3)} ms over 20 runs`);
    expect(avg).toBeLessThan(40);
  });
});
