/**
 * Golden + unit tests for the first-person raycaster (docs/render.md).
 * The ASCII quantizer (T-0006) is deliberately NOT imported here: these tests
 * use a tiny test-local 10-glyph ramp so the golden is independent of it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderFirstPerson, KIND_COLORS } from '../src/render/raycast.js';
import { makeFrameBuffer, type FrameBuffer, type Pose, type Sprite } from '../src/model/types.js';
import { levelFromAscii, ROOM, L_SHAPED } from './fixtures/levels.js';

const GOLDEN = fileURLToPath(new URL('./raycast-golden.txt', import.meta.url));
const TEXTURED_GOLDEN = fileURLToPath(new URL('./raycast-textured-golden.txt', import.meta.url));

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

/** A pose helper for readability. */
function pose(x: number, y: number, yaw: number): Pose {
  return { x, y, yaw };
}

/** Depth read at the centre column of a buffer. */
function centreDepth(fb: FrameBuffer): number {
  return fb.depth[Math.floor(fb.width / 2) + Math.floor(fb.height / 2) * fb.width]!;
}

/** True when every field of two buffers is bit-identical. */
function sameBuffer(a: FrameBuffer, b: FrameBuffer): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  for (let i = 0; i < a.rgb.length; i++) if (a.rgb[i] !== b.rgb[i]) return false;
  for (let i = 0; i < a.depth.length; i++) if (a.depth[i] !== b.depth[i]) return false;
  for (let i = 0; i < a.overlayCh.length; i++) if (a.overlayCh[i] !== b.overlayCh[i]) return false;
  for (let i = 0; i < a.overlayRgb.length; i++) if (a.overlayRgb[i] !== b.overlayRgb[i]) return false;
  return true;
}

/** Wall-pixel shade factors (0.7 = E/W face, 1.0 = N/S face) present in a render. */
function wallShades(fb: FrameBuffer, fogK: number): number[] {
  const shades: number[] = [];
  const n = fb.width * fb.height;
  for (let i = 0; i < n; i++) {
    const d = fb.depth[i];
    if (!Number.isFinite(d)) continue;
    const o = i * 3;
    const r = fb.rgb[o]!;
    const g = fb.rgb[o + 1]!;
    const b = fb.rgb[o + 2]!;
    if (r < 0.01) continue;
    const gr = g / r;
    const br = b / r;
    // wall hue: g/r≈0.964, b/r≈0.909 (floor is 0.925/0.825 — excluded by this gate)
    if (Math.abs(gr - 0.964) < 0.02 && Math.abs(br - 0.909) < 0.02) {
      shades.push(r / (KIND_COLORS.wall[0] * Math.exp(-fogK * d!)));
    }
  }
  return shades;
}

/** Rows in one column that match the grey wall hue (excludes floor/ceiling). */
function wallSpan(fb: FrameBuffer, col: number): number[] {
  const rows: number[] = [];
  for (let y = 0; y < fb.height; y++) {
    const o = (y * fb.width + col) * 3;
    const r = fb.rgb[o]!;
    const g = fb.rgb[o + 1]!;
    const b = fb.rgb[o + 2]!;
    if (r < 0.01) continue;
    const gr = g / r;
    const br = b / r;
    if (Math.abs(gr - 0.964) < 0.02 && Math.abs(br - 0.909) < 0.02) rows.push(y);
  }
  return rows;
}

