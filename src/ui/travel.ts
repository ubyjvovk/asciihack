/**
 * Click-to-move pathfinding (T-0061, docs/gpu-pick.md). Pure BFS over a
 * `LevelView`'s remembered map, plus the vi-key translation the caller feeds
 * to `sendKey`. No I/O; the browser wiring in `web/src/main.ts` owns the
 * click listener and the one-key-per-frame policy.
 *
 * Passable = **known** floor: `kindAt !== 'unexplored'` AND `!isSolid(kind)`.
 * Diagonals are allowed, but the classic NetHack "no squeezing between two
 * diagonal walls" rule applies — a step from `(x, y)` to `(x+dx, y+dy)`
 * with `dx * dy !== 0` needs both cardinal neighbours `(x+dx, y)` and
 * `(x, y+dy)` to be passable too. Without that rule a click would path
 * through a wall corner NetHack itself would reject on the next move.
 */
import { isSolid, type LevelView } from '../model/types.js';

/** A cell on the found path — plain integers so tests can assert exactly. */
export interface PathCell {
  x: number;
  y: number;
}

/** All eight step directions (cardinals + diagonals), matching the 8-way move set. */
const STEPS: ReadonlyArray<readonly [number, number]> = [
  [0, -1], // N
  [1, -1], // NE
  [1, 0], // E
  [1, 1], // SE
  [0, 1], // S
  [-1, 1], // SW
  [-1, 0], // W
  [-1, -1], // NW
];

/** vi-key per (dx, dy) step; index is `(dy + 1) * 3 + (dx + 1)`. */
const VI_KEYS: Readonly<Record<string, string>> = {
  '-1,-1': 'y',
  '0,-1': 'k',
  '1,-1': 'u',
  '-1,0': 'h',
  '1,0': 'l',
  '-1,1': 'b',
  '0,1': 'j',
  '1,1': 'n',
};

/** True when a cell is on the map, remembered and not a solid block. */
function passable(level: LevelView, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= level.width || y >= level.height) return false;
  const k = level.kindAt(x, y);
  if (k === 'unexplored') return false;
  return !isSolid(k);
}

/** True when stepping from `(x, y)` by `(dx, dy)` doesn't squeeze between two diagonal walls. */
function diagonalOpen(level: LevelView, x: number, y: number, dx: number, dy: number): boolean {
  if (dx === 0 || dy === 0) return true;
  return passable(level, x + dx, y) && passable(level, x, y + dy);
}

/**
 * BFS from `from` to `to` through remembered passable cells. Returns the
 * sequence of cells to walk *excluding* the start (so `path[0]` is the first
 * step), or `null` when unreachable or the target itself is not passable.
 *
 * BFS is uniform-cost enough for our grid: every step (cardinal or diagonal)
 * counts as one turn in NetHack's 8-way movement. If a future ticket wants
 * proper Euclidean distances (√2 for diagonals) it needs Dijkstra/A*; that
 * is a look change, not a bug.
 */
export function findPath(
  level: LevelView,
  from: PathCell,
  to: PathCell,
): PathCell[] | null {
  if (from.x === to.x && from.y === to.y) return [];
  if (!passable(level, to.x, to.y)) return null;
  // `from` may be the hero cell, which is passable by definition — but the
  // hero's `top` glyph could be anything, so trust the terrain kind directly.
  if (!passable(level, from.x, from.y)) return null;

  const w = level.width;
  const h = level.height;
  const visited = new Uint8Array(w * h);
  const parents = new Int32Array(w * h).fill(-1);
  const startIdx = from.y * w + from.x;
  visited[startIdx] = 1;
  const queue: number[] = [startIdx];
  let head = 0;
  const targetIdx = to.y * w + to.x;

  while (head < queue.length) {
    const idx = queue[head++]!;
    if (idx === targetIdx) break;
    const x = idx % w;
    const y = (idx - x) / w;
    for (const [dx, dy] of STEPS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!passable(level, nx, ny)) continue;
      if (!diagonalOpen(level, x, y, dx, dy)) continue;
      const nIdx = ny * w + nx;
      if (visited[nIdx]) continue;
      visited[nIdx] = 1;
      parents[nIdx] = idx;
      queue.push(nIdx);
    }
  }

  if (!visited[targetIdx]) return null;
  const path: PathCell[] = [];
  let cur = targetIdx;
  while (cur !== startIdx) {
    const x = cur % w;
    const y = (cur - x) / w;
    path.push({ x, y });
    const p = parents[cur];
    if (p === undefined || p < 0) return null;
    cur = p;
  }
  path.reverse();
  return path;
}

/** vi-key for a single step `(dx, dy)` with `|dx| ≤ 1`, `|dy| ≤ 1`, not both 0. */
export function stepKey(dx: number, dy: number): string | null {
  return VI_KEYS[`${dx},${dy}`] ?? null;
}
