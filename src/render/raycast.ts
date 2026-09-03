/**
 * First-person grid raycaster (docs/architecture.md §5.2). Pure and
 * deterministic: given a `LevelView`, `Pose`, sprite list and `FrameBuffer` it
 * fills the buffer and returns nothing. No I/O, no globals.
 */
import { isSolid, type CellKind, type FrameBuffer, type LevelView, type Pose, type Sprite } from '../model/types.js';
import { barsShade, brickShade, floorShade, gridShade, MORTAR, plankShade, veilShade } from './texture.js';

/** Per-kind linear RGB (0..1, before exposure and fog). Anything not listed is floor-coloured. */
export const KIND_COLORS: Record<CellKind, readonly [number, number, number]> = {
  wall: [0.14, 0.14, 0.15],
  door_closed: [0.16, 0.11, 0.06],
  doorway: [0.28, 0.22, 0.14],
  door_open: [0.28, 0.22, 0.14],
  tree: [0.05, 0.14, 0.05],
  bars: [0.1, 0.16, 0.17],
  stone: [0.12, 0.12, 0.13],
  unexplored: [0.03, 0.03, 0.05],
  floor: [0.1, 0.1, 0.11],
  corridor: [0.07, 0.065, 0.06],
  water: [0.1, 0.25, 0.6],
  lava: [0.85, 0.35, 0.05],
  ice: [0.55, 0.75, 0.85],
  stairs_up: [0.85, 0.85, 0.4],
  stairs_down: [0.85, 0.85, 0.4],
  ladder_up: [0.1, 0.1, 0.11],
  ladder_down: [0.1, 0.1, 0.11],
  altar: [0.7, 0.7, 0.75],
  fountain: [0.3, 0.5, 0.9],
  sink: [0.1, 0.1, 0.11],
  grave: [0.1, 0.1, 0.11],
  throne: [0.1, 0.1, 0.11],
  air: [0.1, 0.1, 0.11],
  cloud: [0.1, 0.1, 0.11],
  drawbridge: [0.1, 0.1, 0.11],
  trap: [0.6, 0.2, 0.6],
  other: [0.1, 0.1, 0.11],
};

/** Linear RGB of the ceiling — pure black: poorly lit, nothing to see up there. */
export const CEILING_COLOR: readonly [number, number, number] = [0, 0, 0];

/** Absolute brightness of brick/plank seams (painted at this value, then fogged). */
const MORTAR_ABS = 0.05;
/** Absolute brightness of the wall's top edge line (not fogged, so it reads far off). */
const EDGE_TOP = 0.75;
/** Absolute brightness of a wall's bottom contact row (not fogged). */
const EDGE_BOT = 0.3;
/** Absolute brightness of wall corner columns (not fogged). */
const EDGE_CORNER = 0.55;
/** Absolute brightness of door/doorway frame posts (not fogged). */
const EDGE_POST = 0.7;
/** Absolute brightness of the floor's perspective grid lines (not fogged). */
const EDGE_GRID = 0.3;

/** Tuning knobs for `renderFirstPerson`; every field has a default. */
export interface RaycastOptions {
  /** Horizontal field of view in degrees. If set it is kept as the horizontal
   *  FOV and the vertical one is derived from the aspect (back-compat); when
   *  unset the vertical FOV is `vFovDeg` and the horizontal is derived. */
  fovDeg?: number;
  /** Vertical field of view in degrees (default 60) when `fovDeg` is unset. */
  vFovDeg?: number;
  /** Horizon row as a fraction of the buffer height (default 0.42) — the camera
   *  pitches down a little so the near floor is on screen at any aspect. */
  horizonFrac?: number;
  /** Distance in cells beyond which nothing is drawn (default 24). */
  maxDepth?: number;
  /** Terminal cell height / width, drives the derived FOV (default 2). */
  cellAspect?: number;
  /** Fog attenuation coefficient (default 0.28). */
  fogK?: number;
  /** Apply procedural surface detail (bricks, floor grid, frames, edges); default true. */
  detail?: boolean;
}