describe('raycast/walls', () => {
  it('lands a wall straight ahead at the expected screen height (±1 row) and column range', () => {
    // 1-wide corridor; hero at (1.5, 4.0) facing north, north wall at distance 3.
    const level = levelFromAscii(['####', '#..#', '#..#', '#..#', '#..#', '####']);
    const fb = makeFrameBuffer(80, 24);
    renderFirstPerson(level, pose(1.5, 4.0, 0), [], fb);
    const c = Math.floor(fb.width / 2);
    const d = centreDepth(fb);
    expect(d).toBeCloseTo(3, 1);
    const horizon = fb.height / 2;
    const fV = fb.height / (2 * Math.tan(((70 * fb.height * 2) / fb.width / 2) * (Math.PI / 180)));
    const top = horizon - (fV * 0.5) / d;
    const bot = horizon + (fV * 0.5) / d;
    // topmost and bottommost WALL rows at the centre column match the projection (±1);
    // the hue gate excludes the warmer floor below the wall.
    const span = wallSpan(fb, c);
    expect(span.length).toBeGreaterThan(0);
    const first = span[0]!;
    const last = span[span.length - 1]!;
    expect(first).toBeGreaterThanOrEqual(Math.floor(top) - 1);
    expect(first).toBeLessThanOrEqual(Math.floor(top) + 1);
    expect(last).toBeGreaterThanOrEqual(Math.floor(bot) - 1);
    expect(last).toBeLessThanOrEqual(Math.floor(bot) + 1);
    // the north wall spans a broad column range at mid-height
    const mid = Math.floor(fb.height / 2);
    for (let x = 36; x <= 44; x++) {
      expect(fb.rgb[(mid * fb.width + x) * 3]!).toBeGreaterThan(0.02);
    }
  });

  it('gives the E/W face shade (70%) on one side when facing a wall at 45°', () => {
    // A single wall cell with open floor around it; from the south-west both its
    // west face (E/W → 0.7) and south face (N/S → 1.0) are visible at 45°.
    const level = levelFromAscii(['#######', '#.....#', '#..#..#', '#.....#', '#######']);
    const fb = makeFrameBuffer(80, 24);
    renderFirstPerson(level, pose(1.5, 2.5, Math.PI / 4), [], fb);
    const shades = wallShades(fb, 0.18);
    expect(shades.length).toBeGreaterThan(0);
    expect(shades.some((s) => Math.abs(s - 0.7) < 0.05)).toBe(true);
    expect(shades.some((s) => Math.abs(s - 1.0) < 0.05)).toBe(true);
  });

  it('treats a north wall at yaw 0 as a 100% (N/S) face', () => {
    const level = levelFromAscii(['####', '#..#', '#..#', '#..#', '####']);
    const fb = makeFrameBuffer(80, 24);
    renderFirstPerson(level, pose(1.5, 3.0, 0), [], fb);
    const shades = wallShades(fb, 0.18);
    expect(shades.some((s) => Math.abs(s - 1.0) < 0.05)).toBe(true);
  });

  it('stops rays at unexplored cells, which render as dark stone', () => {
    const level = levelFromAscii(['##########', '#.....   #', '##########']);
    const fb = makeFrameBuffer(80, 24);
    renderFirstPerson(level, pose(1.5, 1.5, Math.PI / 2), [], fb);
    const d = centreDepth(fb);
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBeCloseTo(4.5, 1); // west face of the first unexplored cell (col 6)
    const c = Math.floor(fb.width / 2);
    const mid = Math.floor(fb.height / 2);
    // the unexplored wall is near-black (stone colour), not a bright floor
    const r = fb.rgb[(mid * fb.width + c) * 3]!;
    const g = fb.rgb[(mid * fb.width + c) * 3 + 1]!;
    const b = fb.rgb[(mid * fb.width + c) * 3 + 2]!;
    expect(Math.max(r, g, b)).toBeLessThan(0.06);
  });

  it('treats a closed door as solid and door-coloured, an open door as passable', () => {
    const closedLevel = levelFromAscii(['#########', '#....+..#', '#########']);
    const closed = makeFrameBuffer(80, 24);
    renderFirstPerson(closedLevel, pose(1.5, 1.5, Math.PI / 2), [], closed);
    expect(centreDepth(closed)).toBeCloseTo(3.5, 1); // stopped at the door (west face at x=5)
    const c = Math.floor(closed.width / 2);
    const mid = Math.floor(closed.height / 2);
    const i = (mid * closed.width + c) * 3;
    // brownish: red dominant over blue, matching door_closed hue
    expect(closed.rgb[i]!).toBeGreaterThan(closed.rgb[i + 2]!);
    expect(closed.rgb[i]!).toBeGreaterThan(0.15);

    const openLevel = levelFromAscii(['#########', '#....' + "'" + '..#', '#########']);
    const open = makeFrameBuffer(80, 24);
    renderFirstPerson(openLevel, pose(1.5, 1.5, Math.PI / 2), [], open);
    // the ray passes through the open door and reaches the east wall (x=8) instead
    expect(centreDepth(open)).toBeCloseTo(6.5, 1);
  });

  it('renders a floor row under a water cell as blue-dominant', () => {
    const level = levelFromAscii(['#########', '#..~~~..#', '#########']);
    const fb = makeFrameBuffer(80, 24);
    renderFirstPerson(level, pose(1.5, 1.5, Math.PI / 2), [], fb);
    let blueCells = 0;
    for (let y = Math.ceil(fb.height / 2); y < fb.height; y++) {
      for (let x = 0; x < fb.width; x++) {
        const i = (y * fb.width + x) * 3;
        const r = fb.rgb[i]!;
        const g = fb.rgb[i + 1]!;
        const b = fb.rgb[i + 2]!;
        if (b > r && b > g && b > 0.1) blueCells++;
      }
    }
    expect(blueCells).toBeGreaterThan(0);
  });
});

