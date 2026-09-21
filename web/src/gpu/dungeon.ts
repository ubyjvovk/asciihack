/**
 * Dungeon voxel scene builder for the GPU render path (T-0039,
 * docs/gpu-dungeon.md). Turns a `LevelView` into afterburn-grade voxel
 * geometry: stacked stone walls with chipped corners, flagstone floors with
 * missing tiles, doorways with posts + lintel, plank doors with hinges, four
 * stepped stair boxes with a faint emissive nosing, water/lava/ice surfaces,
 * small props (fountain, altar, grave, sink, throne) and emissive torch
 * sconces backed by real `THREE.PointLight`s.
 *
 * Coordinates (docs/gpu.md §4): map `x` = east, map `y` = south, three.js
 * `x` = east, `z` = south, `y` = up. One cell = one three unit; the kit voxel
 * unit is `0.125` (8 voxels per cell edge). Wall height stays 1, ceiling
 * bottom sits at `y = 1`.
 *
 * The pure `bakeLevel(level, opts)` returns the merged `GeoWriter`, the torch
 * `lights` and a total `boxCount`; every rule (jitter seeded per cell, door
 * axis inference, torch spacing) is exercised through it without a renderer.
 * `DungeonScene` wraps the bake plus a separable `ceiling` `Object3D` group
 * and the live point-light array; `updateLights(x, y)` follows the hero and
 * marks only the two nearest torches as shadow casters (docs/gpu.md §5 /
 * `.tigerteam/STATE.md` decision log 2026-09-21).
 */

import { Group, Matrix4, Mesh, MeshBasicMaterial, Object3D, PointLight } from 'three/webgpu';
import type { Material } from 'three/webgpu';
import { VoxelBuilder, makeRng } from '../voxel/kit.js';
import { GeoWriter, bakeModel } from '../voxel/mesh.js';
import { FX_FLICKER, FX_PULSE } from './moods.js';
import { isSolid, type CellKind, type LevelView } from '../../../src/model/types.js';

/** Voxel units per cell edge (kit unit = 0.125 metres; wall height = 1 m = 8 units). */
const CELL_UNITS = 8;
/** Cap on live `PointLight`s emitted by torches. */
const MAX_LIVE_LIGHTS = 8;
/** Number of nearest torches that cast real shadows (rest lit flat by SSGI/AO). */
const SHADOW_CASTING_LIGHTS = 2;
/** Minimum Chebyshev cell distance between two chosen torches. */
const TORCH_MIN_SPACING = 6;

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

/** Options passed to `bakeLevel`. */
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

/** Options accepted by the `DungeonScene` constructor. */
export interface DungeonSceneOptions {
  /** Material for the main merged mesh. Defaults to a plain `MeshBasicMaterial`. */
  material?: Material;
  /** Material for the ceiling mesh. Defaults to the same as `material`. */
  ceilingMaterial?: Material;
  /** RNG base seed forwarded to `bakeLevel`. */
  seed?: number;
}

/** Cheap one-letter code per `CellKind` used by `hashKinds`. */
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

