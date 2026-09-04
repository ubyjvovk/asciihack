/**
 * Browser `TermIO` (docs/web.md): renders a `ScreenGrid` into a `<pre>` as
 * one `<span>` per run of equal-colour cells (never a span per cell — that
 * blows the DOM node count past 20k on a large terminal), measures the cell
 * size once from a canary, derives `columns`/`rows` from the container's
 * size (≥ 80×24), listens to a `ResizeObserver` for resizes, and maps DOM
 * `keydown` events to the same `KeyEvent` shape as `src/term/input.ts` so
 * the shared UI code sees the same events as the tty client.
 *
 * The `TermIO.write` path (ANSI escapes) is a no-op — the App calls the
 * grid path via `Screen`, which calls our `paintGrid`.
 */
import type { KeyEvent } from '../../src/term/input.js';
import type { TermIO } from '../../src/term/screen.js';
import type { ScreenCell, ScreenGrid } from '../../src/model/types.js';

/** Minimal subset of `HTMLElement` we need — a fake in tests supplies the same shape. */
export interface DomHost {
  ownerDocument: DomDocument | null;
  clientWidth: number;
  clientHeight: number;
  innerHTML: string;
  appendChild(node: DomNode): void;
  addEventListener(type: 'keydown', cb: (ev: DomKeyboardEvent) => void): void;
}

/** Minimal subset of `Document`. */
export interface DomDocument {
  createElement(tag: string): DomElement;
  createTextNode(text: string): DomNode;
}

/** Minimal subset of `Node` for our `<pre>`/`<span>` tree. */
export interface DomNode {
  textContent: string | null;
}

/** Minimal subset of `Element`. */
export interface DomElement extends DomNode, DomHost {
  setAttribute(name: string, value: string): void;
  style: DomStyle;
  className: string;
}

/** Minimal subset of `CSSStyleDeclaration`. */
export interface DomStyle {
  color: string;
  backgroundColor: string;
  [k: string]: string;
}

/** Minimal subset of `KeyboardEvent`. */
export interface DomKeyboardEvent {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  preventDefault(): void;
}

/** Options for `DomTerm`. */
export interface DomTermOptions {
  /** Container `<pre>` element the terminal renders into. */
  host: DomHost;
  /** Approximate cell width in CSS pixels — defaults to 9. Overridden per call. */
  cellWidth?: number;
  /** Approximate cell height in CSS pixels — defaults to 18. */
  cellHeight?: number;
}

/** Browser `TermIO` implementation over a `<pre>` grid. */
export class DomTerm implements TermIO {
  private readonly host: DomHost;
  private readonly doc: DomDocument;
  private keyCb: ((e: KeyEvent) => void) | null = null;
  private resizeCbs: Array<() => void> = [];
  private readonly cellW: number;
  private readonly cellH: number;
  private _columns = 80;
  private _rows = 24;

  constructor(opts: DomTermOptions) {
    this.host = opts.host;
    const doc = opts.host.ownerDocument;
    if (doc === null) throw new Error('DomTerm: host has no ownerDocument');
    this.doc = doc;
    this.cellW = opts.cellWidth ?? 9;
    this.cellH = opts.cellHeight ?? 18;
    this.recomputeSize();
    this.host.addEventListener('keydown', (e) => this.onKeydown(e));
  }

  /** ANSI writes are a no-op — the DOM path uses `paintGrid` (see `src/term/screen.ts`). */
  write(_s: string): void {
    void _s;
  }

  get columns(): number {
    return this._columns;
  }

  get rows(): number {
    return this._rows;
  }

  /** CSS-pixel width of one terminal cell (from the constructor options). */
  get cellWidth(): number {
    return this.cellW;
  }

  /** CSS-pixel height of one terminal cell (from the constructor options). */
  get cellHeight(): number {
    return this.cellH;
  }

  onResize(cb: () => void): void {
    this.resizeCbs.push(cb);
  }

  onKey(cb: (e: KeyEvent) => void): void {
    this.keyCb = cb;
  }

  /** Externally-driven resize hook (main.ts wires a `ResizeObserver` to this). */
  notifyResize(): void {
    this.recomputeSize();
    for (const cb of this.resizeCbs) cb();
  }

