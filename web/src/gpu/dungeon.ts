/**
 * Dungeon voxel scene builder for the GPU render path (T-0039 / T-0046,
 * docs/gpu-dungeon.md). Turns a `LevelView` into afterburn-grade voxel
 * geometry: stacked stone walls with chipped corners, flagstone floors with
 * missing tiles, doorways with posts + lintel, plank doors with hinges, four
 * stepped stair boxes with a faint emissive nosing, water/lava/ice surfaces,
 * small props (fountain, altar, grave, sink, throne) and emissive torch
 * sconces backed by real `THREE.PointLight`s.
 *
 * Because NetHack changes almost every cell as the player explores, a
 * whole-level rebake lands on the frame that draws the move. This module
 * splits the level into fixed `CHUNK_W × CHUNK_H = 10 × 7` cell chunks (an
 * 80 × 21 level is 8 × 3 = 24 chunks), each its own `Mesh` under
 * `DungeonScene.root`; the ceiling group carries one `Mesh` per chunk too so
 * the ortho path can still hide it. `DungeonScene.refresh(level)` hashes
 * each chunk's cells (kind + `lit`) and rebakes only chunks whose hash moved.
 * Hidden-face culling still sees across chunk boundaries: each rebake runs
 * `hiddenFaces` on the chunk's boxes plus its 4 axial neighbours' boxes
 * ("halo"), so the chunked output is byte-identical to the unchunked one.
 *
 * The pure `bakeLevel(level, opts)` returns a single merged `GeoWriter`, the
 * torch `lights` and a total `boxCount`; it walks cells in the same
 * chunk-major order as `bakeChunks(level, opts)`, so concatenating the
 * chunked writers produces the same bytes.
 *
 * Coordinates (docs/gpu.md §4): map `x` = east, map `y` = south, three.js
 * `x` = east, `z` = south, `y` = up. One cell = one three unit; the kit voxel
 * unit is `0.125` (8 voxels per cell edge). Wall height stays 1, ceiling
 * bottom sits at `y = 1`.
 */

import { Group, Matrix4, Mesh, MeshBasicMaterial, Object3D, PointLight } from 'three/webgpu';
import type { Material } from 'three/webgpu';
import { VoxelBuilder, makeRng, type VoxelBox } from '../voxel/kit.js';
import { GeoWriter, hiddenFaces } from '../voxel/mesh.js';
import { FX_FLICKER, FX_PULSE } from './moods.js';
import { isSolid, type CellKind, type LevelView } from '../../../src/model/types.js';

/** Voxel units per cell edge (kit unit = 0.125 metres; wall height = 1 m = 8 units). */
const CELL_UNITS = 8;
/** Cap on live `PointLight`s emitted by torches. */
const MAX_LIVE_LIGHTS = 8;
/** Number of nearest torches that cast real shadows (rest lit flat by SSGI/AO). */
const SHADOW_CASTING_LIGHTS = 2;
/** Minimum Chebyshev cell distance between two chosen torches. */
const TORCH_MIN_SPACING = 4;
/** Chunk width in cells (docs/gpu-dungeon.md "Chunked rebuild"). */
export const CHUNK_W = 10;
/** Chunk height in cells. */
export const CHUNK_H = 7;

/** One placed torch — an emissive sconce voxel plus a request for a PointLight. */
export interface TorchLight {
  /** Stable id for the torch, `torch-<x>-<y>-<side>`. */
  id: string;
  /** World position of the flame (metres, three.js coordinates). */
  x: number;
  y: number;
  z: number;
  /** sRGB hex colour. */
  color: number;
  /** `PointLight.intensity`. */
  intensity: number;
  /** `PointLight.distance`. */
  distance: number;
  /** Flicker strength forwarded to the (later) light-flicker driver. */
  flicker: number;
  /** Wall face the sconce is mounted on. */
  side: 'n' | 's' | 'e' | 'w';
}

/** Options passed to `bakeLevel`/`bakeChunks`. */
export interface BakeOptions {
  /** RNG base seed; combined with each cell's coords for per-cell jitter. */
  seed?: number;
}

/** Pure bake output — inspect it in tests or hand it to a `DungeonScene`. */
export interface BakeResult {
  /** Writer holding the merged level geometry (walls, floors, doors, stairs, torch sconces). */
  writer: GeoWriter;
  /** Torch light candidates emitted by the bake, in row-major scan order. */
  lights: TorchLight[];
  /** Total number of boxes written to `writer`. */
  boxCount: number;
}

/** Half-open cell bounds of a single chunk (in level cell coordinates). */
export interface ChunkBounds {
  /** Chunk column (0-based). */
  cx: number;
  /** Chunk row (0-based). */
  cy: number;
  /** Inclusive minimum cell column. */
  x0: number;
  /** Inclusive minimum cell row. */
  y0: number;
  /** Exclusive maximum cell column (clamped to `level.width`). */
  x1: number;
  /** Exclusive maximum cell row (clamped to `level.height`). */
  y1: number;
}

/** One chunk of a chunked bake, ready to hang under `DungeonScene.root`. */
export interface ChunkBake extends ChunkBounds {
  /** Per-chunk writer, culled against the chunk's 4 axial neighbours. */
  writer: GeoWriter;
  /** Boxes written to `writer` (cells first, then torch sconces hosted here). */
  boxCount: number;
  /** Per-chunk cell hash — matches `chunkHashOf(level, this)`. */
  hash: string;
}

/** Result of `bakeChunks`: per-chunk writers plus the level-wide torch table. */
export interface ChunksBakeResult {
  chunks: ChunkBake[];
  lights: TorchLight[];
  chunksX: number;
  chunksY: number;
  boxCount: number;
}

/** Options accepted by the `DungeonScene` constructor. */
export interface DungeonSceneOptions {
  /** Material for the main merged mesh. Defaults to a plain `MeshBasicMaterial`. */
  material?: Material;
  /** Material for the ceiling mesh. Defaults to the same as `material`. */
  ceilingMaterial?: Material;
  /** RNG base seed forwarded to `bakeLevel`. */
  seed?: number;
}

