/**
 * Shared 3D-view plumbing for the fps and ortho modes (docs/architecture.md
 * §5, §6.4, §7): sprite extraction from the remembered map, the 8-way facing
 * table, pose helpers, grid blitting and a reusable viewport helper. No I/O;
 * the only side effects are filling caller-visible buffers and answering (or
 * queueing) NetHack key requests through `sendKey`.
 */
import {
  clrToRgb,
  makeFrameBuffer,
  type FrameBuffer,
  type LevelView,
  type Pose,
  type ScreenGrid,
  type Sprite,
} from '../model/types.js';
import type { NethackSession } from '../engine/session.js';
import { quantizeInto } from '../render/ascii.js';
import type { Theme } from '../render/themes.js';
import type { KeyEvent } from '../term/input.js';
import { keyToCode } from './overlays.js';
import { blankGrid } from './grid.js';
import type { Rect } from './modes/classic.js';

/** One compass facing: display name, camera yaw and NetHack vi-key. */
export interface Facing {
  readonly name: string;
  readonly yaw: number;
  readonly key: string;
}

/**
 * The 8 compass facings in clockwise order from north, each with its yaw
 * (0 = north, +π/2 = east, §7) and vi-key (`k u l n j b h y`).
 */
export const FACINGS: readonly Facing[] = [
  { name: 'N', yaw: 0, key: 'k' },
  { name: 'NE', yaw: Math.PI / 4, key: 'u' },
  { name: 'E', yaw: Math.PI / 2, key: 'l' },
  { name: 'SE', yaw: (3 * Math.PI) / 4, key: 'n' },
  { name: 'S', yaw: Math.PI, key: 'j' },
  { name: 'SW', yaw: (5 * Math.PI) / 4, key: 'b' },
  { name: 'W', yaw: (3 * Math.PI) / 2, key: 'h' },
  { name: 'NW', yaw: (7 * Math.PI) / 4, key: 'y' },
];

/** Step one 45° facing clockwise (+1) or counter-clockwise (−1), wrapping around. */
export function turn(facing: Facing, dir: 1 | -1): Facing {
  const i = FACINGS.indexOf(facing);
  return FACINGS[(i + dir + FACINGS.length) % FACINGS.length]!;
}

/** The facing 180° away (used for walking backwards). */
export function opposite(facing: Facing): Facing {
  const i = FACINGS.indexOf(facing);
  return FACINGS[(i + 4) % FACINGS.length]!;
}

/** The sidestep direction ±90° (±2 steps); +1 is to the right of the facing. */
export function strafe(facing: Facing, dir: 1 | -1): Facing {
  const i = FACINGS.indexOf(facing);
  return FACINGS[(i + dir * 2 + FACINGS.length) % FACINGS.length]!;
}

/**
 * Collect billboard sprites for every remembered cell whose `top` glyph is a
 * thing standing on the terrain (monsters, pets, objects): cells whose `top`
 * is `cmap`/`unexplored`/`nothing` (or missing) are bare terrain and skipped.
 * The hero cell is excluded unless `includeHero` (ortho draws it as `@`).
 * Sprite colour is `clrToRgb(top.color) / 255`.
 */
export function spritesFromMap(
  map: LevelView,
  hero: { x: number; y: number } | null,
  includeHero: boolean,
): Sprite[] {
  const out: Sprite[] = [];
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const top = map.cellAt(x, y)?.top;
      if (!top) continue;
      if (top.cls === 'cmap' || top.cls === 'unexplored' || top.cls === 'nothing') continue;
      const isHero = hero !== null && hero.x === x && hero.y === y;
      if (isHero && !includeHero) continue;
      const c = clrToRgb(top.color);
      out.push({
        x,
        y,
        ch: isHero ? '@' : top.ch,
        rgb: [c[0] / 255, c[1] / 255, c[2] / 255],
        cls: top.cls,
      });
    }
  }
  return out;
}

/** Camera pose at the centre of the hero cell, looking along `yawRad`. */
export function poseFor(hero: { x: number; y: number }, yawRad: number): Pose {
  return { x: hero.x + 0.5, y: hero.y + 0.5, yaw: yawRad };
}

/** Copy a quantized `ScreenGrid` into a rectangle of the App's grid, clipped to its bounds. */
export function blitGrid(src: ScreenGrid, dst: ScreenGrid, rect: Rect): void {
  for (let y = 0; y < src.height; y++) {
    const dy = rect.y + y;
    if (dy < 0 || dy >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const dx = rect.x + x;
      if (dx < 0 || dx >= dst.width) continue;
      const s = src.cells[y * src.width + x]!;
      const d = dst.cells[dy * dst.width + dx]!;
      d.ch = s.ch;
      d.fg = s.fg;
      d.bg = s.bg;
    }
  }
}

/** Build a synthetic single-character key event (for translated moves). */
export function charKey(ch: string): KeyEvent {
  return { key: ch, ctrl: false, shift: false, alt: false, seq: ch };
}

/**
 * Answer a pending key/pos request with `e`, or hand it to `queueKey` when
 * NetHack is not waiting for a key (the app flushes it on the next request).
 */
export function sendKey(
  session: NethackSession,
  queueKey: (e: KeyEvent) => void,
  e: KeyEvent,
): void {
  const p = session.pending;
  if (p !== null && (p.kind === 'key' || p.kind === 'pos')) {
    const code = keyToCode(e);
    session.answer(p.kind === 'pos' ? { kind: 'pos', key: code } : { kind: 'key', key: code });
  } else {
    queueKey(e);
  }
}

/**
 * Owns one `FrameBuffer` + `ScreenGrid` sized to the viewport rect
 * (reallocated on size change). `render` runs `fn` against the buffer,
 * quantizes it with `theme`, and returns the reusable grid.
 */
export class Viewport3D {
  private fb: FrameBuffer | null = null;
  private grid: ScreenGrid | null = null;

  /** Render one frame into the reusable grid (same object while the size is unchanged). */
  render(rect: Rect, fn: (fb: FrameBuffer) => void, theme: Theme): ScreenGrid {
    if (
      this.fb === null ||
      this.grid === null ||
      this.fb.width !== rect.width ||
      this.fb.height !== rect.height
    ) {
      this.fb = makeFrameBuffer(rect.width, rect.height);
      this.grid = blankGrid(rect.width, rect.height);
    }
    fn(this.fb);
    return quantizeInto(this.fb, this.grid, { theme });
  }
}
