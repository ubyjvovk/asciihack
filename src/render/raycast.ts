/**
 * First-person grid raycaster (docs/architecture.md §5.2). Pure and
 * deterministic: given a `LevelView`, `Pose`, sprite list and `FrameBuffer` it
 * fills the buffer and returns nothing. No I/O, no globals.
 */
import { isSolid, type CellKind, type FrameBuffer, type LevelView, type Pose, type Sprite } from '../model/types.js';
import { barsShade, brickShade, floorShade, gridShade, MORTAR, plankShade, veilShade } from './texture.js';

/** Per-kind linear RGB (0..1, before exposure and fog). Anything not listed is floor-coloured. */
export const KIND_COLORS: Record<CellKind, readonly [number, number, number]> = {
  wall: [0.18, 0.18, 0.19],
  door_closed: [0.2, 0.15, 0.1],
  doorway: [0.32, 0.26, 0.18],
  door_open: [0.32, 0.26, 0.18],
  tree: [0.09, 0.18, 0.09],
  bars: [0.14, 0.2, 0.21],
  stone: [0.12, 0.12, 0.12],
  unexplored: [0.03, 0.03, 0.03],
  floor: [0.1, 0.1, 0.11],
  corridor: [0.12, 0.115, 0.11],
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

/** Absolute brightness of brick/plank seams (painted at this value, then fogged): a faint darker line, not a dotted contour. */
const MORTAR_ABS = 0.11;
/** Absolute brightness of the wall's top edge line (half-fog), just below the amber bloom so it stays amber. */
const EDGE_TOP = 0.42;
/** Absolute brightness of a wall's bottom contact row (half-fog). */
const EDGE_BOT = 0.2;
/** Absolute brightness of wall corner columns (half-fog). */
const EDGE_CORNER = 0.34;
/** Absolute brightness of door/doorway frame posts (half-fog). */
const EDGE_POST = 0.4;
/** Absolute brightness of the floor's perspective grid lines (half-fog), drawn in screen space. */
const EDGE_GRID = 0.16;
/** Absolute brightness of the dark seam between flagstones (half-fog), drawn in screen space. */
const SEAM_STONE = 0.045;
/** Absolute brightness of the stairs highlight — the one line allowed to bloom. */
const EDGE_STAIRS = 0.6;

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
  /** Fog attenuation coefficient (default 0.14). Absolute edge/grid lines use
   *  half this value so they fade with distance instead of glowing at any
   *  depth (wall body ≈ 0.12 at 3 cells, ≈ 0.08 at 6, gone by 10; top edge ≈
   *  0.37 at 10). */
  fogK?: number;
  /** Apply procedural surface detail (bricks, floor grid, frames, edges); default true. */
  detail?: boolean;
}

