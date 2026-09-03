/**
 * Ortho / isometric renderer over the level grid (docs/architecture.md §5.3,
 * projection locked by ticket T-0008). Pure and deterministic: fills a
 * `FrameBuffer` with a 2:1 isometric view of the remembered level, centred on
 * the hero, exactly like the raycaster so the same quantizer and screen writer
 * show it.
 *
 * Projection: map cell (x, y) (x east, y south) has screen anchor
 * `sx = 2·(x − y) + ox`, `sy = (x + y) + oy`. Its floor is a brick of 4
 * columns × 1 row: columns `sx−2 … sx+1` of row `sy`. Bricks on consecutive
 * rows are staggered by 2 columns, so every screen cell belongs to exactly one
 * map cell. See docs/render.md for the inverse and the brick diagram.
 */
import { isSolid, type CellKind, type FrameBuffer, type LevelView, type Sprite } from '../model/types.js';
import { KIND_COLORS } from './raycast.js';

/** Screen-space origin (`ox`, `oy`) of the isometric projection. */
export interface Origin {
  /** Horizontal origin in columns. */
  ox: number;
  /** Vertical origin in rows. */
  oy: number;
}

/** Tuning knobs for `renderOrtho`; every field has a default. */
export interface OrthoOptions {
  /** Wall extrusion height in brick rows above the floor row (default 2). */
  wallRows?: number;
  /** Fog attenuation coefficient over Chebyshev distance from the hero (default 0.06). */
  fogK?: number;
}

const DEFAULT_WALL_ROWS = 2;
const DEFAULT_FOG_K = 0.06;

/**
 * Project map cell (x, y) to the screen anchor (sx, sy) of its brick (the
 * brick spans columns `sx−2 … sx+1` of row `sy`).
 */
export function cellToScreen(x: number, y: number, origin: Origin): { sx: number; sy: number } {
  return { sx: 2 * (x - y) + origin.ox, sy: x + y + origin.oy };
}

/**
 * Invert the projection: the unique map cell whose brick contains screen cell
 * (c, r). Returns integer cell coordinates for any screen cell that lies in a
 * brick (see docs/render.md for the derivation).
 */
export function screenToCell(c: number, r: number, origin: Origin): { x: number; y: number } {
  const cp = c - origin.ox;
  const rp = r - origin.oy;
  const p = ((rp % 2) + 2) % 2; // non-negative r' mod 2
  const k = Math.floor((cp + 2 - 2 * p) / 4);
  const d = 2 * k + p; // this is x − y
  return { x: (rp + d) / 2, y: (rp - d) / 2 };
}

/**
 * Render an ortho/isometric view of `level` centred on `hero` into `fb`,
 * drawing any `sprites` as overlay glyphs on their tiles. Pure and
 * deterministic; fills every cell of the buffer each frame.
 */
export function renderOrtho(
  level: LevelView,
  hero: { x: number; y: number },
  sprites: Sprite[],
  fb: FrameBuffer,
  opts: OrthoOptions = {},
): void {
  const wallRows = opts.wallRows ?? DEFAULT_WALL_ROWS;
  const fogK = opts.fogK ?? DEFAULT_FOG_K;
  const cols = fb.width;
  const rows = fb.height;

  // Anchor the hero's brick at the centre of the viewport.
  const ox = Math.floor(cols / 2) - 2 * (hero.x - hero.y);
  const oy = Math.floor(rows / 2) - (hero.x + hero.y);
  const origin: Origin = { ox, oy };

  // Pre-fill the whole buffer each frame: stale overlay glyphs from a previous
  // frame and any cell no brick covers (unexplored, out-of-map) stay black at
  // infinite depth, exactly as the raycaster does.
  fb.overlayCh.fill(0);
  fb.overlayRgb.fill(0);
  fb.rgb.fill(0);
  fb.depth.fill(Number.POSITIVE_INFINITY);

  const spriteByCell = new Map<string, Sprite>();
  for (const s of sprites) spriteByCell.set(`${s.x},${s.y}`, s);

  // Painter's order: increasing x + y, ties by increasing x (north-west to
  // south-east), so later (nearer) draws occlude earlier ones.
  const cells: Array<{ x: number; y: number; kind: CellKind }> = [];
  for (let y = 0; y < level.height; y++) {
    for (let x = 0; x < level.width; x++) {
      cells.push({ x, y, kind: level.kindAt(x, y) });
    }
  }
  cells.sort((a, b) => a.x + a.y - (b.x + b.y) || a.x - b.x);

  for (const { x, y, kind } of cells) {
    if (kind === 'unexplored') continue; // stays black at Infinity depth
    const { sx, sy } = cellToScreen(x, y, origin);
    const solid = isSolid(kind);
    const minRow = solid ? sy - wallRows : sy;
    // Only draw cells whose brick can touch the viewport.
    if (sy < 0 || minRow >= rows) continue;
    if (sx + 1 < 0 || sx - 2 >= cols) continue;

    const base = KIND_COLORS[kind];
    const dist = Math.max(Math.abs(x - hero.x), Math.abs(y - hero.y)); // Chebyshev
    const atten = Math.exp(-fogK * dist);
    const depthVal = x + y;

    // Paint one 4-column brick row, optionally per-column shading; also clears
    // any overlay glyph that occupied those cells (occlusion for later walls).
    const paint = (row: number, shade: (col: number) => number): void => {
      if (row < 0 || row >= rows) return;
      for (let col = sx - 2; col <= sx + 1; col++) {
        if (col < 0 || col >= cols) continue;
        const i = row * cols + col;
        const o = i * 3;
        const sh = shade(col);
        fb.rgb[o] = base[0] * sh * atten;
        fb.rgb[o + 1] = base[1] * sh * atten;
        fb.rgb[o + 2] = base[2] * sh * atten;
        fb.depth[i] = depthVal;
        fb.overlayCh[i] = 0;
        fb.overlayRgb[o] = 0;
        fb.overlayRgb[o + 1] = 0;
        fb.overlayRgb[o + 2] = 0;
      }
    };

    if (solid) {
      // Vertical (south-east) face in shadow at 60 %, top face lit at 100 %.
      for (let row = sy - wallRows + 1; row <= sy; row++) paint(row, () => 0.6);
      paint(sy - wallRows, () => 1.0);
    } else {
      // Floor brick: outer two columns at 85 % so tile edges read.
      paint(sy, (col) => (col === sx - 2 || col === sx + 1 ? 0.85 : 1.0));
    }

    // Sprites draw with their tile, same painter step; a wall drawn later
    // (south-east) clears these overlay cells, giving occlusion.
    const sprite = spriteByCell.get(`${x},${y}`);
    if (sprite) {
      const ch = sprite.ch.charCodeAt(0);
      const sr = sprite.rgb;
      for (const [cx, cy] of [
        [sx, sy - 1],
        [sx - 1, sy - 1],
      ] as Array<[number, number]>) {
        if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) continue;
        const i = cy * cols + cx;
        const o = i * 3;
        fb.overlayCh[i] = ch;
        fb.overlayRgb[o] = sr[0] * atten;
        fb.overlayRgb[o + 1] = sr[1] * atten;
        fb.overlayRgb[o + 2] = sr[2] * atten;
      }
    }
  }
}