/** Cheap one-letter code per `CellKind` used by `hashKinds` / `chunkHashOf`. */
const KIND_CODE: Record<CellKind, string> = {
  unexplored: '.',
  stone: 's',
  wall: 'W',
  doorway: 'd',
  door_open: 'o',
  door_closed: 'c',
  floor: 'F',
  corridor: 'C',
  stairs_up: '<',
  stairs_down: '>',
  ladder_up: '(',
  ladder_down: ')',
  altar: 'A',
  fountain: 'U',
  sink: 'K',
  grave: 'G',
  throne: 'T',
  tree: 't',
  bars: 'B',
  water: '~',
  lava: 'L',
  ice: 'I',
  air: ' ',
  cloud: 'l',
  drawbridge: 'b',
  trap: '^',
  other: 'x',
};

/**
 * Build a compact string that changes iff the set of drawable cells does.
 * Kept for backwards compatibility and as the fast level-wide early-out for
 * callers that do not need per-chunk granularity.
 */
export function hashKinds(level: LevelView): string {
  const w = level.width;
  const h = level.height;
  const parts: string[] = [`${w}x${h}`];
  for (let y = 0; y < h; y++) {
    let row = '';
    for (let x = 0; x < w; x++) row += KIND_CODE[level.kindAt(x, y)] ?? '?';
    parts.push(row);
  }
  return parts.join('|');
}

/** True for `wall`/`stone` — the two kinds a torch mounts on. */
function isWallKind(k: CellKind): boolean {
  return k === 'wall' || k === 'stone';
}

/** True for kinds that are walkable (get a floor treatment and a ceiling). */
function passable(k: CellKind): boolean {
  if (k === 'unexplored') return false;
  return !isSolid(k);
}

/** Hash cell coordinates into a per-cell RNG seed so jitter is stable across bakes. */
function cellSeed(x: number, y: number, base: number): number {
  let h = ((x * 73856093) ^ (y * 19349663) ^ ((base | 0) * 83492791)) >>> 0;
  h = (Math.imul(h ^ (h >>> 13), 1274126177) ^ (h >>> 16)) >>> 0;
  return h || 1;
}

/**
 * Infer the axis of a door/doorway from its neighbouring walls: `ew` when the
 * north/south neighbours are walls (people walk east-west through the door),
 * `ns` when the east/west neighbours are. Falls back to `ew` when neither pair
 * is a wall. Matches `web/src/gl/scene-builder.ts` (docs/gpu.md §7).
 */
export function doorAxis(level: LevelView, x: number, y: number): 'ew' | 'ns' {
  const wall = (px: number, py: number): boolean => isWallKind(level.kindAt(px, py));
  if (wall(x, y - 1) && wall(x, y + 1)) return 'ew';
  if (wall(x - 1, y) && wall(x + 1, y)) return 'ns';
  return 'ew';
}

/** Row-major list of known passable cells — one ceiling tile per entry. */
export function ceilingCells(level: LevelView): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let y = 0; y < level.height; y++) {
    for (let x = 0; x < level.width; x++) {
      if (passable(level.kindAt(x, y))) out.push([x, y]);
    }
  }
  return out;
}

/**
 * Select up to `MAX_LIVE_LIGHTS` torches nearest to the hero. Pure; sorted by
 * squared XZ distance to the cell centre `(heroX + 0.5, heroY + 0.5)`.
 */
export function selectActiveTorches(torches: readonly TorchLight[], heroX: number, heroY: number): TorchLight[] {
  const hx = heroX + 0.5;
  const hz = heroY + 0.5;
  return [...torches]
    .map((t, i) => ({ t, i, d: (t.x - hx) * (t.x - hx) + (t.z - hz) * (t.z - hz) }))
    .sort((a, b) => (a.d - b.d) || (a.i - b.i))
    .slice(0, MAX_LIVE_LIGHTS)
    .map((e) => e.t);
}

/** Set `ground = true` on the most recently added root-part box (see `docs/gpu-materials.md`). */
function markGround(b: VoxelBuilder): void {
  const boxes = b.parts[0]!.boxes;
  const last = boxes[boxes.length - 1];
  if (last !== undefined) last.ground = true;
}

// ---------------------------------------------------------------------------
// Cell bakers — each fills a per-cell region 0..CELL_UNITS in x,z and 0..y.
// Called via `builder.at(x*CELL_UNITS, 0, y*CELL_UNITS, () => bake(...))`.
// ---------------------------------------------------------------------------

function buildWall(b: VoxelBuilder): void {
  // Body: the bottom 5/8 of the cell is one solid basalt slab.
  b.box(0, 0, 0, CELL_UNITS, 5, CELL_UNITS, 'basalt2', 'rock');
  // Top: split into four 4×3×4 corner caps; drop one at random for a chipped silhouette.
  const chip = b.int(0, 3);
  for (let i = 0; i < 4; i++) {
    if (i === chip && b.chance(0.75)) continue;
    const cx = (i & 1) === 0 ? 0 : 4;
    const cz = (i & 2) === 0 ? 0 : 4;
    const col = b.chance(0.5) ? 'basalt1' : 'basalt2';
    b.box(cx, 5, cz, 4, 3, 4, col, 'rock');
  }
  // Slate chip band midway on one side.
  if (b.chance(0.4)) {
    b.box(0, b.int(1, 3), b.chance(0.5) ? 0 : 7, CELL_UNITS, 1, 1, 'slate0', 'rock');
  }
  // Occasional damp moss / lichen crumb.
  if (b.chance(0.2)) {
    b.voxel(b.int(0, 7), b.int(0, 2), b.chance(0.5) ? 0 : 7, b.pick(['moss0', 'lichen'])!, 'moss');
  }
}

function buildFloor(b: VoxelBuilder): void {
  // Four 4×1×4 flagstone tiles; each has a small chance of being missing.
  for (let tz = 0; tz < 8; tz += 4) {
    for (let tx = 0; tx < 8; tx += 4) {
      if (b.chance(0.9)) {
        const col = b.chance(0.5) ? 'basalt0' : 'basalt1';
        b.box(tx, 0, tz, 4, 1, 4, col, 'rock');
        markGround(b);
      }
    }
  }
  // A cracked mud pebble sometimes fills the gap.
  if (b.chance(0.25)) {
    b.voxel(b.int(0, 7), 0, b.int(0, 7), 'mud', 'mud');
    markGround(b);
  }
}

function buildCorridor(b: VoxelBuilder): void {
  // No seams — a single rough slab.
  b.box(0, 0, 0, CELL_UNITS, 1, CELL_UNITS, 'basalt1', 'rock');
  markGround(b);
  if (b.chance(0.3)) {
    b.voxel(b.int(0, 7), 0, b.int(0, 7), 'mud', 'mud');
    markGround(b);
  }
}

