/**
 * Click-to-move pathfinding + picking (T-0061, docs/gpu-pick.md).
 *
 * `findPath` walks the session's remembered map with BFS; `cellUnderRay`
 * intersects a click ray with the floor plane. Both are pure, so this file
 * runs in node with no browser or three.js dependency (three is only touched
 * in the tests already exercising it — the pick maths here is plain arithmetic).
 *
 * Case names are the ticket's acceptance list — do not rename them, do not
 * add other tests.
 */
import { describe, expect, it } from 'vitest';
import { findPath } from '../src/ui/travel.js';
import type { CellKind, LevelView, MapCell } from '../src/model/types.js';
import { cellUnderRay } from '../web/src/gpu/pick.js';

/**
 * Build a `LevelView` from a compact string grid. Row 0 is the top; one
 * character per cell:
 *   `.` remembered floor (passable)
 *   `#` remembered wall  (solid, blocks)
 *   ` ` unexplored       (BFS refuses)
 * Every row must be the same length; width is inferred from the first row.
 */
function makeLevel(rows: readonly string[]): LevelView {
  const height = rows.length;
  const width = rows[0]!.length;
  const kindFor = (ch: string): CellKind => {
    if (ch === '.') return 'floor';
    if (ch === '#') return 'wall';
    if (ch === ' ') return 'unexplored';
    throw new Error(`makeLevel: unexpected cell '${ch}'`);
  };
  const kindAt = (x: number, y: number): CellKind => {
    if (x < 0 || y < 0 || x >= width || y >= height) return 'unexplored';
    return kindFor(rows[y]![x]!);
  };
  const cellAt = (x: number, y: number): MapCell | null => {
    if (x < 0 || y < 0 || x >= width || y >= height) return null;
    return { x, y, kind: kindAt(x, y), terrain: null, top: null };
  };
  return { width, height, kindAt, cellAt };
}

describe('click-to-move — BFS over the remembered map', () => {
  it('a path is found through known passable cells', () => {
    // Corridor with a right-angle bend; BFS should walk it (diagonals cut the
    // corner). The straight south-east target from (1, 1) is (4, 3); we assert
    // the path ends there, has at least the Chebyshev-distance number of
    // steps (3) and never leaves the floor.
    const level = makeLevel([
      '#####',
      '#...#',
      '###.#',
      '###.#',
      '#####',
    ]);
    const path = findPath(level, { x: 1, y: 1 }, { x: 3, y: 3 });
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(0);
    // BFS uniform-cost: each step is one turn. Chebyshev distance from (1,1)
    // to (3,3) is max(|dx|, |dy|) = 2, but diagonal squeeze is blocked here
    // by walls at (2, 1) or (1, 2)/(1, 3), so the shortest path has to trace
    // the corridor — that is a 4-cell walk: (2,1)→(3,1)→(3,2)→(3,3).
    expect(path).toEqual([
      { x: 2, y: 1 },
      { x: 3, y: 1 },
      { x: 3, y: 2 },
      { x: 3, y: 3 },
    ]);
    for (const c of path!) expect(level.kindAt(c.x, c.y)).toBe('floor');
  });

  it('unexplored cells are never used', () => {
    // Two floor pockets separated by an unexplored column. BFS must refuse
    // the shortcut through unexplored (` `) even though it is not marked
    // solid — "known cells only" is the ticket's rule.
    const level = makeLevel([
      '#####',
      '#. .#',
      '#####',
    ]);
    // Same row, the "gap" cell is unexplored (' ').
    expect(level.kindAt(2, 1)).toBe('unexplored');
    const path = findPath(level, { x: 1, y: 1 }, { x: 3, y: 1 });
    expect(path).toBeNull();
  });

  it('no diagonal squeeze between two walls', () => {
    // Classic NetHack rule: (0,0) → (1,1) is blocked when both (1,0) and
    // (0,1) are walls. Layout: hero at (0,0) is floor, target (1,1) is
    // floor, north cardinal (1,0) is wall and east cardinal (0,1) is wall.
    const level = makeLevel([
      '.#',
      '#.',
    ]);
    const path = findPath(level, { x: 0, y: 0 }, { x: 1, y: 1 });
    expect(path).toBeNull();
    // Sanity: with both cardinals opened, the diagonal is fine and the
    // shortest path is a single step.
    const open = makeLevel([
      '..',
      '..',
    ]);
    const pathOpen = findPath(open, { x: 0, y: 0 }, { x: 1, y: 1 });
    expect(pathOpen).toEqual([{ x: 1, y: 1 }]);
  });

  it('an unreachable target returns no path', () => {
    // Target is floor but sealed off by walls; BFS drains the reachable set
    // and returns null — the ticket calls for silence, so this is the shape
    // the caller distinguishes "no click action" from an empty walk.
    const level = makeLevel([
      '#####',
      '#.#.#',
      '#####',
    ]);
    const path = findPath(level, { x: 1, y: 1 }, { x: 3, y: 1 });
    expect(path).toBeNull();
  });

  it('cellUnderRay hits the floor plane under the cursor', () => {
    // Camera looks straight down at cell (5, 3): origin above the cell
    // centre, direction −y. The ray hits y=0 at (5.5, 0, 3.5); floor()
    // lands on cell (5, 3). This pins the world-space convention docs/gpu.md
    // §4 asks for: map `x` = world x, map `y` = world z.
    const cell = cellUnderRay({ x: 5.5, y: 4, z: 3.5 }, { x: 0, y: -1, z: 0 });
    expect(cell).toEqual({ x: 5, y: 3 });

    // Oblique ray: from above and behind (south of) the cell, pitched down.
    // At t=10 the hit is (10.5, 0, 20.5): floor → (10, 20).
    const oblique = cellUnderRay({ x: 10.5, y: 5, z: 25.5 }, { x: 0, y: -0.5, z: -0.5 });
    expect(oblique).toEqual({ x: 10, y: 20 });

    // Miss: ray points up — the floor is behind the camera, never hit.
    expect(cellUnderRay({ x: 0, y: 5, z: 0 }, { x: 0, y: 1, z: 0 })).toBeNull();
    // Miss: ray parallel to the floor plane (dy = 0).
    expect(cellUnderRay({ x: 0, y: 5, z: 0 }, { x: 1, y: 0, z: 0 })).toBeNull();
    // Miss: origin below the plane looking down — the hit is at negative t
    // (behind the camera), so no cell is picked.
    expect(cellUnderRay({ x: 0, y: -3, z: 0 }, { x: 0, y: -1, z: 0 })).toBeNull();
  });
});
