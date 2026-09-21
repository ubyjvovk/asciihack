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

/**
 * Read-only view of a `NethackSession` the traveler needs. Structural typing
 * lets `NethackSession` itself pass unchanged; tests use a plain mock with the
 * same shape so `createTraveler` stays testable in node.
 */
export interface TravelSessionView {
  readonly pending: { readonly kind: string } | null;
  readonly hero: { readonly x: number; readonly y: number } | null;
  readonly messages: { readonly length: number };
}

/** Why a walk was aborted. `null` means either running or never started. */
export type TravelAbortReason =
  | 'not-key-or-pos'
  | 'message-changed'
  | 'no-hero'
  | 'blocked'
  | 'no-step-key'
  | 'user-key'
  | 'new-path'
  | 'timeout'
  | null;

/** Snapshot of the traveler's state — exposed on `window.__asciihack.travel`
 *  so the PM can diagnose a stuck walk from the page console (T-0061 rework). */
export interface TravelerState {
  pathLength: number;
  expectedNext: PathCell | null;
  msgSnapshot: number;
  pending: string | null;
  lastAbortReason: TravelAbortReason;
}

/** Public interface of the traveler state machine (docs/gpu-pick.md). */
export interface Traveler {
  /** Begin walking a fresh path; replaces any in-flight walk. */
  start(path: readonly PathCell[]): void;
  /** Abandon the current walk (called on interrupt). No-op when idle. */
  abort(reason?: TravelAbortReason): void;
  /** Send at most one vi-key toward the next path cell, subject to the
   *  interrupt rules. Called once per rAF. */
  tick(): void;
  /** Snapshot of the traveler's state (for the page-console debug handle). */
  state(): TravelerState;
}

/** Wiring for `createTraveler`. `now` and `timeoutMs` are injectable so tests
 *  drive the watchdog with a fake clock; `sendStep` sends one vi-key. */
export interface TravelDeps {
  session: TravelSessionView;
  sendStep: (viKey: string) => void;
  now?: () => number;
  timeoutMs?: number;
}

/** Default watchdog delay: the last step must land within 1.5 s (T-0061
 *  rework attempt 3). Past that the walk aborts with reason `'timeout'` — a
 *  traveler that hangs forever with no `lastAbortReason` is worse than one
 *  that gives up, because the failure is invisible in `state()`. */
export const DEFAULT_TRAVEL_TIMEOUT_MS = 1500;

/**
 * Build the click-to-move state machine (T-0061, docs/gpu-pick.md).
 *
 * The walker owns four pieces of state: the remaining path, the cell the
 * hero is expected to occupy after the last step we sent, the message count
 * at that moment, and the wall-clock time of the send. On each `tick`, the
 * walker first confirms whether the previous step landed (or has run out of
 * time — the watchdog) and then, if the game is asking for a key and none of
 * the interrupt conditions fires, sends the next vi-key.
 *
 * Interrupts (any one aborts the walk):
 *   1. **`'timeout'`** — the previous step did not land within `timeoutMs`.
 *      Covers the single-step case where `path` is already empty and the
 *      per-tick `'blocked'` check no longer fires.
 *   2. **`'blocked'`** — a new key/pos request arrived but the hero has not
 *      reached `expectedNext`; something turned us aside on the previous step.
 *   3. **`'message-changed'`** — `session.messages.length` grew since the
 *      previous step; NetHack wants the player to notice something.
 *   4. **`'not-key-or-pos'`** — pending is a menu / yn / getlin / display /
 *      extcmd / file / message-menu; driving those with vi-keys is user hostile.
 *   5. **`'user-key'`** / **`'new-path'`** — external abort by the click
 *      listener (user pressed a key, or clicked a new destination).
 */
export function createTraveler(deps: TravelDeps): Traveler {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TRAVEL_TIMEOUT_MS;
  const now = deps.now ?? ((): number => Date.now());
  let path: PathCell[] = [];
  let expectedNext: PathCell | null = null;
  let msgSnapshot = 0;
  let lastSendTime = 0;
  let lastAbortReason: TravelAbortReason = null;

  const abort = (reason: TravelAbortReason = null): void => {
    if (path.length > 0 || expectedNext !== null) lastAbortReason = reason;
    path = [];
    expectedNext = null;
  };

  const start = (fresh: readonly PathCell[]): void => {
    if (path.length > 0 || expectedNext !== null) lastAbortReason = 'new-path';
    path = [...fresh];
    expectedNext = null;
    msgSnapshot = deps.session.messages.length;
  };

  const tick = (): void => {
    if (path.length === 0 && expectedNext === null) return;

    const hero = deps.session.hero;

    // Confirmation phase: did the previous step land, or has time run out?
    if (expectedNext !== null) {
      if (hero !== null && hero.x === expectedNext.x && hero.y === expectedNext.y) {
        expectedNext = null; // step landed — proceed to the next
      } else if (now() - lastSendTime > timeoutMs) {
        abort('timeout');
        return;
      }
    }

    if (path.length === 0) return;

    const pending = deps.session.pending;
    if (pending === null) return; // bridge is still processing
    if (pending.kind !== 'key' && pending.kind !== 'pos') {
      abort('not-key-or-pos');
      return;
    }
    if (deps.session.messages.length > msgSnapshot) {
      abort('message-changed');
      return;
    }
    if (hero === null) {
      abort('no-hero');
      return;
    }
    // If NetHack is ready for input but the hero has not reached
    // `expectedNext`, the previous step was rejected (a monster, a door):
    // that's `'blocked'` — the fast-fail path when `pending` moves faster
    // than the timeout.
    if (expectedNext !== null) {
      abort('blocked');
      return;
    }

    const next = path[0]!;
    const dx = next.x - hero.x;
    const dy = next.y - hero.y;
    const key = stepKey(dx, dy);
    if (key === null) {
      abort('no-step-key');
      return;
    }

    // Advance state *before* `sendStep`: the callback runs listeners
    // synchronously (`repaint`), which can indirectly re-enter `tick`.
    path.shift();
    expectedNext = next;
    msgSnapshot = deps.session.messages.length;
    lastSendTime = now();
    deps.sendStep(key);
  };

  const state = (): TravelerState => ({
    pathLength: path.length,
    expectedNext: expectedNext === null ? null : { x: expectedNext.x, y: expectedNext.y },
    msgSnapshot,
    pending: deps.session.pending === null ? null : deps.session.pending.kind,
    lastAbortReason,
  });

  return { start, abort, tick, state };
}
