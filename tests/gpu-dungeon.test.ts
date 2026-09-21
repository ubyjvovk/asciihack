/**
 * Behaviour tests for the pure parts of the dungeon voxel scene (T-0039 /
 * T-0046, docs/gpu-dungeon.md). Every case exercises rules through the pure
 * `bakeLevel`, `bakeChunks`, `bakeCeiling`, `ceilingCells`, `doorAxis` and
 * `selectActiveTorches` helpers, or through `DungeonScene` with a plain
 * `MeshBasicMaterial` — none of this needs a renderer.
 *
 * `bakeLevel` returns `{ writer, lights, boxCount }` and `bakeChunks` returns
 * one `ChunkBake` per chunk; the two share ordering (chunk-major, cells then
 * torches inside each chunk) and hidden-face masks (halo-culled), so the
 * chunked bake's per-chunk writer bytes concatenate to `bakeLevel`'s single
 * writer bytes — the "byte-identical" case below pins that contract.
 */
import { describe, expect, it } from 'vitest';
import { MeshBasicMaterial } from 'three/webgpu';
import { isSolid, type CellKind, type LevelView } from '../src/model/types.js';
import {
  CHUNK_H,
  CHUNK_W,
  DungeonScene,
  bakeCeiling,
  bakeChunks,
  bakeLevel,
  ceilingCells,
  chunksOf,
  doorAxis,
  isDampCell,
  selectActiveTorches,
} from '../web/src/gpu/dungeon.js';
import { levelFromAscii } from './fixtures/levels.js';

/**
 * A tiny four-cell frame surrounded by unexplored space; the doorway on the
 * east wall lets tests inspect both wall+floor+door bakes and a real border
 * of unexplored (' ') cells.
 */
const ONE_ROOM: LevelView = levelFromAscii([
  '       ',
  ' ##### ',
  ' #...# ',
  ' #...D ',
  ' #...# ',
  ' ##### ',
  '       ',
]);

/** A big lit room: enough interior wall to spawn well over eight torches. */
const TORCH_ROOM: LevelView = levelFromAscii(
  [
    '##########################',
    '#........................#',
    '#........................#',
    '#........................#',
    '#........................#',
    '#........................#',
    '#........................#',
    '#........................#',
    '#........................#',
    '#........................#',
    '#........................#',
    '#........................#',
    '#........................#',
    '#........................#',
    '#........................#',
    '#........................#',
    '#........................#',
    '#........................#',
    '#........................#',
    '#........................#',
    '#........................#',
    '##########################',
  ],
  { lit: (k) => (k === 'floor' ? true : undefined) },
);

/** Build the golden fully-known 80×21 room used by the perf + byte-identity cases. */
function buildBigRoomRows(): string[] {
  const rows: string[] = [];
  rows.push('#'.repeat(80));
  for (let y = 1; y < 20; y++) rows.push('#' + '.'.repeat(78) + '#');
  rows.push('#'.repeat(80));
  return rows;
}

/** `buildBigRoomRows` with `(x, y)` swapped to `swap` (a legend char). */
function bigRoomWith(x: number, y: number, swap: string): LevelView {
  const rows = buildBigRoomRows();
  const row = rows[y]!;
  rows[y] = row.substring(0, x) + swap + row.substring(x + 1);
  return levelFromAscii(rows, { lit: (k) => (k === 'floor' ? true : undefined) });
}