describe('raycast/yaw', () => {
  it('looks north at yaw 0 (the ROOM north wall fills the view) and east at +π/2', () => {
    const north = makeFrameBuffer(80, 24);
    renderFirstPerson(ROOM, pose(7.5, 3.5, 0), [], north);
    expect(centreDepth(north)).toBeLessThan(4); // close north wall

    const east = makeFrameBuffer(80, 24);
    renderFirstPerson(ROOM, pose(7.5, 3.5, Math.PI / 2), [], east);
    // looking east through the open doorway: no wall directly ahead (ray leaves the map)
    expect(Number.isFinite(centreDepth(east))).toBe(false);
  });
});

describe('raycast/sprites', () => {
  it('does not draw a sprite behind a wall, and draws one in view with more cells when nearer', () => {
    // Wall cell at (3,2); hero west of it facing east. Sprite A east of the wall
    // (hidden), sprite B west of it (visible).
    const level = levelFromAscii(['########', '#......#', '#..#...#', '#......#', '########']);
    const hidden: Sprite = { x: 4, y: 2, ch: 'A', rgb: [0.9, 0.1, 0.1], cls: 'mon' };
    const visible: Sprite = { x: 2, y: 2, ch: 'B', rgb: [0.1, 0.9, 0.1], cls: 'mon' };
    const fb = makeFrameBuffer(80, 24);
    renderFirstPerson(level, pose(1.5, 2.5, Math.PI / 2), [hidden, visible], fb);
    let aCells = 0;
    let bCells = 0;
    for (let i = 0; i < fb.overlayCh.length; i++) {
      if (fb.overlayCh[i] === 'A'.charCodeAt(0)) aCells++;
      if (fb.overlayCh[i] === 'B'.charCodeAt(0)) bCells++;
    }
    expect(aCells).toBe(0); // hidden behind the wall
    expect(bCells).toBeGreaterThan(0);

    // open room: a near sprite writes more overlay cells than a far one, and the
    // near one must not fully cover the far one — place them in different parts
    // of the view (near up-right, far down-right) in a wide room.
    const open = levelFromAscii([
      '#############',
      '#...........#',
      '#...........#',
      '#...........#',
      '#############',
    ]);
    const near: Sprite = { x: 3, y: 1, ch: 'n', rgb: [0.8, 0.8, 0.8], cls: 'mon' };
    const far: Sprite = { x: 8, y: 3, ch: 'f', rgb: [0.8, 0.8, 0.8], cls: 'mon' };
    const fb2 = makeFrameBuffer(80, 24);
    renderFirstPerson(open, pose(1.5, 2.5, Math.PI / 2), [far, near], fb2);
    let nCells = 0;
    let fCells = 0;
    for (let i = 0; i < fb2.overlayCh.length; i++) {
      if (fb2.overlayCh[i] === 'n'.charCodeAt(0)) nCells++;
      if (fb2.overlayCh[i] === 'f'.charCodeAt(0)) fCells++;
    }
    expect(nCells).toBeGreaterThan(0);
    expect(fCells).toBeGreaterThan(0);
    expect(nCells).toBeGreaterThan(fCells);
  });
});

