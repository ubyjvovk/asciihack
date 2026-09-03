/**
 * Screen writer (docs/architecture.md §6.1): `diff` produces the minimal ANSI
 * needed to move from one `ScreenGrid` to the next, and `Screen` wraps it over
 * an injectable `TermIO` (alt-screen enter/leave, hide cursor). Pure core is
 * `diff`; `Screen` is a thin, testable shell.
 */
import type { ScreenGrid } from '../model/types.js';
import type { KeyEvent } from './input.js';

/** Injectable terminal transport the `Screen` paints through (fakeable in tests). */
export interface TermIO {
  write(s: string): void;
  columns: number;
  rows: number;
  onResize(cb: () => void): void;
  onKey(cb: (e: KeyEvent) => void): void;
}

const CSI = '\x1b[';

function sameCell(a: ScreenGrid, ai: number, b: ScreenGrid, bi: number): boolean {
  const ca = a.cells[ai]!;
  const cb = b.cells[bi]!;
  return (
    ca.ch === cb.ch &&
    ca.fg[0] === cb.fg[0] &&
    ca.fg[1] === cb.fg[1] &&
    ca.fg[2] === cb.fg[2] &&
    ca.bg[0] === cb.bg[0] &&
    ca.bg[1] === cb.bg[1] &&
    ca.bg[2] === cb.bg[2]
  );
}

function sameColor(a: readonly [number, number, number], b: readonly [number, number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/**
 * Compute the ANSI to transform `prev` into `next`. A `null` prev (or a size
 * change) forces a full repaint after `CSI 2 J`. Unchanged cells are skipped,
 * cursor moves and 24-bit SGRs are emitted only when needed, and the output
 * ends with `CSI 0 m` (empty output when nothing changed).
 */
export function diff(prev: ScreenGrid | null, next: ScreenGrid): string {
  const w = next.width;
  const h = next.height;
  const full = prev === null || prev.width !== w || prev.height !== h;
  let out = full ? `${CSI}2J` : '';
  // Virtual cursor (row,col) 1-indexed; 0,0 = unknown → forces an initial move.
  let vrow = 0;
  let vcol = 0;
  let curFg: readonly [number, number, number] | null = null;
  let curBg: readonly [number, number, number] | null = null;

  // Advance the virtual cursor past a just-written char (autowrap at col width).
  const advance = (): void => {
    if (vcol >= w) {
      vrow++;
      vcol = 1;
    } else {
      vcol++;
    }
  };

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      const cell = next.cells[i]!;
      if (!full && prev !== null && sameCell(prev, i, next, i)) {
        continue; // unchanged: skip without moving the terminal cursor
      }
      const tr = r + 1;
      const tc = c + 1;
      if (vrow !== tr || vcol !== tc) {
        out += `${CSI}${tr};${tc}H`;
        vrow = tr;
        vcol = tc;
      }
      if (curFg === null || !sameColor(curFg, cell.fg)) {
        out += `${CSI}38;2;${cell.fg[0]};${cell.fg[1]};${cell.fg[2]}m`;
        curFg = cell.fg;
      }
      if (curBg === null || !sameColor(curBg, cell.bg)) {
        out += `${CSI}48;2;${cell.bg[0]};${cell.bg[1]};${cell.bg[2]}m`;
        curBg = cell.bg;
      }
      out += cell.ch;
      advance();
    }
  }
  if (out !== '') out += `${CSI}0m`;
  return out;
}

/** Mutable shape of the private copy cells (fg/bg are writable arrays here). */
interface CopyCell {
  ch: string;
  fg: [number, number, number];
  bg: [number, number, number];
}

/**
 * Terminal screen wrapper: keeps its own private copy of the last painted
 * cells, paints diffs onto the `TermIO`, redraws everything after
 * `invalidate()` or a resize, and switches the alternate screen on
 * enter/leave. The private copy (rather than the caller's grid object) means
 * a grid mutated in place by `quantizeInto` still diffs correctly next frame.
 */
export class Screen {
  private readonly term: TermIO;
  private prev: ScreenGrid | null = null;

  /** Wrap `term`; registers its resize callback to force a full repaint. */
  constructor(term: TermIO) {
    this.term = term;
    term.onResize(() => this.invalidate());
  }

  /** Paint `grid`, writing only the ANSI diff from the previous paint. */
  paint(grid: ScreenGrid): void {
    const out = diff(this.prev, grid);
    if (out !== '') this.term.write(out);
    this.remember(grid);
  }

  /** Copy `grid` into the private buffer, reusing cell storage across frames. */
  private remember(grid: ScreenGrid): void {
    if (this.prev === null) {
      const n = grid.width * grid.height;
      const cells: CopyCell[] = new Array(n);
      for (let i = 0; i < n; i++) cells[i] = { ch: ' ', fg: [0, 0, 0], bg: [0, 0, 0] };
      this.prev = { width: grid.width, height: grid.height, cells };
    }
    const copy = this.prev as { width: number; height: number; cells: CopyCell[] };
    // The painted grid may grow/shrink between frames (e.g. a resize with no
    // `invalidate()`); only reallocate the copy when its cell count changes,
    // so the steady state stays allocation-free.
    if (copy.cells.length !== grid.width * grid.height) {
      const n = grid.width * grid.height;
      const cells: CopyCell[] = new Array(n);
      for (let i = 0; i < n; i++) cells[i] = { ch: ' ', fg: [0, 0, 0], bg: [0, 0, 0] };
      copy.cells = cells;
    }
    copy.width = grid.width;
    copy.height = grid.height;
    for (let i = 0; i < grid.cells.length; i++) {
      const src = grid.cells[i]!;
      const dst = copy.cells[i]!;
      dst.ch = src.ch;
      dst.fg[0] = src.fg[0];
      dst.fg[1] = src.fg[1];
      dst.fg[2] = src.fg[2];
      dst.bg[0] = src.bg[0];
      dst.bg[1] = src.bg[1];
      dst.bg[2] = src.bg[2];
    }
  }

  /** Force the next `paint` to redraw the whole grid. */
  invalidate(): void {
    this.prev = null;
  }

  /** Enter the alternate screen and hide the cursor. */
  enter(): void {
    this.term.write(`${CSI}?1049h${CSI}?25l`);
    this.prev = null;
  }

  /** Leave the alternate screen, reset SGR and show the cursor. */
  leave(): void {
    this.term.write(`${CSI}?1049l${CSI}0m${CSI}?25h`);
  }
}
