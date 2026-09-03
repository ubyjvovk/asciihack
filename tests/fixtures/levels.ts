/**
 * Synthetic test levels built from ASCII legends (docs/architecture.md §9).
 * A `LevelView` built here is plain data, safe to feed to pure renderers in node.
 */
import type { CellKind, LevelView } from '../../src/model/types.js';

/** Legend: `#`/`|`/`-` wall, `.` floor, `+` closed door, `'` open door, `D` doorway, `~` water, `T` tree, `>`/`<` stairs, `%` corridor, space unexplored. */
function charToKind(ch: string): CellKind {
  switch (ch) {
    case '#':
    case '|':
    case '-':
      return 'wall';
    case '.':
      return 'floor';
    case '+':
      return 'door_closed';
    case "'":
      return 'door_open';
    case 'D':
      return 'doorway';
    case '~':
      return 'water';
    case 'T':
      return 'tree';
    case '>':
      return 'stairs_down';
    case '<':
      return 'stairs_up';
    case '%':
      return 'corridor';
    default:
      return 'unexplored'; // space and anything unknown = never-seen rock
  }
}

/**
 * Build a `LevelView` from rows of legend characters. Row 0 is the north
 * (smallest y) edge; each char is one cell. Out-of-range cells read `unexplored`.
 */
export function levelFromAscii(rows: string[]): LevelView {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  const grid: CellKind[][] = rows.map((r) => [...r].map(charToKind));
  return {
    width,
    height,
    kindAt(x, y) {
      if (x < 0 || y < 0 || x >= width || y >= height) return 'unexplored';
      return grid[y]?.[x] ?? 'unexplored';
    },
    cellAt(x, y) {
      if (x < 0 || y < 0 || x >= width || y >= height) return null;
      return { x, y, kind: grid[y]?.[x] ?? 'unexplored', terrain: null, top: null };
    },
  };
}

/**
 * A 12-wide × 8-tall room with a doorway on the east wall leading into a short
 * corridor that opens off the east edge. Used for the golden render and the
 * yaw-direction tests (the hero stands in the middle facing east).
 */
export const ROOM: LevelView = levelFromAscii([
  '###############',
  '#..........#...',
  '#..........#...',
  '#..........D...',
  '#..........#...',
  '#..........#...',
  '#..........#...',
  '###############',
]);

/** An L-shaped corridor (down, then right) with a small chamber at the top-left. */
export const L_SHAPED: LevelView = levelFromAscii([
  '#########',
  '#.......#',
  '#.......#',
  '#.......#',
  '#######.#',
  '      #.#',
  '      ###',
]);