describe('gpu/dungeon — bakeLevel + DungeonScene', () => {
  it('a one-room level bakes walls, floor and a door and leaves unexplored cells empty', () => {
    const result = bakeLevel(ONE_ROOM);
    // Walls (12 cells) + floors (9 cells) + doorway (1 cell) all contribute.
    expect(result.boxCount).toBeGreaterThan(0);

    // The explored footprint is the closed AABB of the room; every vertex the
    // writer emitted must sit inside it (an unexplored cell contributes zero
    // boxes, so geometry never crosses that border). This also catches any
    // buggy transform that would displace a cell's boxes into open space.
    const explored: Array<[number, number]> = [];
    for (let y = 0; y < ONE_ROOM.height; y++) {
      for (let x = 0; x < ONE_ROOM.width; x++) {
        if (ONE_ROOM.kindAt(x, y) !== 'unexplored') explored.push([x, y]);
      }
    }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [cx, cy] of explored) {
      if (cx < minX) minX = cx;
      if (cx + 1 > maxX) maxX = cx + 1;
      if (cy < minZ) minZ = cy;
      if (cy + 1 > maxZ) maxZ = cy + 1;
    }
    const nv = result.writer.nv;
    const pos = result.writer.pos;
    const E = 1e-6;
    for (let i = 0; i < nv; i++) {
      const wx = pos[i * 3]!;
      const wz = pos[i * 3 + 2]!;
      expect(wx).toBeGreaterThanOrEqual(minX - E);
      expect(wx).toBeLessThanOrEqual(maxX + E);
      expect(wz).toBeGreaterThanOrEqual(minZ - E);
      expect(wz).toBeLessThanOrEqual(maxZ + E);
    }

    // A wall + a floor + a doorway must each show up in the write stream:
    // walls colour their boxes with the basalt family, floors with the darker
    // basalt0/basalt1 flagstones, and the doorway is the only cell with a
    // lintel high up at world y ≥ 0.875 that is NOT solid stone below it.
    const cellHasBox = (x: number, y: number): boolean => {
      const halfX = x + 0.5, halfZ = y + 0.5;
      for (let i = 0; i < nv; i++) {
        const wx = pos[i * 3]!;
        const wz = pos[i * 3 + 2]!;
        if (Math.abs(wx - halfX) < 0.5 && Math.abs(wz - halfZ) < 0.5) return true;
      }
      return false;
    };
    expect(cellHasBox(1, 1)).toBe(true);   // wall cell
    expect(cellHasBox(2, 2)).toBe(true);   // floor cell
    expect(cellHasBox(5, 3)).toBe(true);   // doorway cell
  });

  it('the ceiling group covers every known passable cell and nothing else', () => {
    const expected: Array<[number, number]> = [];
    for (let y = 0; y < ONE_ROOM.height; y++) {
      for (let x = 0; x < ONE_ROOM.width; x++) {
        const k: CellKind = ONE_ROOM.kindAt(x, y);
        if (k !== 'unexplored' && !isSolid(k)) expected.push([x, y]);
      }
    }
    // The pure helper enumerates the same set of cells the DungeonScene bakes.
    const cells = ceilingCells(ONE_ROOM);
    expect(cells).toEqual(expected);

    // The ceiling bake produces exactly one box per passable cell.
    const ceiling = bakeCeiling(ONE_ROOM);
    expect(ceiling.cells).toEqual(expected);
    expect(ceiling.boxCount).toBe(expected.length);

    // DungeonScene attaches the ceiling as a separable child group named
    // 'ceiling' — the ortho path (a later ticket) hides that group. The
    // one-room level fits entirely inside one 10 × 7 chunk, so the ceiling
    // group has exactly one Mesh under it.
    const scene = new DungeonScene({ material: new MeshBasicMaterial() });
    scene.refresh(ONE_ROOM);
    expect(scene.ceiling.name).toBe('ceiling');
    expect(scene.root.children.some((c) => c === scene.ceiling)).toBe(true);
    expect(scene.ceiling.children.length).toBe(1);
    scene.dispose();
  });

  it('the same level bakes byte-identical attribute arrays twice', () => {
    const a = bakeLevel(ONE_ROOM);
    const b = bakeLevel(ONE_ROOM);
    expect(b.boxCount).toBe(a.boxCount);
    expect(b.lights).toEqual(a.lights);
    // Compare the written prefixes of each attribute array — capacities may
    // differ if the writer had to grow, but the live vertex data must match.
    const nv = a.writer.nv;
    expect(b.writer.nv).toBe(nv);
    expect(b.writer.ni).toBe(a.writer.ni);
    expect(b.writer.pos.slice(0, nv * 3)).toEqual(a.writer.pos.slice(0, nv * 3));
    expect(b.writer.col.slice(0, nv * 4)).toEqual(a.writer.col.slice(0, nv * 4));
    expect(b.writer.mat.slice(0, nv * 4)).toEqual(a.writer.mat.slice(0, nv * 4));
    expect(b.writer.nrm.slice(0, nv * 4)).toEqual(a.writer.nrm.slice(0, nv * 4));
    expect(b.writer.idx.slice(0, a.writer.ni)).toEqual(a.writer.idx.slice(0, a.writer.ni));
  });

  it('only cells at or beside water, ice, a fountain or a drawbridge are damp', () => {
    // Dry-by-default: dungeon.ts marks stone boxes `dry: true` in cells the
    // predicate rejects, so a mood's residual wetness/puddles only paint
    // stone the level gives a reason to be wet. The predicate is orthogonal
    // (n/s/e/w) — diagonal neighbours of a damp source stay dry, and the
    // damp source cell itself is damp so the pool/basin/ice reflects properly.
    // Four sources are spread across the grid so no non-source cell touches
    // more than one, and the ordinary-terrain cells at the corners are far
    // enough away to stay dry.
    const grid: CellKind[][] = [
      ['floor',    'floor',    'floor', 'floor', 'floor',      'floor',      'floor'],
      ['floor',    'water',    'floor', 'ice',   'floor',      'corridor',   'floor'],
      ['floor',    'floor',    'floor', 'floor', 'floor',      'floor',      'floor'],
      ['floor',    'fountain', 'floor', 'floor', 'drawbridge', 'floor',      'floor'],
      ['floor',    'floor',    'floor', 'floor', 'floor',      'door_open',  'stairs_up'],
    ];
    const level: LevelView = {
      width: 7,
      height: 5,
      kindAt(x, y) {
        if (x < 0 || y < 0 || x >= 7 || y >= 5) return 'unexplored';
        return grid[y]![x]!;
      },
      cellAt() { return null; },
    };

    // Each damp source cell reports damp.
    for (const [x, y] of [[1, 1], [3, 1], [1, 3], [4, 3]] as const) {
      expect(isDampCell(level, x, y)).toBe(true);
    }
    // Orthogonal neighbours of the water at (1, 1) are damp.
    for (const [x, y] of [[0, 1], [2, 1], [1, 0], [1, 2]] as const) {
      expect(isDampCell(level, x, y)).toBe(true);
    }
    // Diagonal neighbours are not damp — the predicate is 4-connected.
    for (const [x, y] of [[0, 0], [2, 0], [0, 2], [2, 2]] as const) {
      expect(isDampCell(level, x, y)).toBe(false);
    }
    // Corridors, ordinary floor rooms, doors and stairs are dry when nothing
    // damp is next to them (ticket: "the level gives a reason").
    expect(isDampCell(level, 5, 1)).toBe(false); // corridor, far from any source
    expect(isDampCell(level, 6, 0)).toBe(false); // ordinary floor corner
    expect(isDampCell(level, 5, 4)).toBe(false); // door_open in a dry row
    expect(isDampCell(level, 6, 4)).toBe(false); // stairs_up in a dry row
    // Out-of-range coordinates are dry (the LevelView reports `unexplored`).
    expect(isDampCell(level, -1, 2)).toBe(false);
    expect(isDampCell(level, 7, 2)).toBe(false);
  });

  it('a closed door takes its axis from the neighbouring walls', () => {
    // Walls sit north and south of the closed door → people walk east-west
    // through it, so the door slab's long axis is `ew`.
    const nsFrame: LevelView = levelFromAscii([
      '###',
      '.+.',
      '###',
    ]);
    expect(doorAxis(nsFrame, 1, 1)).toBe('ew');

    // Walls east and west of the closed door → axis is `ns`.
    const ewFrame: LevelView = levelFromAscii([
      '#.#',
      '#+#',
      '#.#',
    ]);
    expect(doorAxis(ewFrame, 1, 1)).toBe('ns');

    // Isolated door with no wall neighbours falls back to `ew` (matches
    // web/src/gl/scene-builder.ts).
    const lone: LevelView = levelFromAscii([
      '...',
      '.+.',
      '...',
    ]);
    expect(doorAxis(lone, 1, 1)).toBe('ew');
  });

  it('torch lights are capped at eight and the nearest to the hero win', () => {
    const { lights } = bakeLevel(TORCH_ROOM);
    // The room is large and every floor is lit, so we get well over eight
    // torch candidates from the spacing rule.
    expect(lights.length).toBeGreaterThan(8);

    // Pick a hero position deep inside the room; the eight closest torches
    // must be exactly the ones the selector returns, in non-decreasing order
    // of squared distance.
    const heroX = 5, heroY = 5;
    const active = selectActiveTorches(lights, heroX, heroY);
    expect(active.length).toBe(8);
    const d2 = (t: { x: number; z: number }): number =>
      (t.x - (heroX + 0.5)) ** 2 + (t.z - (heroY + 0.5)) ** 2;
    for (let i = 1; i < active.length; i++) {
      expect(d2(active[i]!)).toBeGreaterThanOrEqual(d2(active[i - 1]!));
    }
    // Nearest-eight identity check: sort every torch by distance manually and
    // compare the first eight ids.
    const truth = [...lights].sort((a, b) => d2(a) - d2(b)).slice(0, 8).map((t) => t.id);
    expect(active.map((t) => t.id)).toEqual(truth);
  });

  it('only the two nearest torches cast shadows and the rest are cleared', () => {
    const scene = new DungeonScene({ material: new MeshBasicMaterial() });
    scene.refresh(TORCH_ROOM);

    scene.updateLights(4, 4);
    expect(scene.pointLights.length).toBeLessThanOrEqual(8);
    // First two lights cast shadows (the 2 nearest); the rest have castShadow cleared.
    expect(scene.pointLights[0]!.castShadow).toBe(true);
    expect(scene.pointLights[1]!.castShadow).toBe(true);
    for (let i = 2; i < scene.pointLights.length; i++) {
      expect(scene.pointLights[i]!.castShadow).toBe(false);
    }
    const firstShadowNames = scene.pointLights
      .filter((p) => p.castShadow)
      .map((p) => p.name)
      .sort();

    // Move the hero to the far corner: the two nearest torches change, and
    // whichever ones used to cast shadows must now have `castShadow = false`.
    scene.updateLights(TORCH_ROOM.width - 5, TORCH_ROOM.height - 5);
    const secondShadowNames = scene.pointLights
      .filter((p) => p.castShadow)
      .map((p) => p.name)
      .sort();
    expect(secondShadowNames).toHaveLength(2);
    expect(secondShadowNames).not.toEqual(firstShadowNames);
    // Every light not currently in the shadow-caster set is cleared.
    for (const p of scene.pointLights) {
      if (!secondShadowNames.includes(p.name)) expect(p.castShadow).toBe(false);
    }
    scene.dispose();
  });

  it('floor and wall stone vary by eight percent per box', () => {
    // T-0054: T-0053 correctly made dungeon stone dry, but wetness had been
    // doing double duty — it darkened albedo *and* its sheen picked out
    // flagstone edges. Without it the amber quantiser reads a flat tan
    // expanse (wet 148 levels → dry 134 = 14 levels lost). Raising the
    // per-box lightness jitter from ±4 % to ±8 % puts the variation back in
    // the geometry rather than by wetting the floor again.
    //
    // The test is a black-box read of `bakeLevel`'s writer. `basalt1` (the
    // corridor cell's single 8×1×8 box, and one of the wall body's colour
    // choices) is `0x2a3437 = (42, 52, 55)`; `jitterColor` scales every
    // channel by a common lightness `l = 1 + (rand−0.5)·2·jitter` and only
    // r/b pick up a small hue tint, so the green channel `g' = round(52·l)`
    // reads out the lightness directly. Sample many corridor cells → 200+
    // basalt1 boxes → `g'/52` should span the full ±8 % window.
    const rows: string[] = [];
    for (let y = 0; y < 15; y++) rows.push('%'.repeat(20));
    const level = levelFromAscii(rows);
    const { writer } = bakeLevel(level);

    const BR = 42, BG = 52, BB = 55; // basalt1 = 0x2a3437
    const seen = new Set<string>();
    const scales: number[] = [];
    const nv = writer.nv;
    // Every vertex of a box shares the same (r, g, b, alpha) tuple; alpha is
    // `Math.round(rnd·255)` so distinct boxes differ. Dedupe on the whole
    // tuple and keep only colours consistent with a jittered basalt1 (within
    // ±10 % on every channel — well outside `mud` at (58, 58, 51), which
    // corridors sprinkle with 30 % probability).
    for (let i = 0; i < nv; i++) {
      const r = writer.col[i * 4]!;
      const g = writer.col[i * 4 + 1]!;
      const b = writer.col[i * 4 + 2]!;
      const a = writer.col[i * 4 + 3]!;
      const key = `${r},${g},${b},${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (Math.abs(r / BR - 1) > 0.10) continue;
      if (Math.abs(g / BG - 1) > 0.10) continue;
      if (Math.abs(b / BB - 1) > 0.10) continue;
      scales.push(g / BG);
    }

    // Sample size guards the range assertion below — a tiny sample could
    // easily miss the extremes even at the right jitter setting.
    expect(scales.length).toBeGreaterThanOrEqual(100);
    const min = Math.min(...scales);
    const max = Math.max(...scales);
    // The observed lightness range spans well beyond the ±4 % envelope the
    // pre-T-0054 setting allowed (max span ≈ [0.96, 1.04]). Pinning at
    // `max > 1.05` and `min < 0.95` catches a regression that walks jitter
    // back down without any lucky sampling saving it.
    expect(max).toBeGreaterThan(1.05);
    expect(min).toBeLessThan(0.95);
    // And no box escapes the theoretical ±8 % window (`l ∈ [0.92, 1.08)`
    // rounded to integer 0..255 → `g'/52 ∈ [48/52, 56/52]` = [0.923, 1.077]).
    // A future retune that pushes jitter past 8 % would fail this side.
    expect(max).toBeLessThanOrEqual(56 / BG);
    expect(min).toBeGreaterThanOrEqual(48 / BG);
  });

  it('every floor cell is fully tiled, worn quadrants included', () => {
    // T-0055: `buildFloor` used to skip a 4×1×4 quadrant at 10 % probability,
    // leaving a black square in the middle of a lit floor cell. It now
    // always places all four quadrants; on the same seeded 10 % roll, the
    // worn quadrant is a `basalt0` tile recessed one voxel (y ∈ [-0.125, 0] m)
    // so the wear reads as a sunken flagstone instead of a hole.
    const H = 6, W = 6;
    const rows: string[] = [];
    for (let y = 0; y < H; y++) rows.push('.'.repeat(W));
    const level = levelFromAscii(rows);

    let sawRecessed = false;
    for (const seed of [1, 7, 13, 42, 99]) {
      const { writer, boxCount } = bakeLevel(level, { seed });
      // Every floor cell contributes exactly four flagstone quadrants plus
      // an optional mud pebble (≤ 1 per cell at 25 % probability), so the
      // per-level box count is in `[4·N, 5·N]`. Fewer than `4·N` would mean a
      // hole survived, more than `5·N` would mean an extra flagstone snuck in.
      expect(boxCount).toBeGreaterThanOrEqual(4 * H * W);
      expect(boxCount).toBeLessThanOrEqual(5 * H * W);

      // Split the writer's vertices into the sixteen quadrant zones of the
      // level (four per cell). Each zone is 0.5 m × 0.5 m in XZ, centred on
      // a flagstone quadrant; every zone must contain at least one vertex
      // at flagstone y (`[-0.125, 0.125] m` covers both normal and recessed
      // tiles), regardless of the seed.
      const E = 1e-6;
      const nv = writer.nv;
      const pos = writer.pos;
      for (let cy = 0; cy < H; cy++) {
        for (let cx = 0; cx < W; cx++) {
          for (const qx of [0, 0.5]) {
            for (const qz of [0, 0.5]) {
              const minX = cx + qx - E;
              const maxX = cx + qx + 0.5 + E;
              const minZ = cy + qz - E;
              const maxZ = cy + qz + 0.5 + E;
              let found = false;
              for (let i = 0; i < nv; i++) {
                const px = pos[i * 3]!;
                const py = pos[i * 3 + 1]!;
                const pz = pos[i * 3 + 2]!;
                if (px >= minX && px <= maxX && pz >= minZ && pz <= maxZ && py >= -0.125 - E && py <= 0.125 + E) {
                  found = true;
                  break;
                }
              }
              expect(found, `seed=${seed} cell=(${cx},${cy}) quadrant=(${qx},${qz})`).toBe(true);
            }
          }
        }
      }
      // A recessed quadrant's bottom face sits at `y = -0.125`; a vertex
      // strictly below zero proves the worn treatment fired without leaving
      // a hole. Across five seeds and 144 quadrant rolls, ~14 fires are
      // expected on average.
      for (let i = 0; i < nv; i++) {
        if (pos[i * 3 + 1]! < -1e-6) { sawRecessed = true; break; }
      }
    }
    expect(sawRecessed).toBe(true);
  });

  it('a fully known 80x21 level stays under the box budget and bakes in under 50 ms', () => {
    const big: LevelView = levelFromAscii(buildBigRoomRows(), { lit: (k) => (k === 'floor' ? true : undefined) });

    // Warm any cache/JIT — the first pass includes optimisation, the second
    // is representative of a steady-state rebuild.
    bakeLevel(big);
    const t0 = performance.now();
    const result = bakeLevel(big);
    const dt = performance.now() - t0;

    // docs/gpu-dungeon.md "Box budget": ≤ 40 000 boxes for a fully-known
    // 80×21 level; ≤ 12 boxes/cell on average.
    expect(result.boxCount).toBeLessThanOrEqual(40000);
    expect(result.boxCount).toBeLessThanOrEqual(12 * 80 * 21);
    // docs/gpu-dungeon.md "Rebuild gate": full rebuild under 50 ms.
    expect(dt).toBeLessThan(50);
  });

  it('revealing one cell rebakes one chunk and leaves the others untouched', () => {
    // Level A: fully known 80×21 room except one interior cell (33, 10) which
    // is still `unexplored`. Cell (33, 10) sits well inside chunk (cx=3, cy=1)
    // (which covers x∈[30,40), y∈[7,14)), so revealing it cannot flip a hidden
    // face on the four axial neighbour chunks — their `mainMesh` refs must
    // therefore stay identical.
    const levelA = bigRoomWith(33, 10, ' ');
    const levelB = bigRoomWith(33, 10, '.');

    const scene = new DungeonScene({ material: new MeshBasicMaterial(), seed: 7 });
    scene.refresh(levelA);
    const { chunksX, chunksY } = chunksOf(levelA);
    const changedIdx = 1 * chunksX + 3; // (cx=3, cy=1) in an 8×3 chunk grid
    expect(chunksX).toBe(8);
    expect(chunksY).toBe(3);

    const mainBefore = scene.mainMeshes();
    const ceilingBefore = scene.ceilingMeshes();
    expect(mainBefore).toHaveLength(chunksX * chunksY);

    const changed = scene.refresh(levelB);
    expect(changed).toBe(true);

    const mainAfter = scene.mainMeshes();
    const ceilingAfter = scene.ceilingMeshes();

    for (let i = 0; i < mainAfter.length; i++) {
      if (i === changedIdx) {
        expect(mainAfter[i]).not.toBe(mainBefore[i]);
      } else {
        expect(mainAfter[i]).toBe(mainBefore[i]);
      }
    }
    // (33, 10) went from unexplored to floor, so the ceiling for that chunk
    // must be replaced too and every other ceiling chunk must be preserved.
    for (let i = 0; i < ceilingAfter.length; i++) {
      if (i === changedIdx) {
        expect(ceilingAfter[i]).not.toBe(ceilingBefore[i]);
      } else {
        expect(ceilingAfter[i]).toBe(ceilingBefore[i]);
      }
    }

    // Refreshing with the same level again is a full early-out — no mesh moves.
    const stable = scene.refresh(levelB);
    expect(stable).toBe(false);
    const mainSame = scene.mainMeshes();
    for (let i = 0; i < mainSame.length; i++) expect(mainSame[i]).toBe(mainAfter[i]);
    scene.dispose();
  });

  it('a chunked bake of a fully known level is byte-identical to an unchunked one', () => {
    const big: LevelView = levelFromAscii(buildBigRoomRows(), { lit: (k) => (k === 'floor' ? true : undefined) });

    const unchunked = bakeLevel(big);
    const chunked = bakeChunks(big);

    // Basic parity: totals match and per-chunk hash is stable across bakes.
    expect(chunked.chunksX).toBe(8);
    expect(chunked.chunksY).toBe(3);
    expect(chunked.chunks).toHaveLength(24);
    expect(chunked.boxCount).toBe(unchunked.boxCount);
    expect(chunked.lights).toEqual(unchunked.lights);

    let nvSum = 0, niSum = 0;
    for (const c of chunked.chunks) {
      nvSum += c.writer.nv;
      niSum += c.writer.ni;
    }
    expect(nvSum).toBe(unchunked.writer.nv);
    expect(niSum).toBe(unchunked.writer.ni);

    // Concatenate every chunk writer's used bytes in chunk-major order and
    // compare against the unchunked writer. Positions, colours, materials and
    // normals must match byte-for-byte; indices must match after offsetting.
    const pos = new Float32Array(nvSum * 3);
    const col = new Uint8Array(nvSum * 4);
    const mat = new Uint8Array(nvSum * 4);
    const nrm = new Int8Array(nvSum * 4);
    const idx = new Uint32Array(niSum);
    let vOff = 0, iOff = 0;
    for (const c of chunked.chunks) {
      const nv = c.writer.nv;
      const ni = c.writer.ni;
      pos.set(c.writer.pos.subarray(0, nv * 3), vOff * 3);
      col.set(c.writer.col.subarray(0, nv * 4), vOff * 4);
      mat.set(c.writer.mat.subarray(0, nv * 4), vOff * 4);
      nrm.set(c.writer.nrm.subarray(0, nv * 4), vOff * 4);
      for (let k = 0; k < ni; k++) idx[iOff + k] = c.writer.idx[k]! + vOff;
      vOff += nv;
      iOff += ni;
    }
    expect(pos).toEqual(unchunked.writer.pos.slice(0, nvSum * 3));
    expect(col).toEqual(unchunked.writer.col.slice(0, nvSum * 4));
    expect(mat).toEqual(unchunked.writer.mat.slice(0, nvSum * 4));
    expect(nrm).toEqual(unchunked.writer.nrm.slice(0, nvSum * 4));
    expect(idx).toEqual(unchunked.writer.idx.slice(0, niSum));
  });

  it('revealing one cell in an 80x21 level costs under 5 ms', () => {
    // Warm the JIT with a full bake, then measure the cost of a single
    // one-cell reveal in the middle of a chunk (chunk (3, 1) covers
    // x∈[30,40), y∈[7,14); cell (33, 10) is interior).
    const levelA = bigRoomWith(33, 10, ' ');
    const levelB = bigRoomWith(33, 10, '.');
    const scene = new DungeonScene({ material: new MeshBasicMaterial(), seed: 7 });
    scene.refresh(levelA); // cold: full bake, all chunks.
    // A no-op call warms the incremental-path branches without changing state.
    scene.refresh(levelA);

    const t0 = performance.now();
    const changed = scene.refresh(levelB);
    const dt = performance.now() - t0;
    expect(changed).toBe(true);
    expect(dt).toBeLessThan(5);

    // Sanity: the CHUNK_W / CHUNK_H the ticket fixed produce an 8 × 3 grid,
    // so the numbers in the assertions above are what a reader expects.
    expect(CHUNK_W).toBe(10);
    expect(CHUNK_H).toBe(7);
    scene.dispose();
  });
});