describe('raycast/determinism', () => {
  it('clears overlay glyphs from a previous frame', () => {
    const level = levelFromAscii(['#############', '#...........#', '#...........#', '#############']);
    const sprite: Sprite = { x: 6, y: 1, ch: 'G', rgb: [0.8, 0.2, 0.2], cls: 'mon' };
    const fb = makeFrameBuffer(80, 24);
    renderFirstPerson(level, pose(1.5, 1.5, Math.PI / 2), [sprite], fb);
    const withSprite = fb.overlayCh.reduce((n, ch) => n + (ch !== 0 ? 1 : 0), 0);
    expect(withSprite).toBeGreaterThan(0);
    // same pose, same buffer, but no sprites: every stale glyph must be cleared
    renderFirstPerson(level, pose(1.5, 1.5, Math.PI / 2), [], fb);
    let nonZero = 0;
    for (let i = 0; i < fb.overlayCh.length; i++) if (fb.overlayCh[i] !== 0) nonZero++;
    expect(nonZero).toBe(0);
  });

  it('paints every cell for odd heights and escaping rays', () => {
    // All-floor 79×21 level with a camera whose rays escape the map / exceed maxDepth,
    // so no wall covers the horizon gap. Pre-fill rgb/depth with −1; after the render
    // no −1 may remain in either plane for any buffer size / rows parity.
    const floor79 = levelFromAscii([
      '###############################################################################',
      '#.............................................................................#',
      '#.............................................................................#',
      '#.............................................................................#',
      '#.............................................................................#',
      '#.............................................................................#',
      '#.............................................................................#',
      '#.............................................................................#',
      '#.............................................................................#',
      '#.............................................................................#',
      '#.............................................................................#',
      '#.............................................................................#',
      '#.............................................................................#',
      '#.............................................................................#',
      '#.............................................................................#',
      '#.............................................................................#',
      '#.............................................................................#',
      '#.............................................................................#',
      '#.............................................................................#',
      '#.............................................................................#',
      '###############################################################################',
    ]);
    const cases: Array<[number, number]> = [
      [80, 21],
      [80, 24],
      [33, 15],
    ];
    for (const [w, h] of cases) {
      const fb = makeFrameBuffer(w, h);
      fb.rgb.fill(-1);
      fb.depth.fill(-1);
      renderFirstPerson(floor79, pose(40, 10.5, 0), [], fb, { maxDepth: 3 });
      for (let i = 0; i < fb.rgb.length; i++) expect(fb.rgb[i]).not.toBe(-1);
      for (let i = 0; i < fb.depth.length; i++) expect(fb.depth[i]).not.toBe(-1);
    }
  });

  it('renders byte-identical buffers for the same input', () => {
    const level = levelFromAscii(['########', '#......#', '#..#...#', '#......#', '########']);
    const sprite: Sprite = { x: 2, y: 1, ch: 'Z', rgb: [0.2, 0.5, 0.9], cls: 'mon' };
    const a = makeFrameBuffer(80, 24);
    const b = makeFrameBuffer(80, 24);
    renderFirstPerson(level, pose(1.5, 1.5, Math.PI / 4), [sprite], a);
    renderFirstPerson(level, pose(1.5, 1.5, Math.PI / 4), [sprite], b);
    expect(sameBuffer(a, b)).toBe(true);
  });

  it('renders the L-shaped level without error (validates the fixture)', () => {
    const fb = makeFrameBuffer(80, 24);
    renderFirstPerson(L_SHAPED, pose(2.5, 1.5, 0), [], fb);
    expect(fb.depth.length).toBe(fb.width * fb.height);
  });
});

