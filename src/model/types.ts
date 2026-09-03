/**
 * PM-owned data model shared by the engine client, the renderers and the
 * terminal UI (docs/architecture.md §4). Import it; do not edit it without a
 * ticket that says so. Pure types + tiny pure helpers, safe in node and browser.
 */

/** NetHack level width in cells (include/global.h COLNO). Column 0 is never used by the game. */
export const COLNO = 80;
/** NetHack level height in cells (include/global.h ROWNO). */
export const ROWNO = 21;

/** What kind of thing a glyph is, computed by the bridge from NetHack's glyph_is_* macros. */
export type GlyphClass =
  | 'mon' // ordinary monster
  | 'pet'
  | 'ridden' // monster the hero rides
  | 'detected' // monster shown by detection
  | 'invisible' // remembered invisible monster marker
  | 'body' // corpse
  | 'statue'
  | 'obj' // ordinary object
  | 'cmap' // dungeon feature (wall, floor, door, stairs, …): idx is the S_* index
  | 'trap' // idx is the trap type
  | 'warning' // warning level marker
  | 'swallow'
  | 'zap'
  | 'explosion'
  | 'unexplored'
  | 'nothing'
  | 'other';

/** One displayed glyph as decoded by the bridge (architecture.md §3.4). */
export interface GlyphInfo {
  /** Raw NetHack glyph number. */
  glyph: number;
  /** The character NetHack would print on a tty (one UTF-16 code unit). */
  ch: string;
  /** NetHack colour index 0–15 (CLR_*), or 16+ for NO_COLOR/custom. */
  color: number;
  /** Class per the glyph_is_* macros. */
  cls: GlyphClass;
  /** Class-relative index: S_* for cmap, monster index for mon/pet/…, object index for obj, trap type for trap. */
  idx: number;
  /** MG_* bit flags (glyphinfo.gm.glyphflags). */
  flags: number;
}

/** Coarse terrain class derived from the remembered background glyph (architecture.md §4.2). */
export type CellKind =
  | 'unexplored' // never displayed
  | 'stone' // solid rock (S_stone once seen, e.g. after mapping)
  | 'wall'
  | 'doorway' // S_ndoor: empty doorway, passable
  | 'door_open'
  | 'door_closed'
  | 'floor'
  | 'corridor'
  | 'stairs_up'
  | 'stairs_down'
  | 'ladder_up'
  | 'ladder_down'
  | 'altar'
  | 'fountain'
  | 'sink'
  | 'grave'
  | 'throne'
  | 'tree'
  | 'bars'
  | 'water'
  | 'lava'
  | 'ice'
  | 'air'
  | 'cloud'
  | 'drawbridge' // open/lowered drawbridge span, passable
  | 'trap'
  | 'other';

/** True for terrain the 3D renderers treat as an opaque, impassable block. */
export function isSolid(kind: CellKind): boolean {
  switch (kind) {
    case 'unexplored':
    case 'stone':
    case 'wall':
    case 'door_closed':
    case 'tree':
    case 'bars':
      return true;
    default:
      return false;
  }
}

/** One remembered map cell. */
export interface MapCell {
  x: number;
  y: number;
  /** Terrain class of the remembered background (what is under any monster/object). */
  kind: CellKind;
  /** Last cmap/trap glyph seen here, or null. */
  terrain: GlyphInfo | null;
  /** What NetHack currently displays here (may be a monster or object), or null if never printed. */
  top: GlyphInfo | null;
}

/** Read-only view of a level for renderers. Out-of-range coordinates report `unexplored` / null. */
export interface LevelView {
  readonly width: number;
  readonly height: number;
  kindAt(x: number, y: number): CellKind;
  cellAt(x: number, y: number): MapCell | null;
}

/**
 * Camera pose in cell units: `x` grows east (column), `y` grows south (row);
 * the centre of cell (cx, cy) is (cx + 0.5, cy + 0.5). `yaw` in radians,
 * 0 faces north (decreasing y), +π/2 faces east, increasing clockwise seen from above.
 */
export interface Pose {
  x: number;
  y: number;
  yaw: number;
}

/** A billboard drawn by the 3D renderers: a NetHack glyph standing on a cell. */
export interface Sprite {
  /** Cell coordinates (the sprite stands at the cell centre). */
  x: number;
  y: number;
  ch: string;
  /** Linear RGB 0..1. */
  rgb: readonly [number, number, number];
  cls: GlyphClass;
}

/**
 * Low-resolution scene buffer the renderers fill and the ASCII quantizer
 * consumes: one sample per terminal cell, row-major from the top-left.
 */
export interface FrameBuffer {
  width: number;
  height: number;
  /** Linear RGB 0..1, 3 floats per cell (unexposed; the quantizer applies exposure/gamma). */
  rgb: Float32Array;
  /** View distance per cell in cell units; Infinity where nothing was hit. */
  depth: Float32Array;
  /** Glyph override per cell: 0 = none, else a UTF-16 code unit the quantizer must print verbatim. */
  overlayCh: Uint16Array;
  /** Colour for overlay glyphs, 3 floats per cell, linear RGB 0..1. */
  overlayRgb: Float32Array;
}

/** Allocate a zeroed frame buffer (depth = Infinity). */
export function makeFrameBuffer(width: number, height: number): FrameBuffer {
  const n = width * height;
  return {
    width,
    height,
    rgb: new Float32Array(n * 3),
    depth: new Float32Array(n).fill(Number.POSITIVE_INFINITY),
    overlayCh: new Uint16Array(n),
    overlayRgb: new Float32Array(n * 3),
  };
}

/** One terminal cell as the screen writer wants it: a character plus 8-bit colours. */
export interface ScreenCell {
  ch: string;
  fg: readonly [number, number, number];
  bg: readonly [number, number, number];
}

/** A rectangle of screen cells, row-major from the top-left. */
export interface ScreenGrid {
  width: number;
  height: number;
  cells: ScreenCell[];
}

/** Classic NetHack colour indices (include/color.h CLR_*), for tables keyed by `GlyphInfo.color`. */
export const CLR = {
  BLACK: 0,
  RED: 1,
  GREEN: 2,
  BROWN: 3,
  BLUE: 4,
  MAGENTA: 5,
  CYAN: 6,
  GRAY: 7,
  NO_COLOR: 8,
  ORANGE: 9,
  BRIGHT_GREEN: 10,
  YELLOW: 11,
  BRIGHT_BLUE: 12,
  BRIGHT_MAGENTA: 13,
  BRIGHT_CYAN: 14,
  WHITE: 15,
} as const;

/** sRGB 0–255 for each CLR_* index (curses-style palette; NO_COLOR renders as GRAY). */
export const CLR_RGB: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [205, 49, 49],
  [13, 188, 121],
  [190, 130, 40],
  [36, 114, 200],
  [188, 63, 188],
  [17, 168, 205],
  [190, 190, 190],
  [190, 190, 190],
  [255, 140, 0],
  [35, 209, 139],
  [229, 229, 16],
  [59, 142, 234],
  [214, 112, 214],
  [41, 184, 219],
  [255, 255, 255],
];

/** Look up the palette entry for a NetHack colour index (unknown indices → GRAY). */
export function clrToRgb(color: number): readonly [number, number, number] {
  return CLR_RGB[color] ?? CLR_RGB[CLR.GRAY]!;
}
