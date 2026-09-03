/**
 * Ortho/isometric mode (docs/architecture.md §5.3, §6.4): renders the
 * remembered map with `renderOrtho`, the hero drawn as an `@` sprite. Arrow
 * keys are plain NetHack moves (west/east/north/south); there is no facing.
 */
import type { NethackSession } from '../../engine/session.js';
import type { ScreenGrid } from '../../model/types.js';
import type { KeyEvent } from '../../term/input.js';
import type { Theme } from '../../render/themes.js';
import { renderOrtho } from '../../render/ortho.js';
import { paintMinimap } from '../minimap.js';
import { charKey, sendKey, spritesFromMap, Viewport3D, blitGrid } from '../view3d.js';
import type { Mode, Rect } from './classic.js';

/** Colour of the ortho rose letters (dim grey). */
const ROSE_FAR_FG: readonly [number, number, number] = [120, 120, 120];
/** Colour of the ortho rose centre `+` (bright). */
const ROSE_NEAR_FG: readonly [number, number, number] = [255, 255, 255];

/**
 * Paint the fixed 5×3 compass rose at the top-left of the ortho viewport:
 * `W N` on the top row, `+` at the centre, `S E` on the bottom, because in
 * the locked projection north is up-right. Pure painting; the `+` is bright.
 */
function paintRose(grid: ScreenGrid, rect: Rect): void {
  const x = rect.x;
  const y = rect.y;
  const put = (dx: number, dy: number, ch: string, fg: readonly [number, number, number]): void => {
    const gx = x + dx;
    const gy = y + dy;
    if (gx < 0 || gx >= grid.width || gy < 0 || gy >= grid.height) return;
    const cell = grid.cells[gy * grid.width + gx]!;
    cell.ch = ch;
    cell.fg = fg;
    cell.bg = [0, 0, 0];
  };
  put(0, 0, 'W', ROSE_FAR_FG);
  put(4, 0, 'N', ROSE_FAR_FG);
  put(2, 1, '+', ROSE_NEAR_FG);
  put(0, 2, 'S', ROSE_FAR_FG);
  put(4, 2, 'E', ROSE_FAR_FG);
}

/** Ortho view: isometric map centred on the hero with an `@` hero sprite. */
export class OrthoMode implements Mode {
  readonly name = 'ortho';
  private readonly session: NethackSession;
  private readonly viewport = new Viewport3D();
  /** Active render theme (cycled with F5 by the App). */
  theme: Theme = 'cyber';
  /** Whether the minimap overlay is shown (toggled with F4 by the App). */
  showMinimap = true;

  /** @param session - the session whose map and hero this mode renders. */
  constructor(session: NethackSession) {
    this.session = session;
  }

  onEnter(): void {}

  onLeave(): void {}

  paintViewport(grid: ScreenGrid, rect: Rect): void {
    const hero = this.session.hero;
    if (hero === null) return;
    const sprites = spritesFromMap(this.session, hero, true);
    const theme = this.theme;
    const sub = this.viewport.render(
      { x: 0, y: 0, width: Math.max(1, rect.width), height: Math.max(1, rect.height) },
      (fb) => renderOrtho(this.session.map, hero, sprites, fb),
      theme,
    );
    blitGrid(sub, grid, rect);
    if (this.showMinimap) paintMinimap(grid, rect, this.session);
    paintRose(grid, rect);
  }

  handleKey(e: KeyEvent, queueKey: (ev: KeyEvent) => void): void {
    switch (e.key) {
      case 'Left':
        sendKey(this.session, queueKey, charKey('h'));
        return;
      case 'Right':
        sendKey(this.session, queueKey, charKey('l'));
        return;
      case 'Up':
        sendKey(this.session, queueKey, charKey('k'));
        return;
      case 'Down':
        sendKey(this.session, queueKey, charKey('j'));
        return;
      default:
        sendKey(this.session, queueKey, e);
        return;
    }
  }
}
