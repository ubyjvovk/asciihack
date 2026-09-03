/**
 * Status rows (docs/architecture.md §6.3): paint the two NetHack status lines
 * from `session.statusLines()` into the bottom rows of the screen, truncated
 * to the grid width.
 */
import type { NethackSession } from '../engine/session.js';
import type { ScreenGrid } from '../model/types.js';
import { putText, UI_BG, UI_FG } from './grid.js';

/** Paint the two status lines into `grid` at rows `y` and `y+1`. */
export function paintStatus(grid: ScreenGrid, session: NethackSession, x: number, y: number): void {
  const [l1, l2] = session.statusLines();
  putText(grid, x, y, l1.slice(0, grid.width - x), UI_FG, UI_BG);
  putText(grid, x, y + 1, l2.slice(0, grid.width - x), UI_FG, UI_BG);
}
