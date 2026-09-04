/**
 * Ortho / isometric renderer over the level grid (docs/architecture.md §5.3,
 * projection locked by ticket T-0021). Pure and deterministic: fills a
 * `FrameBuffer` with a zoomable 2:1 isometric view of the remembered level,
 * centred on the hero, exactly like the raycaster so the same quantizer and
 * screen writer show it. The look follows the first-person readable grammar
 * (docs/render.md "Look"): dark block faces that quantize to sparse glyphs,
 * bright top rims and corner lines at absolute brightness, dark seams, and
 * distance fog that leaves near edges crisp.
 *
 * Projection: a map point (X, Y) (x east, y south) hits the screen column
 * `c = ox + 2k·(X − Y)` and row `r = oy + k·(X + Y)`. The image of each unit
 * square is a 2:1 diamond `4k` columns wide and `2k` rows tall, and because
 * the diamond tiles the plane, every screen cell belongs to exactly one map
 * cell (the inverse maps through the cell centre and floors). Walls are blocks
 * extruded `3k` rows with a lit top and two shaded side faces; monsters and the
 * hero are shaped figures; items are low shapes; unexplored space shows a
 * faint diamond lattice so the player never floats in pure black.
 */
import { isSolid, type CellKind, type FrameBuffer, type LevelView, type Sprite } from '../model/types.js';
import { KIND_COLORS } from './raycast.js';
import { brickShade, floorShade, MORTAR } from './texture.js';

/** Screen-space origin of the isometric projection (also carries the zoom). */
export interface Origin {
  /** Horizontal origin in columns. */
  ox: number;
  /** Vertical origin in rows. */
  oy: number;
  /** Zoom factor: a map cell is a 4k×2k diamond. */
  k: number;
}

/** Tuning knobs for `renderOrtho`; every field has a default. */
export interface OrthoOptions {
  /** Explicit zoom factor `k` (default `clamp(round(rows/28), 1, 6)`). */
  zoom?: number;
  /** Fog attenuation coefficient over Chebyshev distance from the hero (default 0.06). */
  fogK?: number;
}

const DEFAULT_FOG_K = 0.06;

/** Absolute linear-RGB levels for the readable look (docs/render.md "Look"). */
const FACE_TOP = 0.16; // flat dark lid over every block's top face
const RIM_NEAR = 0.75; // upper two edges of the top face
const RIM_FAR = 0.45; // lower two edges of the top face
const EDGE_CORNER = 0.55; // vertical corner between the two side faces
const EDGE_BOT = 0.25; // the block's bottom contact line
const MORTAR_ABS = 0.05; // brick mortar, same absolute level as the raycaster
const SEAM_ABS = 0.3; // floor diamond seams
const DOOR_POST = 0.7; // wall post cells flanking a doorway / open door
/** Faces fade with this fog; rims within this Chebyshev distance stay crisp. */
const NEAR_CRISP = 3;

/** Clamp `v` to [lo, hi]. */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Inverse-map a screen cell `(c, r)` to the continuous map point (X, Y) at the
 * cell's centre (docs/architecture.md §5.3).
 */
function mapPoint(c: number, r: number, origin: Origin): { X: number; Y: number } {
  const { ox, oy, k } = origin;
  const u = (c + 0.5 - ox) / (2 * k);
  const v = (r + 0.5 - oy) / k;
  return { X: (u + v) / 2, Y: (v - u) / 2 };
}

/**
 * Project map cell `(x, y)` to the screen position of its centre `(x + 0.5, y + 0.5)`.
 */
export function cellToScreen(x: number, y: number, origin: Origin): { sx: number; sy: number } {
  const { ox, oy, k } = origin;
  return { sx: ox + 2 * k * (x - y), sy: oy + k * (x + y + 1) };
}

/**
 * Invert the projection: the unique map cell whose diamond contains screen
 * cell `(c, r)` (its centre inverse-mapped and floored).
 */
