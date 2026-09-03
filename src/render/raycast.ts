/**
 * First-person grid raycaster (docs/architecture.md §5.2). Pure and
 * deterministic: given a `LevelView`, `Pose`, sprite list and `FrameBuffer` it
 * fills the buffer and returns nothing. No I/O, no globals.
 */
import { isSolid, type CellKind, type FrameBuffer, type LevelView, type Pose, type Sprite } from '../model/types.js';

/** Per-kind linear RGB (0..1, before exposure and fog). Anything not listed is floor-coloured. */
export const KIND_COLORS: Record<CellKind, readonly [number, number, number]> = {
  wall: [0.55, 0.53, 0.5],
  door_closed: [0.55, 0.35, 0.15],
  doorway: [0.45, 0.3, 0.12],
  door_open: [0.45, 0.3, 0.12],
  tree: [0.15, 0.45, 0.15],
  bars: [0.3, 0.6, 0.65],
  stone: [0.06, 0.06, 0.07],
  unexplored: [0.06, 0.06, 0.07],
  floor: [0.4, 0.37, 0.33],
  corridor: [0.28, 0.22, 0.16],
  water: [0.1, 0.25, 0.6],
  lava: [0.85, 0.35, 0.05],
  ice: [0.55, 0.75, 0.85],
  stairs_up: [0.85, 0.85, 0.4],
  stairs_down: [0.85, 0.85, 0.4],
  ladder_up: [0.4, 0.37, 0.33],
  ladder_down: [0.4, 0.37, 0.33],
  altar: [0.7, 0.7, 0.75],
  fountain: [0.3, 0.5, 0.9],
  sink: [0.4, 0.37, 0.33],
  grave: [0.4, 0.37, 0.33],
  throne: [0.4, 0.37, 0.33],
  air: [0.4, 0.37, 0.33],
  cloud: [0.4, 0.37, 0.33],
  drawbridge: [0.4, 0.37, 0.33],
  trap: [0.6, 0.2, 0.6],
  other: [0.4, 0.37, 0.33],
};

/** Linear RGB of the ceiling, fading to black at the top row. */
export const CEILING_COLOR: readonly [number, number, number] = [0.03, 0.03, 0.04];

/** Tuning knobs for `renderFirstPerson`; every field has a default. */
export interface RaycastOptions {
  /** Horizontal field of view in degrees (default 70). */
  fovDeg?: number;
  /** Distance in cells beyond which nothing is drawn (default 24). */
  maxDepth?: number;
  /** Terminal cell height / width, drives the vertical FOV (default 2). */
  cellAspect?: number;
  /** Fog attenuation coefficient (default 0.18). */
  fogK?: number;
}

const DEFAULT_FOV_DEG = 70;
const DEFAULT_MAX_DEPTH = 24;
const DEFAULT_CELL_ASPECT = 2;
const DEFAULT_FOG_K = 0.18;

/** Scale an RGB triple by a factor (returns a new array). */
function scale(c: readonly [number, number, number], f: number): [number, number, number] {
  return [c[0] * f, c[1] * f, c[2] * f];
}

/**
 * Render a first-person view of `level` from `pose` into `fb`, drawing any
 * `sprites` as depth-tested billboards. Pure and deterministic.
 */
