/**
 * First-person grid raycaster (docs/architecture.md §5.2). Pure and
 * deterministic: given a `LevelView`, `Pose`, sprite list and `FrameBuffer` it
 * fills the buffer and returns nothing. No I/O, no globals.
 */
import { isSolid, type CellKind, type FrameBuffer, type LevelView, type Pose, type Sprite } from '../model/types.js';
import { barsShade, brickShade, gridShade, plankShade, veilShade } from './texture.js';

/** Per-kind linear RGB (0..1, before exposure and fog). Anything not listed is floor-coloured. */
export const KIND_COLORS: Record<CellKind, readonly [number, number, number]> = {
  wall: [0.55, 0.53, 0.5],
  door_closed: [0.55, 0.35, 0.15],
  doorway: [0.45, 0.3, 0.12],
  door_open: [0.45, 0.3, 0.12],
  tree: [0.15, 0.45, 0.15],
  bars: [0.3, 0.6, 0.65],
  stone: [0.12, 0.12, 0.13],
  unexplored: [0.03, 0.03, 0.05],
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
  /** Apply procedural surface detail (bricks, floor grid, frames, edges); default true. */
  detail?: boolean;
}

const DEFAULT_FOV_DEG = 70;
const DEFAULT_MAX_DEPTH = 24;
const DEFAULT_CELL_ASPECT = 2;
const DEFAULT_FOG_K = 0.18;
const DEFAULT_DETAIL = true;

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
  const detail = opts.detail ?? DEFAULT_DETAIL;

  const cols = fb.width;
  const rows = fb.height;

  // Every frame the whole buffer is (re)written, including cells no pass covers:
  // clears stale overlay glyphs from a previous frame and guarantees the gap
  // rows left by an odd-height horizon (and columns whose ray escapes the map or
  // exceeds maxDepth) hold black at infinite depth instead of old data.
  fb.overlayCh.fill(0);
  fb.overlayRgb.fill(0);
  fb.rgb.fill(0);
  fb.depth.fill(Number.POSITIVE_INFINITY);
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
  // Previous column's hit cell and side, for vertical corner-line detection.
  let prevX = -1;
  let prevY = -1;
  let prevSide = -1;
  let prevHadWall = false;

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
      if (detail && (k === 'doorway' || k === 'door_open')) {
        // A doorway stays passable, but the outer 0.12 of the cell (its posts)
        // is solid wall-coloured frame so the opening reads against the wall.
        const perp = side === 0 ? sideDistX - deltaX : sideDistY - deltaY;
        const wallX = side === 0 ? posY + perp * rdy : posX + perp * rdx;
        const fracU = wallX - Math.floor(wallX);
        if (fracU < 0.12 || fracU > 0.88) {
          hitKind = 'wall';
          break;
        }
      }
      const perp = side === 0 ? sideDistX - deltaX : sideDistY - deltaY;
      if (perp > maxDepth) break;
    }

    const hitX = mapX;
    const hitY = mapY;
    if (hitKind !== null) {
      const perpDist = side === 0 ? sideDistX - deltaX : sideDistY - deltaY;
      const d = Math.min(perpDist, maxDepth);
      const top = horizon - (fV * 0.5) / d;
      const bot = horizon + (fV * 0.5) / d;
      wallTop[c] = top;
      wallBot[c] = bot;
      const faceFactor = side === 0 ? 0.7 : 1.0; // E/W face at 70 %, N/S at 100 %
      const corner = detail && c > 0 && (!prevHadWall || hitX !== prevX || hitY !== prevY || side !== prevSide) ? 1.15 : 1.0;
      const atten = Math.exp(-fogK * d);
      // face-fraction u across the hit face (0 at one edge, 1 at the other)
      const u = detail ? (side === 0 ? posY + d * rdy : posX + d * rdx) : 0;
      const uFrac = u - Math.floor(u);
      const seed = hitY * 80 + hitX;
      const y0 = Math.max(0, Math.floor(top));
      const y1 = Math.min(rows - 1, Math.ceil(bot));
      if (!detail) {
        // flat shading: the pre-detail path, byte-identical golden
        let base = KIND_COLORS[hitKind];
        if (side === 0) base = scale(base, 0.7);
        const r = base[0] * atten;
        const g = base[1] * atten;
        const b = base[2] * atten;
        for (let y = y0; y <= y1; y++) {
          const i = (y * cols + c) * 3;
          fb.rgb[i] = r;
          fb.rgb[i + 1] = g;
          fb.rgb[i + 2] = b;
          fb.depth[y * cols + c] = d;
        }
      } else {
        for (let y = y0; y <= y1; y++) {
          const v = y1 > y0 ? (y - top) / (bot - top) : 1; // 0 at wall top, 1 at bottom
          let texFactor = 1;
          let baseColor = KIND_COLORS[hitKind];
          if (hitKind === 'wall') {
            texFactor = brickShade(uFrac, v, seed);
          } else if (hitKind === 'door_closed') {
            if (uFrac < 0.12 || uFrac > 0.88) {
              baseColor = scale(KIND_COLORS.wall, 1.1); // wall-coloured frame posts
            } else {
              texFactor = plankShade(uFrac);
            }
          } else if (hitKind === 'bars') {
            texFactor = barsShade(uFrac);
          }
          if (hitKind === 'wall') {
            // light top edge, contact shadow at the bottom, brighter corner columns
            if (y === y0) texFactor *= 1.25;
            else if (y === y1) texFactor *= 0.8;
            texFactor *= corner;
          } else if (hitKind === 'stone' && y === y0) {
            texFactor *= 1.25; // known rock: flat grey with only the top edge line
          }
          const i = (y * cols + c) * 3;
          if (hitKind === 'unexplored') {
            // the unknown: a dark veil, not a wall — flat base plus a sparse
            // speckle, no brick, no edge/corner lines, so it reads as never seen.
            const veil = veilShade(uFrac, v, seed);
            fb.rgb[i] = (baseColor[0] + veil) * atten;
            fb.rgb[i + 1] = (baseColor[1] + veil) * atten;
            fb.rgb[i + 2] = (baseColor[2] + veil) * atten;
          } else {
            const factor = faceFactor * texFactor;
            fb.rgb[i] = baseColor[0] * factor * atten;
            fb.rgb[i + 1] = baseColor[1] * factor * atten;
            fb.rgb[i + 2] = baseColor[2] * factor * atten;
          }
          fb.depth[y * cols + c] = d;
        }
      }
    } else {
      wallTop[c] = horizon;
      wallBot[c] = horizon;
    }
    prevX = hitX;
    prevY = hitY;
    prevSide = side;
    prevHadWall = hitKind !== null;
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
        let base = isSolid(kind) ? KIND_COLORS.stone : KIND_COLORS[kind];
        let gridFactor = 1;
        if (detail && (kind === 'doorway' || kind === 'door_open')) {
          // the doorway threshold reads as a wall-framed opening, not a gap in
          // the floor colour: outer 0.12 of the cell is wall-coloured frame,
          // the middle stays the passable door colour
          const fx = fX - Math.floor(fX);
          const fy = fY - Math.floor(fY);
          if (fx < 0.12 || fx > 0.88 || fy < 0.12 || fy > 0.88) base = KIND_COLORS.wall;
        } else if (
          detail &&
          (kind === 'floor' ||
            kind === 'ice' ||
            kind === 'stairs_up' ||
            kind === 'stairs_down' ||
            kind === 'altar' ||
            kind === 'throne')
        ) {
          // perspective grid on floor-like surfaces (not corridors, water, lava)
          const edge = kind === 'stairs_up' || kind === 'stairs_down' ? 0.5 : 0.7;
          gridFactor = gridShade(fX, fY, edge);
        }
        const i = (y * cols + x) * 3;
        fb.rgb[i] = base[0] * gridFactor * atten;
        fb.rgb[i + 1] = base[1] * gridFactor * atten;
        fb.rgb[i + 2] = base[2] * gridFactor * atten;
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
  // figure classes: standing monsters vs low items lying on the floor
  const MONSTER_CLS = new Set(['mon', 'pet', 'ridden', 'detected', 'invisible', 'statue']);
  const ITEM_CLS = new Set(['obj', 'body']);
  for (const { s, dx, dy } of ordered) {
    const tX = invDet * (dirY * dx - dirX * dy);
    const tY = invDet * (-planeY * dx + planeX * dy);
    if (tY <= 1e-6) continue; // behind the camera
    const screenX = (cols / 2) * (1 + tX / tY);
    const atten = Math.exp(-fogK * tY);
    const ch = s.ch.charCodeAt(0);
    const floorY = horizon + (fV * 0.5) / tY; // floor row at this distance
    if (!MONSTER_CLS.has(s.cls) && !ITEM_CLS.has(s.cls)) {
      // unusual sprite classes keep the legacy rectangular billboard
      const halfW = (fH * 0.7) / (2 * tY);
      const yTop = horizon - (fV * 0.4) / tY;
      const yBot = floorY;
      const x0 = Math.max(0, Math.floor(screenX - halfW));
      const x1 = Math.min(cols - 1, Math.ceil(screenX + halfW));
      const yy0 = Math.max(0, Math.floor(yTop));
      const yy1 = Math.min(rows - 1, Math.ceil(yBot));
      for (let y = yy0; y <= yy1; y++) {
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
      continue;
    }
    // a shaped figure, base on the floor: monsters stand 0.45×0.9 cells,
    // items lie low at 0.4×0.3 cells.
    const fw = MONSTER_CLS.has(s.cls) ? 0.45 : 0.4;
    const fh = MONSTER_CLS.has(s.cls) ? 0.9 : 0.3;
    const halfW = (fH * fw) / (2 * tY);
    const halfH = (fV * fh) / (2 * tY);
    const yBot = floorY;
    const yTop = yBot - (fV * fh) / tY;
    const centreY = (yTop + yBot) / 2;
    if (yBot - yTop < 2) {
      // far sprites collapse to a single letter at full brightness, no rim
      const xc = Math.round(screenX);
      const yc = Math.round(centreY);
      if (xc < 0 || xc >= cols || yc < 0 || yc >= rows) continue;
      const cell = yc * cols + xc;
      if (fb.depth[cell]! < tY) continue;
      fb.overlayCh[cell] = ch;
      const o = cell * 3;
      fb.overlayRgb[o] = s.rgb[0] * atten;
      fb.overlayRgb[o + 1] = s.rgb[1] * atten;
      fb.overlayRgb[o + 2] = s.rgb[2] * atten;
      fb.depth[cell] = tY;
      continue;
    }
    const x0 = Math.max(0, Math.floor(screenX - halfW));
    const x1 = Math.min(cols - 1, Math.ceil(screenX + halfW));
    const y0 = Math.max(0, Math.floor(yTop));
    const y1 = Math.min(rows - 1, Math.ceil(yBot));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const cell = y * cols + x;
        if (fb.depth[cell]! < tY) continue; // a closer wall/floor hides this sprite cell
        const dxn = (x + 0.5 - screenX) / halfW;
        const dyn = (y + 0.5 - centreY) / halfH;
        const r2 = dxn * dxn + dyn * dyn;
        if (r2 > 1.35) continue; // outside the figure and its dark rim
        // figure cells shade from 1.0 at the centre to 0.55 at the ellipse edge;
        // the 1 < r² ≤ 1.35 ring is the letter at 0.22 (a dark separating rim).
        const bright = r2 <= 1 ? 1 - 0.45 * r2 : 0.22;
        fb.overlayCh[cell] = ch;
        const o = cell * 3;
        fb.overlayRgb[o] = s.rgb[0] * bright * atten;
        fb.overlayRgb[o + 1] = s.rgb[1] * bright * atten;
        fb.overlayRgb[o + 2] = s.rgb[2] * bright * atten;
        fb.depth[cell] = tY;
      }
    }
  }
}
