/**
 * Golden + unit tests for the first-person raycaster (docs/render.md).
 * The ASCII quantizer (T-0006) is deliberately NOT imported here: these tests
 * use a tiny test-local 10-glyph ramp so the golden is independent of it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderFirstPerson, KIND_COLORS } from '../src/render/raycast.js';
import { makeFrameBuffer, type FrameBuffer, type LevelView, type Pose, type Sprite } from '../src/model/types.js';
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

/** Max overlay (sprite) RGB brightness at a cell. */
function overlayMax(fb: FrameBuffer, x: number, y: number): number {
  const o = (y * fb.width + x) * 3;
  return Math.max(fb.overlayRgb[o]!, fb.overlayRgb[o + 1]!, fb.overlayRgb[o + 2]!);
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
    // wall hue: g/r≈1.0, b/r≈1.0714 (floor is 1.0/1.1 — excluded by this gate);
    // edges/mortar are grey (b/r=1.0) so they are excluded too.
    if (Math.abs(gr - 1.0) < 0.02 && Math.abs(br - 1.0714) < 0.02) {
      shades.push(r / (KIND_COLORS.wall[0] * Math.exp(-fogK * d!)));
    }
  }
  return shades;
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
    // default camera: fixed 60° vertical FOV, horizon at 0.42 of the height
    const horizon = fb.height * 0.42;
    const fV = fb.height / (2 * Math.tan((60 / 2) * (Math.PI / 180)));
    const top = horizon - (fV * 0.5) / d;
    const bot = horizon + (fV * 0.5) / d;
    // topmost and bottommost WALL rows at the centre column match the projection
    // (±1). Detect the wall face by its depth (all wall rows share d) because the
    // absolute-mortar bricks make body-hue rows sparse.
    const span: number[] = [];
    for (let y = 0; y < fb.height; y++) {
      if (Math.abs(fb.depth[y * fb.width + c]! - d) < 0.01) span.push(y);
    }
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
    const shades = wallShades(fb, 0.28);
    expect(shades.length).toBeGreaterThan(0);
    expect(shades.some((s) => Math.abs(s - 0.7) < 0.05)).toBe(true);
    expect(shades.some((s) => Math.abs(s - 1.0) < 0.05)).toBe(true);
  });

  it('treats a north wall at yaw 0 as a 100% (N/S) face', () => {
    const level = levelFromAscii(['####', '#..#', '#..#', '#..#', '####']);
    const fb = makeFrameBuffer(80, 24);
    renderFirstPerson(level, pose(1.5, 3.0, 0), [], fb);
    const shades = wallShades(fb, 0.28);
    expect(shades.some((s) => Math.abs(s - 1.0) < 0.05)).toBe(true);
  });

  it('renders an unexplored face 2 cells away as a dark speckled veil with no mortar/edge structure', () => {
    const level = levelFromAscii(['##########', '#...      #', '##########']);
    const fb = makeFrameBuffer(80, 24);
    renderFirstPerson(level, pose(2.0, 1.5, Math.PI / 2), [], fb);
    const d = centreDepth(fb);
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBeCloseTo(2, 1); // west face of the first unexplored cell (x=4)
    const c = Math.floor(fb.width / 2);
    // only the wall-face rows (depth == d) — the veil is dark: nothing brighter than 0.30
    const levels = new Set<number>();
    for (let y = 0; y < fb.height; y++) {
      const cell = y * fb.width + c;
      if (Math.abs(fb.depth[cell]! - d) > 0.01) continue;
      const o = cell * 3;
      const v = Math.max(fb.rgb[o]!, fb.rgb[o + 1]!, fb.rgb[o + 2]!);
      expect(v).toBeLessThanOrEqual(0.3); // base (max 0.05) + speckle ≤ 0.25
      levels.add(Math.round(v * 1000));
    }
    // no mortar/edge structure: fewer than 4 distinct brightness levels per column
    expect(levels.size).toBeLessThan(4);
  });

  it('renders a stone face as flat grey with only a top edge line', () => {
    // hero on a floor strip two cells west of an S_stone cell (fixtures have no
    // stone glyph, so build a minimal LevelView inline)
    const stoneLevel: LevelView = {
      width: 3,
      height: 3,
      kindAt(x, y) {
        if (x === 0 || x === 1) return 'floor';
        return 'stone';
      },
      cellAt: () => null,
    };
    const fb = makeFrameBuffer(80, 24);
    renderFirstPerson(stoneLevel, pose(0.5, 1.5, Math.PI / 2), [], fb);
    const c = Math.floor(fb.width / 2);
    const d = centreDepth(fb);
    expect(d).toBeCloseTo(1.5, 1); // west face of the stone cell (x=2)
    const rows: Array<{ r: number; g: number; b: number }> = [];
    for (let y = 0; y < fb.height; y++) {
      const cell = y * fb.width + c;
      if (Math.abs(fb.depth[cell]! - d) > 0.01) continue;
      const o = cell * 3;
      rows.push({ r: fb.rgb[o]!, g: fb.rgb[o + 1]!, b: fb.rgb[o + 2]! });
    }
    expect(rows.length).toBeGreaterThan(1);
    // flat grey: every interior row shares one brightness and is near-neutral
    const interior = rows.slice(1);
    const interiorLevels = new Set(
      interior.map(({ r, g, b }) => Math.round(Math.max(r, g, b) * 1000)),
    );
    expect(interiorLevels.size).toBe(1);
    const mid = interior[0]!;
    const midMin = Math.min(mid.r, mid.g, mid.b);
    const midMax = Math.max(mid.r, mid.g, mid.b);
    expect(midMax - midMin).toBeLessThan(0.02);
    // top edge: the topmost wall row is brighter than the flat interior
    const topV = Math.max(rows[0]!.r, rows[0]!.g, rows[0]!.b);
    expect(topV).toBeGreaterThan(midMax);
  });

  it('treats a closed door as solid and door-coloured, an open door as passable', () => {
    const closedLevel = levelFromAscii(['#########', '#....+..#', '#########']);
    const closed = makeFrameBuffer(80, 24);
    renderFirstPerson(closedLevel, pose(1.5, 1.5, Math.PI / 2), [], closed);
    expect(centreDepth(closed)).toBeCloseTo(3.5, 1); // stopped at the door (west face at x=5)
    const c = Math.floor(closed.width / 2);
    const mid = Math.floor(closed.height / 2);
    const i = (mid * closed.width + c) * 3;
    // brownish: red dominant over blue, matching door_closed hue (now a dark face)
    expect(closed.rgb[i]!).toBeGreaterThan(closed.rgb[i + 2]!);
    expect(closed.rgb[i]!).toBeGreaterThan(0.02);

    const openLevel = levelFromAscii(['#########', '#....' + "'" + '..#', '#########']);
    const open = makeFrameBuffer(80, 24);
    renderFirstPerson(openLevel, pose(1.5, 1.5, Math.PI / 2), [], open);
    // the ray passes through the open door and reaches the east wall (x=8): the
    // deepest finite depth on the centre column is that far wall (~6.5). (The
    // old mid-height read now falls on floor, since the camera pitches down.)
    let deepest = 0;
    for (let y = 0; y < open.height; y++) {
      const dd = open.depth[y * open.width + c]!;
      if (Number.isFinite(dd)) deepest = Math.max(deepest, dd);
    }
    expect(deepest).toBeCloseTo(6.5, 1);
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
    // looking east through the open doorway: no wall directly ahead — the ray
    // leaves the map, so the centre-depth is a far floor row, not a near wall.
    expect(centreDepth(east)).toBeGreaterThan(4);
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

  it('renders a monster at distance 3 as a tall figure: taller than wide, corners clear, centre brightest', () => {
    const level = levelFromAscii([
      '#############',
      '#...........#',
      '#...........#',
      '#...........#',
      '#############',
    ]);
    const monster: Sprite = { x: 4, y: 1, ch: 'd', rgb: [0.8, 0.8, 0.8], cls: 'mon' };
    const fb = makeFrameBuffer(80, 24);
    renderFirstPerson(level, pose(1.5, 1.5, Math.PI / 2), [monster], fb);
    const cells: Array<[number, number]> = [];
    for (let y = 0; y < fb.height; y++) {
      for (let x = 0; x < fb.width; x++) {
        if (fb.overlayCh[y * fb.width + x] === 'd'.charCodeAt(0)) cells.push([x, y]);
      }
    }
    expect(cells.length).toBeGreaterThan(0);
    const xs = cells.map(([x]) => x);
    const ys = cells.map(([, y]) => y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    // a standing figure: taller than wide once cells' 2:1 aspect is accounted for
    // (the fixed vertical FOV makes the raw cell count square, but each cell is
    // twice as tall as wide, so visually the figure is a tall 2:1 silhouette)
    expect((maxY - minY + 1) * 2).toBeGreaterThan(maxX - minX + 1);
    // the ellipse's bounding-box corners are empty (no overlay cells there)
    const isCell = (x: number, y: number) => cells.some(([cx, cy]) => cx === x && cy === y);
    expect(isCell(minX, minY)).toBe(false);
    expect(isCell(maxX, minY)).toBe(false);
    expect(isCell(minX, maxY)).toBe(false);
    expect(isCell(maxX, maxY)).toBe(false);
    // the centre cell is brighter than the brightest perimeter cell
    const centreBright = overlayMax(fb, Math.floor((minX + maxX) / 2), Math.floor((minY + maxY) / 2));
    let maxEdge = 0;
    for (const [x, y] of cells) {
      if (x === minX || x === maxX || y === minY || y === maxY) {
        maxEdge = Math.max(maxEdge, overlayMax(fb, x, y));
      }
    }
    expect(centreBright).toBeGreaterThan(maxEdge);
  });

  it('renders an item at distance 3 as a low shape whose top row is below the horizon', () => {
    const level = levelFromAscii([
      '#############',
      '#...........#',
      '#...........#',
      '#...........#',
      '#############',
    ]);
    const item: Sprite = { x: 4, y: 1, ch: '*', rgb: [0.8, 0.2, 0.2], cls: 'obj' };
    const fb = makeFrameBuffer(80, 24);
    renderFirstPerson(level, pose(1.5, 1.5, Math.PI / 2), [item], fb);
    const ys: number[] = [];
    for (let y = 0; y < fb.height; y++) {
      for (let x = 0; x < fb.width; x++) {
        if (fb.overlayCh[y * fb.width + x] === '*'.charCodeAt(0)) ys.push(y);
      }
    }
    expect(ys.length).toBeGreaterThan(0);
    expect(Math.min(...ys)).toBeGreaterThan(fb.height * 0.42); // entirely below the horizon
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
        if (Math.abs(gr - 1.0) < 0.03 && Math.abs(br - 1.0714) < 0.03) {
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
    const postRows: number[] = [];
    for (let y = 0; y < fb.height; y++) {
      const o = (y * fb.width + c) * 3;
      const r = fb.rgb[o]!;
      const g = fb.rgb[o + 1]!;
      const b = fb.rgb[o + 2]!;
      if (r < 0.02) continue;
      // strong red dominance = the door-coloured threshold (the opening's middle)
      if (r > b * 1.3 && r > 0.05) doorRows.push(y);
      // bright grey = an absolute frame post at the opening's edges
      else if (Math.abs(g - r) < 0.03 && Math.abs(b - r) < 0.03 && r > 0.4) postRows.push(y);
    }
    expect(doorRows.length).toBeGreaterThan(0); // the middle is door-coloured, not a wall
    expect(postRows.length).toBeGreaterThan(0); // a bright frame post is present
    // the frame sits at the opening's edge: a door row directly touches a post row
    expect(doorRows.some((d) => postRows.includes(d - 1) || postRows.includes(d + 1))).toBe(true);
  });
});

describe('raycast/camera-readability', () => {
  it('keeps the nearest floor row closer than 0.8 cells at any aspect', () => {
    // an open all-floor room, hero in the middle: the tile in front is on screen
    const floor = levelFromAscii([
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
    ]);
    for (const [w, h] of [[80, 24], [200, 60], [278, 104]] as const) {
      const fb = makeFrameBuffer(w, h);
      renderFirstPerson(floor, pose(7.5, 3.5, Math.PI / 2), [], fb);
      // the bottom-row centre is floor (finite depth, close), not wall or black
      const bottom = fb.height - 1;
      const c = Math.floor(fb.width / 2);
      const d = fb.depth[bottom * fb.width + c]!;
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeLessThan(1);
      // theoretical nearest floor: the bottom row looks (1−0.42)·60° down
      const angle = (1 - 0.42) * 60 * (Math.PI / 180);
      expect(0.5 / Math.tan(angle)).toBeLessThan(0.8);
    }
  });

  it('a wider terminal gets a wider horizontal FOV (a wall ahead covers fewer columns fraction)', () => {
    // 1-wide corridor; the north wall at distance 3 fills the view horizontally.
    // 80×24 (aspect 3.33) is wider than 278×104 (aspect 2.67), so its derived
    // horizontal FOV is wider and the wall covers a smaller fraction of the width.
    const level = levelFromAscii(['####', '#..#', '#..#', '#..#', '#..#', '####']);
    const span = (w: number, h: number): number => {
      const fb = makeFrameBuffer(w, h);
      renderFirstPerson(level, pose(1.5, 4.0, 0), [], fb);
      const mid = Math.floor(h / 2);
      let n = 0;
      for (let x = 0; x < w; x++) {
        const d = fb.depth[mid * w + x]!;
        if (Number.isFinite(d) && Math.abs(d - 3) < 0.6) n++;
      }
      return n / w;
    };
    expect(span(80, 24)).toBeLessThan(span(278, 104));
  });

  it('a floor row 2 cells away is grey (r≈g≈b) with ≥ 3 distinct brightness levels', () => {
    const floor = levelFromAscii([
      '#############',
      '#...........#',
      '#...........#',
      '#...........#',
      '#...........#',
      '#...........#',
      '#############',
    ]);
    const fb = makeFrameBuffer(80, 24);
    renderFirstPerson(floor, pose(6.5, 3.5, Math.PI / 2), [], fb);
    let checked = false;
    for (let y = Math.ceil(0.42 * 24); y < 24; y++) {
      const c = Math.floor(80 / 2);
      const d = fb.depth[y * 80 + c]!;
      if (!Number.isFinite(d) || Math.abs(d - 2) > 0.5) continue;
      const levels = new Set<number>();
      let greyOk = true;
      let n = 0;
      for (let x = 0; x < 80; x++) {
        const dd = fb.depth[y * 80 + x]!;
        if (!Number.isFinite(dd) || Math.abs(dd - 2) > 0.5) continue;
        const o = (y * 80 + x) * 3;
        const r = fb.rgb[o]!;
        const g = fb.rgb[o + 1]!;
        const b = fb.rgb[o + 2]!;
        const mx = Math.max(r, g, b);
        const mn = Math.min(r, g, b);
        if (mx > 0 && (mx - mn) / mx > 0.1) greyOk = false;
        levels.add(Math.round(mx * 1000));
        n++;
      }
      if (n > 10) {
        expect(greyOk).toBe(true);
        expect(levels.size).toBeGreaterThanOrEqual(3);
        checked = true;
        break;
      }
    }
    expect(checked).toBe(true);
  });

  it('a wall face 3 cells away is dark in the body with a bright top edge and corner columns', () => {
    // a wall straight ahead at distance 3 whose left and right edges are in view
    const level = levelFromAscii([
      '##########',
      '#...##...#',
      '#........#',
      '#........#',
      '#........#',
      '#........#',
      '#........#',
      '##########',
    ]);
    const fb = makeFrameBuffer(80, 24);
    renderFirstPerson(level, pose(4.5, 5.0, 0), [], fb);
    const cells: number[] = []; // brightness of every cell ~3 cells away (the wall face)
    for (let y = 0; y < fb.height; y++) {
      for (let x = 0; x < fb.width; x++) {
        const d = fb.depth[y * fb.width + x]!;
        if (!Number.isFinite(d) || Math.abs(d - 3) > 0.6) continue;
        const o = (y * fb.width + x) * 3;
        cells.push(Math.max(fb.rgb[o]!, fb.rgb[o + 1]!, fb.rgb[o + 2]!));
      }
    }
    expect(cells.length).toBeGreaterThan(10);
    const sorted = [...cells].sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length / 2)]!).toBeLessThan(0.16); // dark body median
    expect(Math.max(...cells)).toBeGreaterThan(0.6); // bright top edge row
    expect(cells.some((v) => v > 0.4 && v <= 0.6)).toBe(true); // bright corner column
  });

  it('every ceiling cell is exactly black', () => {
    // an open all-floor room with no wall in view: everything above the horizon
    // is the ceiling and must be pure black.
    const floor = levelFromAscii([
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
    ]);
    const fb = makeFrameBuffer(80, 24);
    renderFirstPerson(floor, pose(7.5, 3.5, Math.PI / 2), [], fb);
    const horizonRow = Math.floor(0.42 * 24);
    for (let y = 0; y < horizonRow; y++) {
      for (let x = 0; x < fb.width; x++) {
        const o = (y * fb.width + x) * 3;
        expect(fb.rgb[o]!).toBe(0);
        expect(fb.rgb[o + 1]!).toBe(0);
        expect(fb.rgb[o + 2]!).toBe(0);
      }
    }
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
    // pin the shaped sprites: one standing monster and one low item in view east
    const sprites: Sprite[] = [
      { x: 9, y: 3, ch: 'd', rgb: [0.8, 0.3, 0.3], cls: 'mon' },
      { x: 10, y: 4, ch: '*', rgb: [0.8, 0.8, 0.2], cls: 'obj' },
    ];
    renderFirstPerson(ROOM, pose(7.5, 3.5, Math.PI / 2), sprites, fb);
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