/** Build a compact string that changes iff the set of drawable cells does. */
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
  b.box(0, 0, 0, CELL_UNITS, 0.8, CELL_UNITS, 'crystalCold1', {
    rough: 0.1, metal: 0.1, dry: true,
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

// ---------------------------------------------------------------------------
// Pure bake — one merged geometry, torch light list, total box count.
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
 * Pure bake: `LevelView` → merged voxel geometry + torch light list. Iterates
 * cells in row-major order, reseeding the builder RNG per cell so that jitter
 * depends only on `(x, y, seed)` and the same level bakes byte-identically
 * twice. Torches are collected up front and appended to the same builder so
 * their sconces share hidden-face culling with the walls that host them.
 */
export function bakeLevel(level: LevelView, opts?: BakeOptions): BakeResult {
  const baseSeed = opts?.seed ?? 1;
  const builder = new VoxelBuilder({ unit: 0.125, seed: baseSeed, jitter: 0.04 });

  for (let y = 0; y < level.height; y++) {
    for (let x = 0; x < level.width; x++) {
      const kind = level.kindAt(x, y);
      if (kind === 'unexplored') continue;
      builder.rand = makeRng(cellSeed(x, y, baseSeed));
      builder.at(x * CELL_UNITS, 0, y * CELL_UNITS, () => bakeCell(builder, level, x, y, kind));
    }
  }

  const torches = collectTorches(level);
  const lights: TorchLight[] = [];
  for (const t of torches) {
    builder.rand = makeRng(cellSeed(t.x, t.y, baseSeed) ^ 0xa53f7c1d);
    builder.at(t.x * CELL_UNITS, 0, t.y * CELL_UNITS, () => buildTorchSconce(builder, t.side));
    const off = torchOffset(t.side);
    lights.push({
      id: `torch-${t.x}-${t.y}-${t.side}`,
      x: t.x + 0.5 + off.dx,
      y: 0.65,
      z: t.y + 0.5 + off.dz,
      color: 0xffb060,
      intensity: 6,
      distance: 8,
      flicker: 0.3,
      side: t.side,
    });
  }

  const model = builder.build('dungeon');
  const writer = new GeoWriter(Math.max(1024, model.boxCount));
  bakeModel(writer, model, IDENTITY, { cull: true });
  return { writer, lights, boxCount: model.boxCount };
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
  const model = builder.build('ceiling');
  const writer = new GeoWriter(Math.max(64, model.boxCount));
  bakeModel(writer, model, IDENTITY, { cull: true });
  return { writer, cells, boxCount: model.boxCount };
}

const IDENTITY = new Matrix4();

// ---------------------------------------------------------------------------
// DungeonScene — the class that lives in the render loop.
// ---------------------------------------------------------------------------

/**
 * Owns the merged level `Mesh`, the separable `ceiling` group and the live
 * `PointLight` array. `refresh(level)` rebuilds only when `hashKinds(level)`
 * changes; `updateLights(x, y)` reassigns which of the baked torches are
 * currently emitting (cap `MAX_LIVE_LIGHTS = 8`; `SHADOW_CASTING_LIGHTS = 2`
 * nearest cast real shadows, the rest are lit flat).
 */
export class DungeonScene {
  readonly root: Object3D;
  readonly ceiling: Object3D;
  readonly pointLights: PointLight[] = [];
  private readonly material: Material;
  private readonly ceilingMaterial: Material;
  private readonly seed: number;
  private mainMesh: Mesh | null = null;
  private ceilingMesh: Mesh | null = null;
  private torches: TorchLight[] = [];
  private structHash = '';
  private readonly torchGroup: Object3D;

  constructor(opts: DungeonSceneOptions = {}) {
    this.material = opts.material ?? new MeshBasicMaterial();
    this.ceilingMaterial = opts.ceilingMaterial ?? this.material;
    this.seed = opts.seed ?? 1;
    this.root = new Group();
    this.root.name = 'dungeon';
    this.ceiling = new Group();
    this.ceiling.name = 'ceiling';
    this.torchGroup = new Group();
    this.torchGroup.name = 'torches';
    this.root.add(this.ceiling);
    this.root.add(this.torchGroup);
  }

  /** Rebuild the main mesh + ceiling if `hashKinds(level)` has changed. */
  refresh(level: LevelView): boolean {
    const hash = hashKinds(level);
    if (hash === this.structHash) return false;
    this.structHash = hash;

    if (this.mainMesh !== null) {
      this.root.remove(this.mainMesh);
      this.mainMesh.geometry.dispose();
      this.mainMesh = null;
    }
    if (this.ceilingMesh !== null) {
      this.ceiling.remove(this.ceilingMesh);
      this.ceilingMesh.geometry.dispose();
      this.ceilingMesh = null;
    }

    const main = bakeLevel(level, { seed: this.seed });
    if (main.boxCount > 0) {
      const geom = main.writer.toGeometry();
      this.mainMesh = new Mesh(geom, this.material);
      this.mainMesh.name = 'level';
      this.mainMesh.castShadow = true;
      this.mainMesh.receiveShadow = true;
      this.root.add(this.mainMesh);
    }
    const ceiling = bakeCeiling(level, { seed: this.seed });
    if (ceiling.boxCount > 0) {
      const geom = ceiling.writer.toGeometry();
      this.ceilingMesh = new Mesh(geom, this.ceilingMaterial);
      this.ceilingMesh.name = 'ceiling-mesh';
      this.ceilingMesh.castShadow = false;
      this.ceilingMesh.receiveShadow = true;
      this.ceiling.add(this.ceilingMesh);
    }
    this.torches = main.lights;
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
    if (this.mainMesh !== null) {
      this.mainMesh.geometry.dispose();
      this.root.remove(this.mainMesh);
      this.mainMesh = null;
    }
    if (this.ceilingMesh !== null) {
      this.ceilingMesh.geometry.dispose();
      this.ceiling.remove(this.ceilingMesh);
      this.ceilingMesh = null;
    }
    for (const light of this.pointLights) {
      this.torchGroup.remove(light);
      light.dispose();
    }
    this.pointLights.length = 0;
  }
}