const DEFAULT_VFOV_DEG = 60;
const DEFAULT_HORIZON_FRAC = 0.42;
const DEFAULT_MAX_DEPTH = 24;
const DEFAULT_CELL_ASPECT = 2;
const DEFAULT_FOG_K = 0.14;
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
  // Previous column's hit side and perpendicular depth, for the corner-line
  // rule: a real corner is only where the hit **face** changes (N/S ↔ E/W) or
  // the perpendicular distance jumps by more than 0.5 cells between adjacent
  // columns. Same-face same-depth transitions across a flat wall's cell seams
  // must NOT fire (that lit the wall like a row of pillars).
  let prevSide = -1;
  let prevPerpDist = 0;
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
    let isDoorPost = false; // the ray hit the solid post at a doorway/open-door edge
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
          isDoorPost = true;
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
        detail && c > 0 && prevHadWall && (side !== prevSide || Math.abs(d - prevPerpDist) > 0.5);
      const atten = Math.exp(-fogK * d);
      const edgeAtten = Math.exp(-0.5 * fogK * d); // absolute lines fade at half strength
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
            if (isDoorPost) {
              // a doorway's two vertical posts: a thin solid frame at the
              // door-post brightness, no brick or edge lines.
              r = g = b = EDGE_POST * edgeAtten;
            } else {
              const tex = brickShade(uFrac, v, seed);
              if (tex === MORTAR) {
                r = g = b = MORTAR_ABS * atten; // seams are absolute and fogged
              } else {
                const factor = faceFactor * tex;
                r = baseColor[0] * factor * atten;
                g = baseColor[1] * factor * atten;
                b = baseColor[2] * factor * atten;
              }
              // Edge lines are absolute brightness fogged at half strength so
              // silhouettes read at distance but don't glow at any depth; top
              // edge is brightest, then corner columns, then the bottom contact.
              if (y === y0) r = g = b = EDGE_TOP * edgeAtten;
              else if (isCorner) r = g = b = EDGE_CORNER * edgeAtten;
              else if (y === y1) r = g = b = EDGE_BOT * edgeAtten;
            }
          } else if (hitKind === 'door_closed') {
            if (uFrac < 0.12 || uFrac > 0.88) {
              r = g = b = EDGE_POST * edgeAtten; // wall-coloured frame posts, half-fog
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
              r = g = b = EDGE_TOP * edgeAtten; // known rock: flat grey with only the top edge line
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
    prevSide = side;
    prevPerpDist = hitKind !== null ? Math.min(side === 0 ? sideDistX - deltaX : sideDistY - deltaY, maxDepth) : 0;
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
  // Screen-space seams (docs/render.md "Floor"): a seam is where the floor
  // cell index (or the half-cell flagstone index) differs from the sample
  // directly above (row − 1) or to its left (column − 1), so every seam is
  // exactly one screen cell thick at any distance instead of a world-space
  // width that fattens into thick bands near the camera.
  const prevRowMx = new Int32Array(cols);
  const prevRowMy = new Int32Array(cols);
  const prevRowFix = new Int32Array(cols);
  const prevRowFiy = new Int32Array(cols);
  // The floor coordinate that advances with depth (drives the horizontal
  // seams) vs laterally across columns (drives the vertical seams), from the
  // view direction. A horizontal seam only compares the depth coordinate with
  // the sample above — the lateral one drifts with depth, and comparing it
  // too would double the seams into 2-cell-thick jaggies.
  const depthIsX = Math.abs(dirX) >= Math.abs(dirY);
  let firstRow = true;
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
    const edgeAtten = Math.exp(-0.5 * fogK * rowDist); // half-strength fog for absolute lines
    let leftMx = -1;
    let leftMy = -1;
    let leftFix = -1;
    let leftFiy = -1;
    for (let x = 0; x < cols; x++) {
      const mx = Math.floor(fX);
      const my = Math.floor(fY);
      const fix = Math.floor(fX / 0.5);
      const fiy = Math.floor(fY / 0.5);
      // screen-space seams: a horizontal seam fires where the depth-aligned
      // floor coordinate crosses a cell boundary from the sample above, a
      // vertical seam where the lateral coordinate crosses from the sample to
      // the left — each exactly one screen cell thick. The first row and first
      // column have no valid neighbour, so those comparisons are skipped.
      const gridAbove = depthIsX ? mx !== prevRowMx[x]! : my !== prevRowMy[x]!;
      const gridLeft = depthIsX ? my !== leftMy : mx !== leftMx;
      const gridLine = (x > 0 && gridLeft) || (!firstRow && gridAbove);
      const flagAbove = depthIsX ? fix !== prevRowFix[x]! : fiy !== prevRowFiy[x]!;
      const flagLeft = depthIsX ? fiy !== leftFiy : fix !== leftFix;
      const flagSeam = (x > 0 && flagLeft) || (!firstRow && flagAbove);
      if (y >= wallBot[x]!) {
        const kind = level.kindAt(mx, my);
        const base = isSolid(kind) ? KIND_COLORS.stone : KIND_COLORS[kind];
        // Lit rooms use the base floor colour; a remembered-dark room floor
        // (MapCell.lit === false) dims the stone body ×0.45, and a lit
        // corridor (lit === true) brightens it ×1.4 — grid lines and seams
        // keep their absolute brightness so perspective still reads
        // (docs/render.md "Floor" and "Lighting").
        const lit = level.cellAt(mx, my)?.lit;
        let r: number;
        let g: number;
        let b: number;
        if (detail && kind === 'floor') {
          // flagstone floor: a grid line on each cell boundary, a dark seam
          // between half-cell stones, and a ±15 % stone body — all detected in
          // screen space so each is one cell thick at any distance. The grid
          // and seam keep their absolute brightness (they ignore the lit dim)
          // so dark rooms still show perspective.
          if (gridLine) {
            r = g = b = EDGE_GRID * edgeAtten;
          } else if (flagSeam) {
            r = g = b = SEAM_STONE * edgeAtten;
          } else {
            const tex = floorShade(fX, fY, 0.5, false);
            const dim = lit === false ? 0.45 : 1;
            r = base[0] * tex * atten * dim;
            g = base[1] * tex * atten * dim;
            b = base[2] * tex * atten * dim;
          }
        } else if (detail && kind === 'corridor') {
          // known corridor: neutral rough rock (side-1.0 stones, no seams), so
          // it quantizes to dots like a floor cell and stays distinct from the
          // black unknown veil. A lit corridor brightens ×1.4.
          const tex = floorShade(fX, fY, 1.0, false);
          const boost = lit === true ? 1.4 : 1;
          r = base[0] * tex * atten * boost;
          g = base[1] * tex * atten * boost;
          b = base[2] * tex * atten * boost;
        } else if (
          detail &&
          (kind === 'ice' ||
            kind === 'stairs_up' ||
            kind === 'stairs_down' ||
            kind === 'altar' ||
            kind === 'throne')
        ) {
          if (kind === 'stairs_up' || kind === 'stairs_down') {
            // stairs: the converging cell seams bloom as the one bright
            // highlight; the body is the flat stair colour.
            if (gridLine) {
              r = g = b = EDGE_STAIRS * edgeAtten;
            } else {
              r = base[0] * atten;
              g = base[1] * atten;
              b = base[2] * atten;
            }
          } else {
            // ice / altar / throne keep the world-space multiplier grid
            const gridFactor = gridShade(fX, fY, 0.7);
            r = base[0] * gridFactor * atten;
            g = base[1] * gridFactor * atten;
            b = base[2] * gridFactor * atten;
          }
        } else {
          // flat: a doorway / open door is just its door-coloured floor (the
          // two posts are the wall pass), water, lava, and the flat
          // (detail:false) path — no threshold frame.
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
      leftMx = mx;
      leftMy = my;
      leftFix = fix;
      leftFiy = fiy;
      prevRowMx[x] = mx;
      prevRowMy[x] = my;
      prevRowFix[x] = fix;
      prevRowFiy[x] = fiy;
      fX += stepX;
      fY += stepY;
    }
    firstRow = false;
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