function buildDoorFrame(b: VoxelBuilder, axis: 'ew' | 'ns'): void {
  buildFloor(b);
  // Two vertical posts, one lintel across the top.
  if (axis === 'ew') {
    b.box(0, 1, 3, 1, 6, 2, 'basalt1', 'rock');
    b.box(7, 1, 3, 1, 6, 2, 'basalt1', 'rock');
    b.box(0, 7, 3, CELL_UNITS, 1, 2, 'basalt2', 'rock');
  } else {
    b.box(3, 1, 0, 2, 6, 1, 'basalt1', 'rock');
    b.box(3, 1, 7, 2, 6, 1, 'basalt1', 'rock');
    b.box(3, 7, 0, 2, 1, CELL_UNITS, 'basalt2', 'rock');
  }
}

function buildClosedDoor(b: VoxelBuilder, axis: 'ew' | 'ns'): void {
  buildDoorFrame(b, axis);
  if (axis === 'ew') {
    // Plank door slab: 6 wide, 6 tall, 2 deep (long axis along east-west).
    b.box(1, 1, 3, 6, 6, 2, b.chance(0.5) ? 'wood0' : 'wood1', 'wood');
    // Two brass hinges + a handle.
    b.box(1, 5, 2.6, 0.6, 0.6, 0.6, 'brass', 'brass', { j: 0 });
    b.box(1, 2, 2.6, 0.6, 0.6, 0.6, 'brass', 'brass', { j: 0 });
    b.box(5.5, 3.5, 2.6, 0.5, 0.5, 0.5, 'brass', 'brass', { j: 0 });
  } else {
    b.box(3, 1, 1, 2, 6, 6, b.chance(0.5) ? 'wood0' : 'wood1', 'wood');
    b.box(2.6, 5, 1, 0.6, 0.6, 0.6, 'brass', 'brass', { j: 0 });
    b.box(2.6, 2, 1, 0.6, 0.6, 0.6, 'brass', 'brass', { j: 0 });
    b.box(2.6, 3.5, 5.5, 0.5, 0.5, 0.5, 'brass', 'brass', { j: 0 });
  }
}

function buildStairs(b: VoxelBuilder, up: boolean): void {
  // Four stepped slabs of slate. Up-stairs climb toward +z; down-stairs
  // descend into the floor (voxel y goes negative).
  for (let i = 0; i < 4; i++) {
    const zBase = i * 2;
    if (up) {
      b.box(0, 0, zBase, CELL_UNITS, i + 1, 2, 'slate1', 'rock');
    } else {
      b.box(0, -i - 1, zBase, CELL_UNITS, i + 1, 2, 'slate1', 'rock');
    }
    markGround(b);
  }
  // Faint emissive nosing at the top edge of the run.
  const nz = up ? 6 : 0;
  const ny = up ? 4 : 0;
  b.box(0, ny, nz, CELL_UNITS, 0.2, 0.2, 'lantern', 'lamp', { j: 0 });
}

function buildWater(b: VoxelBuilder): void {
  b.box(0, 0, 0, CELL_UNITS, 0.8, CELL_UNITS, 'water', { rough: 0.05, metal: 0.9 });
  markGround(b);
}

function buildLava(b: VoxelBuilder): void {
  b.box(0, 0, 0, CELL_UNITS, 0.8, CELL_UNITS, 'ember', {
    rough: 0.5, metal: 0, emissive: 6, fx: FX_PULSE, dry: true,
  });
  markGround(b);
}

function buildIce(b: VoxelBuilder): void {
  b.box(0, 0, 0, CELL_UNITS, 0.8, CELL_UNITS, 'crystalCold0', {
    rough: 0.18, metal: 0.1, dry: true,
  });
  markGround(b);
}

function buildFountain(b: VoxelBuilder): void {
  buildFloor(b);
  // Basin rim (four short slate walls).
  b.box(1, 1, 1, 6, 1, 1, 'slate1', 'rock');
  b.box(1, 1, 6, 6, 1, 1, 'slate1', 'rock');
  b.box(1, 1, 1, 1, 1, 6, 'slate1', 'rock');
  b.box(6, 1, 1, 1, 1, 6, 'slate1', 'rock');
  // Pooled water inside.
  b.box(2, 1, 2, 4, 0.6, 4, 'water', { rough: 0.05, metal: 0.9 });
  // Central spout.
  b.box(3.5, 2, 3.5, 1, 3, 1, 'slate2', 'rock');
}

function buildAltar(b: VoxelBuilder): void {
  buildFloor(b);
  // Squat slate plinth + a lighter cap.
  b.box(2, 1, 2, 4, 3, 4, 'slate0', 'rock');
  b.box(1.5, 4, 1.5, 5, 0.6, 5, 'slate2', 'rock');
  // Tiny emissive candle nub.
  b.box(3.5, 4.6, 3.5, 1, 0.6, 1, 'lantern', 'lamp', { j: 0 });
}

function buildGrave(b: VoxelBuilder): void {
  buildFloor(b);
  // Headstone slab + a small mound of turned earth.
  b.box(3, 1, 1, 2, 4, 0.6, 'slate1', 'rock');
  b.box(1, 1, 2, 6, 0.6, 5, 'mud', 'mud');
}

function buildSink(b: VoxelBuilder): void {
  buildFloor(b);
  // Metal frame + porcelain basin.
  b.box(1, 1, 1, 6, 3, 6, 'panel', 'metal');
  b.box(1.5, 3, 1.5, 5, 0.6, 5, 'hull0', 'plastic');
  // Faucet.
  b.box(3.5, 3.6, 6, 1, 1, 0.6, 'brass', 'brass', { j: 0 });
}

function buildThrone(b: VoxelBuilder): void {
  buildFloor(b);
  // Seat.
  b.box(1, 1, 1, 6, 2, 6, 'slate1', 'rock');
  // Backrest against +z wall.
  b.box(1, 3, 6, 6, 4, 1, 'slate2', 'rock');
  // Two brass finials.
  b.box(1, 7, 6, 1, 1, 1, 'brass', 'brass', { j: 0 });
  b.box(6, 7, 6, 1, 1, 1, 'brass', 'brass', { j: 0 });
}