export function renderFirstPerson(
  level: LevelView,
  pose: Pose,
  sprites: Sprite[],
  fb: FrameBuffer,
  opts: RaycastOptions = {},
): void {
  const fovDeg = opts.fovDeg ?? DEFAULT_FOV_DEG;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const cellAspect = opts.cellAspect ?? DEFAULT_CELL_ASPECT;
  const fogK = opts.fogK ?? DEFAULT_FOG_K;

  const cols = fb.width;
  const rows = fb.height;
  const fovRad = (fovDeg * Math.PI) / 180;
  // Vertical FOV is aspect-corrected: a terminal cell is twice as tall as wide.
  const vFovRad = (fovRad * rows * cellAspect) / cols;
  const fH = cols / (2 * Math.tan(fovRad / 2)); // horizontal focal length (cells → pixels)
  const fV = rows / (2 * Math.tan(vFovRad / 2)); // vertical focal length
  const horizon = rows / 2;
  const posZ = 0.5 * fV; // eye height in focal units

  const posX = pose.x;
  const posY = pose.y;
  // yaw 0 = north (−y), +π/2 = east, clockwise from above.
  const dirX = Math.sin(pose.yaw);
  const dirY = -Math.cos(pose.yaw);
  const tanHalf = Math.tan(fovRad / 2);
  const planeX = -dirY * tanHalf;
  const planeY = dirX * tanHalf;

  // Per-column wall depth and draw extents (filled by the wall pass, consumed by
  // the ceiling/floor passes so a wall cell is never overwritten by them).
  const wallTop = new Float32Array(cols);
  const wallBot = new Float32Array(cols);

  // --- wall pass: one DDA ray per column ---
  for (let c = 0; c < cols; c++) {
    const camX = (2 * c) / cols - 1;
    const rdx = dirX + planeX * camX;
    const rdy = dirY + planeY * camX;

    let mapX = Math.floor(posX);
    let mapY = Math.floor(posY);
    const deltaX = Math.abs(1 / rdx);
    const deltaY = Math.abs(1 / rdy);
    let stepX: number;
    let stepY: number;
    let sideDistX: number;
    let sideDistY: number;
    if (rdx < 0) {
      stepX = -1;
      sideDistX = (posX - mapX) * deltaX;
    } else {
      stepX = 1;
      sideDistX = (mapX + 1 - posX) * deltaX;
    }
    if (rdy < 0) {
      stepY = -1;
      sideDistY = (posY - mapY) * deltaY;
    } else {
      stepY = 1;
      sideDistY = (mapY + 1 - posY) * deltaY;
    }

    let side = 0;
    let hitKind: CellKind | null = null;
    for (let i = 0; i < 256; i++) {
      if (sideDistX < sideDistY) {
        sideDistX += deltaX;
        mapX += stepX;
        side = 0;
      } else {
        sideDistY += deltaY;
        mapY += stepY;
        side = 1;
      }
      if (mapX < 0 || mapY < 0 || mapX >= level.width || mapY >= level.height) break;
      const k = level.kindAt(mapX, mapY);
      if (isSolid(k)) {
        hitKind = k;
        break;
      }
      const perp = side === 0 ? sideDistX - deltaX : sideDistY - deltaY;
      if (perp > maxDepth) break;
    }

    if (hitKind !== null) {
      const perpDist = side === 0 ? sideDistX - deltaX : sideDistY - deltaY;
      const d = Math.min(perpDist, maxDepth);
      const top = horizon - (fV * 0.5) / d;
      const bot = horizon + (fV * 0.5) / d;
      wallTop[c] = top;
      wallBot[c] = bot;
      let base = KIND_COLORS[hitKind];
      if (side === 0) base = scale(base, 0.7); // E/W face at 70 %, N/S at 100 %
      const atten = Math.exp(-fogK * d);
      const r = base[0] * atten;
      const g = base[1] * atten;
      const b = base[2] * atten;
      const y0 = Math.max(0, Math.floor(top));
      const y1 = Math.min(rows - 1, Math.ceil(bot));
      for (let y = y0; y <= y1; y++) {
        const i = (y * cols + c) * 3;
        fb.rgb[i] = r;
        fb.rgb[i + 1] = g;
        fb.rgb[i + 2] = b;
        fb.depth[y * cols + c] = d;
      }
    } else {
      wallTop[c] = horizon;
      wallBot[c] = horizon;
    }
  }

  // --- ceiling pass: black gradient above each column's wall top ---
  for (let c = 0; c < cols; c++) {
    const topRow = Math.floor(wallTop[c]!);
    if (topRow <= 0) continue;
    for (let y = 0; y < topRow; y++) {
      const factor = Math.min(1, y / horizon); // 0 at the top row, 1 at the horizon
      const r = CEILING_COLOR[0] * factor;
      const g = CEILING_COLOR[1] * factor;
      const b = CEILING_COLOR[2] * factor;
      const i = (y * cols + c) * 3;
      fb.rgb[i] = r;
      fb.rgb[i + 1] = g;
      fb.rgb[i + 2] = b;
      fb.depth[y * cols + c] = horizon - y > 0 ? posZ / (horizon - y) : Number.POSITIVE_INFINITY;
    }
  }

  // --- floor pass: per-row distance, per-column horizontal step ---
  for (let y = Math.ceil(horizon); y < rows; y++) {
    const p = y - horizon;
    if (p <= 0) {
      // horizon row: only where no wall covers it (infinite distance → black)
      for (let x = 0; x < cols; x++) {
        if (y >= wallBot[x]!) {
          const i = (y * cols + x) * 3;
          fb.rgb[i] = 0;
          fb.rgb[i + 1] = 0;
          fb.rgb[i + 2] = 0;
          fb.depth[y * cols + x] = Number.POSITIVE_INFINITY;
        }
      }
      continue;
    }
    const rowDist = posZ / p;
    if (rowDist > maxDepth) {
      for (let x = 0; x < cols; x++) {
        if (y >= wallBot[x]!) {
          const i = (y * cols + x) * 3;
          fb.rgb[i] = 0;
          fb.rgb[i + 1] = 0;
          fb.rgb[i + 2] = 0;
          fb.depth[y * cols + x] = Number.POSITIVE_INFINITY;
        }
      }
      continue;
    }
    const stepX = (rowDist * 2 * planeX) / cols;
    const stepY = (rowDist * 2 * planeY) / cols;
    let fX = posX + rowDist * (dirX - planeX);
    let fY = posY + rowDist * (dirY - planeY);
    const atten = Math.exp(-fogK * rowDist);
    for (let x = 0; x < cols; x++) {
      if (y >= wallBot[x]!) {
        const kind = level.kindAt(Math.floor(fX), Math.floor(fY));
        const base = isSolid(kind) ? KIND_COLORS.stone : KIND_COLORS[kind];
        const i = (y * cols + x) * 3;
        fb.rgb[i] = base[0] * atten;
        fb.rgb[i + 1] = base[1] * atten;
        fb.rgb[i + 2] = base[2] * atten;
        fb.depth[y * cols + x] = rowDist;
      }
      fX += stepX;
      fY += stepY;
    }
  }

  // --- sprites: far to near, depth-tested per cell against the buffer depth ---
  const ordered = sprites
    .map((s) => ({ s, dx: s.x + 0.5 - posX, dy: s.y + 0.5 - posY }))
    .filter((o) => Math.abs(o.dx) > 1e-9 || Math.abs(o.dy) > 1e-9) // skip the camera cell
    .sort((a, b) => b.dx * b.dx + b.dy * b.dy - (a.dx * a.dx + a.dy * a.dy));

  const invDet = 1 / (planeX * dirY - dirX * planeY);
  for (const { s, dx, dy } of ordered) {
    const tX = invDet * (dirY * dx - dirX * dy);
    const tY = invDet * (-planeY * dx + planeX * dy);
    if (tY <= 1e-6) continue; // behind the camera
    const screenX = (cols / 2) * (1 + tX / tY);
    const halfW = (fH * 0.7) / (2 * tY); // billboard 0.7 cells wide
    const yTop = horizon - (fV * 0.4) / tY; // billboard 0.9 cells tall, base at floor
    const yBot = horizon + (fV * 0.5) / tY;
    const x0 = Math.max(0, Math.floor(screenX - halfW));
    const x1 = Math.min(cols - 1, Math.ceil(screenX + halfW));
    const y0 = Math.max(0, Math.floor(yTop));
    const y1 = Math.min(rows - 1, Math.ceil(yBot));
    const atten = Math.exp(-fogK * tY);
    const ch = s.ch.charCodeAt(0);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const cell = y * cols + x;
        if (fb.depth[cell]! < tY) continue; // a closer wall/floor hides this sprite cell
        fb.overlayCh[cell] = ch;
        const o = cell * 3;
        fb.overlayRgb[o] = s.rgb[0] * atten;
        fb.overlayRgb[o + 1] = s.rgb[1] * atten;
        fb.overlayRgb[o + 2] = s.rgb[2] * atten;
        fb.depth[cell] = tY;
      }
    }
  }
}
