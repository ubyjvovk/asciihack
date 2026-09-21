/**
 * Synthetic test levels built from ASCII legends (docs/architecture.md §9).
 * A `LevelView` built here is plain data, safe to feed to pure renderers in node.
 */
import type { CellKind, LevelView } from '../../src/model/types.js';

/** Legend: `#`/`|`/`-` wall, `.` floor, `+` closed door, `'` open door, `D` doorway, `~` water, `L` lava, `I` ice, `{` fountain, `T` tree, `>`/`<` stairs, `%` corridor, space unexplored. */
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
    case 'L':
      return 'lava';
    case 'I':
      return 'ice';
    case '{':
      return 'fountain';
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

/** Extra options for `levelFromAscii`. */
export interface LevelFromAsciiOptions {
  /** Return `MapCell.lit` for a cell; `undefined` leaves it unset. */
  lit?: (kind: CellKind, x: number, y: number) => boolean | undefined;
}

/**
 * Build a `LevelView` from rows of legend characters. Row 0 is the north
 * (smallest y) edge; each char is one cell. Out-of-range cells read `unexplored`.
 * When `opts.lit(kind, x, y)` is supplied, its result is written to
 * `MapCell.lit`; absent, `lit` stays `undefined`.
 */
export function levelFromAscii(rows: string[], opts?: LevelFromAsciiOptions): LevelView {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  const grid: CellKind[][] = rows.map((r) => [...r].map(charToKind));
  const litFn = opts?.lit;
  return {
    width,
    height,
    kindAt(x, y) {
      if (x < 0 || y < 0 || x >= width || y >= height) return 'unexplored';
      return grid[y]?.[x] ?? 'unexplored';
    },
    cellAt(x, y) {
      if (x < 0 || y < 0 || x >= width || y >= height) return null;
      const kind = grid[y]?.[x] ?? 'unexplored';
      const lit = litFn === undefined ? undefined : litFn(kind, x, y);
      return { x, y, kind, terrain: null, top: null, lit };
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
