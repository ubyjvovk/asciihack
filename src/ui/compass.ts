/**
 * Compass ribbon for the first-person view (docs/architecture.md §7): a
 * heading strip on the top row of the fps viewport showing the facing heading
 * bright at the centre, the adjacent headings dim, and a `·`/`|` tick every
 * 15°, all on a black strip so it reads over the scene. The ribbon spans the
 * real horizontal field of view: its visible window is `±hFov/2` and its
 * scale is `(rect.width·0.34) / hFov` columns per radian, so the headings you
 * see are the headings actually in view. Pure painting; no I/O, no session
 * state.
 */
import type { ScreenGrid } from '../model/types.js';
import type { Rect } from './modes/classic.js';

/** The 8 headings with their bearings in degrees, clockwise from north. */
const HEADINGS: ReadonlyArray<{ name: string; deg: number }> = [
  { name: 'N', deg: 0 },
  { name: 'NE', deg: 45 },
  { name: 'E', deg: 90 },
  { name: 'SE', deg: 135 },
  { name: 'S', deg: 180 },
  { name: 'SW', deg: 225 },
  { name: 'W', deg: 270 },
  { name: 'NW', deg: 315 },
];
/** Colour of the nearest heading (bright white). */
const NEAR_FG: readonly [number, number, number] = [255, 255, 255];
/** Colour of the other visible headings (dim grey). */
const FAR_FG: readonly [number, number, number] = [120, 120, 120];
/** Colour of the 15° ticks (darker). */
const TICK_FG: readonly [number, number, number] = [80, 80, 80];
/** Ribbon background: black so it reads over any rendered scene. */
const BG: readonly [number, number, number] = [0, 0, 0];

/** Signed angular difference of `headingDeg` from `yawDeg` (degrees, wrapped to (−180, 180]). */
function deltaDeg(headingDeg: number, yawDeg: number): number {
  let d = ((headingDeg - yawDeg) % 360 + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}

/** Signed angular difference of `headingDeg` from `yawDeg` in radians (wrapped to (−π, π]). */
function deltaRad(headingDeg: number, yawDeg: number): number {
  return (deltaDeg(headingDeg, yawDeg) * Math.PI) / 180;
}

/**
 * Paint the compass ribbon on the first row of `rect`, centred on the
 * viewport: a black strip ~0.34 of the viewport width wide, the nearest
 * heading bright white (at the centre when it is being faced), the other
 * in-window headings dim grey, a `·` tick every 15° with a `|` facing notch
 * at the centre column. The visible window is `±hFovRad/2` so the headings in
 * view are exactly the headings the camera sees.
 */
export function paintCompass(grid: ScreenGrid, rect: Rect, yawRad: number, hFovRad: number): void {
  const yawDeg = (yawRad * 180) / Math.PI;
  const centre = rect.x + Math.floor(rect.width / 2);
  const y = rect.y;
  if (y < 0 || y >= grid.height) return;
  // Columns per radian, chosen so the ribbon stays ~a third of the viewport
  // width at any FOV; the visible half-width is then rect.width·0.34/2.
  const scale = (rect.width * 0.34) / hFovRad;
  const half = Math.round((rect.width * 0.34) / 2);
  // Black strip so the markers read over the rendered scene (a hair wider to
  // cover two-character headings that straddle the window edge).
  for (let x = centre - half - 2; x <= centre + half + 2; x++) {
    if (x < 0 || x >= grid.width) continue;
    const cell = grid.cells[y * grid.width + x]!;
    cell.ch = ' ';
    cell.fg = BG;
    cell.bg = BG;
  }
  const put = (x: number, ch: string, fg: readonly [number, number, number]): void => {
    if (x < 0 || x >= grid.width) return;
    const cell = grid.cells[y * grid.width + x]!;
    cell.ch = ch;
    cell.fg = fg;
    cell.bg = BG;
  };
  // 15° ticks across the visible window (±hFov/2); the centre one is the notch.
  for (let d = -90; d <= 90; d += 15) {
    const off = Math.round(((d * Math.PI) / 180) * scale);
    if (Math.abs(off) > half) continue;
    put(centre + off, d === 0 ? '|' : '·', TICK_FG);
  }
  // Headings inside the window; the nearest one bright, the rest dim.
  let nearest: { name: string; deg: number } | null = null;
  let nearestAbs = Infinity;
  for (const h of HEADINGS) {
    const a = Math.abs(deltaDeg(h.deg, yawDeg));
    if (a < nearestAbs) {
      nearestAbs = a;
      nearest = h;
    }
  }
  for (const h of HEADINGS) {
    const off = Math.round(deltaRad(h.deg, yawDeg) * scale);
    if (Math.abs(off) > half) continue;
    const col = centre + off;
    const fg = h === nearest ? NEAR_FG : FAR_FG;
    for (let i = 0; i < h.name.length; i++) put(col + i, h.name[i]!, fg);
  }
}