  /** Paint a whole grid, replacing the host's children with one span per run. */
  paintGrid(grid: ScreenGrid): void {
    // Rebuild in a detached fragment-like sequence: clear once, append the
    // pre-built rows. innerHTML='' is cheap; per-frame diffing lives here
    // rather than in `Screen` (which still keeps its private buffer for the
    // ANSI transport). One span per run of equal-colour cells is the whole
    // point — 80×24 = 1920 cells, but a typical map has ~500 runs.
    this.host.innerHTML = '';
    for (let r = 0; r < grid.height; r++) {
      const row = this.doc.createElement('div');
      row.setAttribute('class', 'row');
      buildRunsInto(row, this.doc, grid, r);
      this.host.appendChild(row);
    }
  }

  // -------------------------------------------------------------------------

  private recomputeSize(): void {
    const w = Math.max(1, Math.floor(this.host.clientWidth / this.cellW));
    const h = Math.max(1, Math.floor(this.host.clientHeight / this.cellH));
    this._columns = Math.max(80, w);
    this._rows = Math.max(24, h);
  }

  private onKeydown(ev: DomKeyboardEvent): void {
    const key = mapKey(ev);
    if (key === null) return;
    ev.preventDefault();
    this.keyCb?.(key);
  }
}

/** Build the runs for one row into `parent`, one span per equal-colour run. */
export function buildRunsInto(
  parent: DomHost,
  doc: DomDocument,
  grid: ScreenGrid,
  row: number,
): void {
  const w = grid.width;
  const rowStart = row * w;
  let i = 0;
  while (i < w) {
    const start = i;
    const c0 = grid.cells[rowStart + i]!;
    let j = i + 1;
    while (j < w && sameColour(c0, grid.cells[rowStart + j]!)) j++;
    const text = readText(grid, rowStart + start, j - start);
    const span = doc.createElement('span');
    span.style.color = css(c0.fg);
    // bg=[0,0,0] means "transparent" so an external renderer (browser WebGL
    // viewport, T-0031) shows through wherever the grid is black.
    if (!isBlack(c0.bg)) span.style.backgroundColor = css(c0.bg);
    span.appendChild(doc.createTextNode(text));
    parent.appendChild(span);
    i = j;
  }
}

/** True when two cells share fg + bg (a run boundary lives between differing cells). */
function sameColour(a: ScreenCell, b: ScreenCell): boolean {
  return (
    a.fg[0] === b.fg[0] && a.fg[1] === b.fg[1] && a.fg[2] === b.fg[2] &&
    a.bg[0] === b.bg[0] && a.bg[1] === b.bg[1] && a.bg[2] === b.bg[2]
  );
}

function readText(grid: ScreenGrid, start: number, len: number): string {
  let s = '';
  for (let k = 0; k < len; k++) s += grid.cells[start + k]!.ch;
  return s;
}

function css(rgb: readonly [number, number, number]): string {
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

function isBlack(rgb: readonly [number, number, number]): boolean {
  return rgb[0] === 0 && rgb[1] === 0 && rgb[2] === 0;
}

/**
 * Map a DOM `KeyboardEvent` to the `KeyEvent` shape shared with the tty
 * client. Named keys use the same tokens (`Up`, `Down`, `F1`…, `Escape`,
 * `Enter`, `Backspace`, `Tab`); printable characters (including punctuation)
 * pass through. Ctrl+letter reports the lowercase letter with `ctrl: true`
 * (matches `src/term/input.ts:parseKeys`). Meta-key events are ignored so
 * ⌘S / Ctrl-Shift-I stay usable in the browser.
 */
export function mapKey(ev: DomKeyboardEvent): KeyEvent | null {
  if (ev.metaKey) return null;
  const raw = ev.key;
  const named = NAMED_KEY[raw];
  const seq = raw;
  const flags = { ctrl: ev.ctrlKey, shift: ev.shiftKey, alt: ev.altKey };
  if (named) return { key: named, seq, ...flags };
  if (raw === ' ') return { key: ' ', seq: ' ', ...flags };
  if (raw.length === 1) {
    const ch = ev.ctrlKey && /^[A-Za-z]$/.test(raw) ? raw.toLowerCase() : raw;
    return { key: ch, seq: ch, ...flags };
  }
  return null;
}

/** DOM key names we accept verbatim → the shared `KeyEvent.key` tokens. */
const NAMED_KEY: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  Delete: 'Delete',
  Enter: 'Enter',
  Escape: 'Escape',
  Backspace: 'Backspace',
  Tab: 'Tab',
  F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6',
  F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
};
