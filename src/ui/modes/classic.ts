/**
 * Classic mode (docs/architecture.md §6.3): paints the 80×21 map from
 * `session.map` into the viewport (centred when the terminal is wider), and
 * forwards every key to NetHack. The first-person/ortho modes (T-0007/T-0008)
 * will implement the same `Mode` interface with a different `paintViewport`.
 */
import type { NethackSession } from '../../engine/session.js';
import { COLNO, ROWNO, clrToRgb } from '../../model/types.js';
import type { ScreenGrid } from '../../model/types.js';
import type { KeyEvent } from '../../term/input.js';
import { keyToCode } from '../overlays.js';

/** A screen rectangle for `paintViewport`. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One playable view mode. Modes are switchable with F1–F3. */
export interface Mode {
  /** Mode name shown in the status banner. */
  readonly name: string;
  /** Called when the mode becomes active. */
  onEnter(): void;
  /** Called when the mode is left. */
  onLeave(): void;
  /** Paint the viewport (the area between the message line and the status rows). */
  paintViewport(grid: ScreenGrid, rect: Rect): void;
  /**
   * Handle a key that reached the mode (no overlay or message paging active).
   * `queueKey` stores a key when there is no pending key request, to be
   * answered when NetHack next asks for one.
   */
  handleKey(e: KeyEvent, queueKey: (e: KeyEvent) => void): void;
}

/** Classic top-down map mode: the whole 80×21 map, hero in inverse video. */
export class ClassicMode implements Mode {
  readonly name = 'classic';
  private readonly session: NethackSession;

  /** @param session - the session whose map this mode renders. */
  constructor(session: NethackSession) {
    this.session = session;
  }

  onEnter(): void {}

  onLeave(): void {}

  paintViewport(grid: ScreenGrid, rect: Rect): void {
    const offX = rect.x + Math.max(0, Math.floor((rect.width - COLNO) / 2));
    const offY = rect.y;
    const hero = this.session.hero;
    for (let y = 0; y < ROWNO; y++) {
      const gy = offY + y;
      if (gy < 0 || gy >= grid.height) continue;
      for (let x = 0; x < COLNO; x++) {
        const gx = offX + x;
        if (gx < 0 || gx >= grid.width) continue;
        const cell = this.session.map.cellAt(x, y);
        const top = cell?.top;
        const ch = top?.ch ?? ' ';
        const fg = clrToRgb(top?.color ?? 0);
        const idx = gy * grid.width + gx;
        const isHero = hero !== null && hero.x === x && hero.y === y;
        if (isHero) {
          // Inverse video: glyph colour becomes the background, black the ink.
          grid.cells[idx]!.ch = ch;
          grid.cells[idx]!.fg = [0, 0, 0];
          grid.cells[idx]!.bg = fg;
        } else {
          grid.cells[idx]!.ch = ch;
          grid.cells[idx]!.fg = fg;
          grid.cells[idx]!.bg = [0, 0, 0];
        }
      }
    }
  }

  handleKey(e: KeyEvent, queueKey: (e: KeyEvent) => void): void {
    const p = this.session.pending;
    if (p !== null && (p.kind === 'key' || p.kind === 'pos')) {
      const code = keyToCode(e);
      this.session.answer(p.kind === 'pos' ? { kind: 'pos', key: code } : { kind: 'key', key: code });
    } else {
      queueKey(e);
    }
  }
}