describe('raycast/surface-detail', () => {
  it('a wall 3 cells away renders with at least 3 distinct brightness levels in one row (the blank-block case)', () => {
    // 1-wide corridor, hero at (1.5, 4.0) facing north, north wall at distance 3.
    const level = levelFromAscii(['####', '#..#', '#..#', '#..#', '#..#', '####']);
    const fb = makeFrameBuffer(80, 24);
    renderFirstPerson(level, pose(1.5, 4.0, 0), [], fb);
    // find a row dominated by the grey wall hue and count its distinct brightness levels
    let saw = false;
    for (let y = 0; y < fb.height; y++) {
      const levels = new Set<number>();
      let wallCols = 0;
      for (let x = 0; x < fb.width; x++) {
        const o = (y * fb.width + x) * 3;
        const r = fb.rgb[o]!;
        if (r < 0.02) continue;
        const gr = fb.rgb[o + 1]! / r;
        const br = fb.rgb[o + 2]! / r;
        if (Math.abs(gr - 0.964) < 0.03 && Math.abs(br - 0.909) < 0.03) {
          wallCols++;
          levels.add(Math.round(r * 1000));
        }
      }
      if (wallCols > 10) {
        expect(levels.size).toBeGreaterThanOrEqual(3);
        saw = true;
        break;
      }
    }
    expect(saw).toBe(true);
  });

  it('floor cells show grid lines (a row with at least 2 distinct brightness levels)', () => {
    const level = levelFromAscii([
      '#############',
      '#...........#',
      '#...........#',
      '#...........#',
      '#...........#',
      '#############',
    ]);
    const fb = makeFrameBuffer(80, 24);
    renderFirstPerson(level, pose(7.5, 2.5, Math.PI / 2), [], fb);
    let saw = false;
    for (let y = Math.ceil(fb.height / 2); y < fb.height; y++) {
      const levels = new Set<number>();
      let lit = 0;
      for (let x = 0; x < fb.width; x++) {
        const r = fb.rgb[(y * fb.width + x) * 3]!;
        if (r < 0.02) continue;
        lit++;
        levels.add(Math.round(r * 1000));
      }
      if (lit > fb.width / 2) {
        expect(levels.size).toBeGreaterThanOrEqual(2);
        saw = true;
        break;
      }
    }
    expect(saw).toBe(true);
  });

  it('a doorway column shows frame posts (wall colour) at its edges and floor colour in the middle', () => {
    // A doorway in an east-west wall two cells ahead; the hero faces it from the south.
    const level = levelFromAscii([
      '#############',
      '#...........#',
      '#......D....#',
      '#...........#',
      '#...........#',
      '#############',
    ]);
    const fb = makeFrameBuffer(80, 24);
    renderFirstPerson(level, pose(7.5, 4.5, 0), [], fb);
    const c = Math.floor(fb.width / 2);
    const doorRows: number[] = [];
    const wallRows: number[] = [];
    for (let y = 0; y < fb.height; y++) {
      const o = (y * fb.width + c) * 3;
      const r = fb.rgb[o]!;
      const g = fb.rgb[o + 1]!;
      const b = fb.rgb[o + 2]!;
      if (r < 0.02) continue;
      // strong red dominance = the door-coloured threshold (the opening's middle)
      if (r / Math.max(b, 1e-6) > 2.2 && r > 0.05) doorRows.push(y);
      // grey hue = wall, which includes the door's frame posts
      else if (Math.abs(g / r - 0.964) < 0.03 && Math.abs(b / r - 0.909) < 0.03) wallRows.push(y);
    }
    expect(doorRows.length).toBeGreaterThan(0); // the middle is floor-coloured, not a wall
    expect(wallRows.length).toBeGreaterThan(0); // a wall-coloured frame post is present
    // the frame sits at the opening's edge: a door row directly touches a wall frame row
    expect(doorRows.some((d) => wallRows.includes(d - 1) || wallRows.includes(d + 1))).toBe(true);
  });
});

describe('raycast/golden', () => {
  it('matches the committed flat (detail:false) golden render of ROOM at 80×24 facing east', () => {
    const fb = makeFrameBuffer(80, 24);
    renderFirstPerson(ROOM, pose(7.5, 3.5, Math.PI / 2), [], fb, { detail: false });
    const out = quantize(fb);
    if (process.env.UPDATE_GOLDEN === '1') {
      writeFileSync(GOLDEN, out);
      return;
    }
    const expected = readFileSync(GOLDEN, 'utf8');
    expect(out).toBe(expected);
  });

  it('matches the committed default-detail (textured) golden render of ROOM at 80×24 facing east', () => {
    const fb = makeFrameBuffer(80, 24);
    renderFirstPerson(ROOM, pose(7.5, 3.5, Math.PI / 2), [], fb);
    const out = quantize(fb);
    if (process.env.UPDATE_GOLDEN === '1') {
      writeFileSync(TEXTURED_GOLDEN, out);
      return;
    }
    const expected = readFileSync(TEXTURED_GOLDEN, 'utf8');
    expect(out).toBe(expected);
  });
});

describe('raycast/performance', () => {
  it('renders 200×60 in under 8 ms on average over 20 runs with detail on', () => {
    const fb = makeFrameBuffer(200, 60);
    const sprite: Sprite = { x: 6, y: 5, ch: 'k', rgb: [0.9, 0.9, 0.9], cls: 'mon' };
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      renderFirstPerson(ROOM, pose(7.5, 3.5, Math.PI / 4), [sprite], fb);
      times.push(performance.now() - t0);
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    // eslint-disable-next-line no-console
    console.log(`raycast 200×60 average: ${avg.toFixed(3)} ms over 20 runs`);
    expect(avg).toBeLessThan(8);
  });
});
