/**
 * Shared screen-grid helpers for the terminal UI (docs/architecture.md §6.3):
 * a tiny text/box painter used by the classic viewport, the status rows, the
 * overlays and the message line. Pure — no I/O, no session state.
 */
import type { ScreenGrid } from '../model/types.js';

/** Default foreground for UI chrome text. */
export const UI_FG: readonly [number, number, number] = [255, 255, 255];
/** Default background for UI chrome. */
export const UI_BG: readonly [number, number, number] = [0, 0, 0];
/** Border colour for boxed overlays. */
export const BORDER_FG: readonly [number, number, number] = [150, 150, 150];

/** Allocate a blank `ScreenGrid` (every cell a space on black). */
export function blankGrid(width: number, height: number): ScreenGrid {
  const cells = new Array(width * height);
  for (let i = 0; i < cells.length; i++) {
    cells[i] = { ch: ' ', fg: UI_FG, bg: UI_BG };
  }
  return { width, height, cells };
}

/** Write `text` into the grid starting at (x, y), clipped to the grid bounds. */
export function putText(
  grid: ScreenGrid,
  x: number,
  y: number,
  text: string,
  fg: readonly [number, number, number] = UI_FG,
  bg: readonly [number, number, number] = UI_BG,
): void {
  for (let i = 0; i < text.length; i++) {
    const gx = x + i;
    if (gx < 0 || gx >= grid.width || y < 0 || y >= grid.height) break;
    grid.cells[y * grid.width + gx]!.ch = text[i]!;
    grid.cells[y * grid.width + gx]!.fg = fg;
    grid.cells[y * grid.width + gx]!.bg = bg;
  }
}

/** Paint a bordered box of `w`×`h` cells centred on (cx, cy), clamped to the
 *  grid. Returns the interior rectangle (inside the border) for content. */
export function paintBox(
  grid: ScreenGrid,
  cx: number,
  cy: number,
  w: number,
  h: number,
  title: string,
): { x: number; y: number; width: number; height: number } {
  const x = Math.max(0, Math.min(grid.width - w, cx - Math.floor(w / 2)));
  const y = Math.max(0, Math.min(grid.height - h, cy - Math.floor(h / 2)));
  for (let i = 0; i < w; i++) {
    putText(grid, x + i, y, '-', BORDER_FG);
    putText(grid, x + i, y + h - 1, '-', BORDER_FG);
  }
  for (let i = 0; i < h; i++) {
    putText(grid, x, y + i, '|', BORDER_FG);
    putText(grid, x + w - 1, y + i, '|', BORDER_FG);
  }
  putText(grid, x, y, '+', BORDER_FG);
  putText(grid, x + w - 1, y, '+', BORDER_FG);
  putText(grid, x, y + h - 1, '+', BORDER_FG);
  putText(grid, x + w - 1, y + h - 1, '+', BORDER_FG);
  if (title) putText(grid, x + 2, y, title.slice(0, Math.max(0, w - 4)), UI_FG);
  return { x: x + 1, y: y + 1, width: w - 2, height: h - 2 };
}