export function screenToCell(c: number, r: number, origin: Origin): { x: number; y: number } {
  const { X, Y } = mapPoint(c, r, origin);
  return { x: Math.floor(X), y: Math.floor(Y) };
}

/** Classes drawn as tall standing figures (monsters and the hero). */
const MONSTER_CLS = new Set(['mon', 'pet', 'ridden', 'detected', 'invisible', 'statue']);
/** Classes drawn as low items lying on the tile. */
const ITEM_CLS = new Set(['obj', 'body']);

/**
 * Render an ortho/isometric view of `level` centred on `hero` into `fb`,
 * drawing any `sprites` as figures/items on their tiles. Pure and
 * deterministic; fills every cell of the buffer each frame.
 */
export function renderOrtho(
  level: LevelView,
  hero: { x: number; y: number },
  sprites: Sprite[],
  fb: FrameBuffer,
  opts: OrthoOptions = {},
): void {
  const cols = fb.width;
  const rows = fb.height;
  const k = opts.zoom ?? clamp(Math.round(rows / 28), 1, 6);
  const fogK = opts.fogK ?? DEFAULT_FOG_K;
  const h = 3 * k; // wall extrusion height in rows
  const hx = hero.x;
  const hy = hero.y;

  // Anchor the hero's cell centre at (floor(cols/2), floor(rows·0.55)) — a
  // little below centre so the walls above have room.
  const ox = Math.floor(cols / 2) - 2 * k * (hx - hy);
  const oy = Math.floor(rows * 0.55) - k * (hx + hy + 1);
  const origin: Origin = { ox, oy, k };

  // Pre-fill the whole buffer each frame: stale overlay glyphs and any cell no
  // pass covers stay black at infinite depth, exactly as the raycaster does.
  fb.overlayCh.fill(0);
  fb.overlayRgb.fill(0);
  fb.rgb.fill(0);
  fb.depth.fill(Number.POSITIVE_INFINITY);

  const spriteByCell = new Map<string, Sprite>();
  for (const s of sprites) spriteByCell.set(`${s.x},${s.y}`, s);

  // --- doorway posts: the wall cells flanking a doorway / open door ---
  // A doorway is a floor tile in the door colour; its two post cells (the
  // wall cells west and east of it) paint at the absolute 0.70 level so the
  // opening reads as framed, like the raycaster's frame posts.
  const postCells = new Set<string>();
  for (let y = 0; y < level.height; y++) {
    for (let x = 0; x < level.width; x++) {
      const kd = level.kindAt(x, y);
      if (kd !== 'doorway' && kd !== 'door_open') continue;
      for (const px of [x - 1, x + 1]) {
        const kp = level.kindAt(px, y);
        if (isSolid(kp) && kp !== 'unexplored') postCells.add(`${px},${y}`);
      }
    }
  }

  // --- cutaway: a wall stands between the camera and a nearby figure ---
  // A wall is "in front of" a figure when its x+y exceeds the figure's and it
  // is within 2 cells of it in both axes; walls in front of the hero (or of a
  // monster within 2 cells of the hero) are painted as translucent ghost
  // blocks so the hero/monster stays visible through them (docs/render.md).
  const isCutaway = (x: number, y: number): boolean => {
    if (x + y > hx + hy && Math.abs(x - hx) <= 2 && Math.abs(y - hy) <= 2) return true;
    for (const s of sprites) {
      if (s.x === hx && s.y === hy) continue; // the hero itself
      if (!MONSTER_CLS.has(s.cls)) continue; // only monsters, not items
      if (Math.abs(s.x - hx) > 2 || Math.abs(s.y - hy) > 2) continue; // monster not near the hero
      if (x + y > s.x + s.y && Math.abs(x - s.x) <= 2 && Math.abs(y - s.y) <= 2) return true;
    }
    return false;
  };

  const isNearEdge = (X: number, Y: number): boolean => {
    const fx = X - Math.floor(X);
    const fy = Y - Math.floor(Y);
    // Cell-centre samples always land at distance ≥ 1/(8k) from a cell edge,
    // so the seam band must exceed that to stay visible (see docs/render.md).
    return Math.min(fx, 1 - fx) < 0.2 / k || Math.min(fy, 1 - fy) < 0.2 / k;
  };

  // --- floor pass: every screen cell, one inverse mapping each ---
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const { X, Y } = mapPoint(c, r, origin);
      const x = Math.floor(X);
      const y = Math.floor(Y);
      const kind = level.kindAt(x, y);
      const i = r * cols + c;
      const o = i * 3;
      const dist = Math.max(Math.abs(x - hx), Math.abs(y - hy));
      const atten = Math.exp(-fogK * dist);
      if (kind === 'unexplored') {
        // the unknown: pure black with faint diamond lattice seams (also covers
        // outside the 80×21 map, so the whole viewport shows the lattice). The
        // seams sit at 0.09 absolute so they survive the quantizer's black
        // point (0.09·1.7 ≈ 0.153 > 0.10 after the exposure curve) — at the old
        // 0.05 they quantized to space and the room floated in pure black again.
        if (isNearEdge(X, Y)) {
          fb.rgb[o] = 0.09 * atten;
          fb.rgb[o + 1] = 0.09 * atten;
          fb.rgb[o + 2] = 0.09 * atten;
        } else {
          fb.rgb[o] = 0;
          fb.rgb[o + 1] = 0;
          fb.rgb[o + 2] = 0;
        }
        continue;
      }
      if (isSolid(kind)) continue; // painted as a block by the wall pass
      if (kind === 'floor' || kind === 'doorway' || kind === 'door_open') {
        // flagstone floor: stones ±20 % from `floorShade`, diamond seams at an
        // absolute 0.30 so they read instead of fading with the dark base.
        const base = kind === 'floor' ? KIND_COLORS[kind] : KIND_COLORS.door_open;
        if (isNearEdge(X, Y)) {
          fb.rgb[o] = SEAM_ABS * atten;
          fb.rgb[o + 1] = SEAM_ABS * atten;
          fb.rgb[o + 2] = SEAM_ABS * atten;
        } else {
          const tex = floorShade(X, Y);
          fb.rgb[o] = base[0] * tex * atten;
          fb.rgb[o + 1] = base[1] * tex * atten;
          fb.rgb[o + 2] = base[2] * tex * atten;
        }
      } else {
        const base = KIND_COLORS[kind];
        fb.rgb[o] = base[0] * atten;
        fb.rgb[o + 1] = base[1] * atten;
        fb.rgb[o + 2] = base[2] * atten;
      }
      fb.depth[i] = x + y;
    }
  }

  // --- wall pass, painter's order (increasing x + y, then x) ---
  const cells: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < level.height; y++) {
    for (let x = 0; x < level.width; x++) cells.push({ x, y });
  }
  cells.sort((a, b) => a.x + a.y - (b.x + b.y) || a.x - b.x);

  const drawBlock = (x: number, y: number, kind: CellKind): void => {
    const sx = ox + 2 * k * (x - y);
    const sy = oy + k * (x + y + 1);
    const cMin = sx - 2 * k;
    const cMax = sx + 2 * k;
    if (cMax < 0 || cMin >= cols) return; // off-screen horizontally
    const rTop = sy - k - h;
    const rBot = sy + k;
    if (rBot < 0 || rTop >= rows) return; // off-screen vertically
    const base = KIND_COLORS[kind];
    const dist = Math.max(Math.abs(x - hx), Math.abs(y - hy));
    const atten = Math.exp(-fogK * dist);
    // Rims within 3 cells of the hero stay crisp (no fog fade); beyond that
    // they fade like the faces so distant blocks still read through the fog.
    const near = dist <= NEAR_CRISP;
    const rimAtten = near ? 1 : atten;
    const depthVal = x + y;
    const seed = y * 80 + x;
    const useBrick = kind === 'wall';
    const cutaway = isCutaway(x, y);
    const setBlockCell = (c: number, r: number, rr: number, gg: number, bb: number): void => {
      const i = r * cols + c;
      const o = i * 3;
      const ghost = cutaway ? 0.35 : 1;
      fb.rgb[o] = rr * ghost;
      fb.rgb[o + 1] = gg * ghost;
      fb.rgb[o + 2] = bb * ghost;
      fb.depth[i] = depthVal;
      if (cutaway && fb.overlayCh[i] !== 0) {
        // an already-drawn figure letter: keep it, dimmed (x-ray through the ghost wall)
        fb.overlayRgb[o] = (fb.overlayRgb[o] ?? 0) * 0.7;
        fb.overlayRgb[o + 1] = (fb.overlayRgb[o + 1] ?? 0) * 0.7;
        fb.overlayRgb[o + 2] = (fb.overlayRgb[o + 2] ?? 0) * 0.7;
      } else {
        fb.overlayCh[i] = 0;
        fb.overlayRgb[o] = 0;
        fb.overlayRgb[o + 1] = 0;
        fb.overlayRgb[o + 2] = 0;
      }
    };
    const sideBotOf = (c: number): number => {
      const gap = Math.abs(c - sx);
      return Math.floor(sy + (2 * k - gap) / 2);
    };
    // Upper/lower boundary rows of the *lid* (the base diamond shifted up h).
    // lidTopOf uses the same -k apex the wall pass below uses for the faces
    // (sy - k at gap 0), so the lid's top row is the true diamond edge; the
    // side faces hang below the lid's bottom row.
    const lidTopOf = (c: number): number => Math.ceil(sy - k + Math.abs(c - sx) / 2 - h);
    const lidBotOf = (c: number): number => sideBotOf(c) - h;
    // Paint one side-face cell: the vertical corner column and the bottom
    // contact line at absolute brightness, the body as the (fogged) base.
    // Precedence is top rim > corner > contact > body, like the raycaster:
    // the corner wins over contact except at the two bottom diamond tips.
    // Doorway posts paint entirely at the absolute 0.70 level instead.
    const isPost = postCells.has(`${x},${y}`);
    const paintFace = (c: number, r: number, bot: number, f: number): void => {
      const atBottomTip = r === bot && (c === sx - 2 * k + 1 || c === sx + 2 * k - 1);
      if (isPost) {
        const v = DOOR_POST * rimAtten;
        setBlockCell(c, r, v, v, v);
      } else if (c === sx && !atBottomTip) {
        // the vertical corner between the two faces, absolute brightness
        const v = EDGE_CORNER * rimAtten;
        setBlockCell(c, r, v, v, v);
      } else if (r === bot) {
        // the block's bottom contact line, absolute brightness
        const v = EDGE_BOT * rimAtten;
        setBlockCell(c, r, v, v, v);
      } else {
        const v = f * atten;
        setBlockCell(c, r, base[0] * v, base[1] * v, base[2] * v);
      }
    };
    for (let c = cMin; c <= cMax; c++) {
      if (c < 0 || c >= cols) continue;
      const gap = Math.abs(c - sx);
      const botBase = sideBotOf(c); // lower boundary of the base diamond at c
      // top face = the base diamond shifted up h; side face = the wall below it.
      // The lid keeps ONE row per diamond row: the lid's true diamond rows
      // wantTop..wantBot (not the loop's ±1 footprint, which overshoots the
      // diamond at the apex and smears the rim onto the neighbour tile).
      // The side faces hang below the lid's bottom row.
      const wantTop = lidTopOf(c);
      const sideBot = botBase;
      const r0 = Math.max(0, wantTop);
      const r1 = Math.min(rows - 1, lidBotOf(c));
      for (let r = r0; r <= r1; r++) {
        // the top face's upper edge paints at the absolute 0.75, its lower
        // edge at 0.45 (docs/render.md "Look"); the rows between are the
        // dark 0.16 lid. Doorway posts keep 0.70 everywhere.
        let v: number;
        if (isPost) v = DOOR_POST * rimAtten;
        else if (r === wantTop) v = RIM_NEAR * rimAtten;
        else if (r === lidBotOf(c)) v = RIM_FAR * rimAtten;
        else v = FACE_TOP * atten;
        setBlockCell(c, r, v, v, v);
      }
      for (let r = Math.max(0, lidBotOf(c) + 1); r <= Math.min(rows - 1, sideBot); r++) {
        if (useBrick) {
          // brick-textured wall: the body is base × face factor × brick
          // (±0.03), the mortar seams paint at the absolute 0.05 level.
          const faceFactor = c < sx ? 0.55 : 0.75;
          const u = c < sx ? (c - (sx - 2 * k)) / (2 * k) : (c - sx) / (2 * k);
          const v = (r - (botBase - h)) / h;
          const tex = brickShade(u, v, seed);
          if (tex === MORTAR) {
            const m = MORTAR_ABS * atten;
            setBlockCell(c, r, m, m, m);
          } else {
            paintFace(c, r, sideBot, faceFactor * tex);
          }
        } else {
          // stone, doors, tree, bars: flat faces, no texture
          paintFace(c, r, sideBot, c < sx ? 0.55 : 0.75);
        }
      }
    }
  };

  const drawSprite = (s: Sprite): void => {
    const sx = ox + 2 * k * (s.x - s.y);
    const sy = oy + k * (s.x + s.y + 1);
    const isHero = s.x === hx && s.y === hy;
    const figure = MONSTER_CLS.has(s.cls) || isHero;
    const atten = Math.exp(-fogK * Math.max(Math.abs(s.x - hx), Math.abs(s.y - hy)));
    const ch = s.ch.charCodeAt(0);
    const depthVal = s.x + s.y;
    if (s.tile && !isHero) {
      // Tile art as a square billboard: `brows` rows (height scaled the way the
      // 0.9-tall figure maps to 3.5k) and `2·brows` columns so it stays square
      // on screen (a cell is twice as tall as wide); the tile's bottom edge
      // (feet) sits on the tile centre row `sy`. Transparent pixels leave the
      // floor visible; no rim needed.
      const brows = Math.max(1, Math.round(((s.height ?? 0.7) * 3.5 * k) / 0.9));
      const bw = 2 * brows;
      const yTop = sy - brows;
      const y0 = Math.max(0, Math.ceil(yTop));
      const y1 = Math.min(rows - 1, sy);
      const x0 = sx - brows;
      const x1 = sx + brows;
      const tile = s.tile;
      for (let r = y0; r <= y1; r++) {
        const v = (r + 0.5 - yTop) / brows;
        const vi = Math.min(15, Math.max(0, Math.floor(v * 16)));
        for (let c = x0; c <= x1; c++) {
          if (c < 0 || c >= cols) continue;
          const u = (c + 0.5 - (sx - brows)) / bw;
          const ui = Math.min(15, Math.max(0, Math.floor(u * 16)));
          const pal = tile.pixels[vi * 16 + ui]!;
          if (pal === 0) continue; // transparent: floor shows through
          const pc = tile.palette[pal]!;
          const i = r * cols + c;
          const o = i * 3;
          fb.overlayCh[i] = ch;
          fb.overlayRgb[o] = (pc[0] / 255) * atten;
          fb.overlayRgb[o + 1] = (pc[1] / 255) * atten;
          fb.overlayRgb[o + 2] = (pc[2] / 255) * atten;
          fb.depth[i] = depthVal;
        }
      }
      return;
    }
    if (k === 1) {
      // far/small zoom: the figure collapses to one or two cells, no rim
      const spots: Array<[number, number]> = figure ? [[sx, sy - 1], [sx, sy]] : [[sx, sy]];
      for (const [c, r] of spots) {
        if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
        const i = r * cols + c;
        const o = i * 3;
        fb.overlayCh[i] = ch;
        fb.overlayRgb[o] = s.rgb[0] * atten;
        fb.overlayRgb[o + 1] = s.rgb[1] * atten;
        fb.overlayRgb[o + 2] = s.rgb[2] * atten;
        fb.depth[i] = depthVal;
      }
      return;
    }
    const halfW = k - 1; // full width 2k−1 (odd); hero is 7 wide at k = 4
    const halfH = figure ? 1.75 * k : 0.75 * k; // figures 3.5k tall, items 1.5k
    // figures stand 3.5k rows with their feet at the tile centre row sy; items
    // are low shapes 1.5k tall centred on the tile.
    const y0 = figure ? Math.ceil(sy - 2 * halfH + 1) : Math.ceil(sy - halfH);
    const y1 = figure ? sy : Math.floor(sy + halfH);
    const cy = (y0 + y1) / 2;
    for (let r = y0; r <= y1; r++) {
      if (r < 0 || r >= rows) continue;
      for (let c = sx - halfW; c <= sx + halfW; c++) {
        if (c < 0 || c >= cols) continue;
        const dx = (c - sx) / halfW;
        const dy = (r + 0.5 - cy) / halfH;
        const r2 = dx * dx + dy * dy;
        if (r2 > 1.35) continue; // outside the figure and its rim
        const bright = r2 <= 1 ? 1 - 0.45 * r2 : 0.22; // rim ring at 0.22
        const i = r * cols + c;
        const o = i * 3;
        fb.overlayCh[i] = ch;
        fb.overlayRgb[o] = s.rgb[0] * bright * atten;
        fb.overlayRgb[o + 1] = s.rgb[1] * bright * atten;
        fb.overlayRgb[o + 2] = s.rgb[2] * bright * atten;
        fb.depth[i] = depthVal;
      }
    }
  };

  for (const { x, y } of cells) {
    const kind = level.kindAt(x, y);
    if (isSolid(kind) && kind !== 'unexplored') drawBlock(x, y, kind);
    const sprite = spriteByCell.get(`${x},${y}`);
    if (sprite) drawSprite(sprite);
  }

  // --- hero always on top ---
  // Re-stamp every cell of the hero figure that a wall overwrote with the hero
  // letter at 0.6 brightness (an x-ray silhouette), so the hero is never fully
  // hidden even where the cutaway rule does not apply.
  const heroSprite = sprites.find((s) => s.x === hx && s.y === hy);
  if (heroSprite) {
    const hsx = ox + 2 * k * (hx - hy);
    const hsy = oy + k * (hx + hy + 1);
    const heroCh = heroSprite.ch.charCodeAt(0);
    const restamp = (c: number, r: number): void => {
      if (c < 0 || c >= cols || r < 0 || r >= rows) return;
      const i = r * cols + c;
      if (fb.overlayCh[i] !== heroCh) {
        const o = i * 3;
        fb.overlayCh[i] = heroCh;
        fb.overlayRgb[o] = heroSprite.rgb[0] * 0.6;
        fb.overlayRgb[o + 1] = heroSprite.rgb[1] * 0.6;
        fb.overlayRgb[o + 2] = heroSprite.rgb[2] * 0.6;
      }
    };
    if (k === 1) {
      restamp(hsx, hsy - 1);
      restamp(hsx, hsy);
    } else {
      const halfW = k - 1;
      const halfH = 1.75 * k;
      const y0 = Math.ceil(hsy - 2 * halfH + 1);
      const y1 = hsy;
      const cy = (y0 + y1) / 2;
      for (let r = y0; r <= y1; r++) {
        for (let c = hsx - halfW; c <= hsx + halfW; c++) {
          const dx = (c - hsx) / halfW;
          const dy = (r + 0.5 - cy) / halfH;
          if (dx * dx + dy * dy > 1.35) continue;
          restamp(c, r);
        }
      }
    }
  }
}
