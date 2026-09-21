/**
 * Classic-map minimap for the fps/ortho modes (docs/architecture.md §6.3): a
 * 42×13 window (inner 40×11) drawn top-right over the viewport, with each
 * minimap cell sampling a 2×2 block of the remembered map so the whole
 * 80×21 level fits at a glance. One-cell `-`/`|` border, the hero in
 * inverse video. Pure painting over the session model; no I/O.
 */
import { clrToRgb } from '../model/types.js';
import type { CellKind, GlyphClass, MapCell, ScreenGrid } from '../model/types.js';
import type { NethackSession } from '../engine/session.js';
import { FACINGS, type Facing } from './view3d.js';
import type { Rect } from './modes/classic.js';

/** Minimap window width, including the one-cell border. */
export const MINIMAP_WIDTH = 42;
/** Minimap window height, including the one-cell border. */
export const MINIMAP_HEIGHT = 13;
/** Grey used for the minimap border. */
const DIM_GREY: readonly [number, number, number] = [100, 100, 100];
/** Facing arrow glyphs indexed like `FACINGS` (N, NE, … NW clockwise), all BMP one-cell. */
const FACING_ARROWS: ReadonlyArray<string> = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
/** Top-right corner inset in cells (one column / one row from the edge). */
const INSET = 1;

// Priority ranks for the 2×2 block sampler: lower wins, and ties within a
// rank are broken by scan order (top-left first). The hero at rank 1 always
// wins the block containing it, or the player loses themselves on the map.
const HERO_RANK = 1;
const MONSTER_RANK = 2;
const OBJECT_RANK = 3;
const FEATURE_RANK = 4;
const PASSABLE_RANK = 5;
const WALL_RANK = 6;
const EMPTY_RANK = 7;

const MONSTER_CLASSES: ReadonlySet<GlyphClass> = new Set<GlyphClass>(['mon', 'pet']);
const FEATURE_KINDS: ReadonlySet<CellKind> = new Set<CellKind>([
  'stairs_up', 'stairs_down', 'ladder_up', 'ladder_down',
  'fountain', 'altar', 'throne',
  'doorway', 'door_open', 'door_closed',
]);
const PASSABLE_KINDS: ReadonlySet<CellKind> = new Set<CellKind>(['floor', 'corridor']);

/** Priority rank a single map cell gets in the 2×2 block sampler. */
function rankOf(cell: MapCell | null, isHero: boolean): number {
  if (isHero) return HERO_RANK;
  if (cell === null || cell.kind === 'unexplored') return EMPTY_RANK;
  const top = cell.top;
  if (top !== null && MONSTER_CLASSES.has(top.cls)) return MONSTER_RANK;
  if (top !== null && top.cls === 'obj') return OBJECT_RANK;
  if (FEATURE_KINDS.has(cell.kind)) return FEATURE_RANK;
  if (PASSABLE_KINDS.has(cell.kind)) return PASSABLE_RANK;
  if (cell.kind === 'wall') return WALL_RANK;
  return EMPTY_RANK;
}

/**
 * Paint the minimap over `grid` inside `rect` (the viewport). At full size
 * the inner 40×11 window samples 2×2 map blocks and covers the whole 80×21
 * map with a row to spare; on a narrow terminal the panel clamps to
 * `rect.width`/`rect.height` and shows less of the map, still hero-centred.
 * Unexplored blocks are spaces, the hero is inverse video. When `facing` is
 * given the hero prints its facing arrow (`↑ ↗ → ↘ ↓ ↙ ← ↖`) instead of `@`.
 * Does nothing when the hero position is unknown.
 */
export function paintMinimap(
  grid: ScreenGrid,
  rect: Rect,
  session: NethackSession,
  facing?: Facing,
): void {
  const hero = session.hero;
  if (hero === null) return;
  const w = Math.min(MINIMAP_WIDTH, rect.width);
  if (w < 3) return;
  const height = Math.min(MINIMAP_HEIGHT, rect.height);
  if (height < 3) return;
  const ox = rect.x + rect.width - w - INSET;
  const oy = rect.y + INSET;
  const innerW = w - 2;
  const innerH = height - 2;
  const mapW = session.map.width;
  const mapH = session.map.height;
  // Top-left map cell of the window in map-cell units. The window covers
  // innerW*2 × innerH*2 map cells (a 2×2 block per minimap cell). Clamp so
  // it stays inside the map; when the coverage is larger than the map (the
  // full 42×13 panel on an 80×21 map) the clamp pins startX/startY to 0 and
  // the view stops scrolling with the hero.
  const coverX = innerW * 2;
  const coverY = innerH * 2;
  const startX = Math.max(0, Math.min(mapW - coverX, hero.x - coverX / 2));
  const startY = Math.max(0, Math.min(mapH - coverY, hero.y - coverY / 2));

  const put = (
    x: number,
    y: number,
    ch: string,
    fg: readonly [number, number, number],
    bg: readonly [number, number, number],
  ): void => {
    if (x < 0 || x >= grid.width || y < 0 || y >= grid.height) return;
    const cell = grid.cells[y * grid.width + x]!;
    cell.ch = ch;
    cell.fg = fg;
    cell.bg = bg;
  };
  // Border.
  for (let x = 0; x < w; x++) {
    put(ox + x, oy, x === 0 || x === w - 1 ? '+' : '-', DIM_GREY, [0, 0, 0]);
    put(ox + x, oy + height - 1, x === 0 || x === w - 1 ? '+' : '-', DIM_GREY, [0, 0, 0]);
  }
  for (let y = 1; y < height - 1; y++) {
    put(ox, oy + y, '|', DIM_GREY, [0, 0, 0]);
    put(ox + w - 1, oy + y, '|', DIM_GREY, [0, 0, 0]);
  }
  // Contents: each minimap cell picks the highest-priority map cell out of a
  // 2×2 block (scan order top-left → top-right → bottom-left → bottom-right).
  const scan: ReadonlyArray<readonly [number, number]> = [
    [0, 0], [1, 0], [0, 1], [1, 1],
  ];
  for (let dy = 0; dy < innerH; dy++) {
    for (let dx = 0; dx < innerW; dx++) {
      const bx = startX + 2 * dx;
      const by = startY + 2 * dy;
      let bestRank = EMPTY_RANK + 1;
      let bestCell: MapCell | null = null;
      let bestIsHero = false;
      for (const [sx, sy] of scan) {
        const mx = bx + sx;
        const my = by + sy;
        const cell = session.map.cellAt(mx, my);
        const isHero = mx === hero.x && my === hero.y;
        const r = rankOf(cell, isHero);
        if (r < bestRank) {
          bestRank = r;
          bestCell = cell;
          bestIsHero = isHero;
          if (r === HERO_RANK) break;
        }
      }
      const top = bestCell?.top ?? null;
      const fgc = top ? clrToRgb(top.color) : ([0, 0, 0] as const);
      if (bestIsHero) {
        const heroCh =
          facing === undefined ? '@' : (FACING_ARROWS[FACINGS.indexOf(facing)] ?? '@');
        put(ox + 1 + dx, oy + 1 + dy, heroCh, [0, 0, 0], fgc);
      } else if (bestRank === EMPTY_RANK || top === null) {
        put(ox + 1 + dx, oy + 1 + dy, ' ', [0, 0, 0], [0, 0, 0]);
      } else {
        put(ox + 1 + dx, oy + 1 + dy, top.ch, fgc, [0, 0, 0]);
      }
    }
  }
}
