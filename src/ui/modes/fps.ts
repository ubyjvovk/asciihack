/**
 * First-person mode (docs/architecture.md §5, §6.4, §7): renders the raycaster
 * view from the hero's facing, with arrow-key facing controls that translate
 * to NetHack vi-key moves and a smooth 120 ms turn animation. Only active
 * when NetHack is waiting for a key; otherwise keys flow to the overlay or
 * prompt exactly as in classic mode.
 */
import type { NethackSession } from '../../engine/session.js';
import type { ScreenGrid } from '../../model/types.js';
import type { KeyEvent } from '../../term/input.js';
import type { Theme } from '../../render/themes.js';
import { renderFirstPerson } from '../../render/raycast.js';
import { paintMinimap } from '../minimap.js';
import { paintCompass } from '../compass.js';
import { FOV_MIN, FOV_MAX } from '../settings.js';
import {
  FACINGS,
  charKey,
  opposite,
  poseFor,
  sendKey,
  spritesFromMap,
  strafe,
  turn,
  Viewport3D,
  type Facing,
  blitGrid,
} from '../view3d.js';
import type { Mode, Rect } from './classic.js';

/** Yaw turn duration in ms: the world swings instead of snapping. */
export const TURN_MS = 120;

/** Default vertical FOV in degrees (tuned with F6/F7 or `--fov`). */
export const DEFAULT_VFOV_DEG = 60;

/**
 * Horizontal FOV in radians for a vertical FOV at a given viewport size.
 * Mirrors the derivation inside `renderFirstPerson` (src/render/raycast.ts)
 * and must be kept identical (docs/architecture.md §5.2): a terminal cell is twice as tall as wide, so the horizontal FOV is
 * wider than the vertical one on a landscape viewport.
 */
export function hFovRad(vFovDeg: number, cols: number, rows: number, cellAspect = 2): number {
  const vFovRad = (vFovDeg * Math.PI) / 180;
  return 2 * Math.atan(Math.tan(vFovRad / 2) * (cols / (rows * cellAspect)));
}

/** Facing index after a digit/arrow key that also moves (vi-keys + numpad). */
const DIGIT_FACING: Record<string, number> = {
  h: 6,
  k: 0,
  l: 2,
  j: 4,
  y: 7,
  u: 1,
  b: 5,
  n: 3,
  H: 6,
  K: 0,
  L: 2,
  J: 4,
  Y: 7,
  U: 1,
  B: 5,
  N: 3,
  '4': 6,
  '8': 0,
  '6': 2,
  '2': 4,
  '7': 7,
  '9': 1,
  '1': 5,
  '3': 3,
};

/** Shortest signed yaw delta from `from` to `to` (radians, wrapped to ±π). */
function yawDelta(from: number, to: number): number {
  let d = (to - from) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** First-person view: raycast from the hero cell along the facing yaw. */
export class FpsMode implements Mode {
  readonly name = 'fps';
  private readonly session: NethackSession;
  private readonly viewport = new Viewport3D();
  private facing: Facing = FACINGS[0]!;
  private yaw: number;
  private yawFrom: number;
  private yawTo: number;
  private turnStart = 0;
  private turning = false;
  private now: () => number;
  /** Active render theme (cycled with F5 by the App). */
  theme: Theme = 'cyber';
  /** Whether the minimap overlay is shown (toggled with F4 by the App). */
  showMinimap = true;
  /** Vertical FOV in degrees for the raycaster (adjusted with F6/F7 by the App). */
  vFovDeg = DEFAULT_VFOV_DEG;
  /**
   * When true the CPU raycaster is skipped and the viewport cells are left as
   * spaces on black so an external renderer (browser WebGL, T-0031) shows
   * through; the minimap and compass still paint on top.
   */
  externalViewport = false;

  /** @param session - the session whose map and hero this mode renders. */
  constructor(session: NethackSession, now: () => number = () => Date.now()) {
    this.session = session;
    this.now = now;
    this.yaw = FACINGS[0]!.yaw;
    this.yawFrom = this.yaw;
    this.yawTo = this.yaw;
  }

  onEnter(): void {}

  onLeave(): void {}

  /** The current facing (the direction `Up` walks). */
  get currentFacing(): Facing {
    return this.facing;
  }

  /** The interpolated camera yaw in radians (settles to the facing yaw). */
  get currentYaw(): number {
    return this.yaw;
  }

  /** Whether a turn animation is still running. */
  get isTurning(): boolean {
    return this.turning;
  }

  paintViewport(grid: ScreenGrid, rect: Rect): void {
    const hero = this.session.hero;
    if (hero === null) return;
    this.advance(this.now());
    const vFovDeg = Math.min(FOV_MAX, Math.max(FOV_MIN, this.vFovDeg));
    if (!this.externalViewport) {
      const sprites = spritesFromMap(this.session, hero, false);
      const sub = this.viewport.render(
        { x: 0, y: 0, width: Math.max(1, rect.width), height: Math.max(1, rect.height) },
        (fb) =>
          renderFirstPerson(
            this.session.map,
            poseFor(hero, this.yaw),
            sprites,
            fb,
            { vFovDeg, cellAspect: 2 },
          ),
        this.theme,
      );
      blitGrid(sub, grid, rect);
    }
    if (this.showMinimap) paintMinimap(grid, rect, this.session, this.facing);
    const hFov = hFovRad(vFovDeg, Math.max(1, rect.width), Math.max(1, rect.height));
    paintCompass(grid, rect, this.yaw, hFov);
  }

  /**
   * Advance the turn animation toward the facing yaw. Returns `true` while
   * more frames are needed (the App keeps repainting at ≤ 30 fps).
   */
  tick(nowMs: number): boolean {
    return this.advance(nowMs);
  }

  private advance(nowMs: number): boolean {
    if (!this.turning) return false;
    const t = Math.min(1, (nowMs - this.turnStart) / TURN_MS);
    this.yaw = this.yawFrom + yawDelta(this.yawFrom, this.yawTo) * t;
    if (t >= 1) {
      this.yaw = this.yawTo;
      this.turning = false;
      return false;
    }
    return true;
  }

  private startTurn(to: Facing): void {
    this.yawFrom = this.yaw;
    this.yawTo = to.yaw;
    this.facing = to;
    this.turnStart = this.now();
    this.turning = true;
  }

  handleKey(e: KeyEvent, queueKey: (ev: KeyEvent) => void): void {
    if (e.key === 'Left' || e.key === 'Right') {
      const dir = e.key === 'Right' ? 1 : -1;
      if (!e.shift) {
        // Turn: consumed, never sent to NetHack. One press steps a single
        // 45° facing (the 8 facings map to NetHack's 8 directions).
        this.startTurn(turn(this.facing, dir));
        return;
      }
      // Strafe: send the sidestep key, facing unchanged.
      sendKey(this.session, queueKey, charKey(strafe(this.facing, dir === 1 ? 1 : -1).key));
      return;
    }
    if (e.key === 'Up') {
      sendKey(this.session, queueKey, charKey(this.facing.key));
      return;
    }
    if (e.key === 'Down') {
      sendKey(this.session, queueKey, charKey(opposite(this.facing).key));
      return;
    }
    const idx = DIGIT_FACING[e.key];
    if (idx !== undefined) {
      this.facing = FACINGS[idx]!;
      this.yaw = this.yawTo = this.facing.yaw;
      this.yawFrom = this.yaw;
      this.turning = false;
      sendKey(this.session, queueKey, charKey(e.key));
      return;
    }
    sendKey(this.session, queueKey, e);
  }
}