function buildTorchSconce(b: VoxelBuilder, side: 'n' | 's' | 'e' | 'w'): void {
  // Bracket + flame, mounted on the interior wall face, tucked ~0.15 m in.
  // Positions are in voxel units within a cell (0..8).
  const bracket = 'brass';
  const flame = 'fire';
  const flameOpts = { rough: 0.4, metal: 0, emissive: 12, fx: FX_FLICKER, dry: true };
  const bx = 3.5, bz = 3.5, by = 4.5;
  switch (side) {
    case 'n': {
      // Wall face is at z = 0 (north face of cell); sconce protrudes toward -z.
      b.box(bx, by - 0.5, 0, 1, 1, 0.6, bracket, 'brass', { j: 0 });
      b.box(bx + 0.1, by + 0.4, -0.1, 0.8, 1, 0.8, flame, flameOpts);
      break;
    }
    case 's': {
      b.box(bx, by - 0.5, 7.4, 1, 1, 0.6, bracket, 'brass', { j: 0 });
      b.box(bx + 0.1, by + 0.4, 8.3, 0.8, 1, 0.8, flame, flameOpts);
      break;
    }
    case 'w': {
      b.box(0, by - 0.5, bz, 0.6, 1, 1, bracket, 'brass', { j: 0 });
      b.box(-0.1, by + 0.4, bz + 0.1, 0.8, 1, 0.8, flame, flameOpts);
      break;
    }
    case 'e': {
      b.box(7.4, by - 0.5, bz, 0.6, 1, 1, bracket, 'brass', { j: 0 });
      b.box(8.3, by + 0.4, bz + 0.1, 0.8, 1, 0.8, flame, flameOpts);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Torch placement — deterministic, capped by TORCH_MIN_SPACING (Chebyshev).
// ---------------------------------------------------------------------------

interface TorchPlacement {
  x: number;
  y: number;
  side: 'n' | 's' | 'e' | 'w';
}

/**
 * Row-major scan for torch candidates: each `wall`/`stone` cell whose
 * neighbouring cell (n/s/w/e priority) is a lit passable floor is a candidate.
 * A global Chebyshev spacing of `TORCH_MIN_SPACING` cells is then applied.
 */
function collectTorches(level: LevelView): TorchPlacement[] {
  const candidates: TorchPlacement[] = [];
  const deltas: Array<[number, number, TorchPlacement['side']]> = [
    [0, -1, 'n'],
    [0, 1, 's'],
    [-1, 0, 'w'],
    [1, 0, 'e'],
  ];
  for (let y = 0; y < level.height; y++) {
    for (let x = 0; x < level.width; x++) {
      if (!isWallKind(level.kindAt(x, y))) continue;
      for (const [dx, dy, side] of deltas) {
        const c = level.cellAt(x + dx, y + dy);
        if (c === null || c.lit !== true) continue;
        if (!passable(c.kind)) continue;
        candidates.push({ x, y, side });
        break; // one sconce per wall cell
      }
    }
  }
  const chosen: TorchPlacement[] = [];
  for (const c of candidates) {
    let ok = true;
    for (const p of chosen) {
      if (Math.max(Math.abs(p.x - c.x), Math.abs(p.y - c.y)) < TORCH_MIN_SPACING) { ok = false; break; }
    }
    if (ok) chosen.push(c);
  }
  return chosen;
}

/** Cell-centre offset (metres) of the flame relative to the wall cell. */
function torchOffset(side: TorchPlacement['side']): { dx: number; dz: number } {
  switch (side) {
    case 'n': return { dx: 0, dz: -0.15 };
    case 's': return { dx: 0, dz: 0.15 };
    case 'w': return { dx: -0.15, dz: 0 };
    case 'e': return { dx: 0.15, dz: 0 };
  }
}

/** Convert a chosen `TorchPlacement` into the `TorchLight` a renderer consumes. */
function torchLightOf(t: TorchPlacement): TorchLight {
  const off = torchOffset(t.side);
  return {
    id: `torch-${t.x}-${t.y}-${t.side}`,
    x: t.x + 0.5 + off.dx,
    y: 0.65,
    z: t.y + 0.5 + off.dz,
    color: 0xffb060,
    intensity: 3.5,
    distance: 7,
    flicker: 0.3,
    side: t.side,
  };
}

// ---------------------------------------------------------------------------
// Chunk primitives — bounds, hashes, per-chunk bakers.
// ---------------------------------------------------------------------------

/** Number of chunks along each axis for `level` (at least 1 in each dimension). */
export function chunksOf(level: LevelView): { chunksX: number; chunksY: number } {
  return {
    chunksX: Math.max(1, Math.ceil(level.width / CHUNK_W)),
    chunksY: Math.max(1, Math.ceil(level.height / CHUNK_H)),
  };
}

/** Bounds of chunk `(cx, cy)` clamped to the level's cell extent. */
export function chunkAt(level: LevelView, cx: number, cy: number): ChunkBounds {
  return {
    cx, cy,
    x0: cx * CHUNK_W,
    y0: cy * CHUNK_H,
    x1: Math.min(level.width, (cx + 1) * CHUNK_W),
    y1: Math.min(level.height, (cy + 1) * CHUNK_H),
  };
}

/** All chunks of `level` in chunk-major order (`cx` inside `cy`). */
export function chunkBoundsList(level: LevelView): ChunkBounds[] {
  const { chunksX, chunksY } = chunksOf(level);
  const out: ChunkBounds[] = [];
  for (let cy = 0; cy < chunksY; cy++) {
    for (let cx = 0; cx < chunksX; cx++) out.push(chunkAt(level, cx, cy));
  }
  return out;
}

/**
 * Cheap per-chunk hash covering the chunk's cells' `kind` + `lit` — the two
 * inputs any per-cell baker cares about. Walks only the chunk's cells (never
 * the whole level), so hashing is strictly cheaper than baking.
 */
export function chunkHashOf(level: LevelView, b: ChunkBounds): string {
  let s = `${b.x1 - b.x0}x${b.y1 - b.y0}`;
  for (let y = b.y0; y < b.y1; y++) {
    s += '|';
    for (let x = b.x0; x < b.x1; x++) {
      const c = level.cellAt(x, y);
      s += KIND_CODE[c?.kind ?? 'unexplored'] ?? '?';
      s += c === null ? '_' : c.lit === true ? '1' : c.lit === false ? '0' : '_';
    }
  }
  return s;
}

/** Bake main geometry (walls, floors, doors, stairs, features) for one chunk. */
function bakeChunkCellBoxes(level: LevelView, b: ChunkBounds, baseSeed: number): VoxelBox[] {
  const builder = new VoxelBuilder({ unit: 0.125, seed: baseSeed, jitter: 0.04 });
  for (let y = b.y0; y < b.y1; y++) {
    for (let x = b.x0; x < b.x1; x++) {
      const kind = level.kindAt(x, y);
      if (kind === 'unexplored') continue;
      builder.rand = makeRng(cellSeed(x, y, baseSeed));
      builder.at(x * CELL_UNITS, 0, y * CELL_UNITS, () => bakeCell(builder, level, x, y, kind));
    }
  }
  return builder.parts[0]!.boxes;
}

/** Bake ceiling geometry (one 8×1×8 slab per known passable cell) for one chunk. */
function bakeChunkCeilingBoxes(level: LevelView, b: ChunkBounds, baseSeed: number): VoxelBox[] {
  const builder = new VoxelBuilder({ unit: 0.125, seed: baseSeed, jitter: 0.03 });
  for (let y = b.y0; y < b.y1; y++) {
    for (let x = b.x0; x < b.x1; x++) {
      if (!passable(level.kindAt(x, y))) continue;
      builder.rand = makeRng(cellSeed(x, y, baseSeed) ^ 0x1c9e7f5b);
      builder.at(x * CELL_UNITS, 0, y * CELL_UNITS, () => {
        builder.box(0, CELL_UNITS, 0, CELL_UNITS, 1, CELL_UNITS, 'basalt0', 'rock');
      });
    }
  }
  return builder.parts[0]!.boxes;
}

/** Bake torch sconce geometry for every torch mounted on a wall inside a chunk. */
function bakeChunkTorchBoxes(torches: readonly TorchPlacement[], baseSeed: number): VoxelBox[] {
  if (torches.length === 0) return [];
  const builder = new VoxelBuilder({ unit: 0.125, seed: baseSeed, jitter: 0.04 });
  for (const t of torches) {
    builder.rand = makeRng(cellSeed(t.x, t.y, baseSeed) ^ 0xa53f7c1d);
    builder.at(t.x * CELL_UNITS, 0, t.y * CELL_UNITS, () => buildTorchSconce(builder, t.side));
  }
  return builder.parts[0]!.boxes;
}

/** Bucket level-wide torch placements into per-chunk lists, preserving scan order. */
function torchesByChunk(torches: readonly TorchPlacement[], chunksX: number, chunksY: number): TorchPlacement[][] {
  const out: TorchPlacement[][] = [];
  for (let i = 0; i < chunksX * chunksY; i++) out.push([]);
  for (const t of torches) {
    const cx = Math.floor(t.x / CHUNK_W);
    const cy = Math.floor(t.y / CHUNK_H);
    if (cx < 0 || cy < 0 || cx >= chunksX || cy >= chunksY) continue;
    out[cy * chunksX + cx]!.push(t);
  }
  return out;
}

/** Compact hash of a chunk's torch subset — order-sensitive, keyed by `(x, y, side)`. */
function torchSubsetHash(torches: readonly TorchPlacement[]): string {
  if (torches.length === 0) return '';
  let s = '';
  for (const t of torches) s += `${t.x},${t.y},${t.side};`;
  return s;
}

// ---------------------------------------------------------------------------
// Halo culling — each chunk's boxes are culled against its 4 axial neighbours.
// hiddenFaces only checks direct-plane-sharing neighbours, so this halo is
// sufficient: it matches what a global pass over all boxes would produce.
// ---------------------------------------------------------------------------

function neighbourIndices(idx: number, chunksX: number, chunksY: number): number[] {
  const cy = Math.floor(idx / chunksX);
  const cx = idx % chunksX;
  const out: number[] = [];
  if (cx > 0) out.push(cy * chunksX + (cx - 1));
  if (cx + 1 < chunksX) out.push(cy * chunksX + (cx + 1));
  if (cy > 0) out.push((cy - 1) * chunksX + cx);
  if (cy + 1 < chunksY) out.push((cy + 1) * chunksX + cx);
  return out;
}

/**
 * Boxes from `i`'s 4 axial neighbours restricted to the 1-cell strip adjacent
 * to the shared boundary — enough context for `hiddenFaces` to cull my
 * boundary faces without pulling in the neighbour's interior.
 */
function haloBoxes(
  boxesAt: (idx: number) => readonly VoxelBox[],
  bounds: readonly ChunkBounds[],
  chunksX: number,
  chunksY: number,
  idx: number,
): VoxelBox[] {
  const b = bounds[idx]!;
  const cy = Math.floor(idx / chunksX);
  const cx = idx % chunksX;
  const out: VoxelBox[] = [];
  const x0 = b.x0 * CELL_UNITS;
  const x1 = b.x1 * CELL_UNITS;
  const z0 = b.y0 * CELL_UNITS;
  const z1 = b.y1 * CELL_UNITS;
  const STRIP = CELL_UNITS;

  const collect = (nx: number, ny: number, keep: (box: VoxelBox) => boolean): void => {
    if (nx < 0 || ny < 0 || nx >= chunksX || ny >= chunksY) return;
    for (const box of boxesAt(ny * chunksX + nx)) if (keep(box)) out.push(box);
  };

  collect(cx - 1, cy, (box) => box.x + box.w > x0 - STRIP && box.x < x0);
  collect(cx + 1, cy, (box) => box.x < x1 + STRIP && box.x + box.w > x1);
  collect(cx, cy - 1, (box) => box.z + box.d > z0 - STRIP && box.z < z0);
  collect(cx, cy + 1, (box) => box.z < z1 + STRIP && box.z + box.d > z1);

  return out;
}

/** Extract the hidden-face mask for the first `ownLen` boxes of a halo run. */
function ownMaskFromHalo(mixed: readonly VoxelBox[], ownLen: number): Uint8Array {
  const full = hiddenFaces(mixed as VoxelBox[]);
  return full.slice(0, ownLen);
}

function maskEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Pure bakes — chunked + unchunked. Both walk cells in chunk-major order.
// ---------------------------------------------------------------------------

/** Fill `builder` with the geometry for one cell classified by `kind`. */
function bakeCell(builder: VoxelBuilder, level: LevelView, x: number, y: number, kind: CellKind): void {
  switch (kind) {
    case 'unexplored':
      return;
    case 'wall':
    case 'stone':
    case 'tree':
    case 'bars':
      buildWall(builder);
      return;
    case 'door_closed':
      buildClosedDoor(builder, doorAxis(level, x, y));
      return;
    case 'door_open':
    case 'doorway':
      buildDoorFrame(builder, doorAxis(level, x, y));
      return;
    case 'floor':
      buildFloor(builder);
      return;
    case 'corridor':
      buildCorridor(builder);
      return;
    case 'stairs_up':
    case 'ladder_up':
      buildStairs(builder, true);
      return;
    case 'stairs_down':
    case 'ladder_down':
      buildStairs(builder, false);
      return;
    case 'water':
      buildWater(builder);
      return;
    case 'lava':
      buildLava(builder);
      return;
    case 'ice':
      buildIce(builder);
      return;
    case 'fountain':
      buildFountain(builder);
      return;
    case 'altar':
      buildAltar(builder);
      return;
    case 'grave':
      buildGrave(builder);
      return;
    case 'sink':
      buildSink(builder);
      return;
    case 'throne':
      buildThrone(builder);
      return;
    default:
      buildFloor(builder);
      return;
  }
}

/**
 * Chunked bake: one `GeoWriter` per chunk, culled against its 4 axial
 * neighbours. Boxes inside each chunk are emitted cells-first (row-major) then
 * this chunk's torch sconces in scan order, so the concatenation of every
 * chunk writer's used bytes matches `bakeLevel(level, opts).writer`.
 */
export function bakeChunks(level: LevelView, opts?: BakeOptions): ChunksBakeResult {
  const baseSeed = opts?.seed ?? 1;
  const { chunksX, chunksY } = chunksOf(level);
  const bounds = chunkBoundsList(level);
  const torches = collectTorches(level);
  const grouped = torchesByChunk(torches, chunksX, chunksY);

  const chunkBoxes: VoxelBox[][] = bounds.map((b, i) => [
    ...bakeChunkCellBoxes(level, b, baseSeed),
    ...bakeChunkTorchBoxes(grouped[i]!, baseSeed),
  ]);

  const chunks: ChunkBake[] = bounds.map((b, i) => {
    const own = chunkBoxes[i]!;
    const halo = haloBoxes((j) => chunkBoxes[j]!, bounds, chunksX, chunksY, i);
    const hidden = ownMaskFromHalo([...own, ...halo], own.length);
    const writer = new GeoWriter(Math.max(64, own.length));
    for (let j = 0; j < own.length; j++) writer.box(own[j]!, 0.125, 0, 0, 0, IDENTITY, hidden[j]!);
    return {
      cx: b.cx, cy: b.cy,
      x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1,
      writer,
      boxCount: own.length,
      hash: chunkHashOf(level, b),
    };
  });

  const lights = torches.map(torchLightOf);
  const boxCount = chunkBoxes.reduce((s, a) => s + a.length, 0);
  return { chunks, lights, chunksX, chunksY, boxCount };
}

/**
 * Pure bake: `LevelView` → merged voxel geometry + torch light list. Walks
 * cells and torches in the same chunk-major order as `bakeChunks`, using a
 * global `hiddenFaces` pass so its writer bytes match the chunked bake
 * concatenated (see the "byte-identical" test in `tests/gpu-dungeon.test.ts`).
 */
export function bakeLevel(level: LevelView, opts?: BakeOptions): BakeResult {
  const baseSeed = opts?.seed ?? 1;
  const { chunksX, chunksY } = chunksOf(level);
  const bounds = chunkBoundsList(level);
  const torches = collectTorches(level);
  const grouped = torchesByChunk(torches, chunksX, chunksY);

  const allBoxes: VoxelBox[] = [];
  for (let i = 0; i < bounds.length; i++) {
    for (const b of bakeChunkCellBoxes(level, bounds[i]!, baseSeed)) allBoxes.push(b);
    for (const b of bakeChunkTorchBoxes(grouped[i]!, baseSeed)) allBoxes.push(b);
  }
  const hidden = hiddenFaces(allBoxes);
  const writer = new GeoWriter(Math.max(1024, allBoxes.length));
  for (let i = 0; i < allBoxes.length; i++) writer.box(allBoxes[i]!, 0.125, 0, 0, 0, IDENTITY, hidden[i]!);
  const lights = torches.map(torchLightOf);
  return { writer, lights, boxCount: allBoxes.length };
}

/** Bake just the ceiling: one flat slab per known passable cell at `y = 1`. */
export function bakeCeiling(level: LevelView, opts?: BakeOptions): { writer: GeoWriter; cells: Array<[number, number]>; boxCount: number } {
  const baseSeed = opts?.seed ?? 1;
  const cells = ceilingCells(level);
  const builder = new VoxelBuilder({ unit: 0.125, seed: baseSeed, jitter: 0.03 });
  for (const [x, y] of cells) {
    builder.rand = makeRng(cellSeed(x, y, baseSeed) ^ 0x1c9e7f5b);
    builder.at(x * CELL_UNITS, 0, y * CELL_UNITS, () => {
      builder.box(0, CELL_UNITS, 0, CELL_UNITS, 1, CELL_UNITS, 'basalt0', 'rock');
    });
  }
  const boxes = builder.parts[0]!.boxes;
  const hidden = hiddenFaces(boxes);
  const writer = new GeoWriter(Math.max(64, boxes.length));
  for (let i = 0; i < boxes.length; i++) writer.box(boxes[i]!, 0.125, 0, 0, 0, IDENTITY, hidden[i]!);
  return { writer, cells, boxCount: boxes.length };
}

const IDENTITY = new Matrix4();

// ---------------------------------------------------------------------------
// DungeonScene — chunked, stateful, rebuilds only chunks whose hash moved.
// ---------------------------------------------------------------------------

/** Per-chunk cached state living inside a `DungeonScene`. */
interface SceneChunk {
  bounds: ChunkBounds;
  cellHash: string;
  ceilingHash: string;
  torchHash: string;
  cellBoxes: VoxelBox[];
  torchBoxes: VoxelBox[];
  ceilingBoxes: VoxelBox[];
  mainMask: Uint8Array;
  ceilingMask: Uint8Array;
  mainMesh: Mesh | null;
  ceilingMesh: Mesh | null;
}

/**
 * Owns per-chunk `Mesh`es under `root` and `ceiling`, plus the live
 * `PointLight` array. `refresh(level)` hashes each chunk (`kind` + `lit`) and
 * rebakes only chunks whose hash moved (`docs/gpu-dungeon.md` "Chunked
 * rebuild"). `updateLights(x, y)` reassigns which torches emit (cap
 * `MAX_LIVE_LIGHTS = 8`; `SHADOW_CASTING_LIGHTS = 2` nearest cast shadows).
 */
export class DungeonScene {
  readonly root: Object3D;
  readonly ceiling: Object3D;
  readonly pointLights: PointLight[] = [];
  private readonly material: Material;
  private readonly ceilingMaterial: Material;
  private readonly seed: number;
  private readonly chunkGroup: Object3D;
  private readonly torchGroup: Object3D;
  private torches: TorchLight[] = [];
  private width = 0;
  private height = 0;
  private chunksX = 0;
  private chunksY = 0;
  private chunks: SceneChunk[] = [];

  constructor(opts: DungeonSceneOptions = {}) {
    this.material = opts.material ?? new MeshBasicMaterial();
    this.ceilingMaterial = opts.ceilingMaterial ?? this.material;
    this.seed = opts.seed ?? 1;
    this.root = new Group();
    this.root.name = 'dungeon';
    this.chunkGroup = new Group();
    this.chunkGroup.name = 'chunks';
    this.ceiling = new Group();
    this.ceiling.name = 'ceiling';
    this.torchGroup = new Group();
    this.torchGroup.name = 'torches';
    this.root.add(this.chunkGroup);
    this.root.add(this.ceiling);
    this.root.add(this.torchGroup);
  }

  /** Per-chunk main meshes in chunk-major order (`null` when the chunk is empty). */
  mainMeshes(): (Mesh | null)[] {
    return this.chunks.map((c) => c.mainMesh);
  }

  /** Per-chunk ceiling meshes in chunk-major order (`null` when a chunk has no passable cell). */
  ceilingMeshes(): (Mesh | null)[] {
    return this.chunks.map((c) => c.ceilingMesh);
  }

  /**
   * Rebuild any chunks whose per-chunk hash moved since the last call. Returns
   * `true` if any geometry changed. Level-wide early-out: if every chunk hash
   * and torch subset matches its cached value, this returns `false` without
   * touching a mesh.
   */
  refresh(level: LevelView): boolean {
    if (level.width !== this.width || level.height !== this.height) {
      this._reshape(level);
    }

    const n = this.chunks.length;
    const newCellHash = new Array<string>(n);
    const newCeilingHash = new Array<string>(n);
    const dirtyCells = new Array<boolean>(n);
    const dirtyCeiling = new Array<boolean>(n);
    let anyDirty = false;
    for (let i = 0; i < n; i++) {
      const c = this.chunks[i]!;
      const h = chunkHashOf(level, c.bounds);
      newCellHash[i] = h;
      dirtyCells[i] = h !== c.cellHash;
      const ch = ceilingHashOf(level, c.bounds);
      newCeilingHash[i] = ch;
      dirtyCeiling[i] = ch !== c.ceilingHash;
      if (dirtyCells[i] || dirtyCeiling[i]) anyDirty = true;
    }

    // Torches are collected level-wide (their spacing rule is global) but
    // grouped into per-chunk subsets so a chunk that hosts the same torches
    // stays clean.
    const newTorches = collectTorches(level);
    const grouped = torchesByChunk(newTorches, this.chunksX, this.chunksY);
    const newTorchHash = new Array<string>(n);
    const dirtyTorches = new Array<boolean>(n);
    for (let i = 0; i < n; i++) {
      const h = torchSubsetHash(grouped[i]!);
      newTorchHash[i] = h;
      dirtyTorches[i] = h !== this.chunks[i]!.torchHash;
      if (dirtyTorches[i]) anyDirty = true;
    }

    if (!anyDirty) return false;

    // 1. Rebake boxes for every chunk that changed. This is the O(chunk_cells)
    //    work the ticket is all about avoiding for the 23 clean chunks.
    for (let i = 0; i < n; i++) {
      const c = this.chunks[i]!;
      if (dirtyCells[i]) c.cellBoxes = bakeChunkCellBoxes(level, c.bounds, this.seed);
      if (dirtyTorches[i]) c.torchBoxes = bakeChunkTorchBoxes(grouped[i]!, this.seed);
      if (dirtyCeiling[i]) c.ceilingBoxes = bakeChunkCeilingBoxes(level, c.bounds, this.seed);
    }

    // 2. Only re-cull chunks whose own boxes changed. A neighbour's mask
    //    might in theory shift when a wall appears/disappears exactly on our
    //    shared boundary, but the resulting extra face sits inside the new
    //    (or under the removed) wall and is invisible from any pose the
    //    player can occupy. Re-culling neighbours would double the hidden
    //    face work per refresh — the ticket's 5 ms budget does not permit it.
    const maskDirtyMain = new Set<number>();
    const maskDirtyCeiling = new Set<number>();
    for (let i = 0; i < n; i++) {
      if (dirtyCells[i] || dirtyTorches[i]) maskDirtyMain.add(i);
      if (dirtyCeiling[i]) maskDirtyCeiling.add(i);
    }

    // 3. Re-cull + rewrite mesh only when the resulting hidden-face mask
    //    actually changed. Chunks whose halo did not shift keep their mesh
    //    reference — this is what the "leaves the others untouched" test pins.
    const mainOwn = (i: number): VoxelBox[] => {
      const c = this.chunks[i]!;
      return [...c.cellBoxes, ...c.torchBoxes];
    };
    const ceilingOwn = (i: number): VoxelBox[] => this.chunks[i]!.ceilingBoxes;

    const mainBoxCache: (VoxelBox[] | undefined)[] = new Array(n);
    const ceilingBoxCache: (VoxelBox[] | undefined)[] = new Array(n);
    const getMainBoxes = (i: number): VoxelBox[] => (mainBoxCache[i] ??= mainOwn(i));
    const getCeilingBoxes = (i: number): VoxelBox[] => (ceilingBoxCache[i] ??= ceilingOwn(i));

    const boundsAll = this.chunks.map((c) => c.bounds);

    for (const i of maskDirtyMain) {
      const own = getMainBoxes(i);
      const halo = haloBoxes(getMainBoxes, boundsAll, this.chunksX, this.chunksY, i);
      const mask = ownMaskFromHalo([...own, ...halo], own.length);
      const c = this.chunks[i]!;
      if (!maskEquals(mask, c.mainMask)) {
        c.mainMask = mask;
        this._replaceMainMesh(c, own, mask);
      }
    }

    for (const i of maskDirtyCeiling) {
      const own = getCeilingBoxes(i);
      const halo = haloBoxes(getCeilingBoxes, boundsAll, this.chunksX, this.chunksY, i);
      const mask = ownMaskFromHalo([...own, ...halo], own.length);
      const c = this.chunks[i]!;
      if (!maskEquals(mask, c.ceilingMask)) {
        c.ceilingMask = mask;
        this._replaceCeilingMesh(c, own, mask);
      }
    }

    // 4. Commit hashes and refresh the level-wide torch table.
    for (let i = 0; i < n; i++) {
      const c = this.chunks[i]!;
      c.cellHash = newCellHash[i]!;
      c.ceilingHash = newCeilingHash[i]!;
      c.torchHash = newTorchHash[i]!;
    }
    this.torches = newTorches.map(torchLightOf);

    return true;
  }

  /**
   * Reassign point lights to the (up to `MAX_LIVE_LIGHTS`) torches nearest
   * the hero, marking only the first `SHADOW_CASTING_LIGHTS` as shadow
   * casters. Idempotent — safe to call every frame.
   */
  updateLights(heroX: number, heroY: number): void {
    const active = selectActiveTorches(this.torches, heroX, heroY);
    while (this.pointLights.length < active.length) {
      const p = new PointLight(0xffffff, 1, 1);
      this.pointLights.push(p);
      this.torchGroup.add(p);
    }
    while (this.pointLights.length > active.length) {
      const p = this.pointLights.pop()!;
      this.torchGroup.remove(p);
      p.dispose();
    }
    for (let i = 0; i < active.length; i++) {
      const t = active[i]!;
      const light = this.pointLights[i]!;
      light.position.set(t.x, t.y, t.z);
      light.color.setHex(t.color);
      light.intensity = t.intensity;
      light.distance = t.distance;
      light.castShadow = i < SHADOW_CASTING_LIGHTS;
      light.name = t.id;
    }
  }

  /** Free every GPU-side resource held by the scene. */
  dispose(): void {
    for (const c of this.chunks) {
      if (c.mainMesh !== null) {
        this.chunkGroup.remove(c.mainMesh);
        c.mainMesh.geometry.dispose();
        c.mainMesh = null;
      }
      if (c.ceilingMesh !== null) {
        this.ceiling.remove(c.ceilingMesh);
        c.ceilingMesh.geometry.dispose();
        c.ceilingMesh = null;
      }
    }
    for (const light of this.pointLights) {
      this.torchGroup.remove(light);
      light.dispose();
    }
    this.pointLights.length = 0;
  }

  /** Resize the chunk grid for a new level (dispose existing meshes first). */
  private _reshape(level: LevelView): void {
    for (const c of this.chunks) {
      if (c.mainMesh !== null) {
        this.chunkGroup.remove(c.mainMesh);
        c.mainMesh.geometry.dispose();
        c.mainMesh = null;
      }
      if (c.ceilingMesh !== null) {
        this.ceiling.remove(c.ceilingMesh);
        c.ceilingMesh.geometry.dispose();
        c.ceilingMesh = null;
      }
    }
    this.width = level.width;
    this.height = level.height;
    const { chunksX, chunksY } = chunksOf(level);
    this.chunksX = chunksX;
    this.chunksY = chunksY;
    this.chunks = [];
    for (let cy = 0; cy < chunksY; cy++) {
      for (let cx = 0; cx < chunksX; cx++) {
        this.chunks.push({
          bounds: chunkAt(level, cx, cy),
          cellHash: '',
          ceilingHash: '',
          torchHash: '',
          cellBoxes: [],
          torchBoxes: [],
          ceilingBoxes: [],
          mainMask: new Uint8Array(),
          ceilingMask: new Uint8Array(),
          mainMesh: null,
          ceilingMesh: null,
        });
      }
    }
    this.torches = [];
  }

  private _replaceMainMesh(c: SceneChunk, boxes: readonly VoxelBox[], mask: Uint8Array): void {
    if (c.mainMesh !== null) {
      this.chunkGroup.remove(c.mainMesh);
      c.mainMesh.geometry.dispose();
      c.mainMesh = null;
    }
    if (boxes.length === 0) return;
    const writer = new GeoWriter(Math.max(64, boxes.length));
    for (let i = 0; i < boxes.length; i++) writer.box(boxes[i]!, 0.125, 0, 0, 0, IDENTITY, mask[i]!);
    const mesh = new Mesh(writer.toGeometry(), this.material);
    mesh.name = `level-${c.bounds.cx}-${c.bounds.cy}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    c.mainMesh = mesh;
    this.chunkGroup.add(mesh);
  }

  private _replaceCeilingMesh(c: SceneChunk, boxes: readonly VoxelBox[], mask: Uint8Array): void {
    if (c.ceilingMesh !== null) {
      this.ceiling.remove(c.ceilingMesh);
      c.ceilingMesh.geometry.dispose();
      c.ceilingMesh = null;
    }
    if (boxes.length === 0) return;
    const writer = new GeoWriter(Math.max(16, boxes.length));
    for (let i = 0; i < boxes.length; i++) writer.box(boxes[i]!, 0.125, 0, 0, 0, IDENTITY, mask[i]!);
    const mesh = new Mesh(writer.toGeometry(), this.ceilingMaterial);
    mesh.name = `ceiling-${c.bounds.cx}-${c.bounds.cy}`;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    c.ceilingMesh = mesh;
    this.ceiling.add(mesh);
  }
}

/** Cheaper-than-cellHash: only cares whether each cell is passable (ceiling depends on that alone). */
function ceilingHashOf(level: LevelView, b: ChunkBounds): string {
  let s = `c${b.x1 - b.x0}x${b.y1 - b.y0}`;
  for (let y = b.y0; y < b.y1; y++) {
    s += '|';
    for (let x = b.x0; x < b.x1; x++) s += passable(level.kindAt(x, y)) ? '1' : '0';
  }
  return s;
}