const DEFAULT_VFOV_DEG = 60;
const DEFAULT_HORIZON_FRAC = 0.42;
const DEFAULT_MAX_DEPTH = 24;
const DEFAULT_CELL_ASPECT = 2;
const DEFAULT_FOG_K = 0.28;
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
  const vFovDeg = opts.vFovDeg ?? DEFAULT_VFOV_DEG;
  const horizonFrac = opts.horizonFrac ?? DEFAULT_HORIZON_FRAC;
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
  // Camera: by default the VERTICAL FOV is fixed (vFovDeg) and the horizontal
  // one is derived so a landscape terminal sees more sideways — with the old
  // fixed-horizontal setup a wide terminal derived a narrow vertical FOV and
  // the floor tile in front fell below the bottom of the screen. If the caller
  // passes `fovDeg` explicitly we keep it as the horizontal FOV and derive the
  // vertical one from the aspect (back-compat for tests).
  let fovRad: number;
  let vFovRad: number;
  if (opts.fovDeg !== undefined) {
    fovRad = (opts.fovDeg * Math.PI) / 180;
    // Vertical FOV is aspect-corrected: a terminal cell is twice as tall as wide.
    vFovRad = (fovRad * rows * cellAspect) / cols;
  } else {
    vFovRad = (vFovDeg * Math.PI) / 180;
    fovRad = 2 * Math.atan(Math.tan(vFovRad / 2) * (cols / (rows * cellAspect)));
  }
  const fH = cols / (2 * Math.tan(fovRad / 2)); // horizontal focal length (cells → pixels)
  const fV = rows / (2 * Math.tan(vFovRad / 2)); // vertical focal length
  const horizon = rows * horizonFrac; // camera pitches down a little: more floor, less ceiling
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
      const isCorner =
        detail && c > 0 && (!prevHadWall || hitX !== prevX || hitY !== prevY || side !== prevSide);
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
        const baseColor = KIND_COLORS[hitKind];
        for (let y = y0; y <= y1; y++) {
          const v = y1 > y0 ? (y - top) / (bot - top) : 1; // 0 at wall top, 1 at bottom
          const i = (y * cols + c) * 3;
          let r: number;
          let g: number;
          let b: number;
          if (hitKind === 'unexplored') {
            // the unknown: a dark veil, not a wall — flat base plus a sparse
            // speckle, no brick, no edge/corner lines, so it reads as never seen.
            const veil = veilShade(uFrac, v, seed);
            r = (baseColor[0] + veil) * atten;
            g = (baseColor[1] + veil) * atten;
            b = (baseColor[2] + veil) * atten;
          } else if (hitKind === 'wall') {
            const tex = brickShade(uFrac, v, seed);
            if (tex === MORTAR) {
              r = g = b = MORTAR_ABS * atten; // seams are absolute and fogged
            } else {
              const factor = faceFactor * tex;
              r = baseColor[0] * factor * atten;
              g = baseColor[1] * factor * atten;
              b = baseColor[2] * factor * atten;
            }
            // Edge lines are absolute brightness (not fogged) so silhouettes read
            // at distance; top edge is brightest, then corner columns, then the
            // bottom contact row.
            if (y === y0) r = g = b = EDGE_TOP;
            else if (isCorner) r = g = b = EDGE_CORNER;
            else if (y === y1) r = g = b = EDGE_BOT;
          } else if (hitKind === 'door_closed') {
            if (uFrac < 0.12 || uFrac > 0.88) {
              r = g = b = EDGE_POST; // wall-coloured frame posts, absolute
            } else {
              const p = plankShade(uFrac);
              if (p === MORTAR) {
                r = g = b = MORTAR_ABS * atten;
              } else {
                const factor = faceFactor * p;
                r = baseColor[0] * factor * atten;
                g = baseColor[1] * factor * atten;
                b = baseColor[2] * factor * atten;
              }
            }
          } else if (hitKind === 'bars') {
            const factor = faceFactor * barsShade(uFrac);
            r = baseColor[0] * factor * atten;
            g = baseColor[1] * factor * atten;
            b = baseColor[2] * factor * atten;
          } else {
            // stone, tree, and any other solid: flat face, no texture
            const factor = faceFactor;
            r = baseColor[0] * factor * atten;
            g = baseColor[1] * factor * atten;
            b = baseColor[2] * factor * atten;
            if (hitKind === 'stone' && y === y0) {
              r = g = b = EDGE_TOP; // known rock: flat grey with only the top edge line
            }
          }
          fb.rgb[i] = r;
          fb.rgb[i + 1] = g;
          fb.rgb[i + 2] = b;
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

  // --- ceiling pass: pure black above each column's wall top (no gradient) ---
  for (let c = 0; c < cols; c++) {
    const topRow = Math.floor(wallTop[c]!);
    if (topRow <= 0) continue;
    for (let y = 0; y < topRow; y++) {
      const i = (y * cols + c) * 3;
      fb.rgb[i] = CEILING_COLOR[0];
      fb.rgb[i + 1] = CEILING_COLOR[1];
      fb.rgb[i + 2] = CEILING_COLOR[2];
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
        let r: number;
        let g: number;
        let b: number;
        if (detail && (kind === 'doorway' || kind === 'door_open')) {
          // the doorway threshold reads as a wall-framed opening, not a gap in
          // the floor colour: outer 0.12 of the cell is a bright frame post,
          // the middle stays the passable door colour
          const fx = fX - Math.floor(fX);
          const fy = fY - Math.floor(fY);
          if (fx < 0.12 || fx > 0.88 || fy < 0.12 || fy > 0.88) {
            r = g = b = EDGE_POST;
          } else {
            r = base[0] * atten;
            g = base[1] * atten;
            b = base[2] * atten;
          }
        } else if (detail && kind === 'floor') {
          // flagstone floor: dark stone with a converging perspective grid. The
          // grid lines at cell edges are absolute brightness so they read as
          // the converging lines, not as a multiplier of the already-dark stone.
          const fx = fX - Math.floor(fX);
          const fy = fY - Math.floor(fY);
          if (Math.min(fx, 1 - fx) < 0.05 || Math.min(fy, 1 - fy) < 0.05) {
            r = g = b = EDGE_GRID;
          } else {
            const tex = floorShade(fX, fY);
            r = base[0] * tex * atten;
            g = base[1] * tex * atten;
            b = base[2] * tex * atten;
          }
        } else if (detail && kind === 'corridor') {
          const tex = floorShade(fX, fY, 1.0, false); // rough rock, no seams
          r = base[0] * tex * atten;
          g = base[1] * tex * atten;
          b = base[2] * tex * atten;
        } else if (
          detail &&
          (kind === 'ice' ||
            kind === 'stairs_up' ||
            kind === 'stairs_down' ||
            kind === 'altar' ||
            kind === 'throne')
        ) {
          // perspective grid on the other floor-like surfaces (not corridors)
          const edge = kind === 'stairs_up' || kind === 'stairs_down' ? 0.5 : 0.7;
          const gridFactor = gridShade(fX, fY, edge);
          r = base[0] * gridFactor * atten;
          g = base[1] * gridFactor * atten;
          b = base[2] * gridFactor * atten;
        } else {
          // flat: floor tint, water, lava, and the flat (detail:false) path
          r = base[0] * atten;
          g = base[1] * atten;
          b = base[2] * atten;
        }
        const i = (y * cols + x) * 3;
        fb.rgb[i] = r;
        fb.rgb[i + 1] = g;
        fb.rgb[i + 2] = b;
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
    // A sprite with tile art samples the 16×16 tile as a square billboard
    // (width = height cells; the cell aspect correction makes it square on
    // screen): only where the tile has an opaque pixel do we write the letter.
    if (s.tile) {
      const h = s.height ?? 0.7;
      const halfW = (fH * h) / (2 * tY);
      const halfH = (fV * h) / (2 * tY);
      const yBot = floorY;
      const yTop = yBot - (fV * h) / tY;
      const cellsW = 2 * halfW;
      const cellsH = yBot - yTop;
      if (cellsH < 2 || cellsW < 2) {
        // far/undersized billboards collapse to a single letter in the sprite colour
        const xc = Math.round(screenX);
        const yc = Math.round((yTop + yBot) / 2);
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
      const tile = s.tile;
      for (let y = y0; y <= y1; y++) {
        const v = (y + 0.5 - yTop) / cellsH;
        const vi = Math.min(15, Math.max(0, Math.floor(v * 16)));
        const shade = 0.85 + 0.15 * (1 - v); // slight vertical shading, top brighter
        for (let x = x0; x <= x1; x++) {
          const cell = y * cols + x;
          if (fb.depth[cell]! < tY) continue; // a closer wall/floor hides this cell
          const u = (x + 0.5 - (screenX - halfW)) / cellsW;
          const ui = Math.min(15, Math.max(0, Math.floor(u * 16)));
          const pal = tile.pixels[vi * 16 + ui]!;
          if (pal === 0) continue; // transparent pixel: floor shows through
          const pc = tile.palette[pal]!;
          fb.overlayCh[cell] = ch;
          const o = cell * 3;
          fb.overlayRgb[o] = (pc[0] / 255) * shade * atten;
          fb.overlayRgb[o + 1] = (pc[1] / 255) * shade * atten;
          fb.overlayRgb[o + 2] = (pc[2] / 255) * shade * atten;
          fb.depth[cell] = tY;
        }
      }
      continue;
    }
    // A shaped figure without a tile, standing on the floor at `s.height`
    // (no longer a fixed 0.9): monsters fh×fw/2, items a low fh×(4/3)fh shape.
    const fh = s.height ?? (MONSTER_CLS.has(s.cls) ? 0.9 : 0.3);
    const fw = MONSTER_CLS.has(s.cls) ? fh * 0.5 : fh * (4 / 3);
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
