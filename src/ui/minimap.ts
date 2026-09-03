/**
 * Classic-map minimap for the fps/ortho modes (docs/architecture.md §6.3): a
 * 40×11 window of the remembered map centred on the hero, drawn top-right
 * over the viewport with a one-cell `-`/`|` border, the hero in inverse
 * video. Pure painting over the session model; no I/O.
 */
import { clrToRgb } from '../model/types.js';
import type { ScreenGrid } from '../model/types.js';
import type { NethackSession } from '../engine/session.js';
import type { Rect } from './modes/classic.js';

/** Minimap window size, including the one-cell border. */
export const MINIMAP_WIDTH = 40;
/** Minimap window height, including the one-cell border. */
export const MINIMAP_HEIGHT = 11;
/** Grey used for the minimap border. */
const DIM_GREY: readonly [number, number, number] = [100, 100, 100];
/** Top-right corner inset in cells (one column / one row from the edge). */
const INSET = 1;

/**
 * Paint the minimap over `grid` inside `rect` (the viewport). Shows a
 * 38×9 window of the map centred on the hero (clamped to the map bounds);
 * unexplored cells are spaces, the hero is inverse video. Does nothing when
 * the hero position is unknown.
 */
export function paintMinimap(grid: ScreenGrid, rect: Rect, session: NethackSession): void {
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
  // Top-left map cell of the window, clamped so the window covers the map.
  const startX = Math.max(0, Math.min(mapW - innerW, hero.x - Math.floor(innerW / 2)));
  const startY = Math.max(0, Math.min(mapH - innerH, hero.y - Math.floor(innerH / 2)));

  const put = (x: number, y: number, ch: string, fg: readonly [number, number, number], bg: readonly [number, number, number]): void => {
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
  // Contents.
  for (let dy = 0; dy < innerH; dy++) {
    for (let dx = 0; dx < innerW; dx++) {
      const mx = startX + dx;
      const my = startY + dy;
      const cell = session.map.cellAt(mx, my);
      const top = cell?.top;
      const isHero = mx === hero.x && my === hero.y;
      const ch = top?.ch ?? ' ';
      const fgc = top ? clrToRgb(top.color) : ([0, 0, 0] as const);
      if (isHero) {
        put(ox + 1 + dx, oy + 1 + dy, '@', [0, 0, 0], fgc);
      } else if (cell === null || cell.kind === 'unexplored' || top === null || top === undefined) {
        put(ox + 1 + dx, oy + 1 + dy, ' ', [0, 0, 0], [0, 0, 0]);
      } else {
        put(ox + 1 + dx, oy + 1 + dy, ch, fgc, [0, 0, 0]);
      }
    }
  }
}
