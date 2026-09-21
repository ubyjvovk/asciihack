/**
 * Behaviour tests for the pure parts of the dungeon voxel scene (T-0039,
 * docs/gpu-dungeon.md). Every case exercises rules through the pure
 * `bakeLevel`, `bakeCeiling`, `ceilingCells`, `doorAxis` and
 * `selectActiveTorches` helpers, or through `DungeonScene` with a plain
 * `MeshBasicMaterial` — none of this needs a renderer.
 *
 * Expected shape: `bakeLevel` returns `{ writer, lights, boxCount }` and
 * `writer.pos`/`writer.col`/`writer.mat` are the same typed arrays across
 * two calls on the same level (docs/gpu-dungeon.md "Rebuild gate").
 */
import { describe, expect, it } from 'vitest';
import { MeshBasicMaterial } from 'three/webgpu';
import { isSolid, type CellKind, type LevelView } from '../src/model/types.js';
import {
  DungeonScene,
  bakeCeiling,
  bakeLevel,
  ceilingCells,
  doorAxis,
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
    // 'ceiling' — the ortho path (a later ticket) hides that group.
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

  it('a fully known 80x21 level stays under the box budget and bakes in under 50 ms', () => {
    const rows: string[] = [];
    rows.push('#'.repeat(80));
    for (let y = 1; y < 20; y++) rows.push('#' + '.'.repeat(78) + '#');
    rows.push('#'.repeat(80));
    const big: LevelView = levelFromAscii(rows, { lit: (k) => (k === 'floor' ? true : undefined) });

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
});
