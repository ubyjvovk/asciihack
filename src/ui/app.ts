/**
 * The terminal application shell (docs/architecture.md §6.3): owns the
 * compose-and-paint loop, message/status handling, overlay routing, mode
 * switching and global keys (Ctrl+L, Ctrl+P, F1–F3). Composition is
 * `paintMessageLine` + the mode's `paintViewport` + `paintStatus` + the
 * pending request's overlay; keys go to the overlay, then the message pager,
 * then the mode. The fps/ortho modes are not implemented yet (T-0007/T-0008):
 * switching to them shows a "not yet" banner and stays in classic.
 */
import type { NethackSession } from '../engine/session.js';
import type { ScreenGrid } from '../model/types.js';
import type { KeyEvent } from '../term/input.js';
import { Screen, type TermIO } from '../term/screen.js';
import { blankGrid, putText, UI_BG, UI_FG } from './grid.js';
import { ClassicMode, type Mode } from './modes/classic.js';
import { createOverlay, keyToCode, TextOverlay, type Overlay } from './overlays.js';
import { paintStatus } from './status.js';

/** Minimum terminal width for the classic layout (80×21 map + message + 2 status). */
export const MIN_COLS = 80;
/** Minimum terminal height for the classic layout. */
export const MIN_ROWS = 24;

/** Options accepted by the `App` constructor. */
export interface AppOptions {
  session: NethackSession;
  term: TermIO;
  /** Requested mode name: `classic`, `fps` or `ortho` (default `fps`). */
  mode?: string;
}

/**
 * Terminal app: wires the session's events and the term's key/resize events
 * to a compose-and-paint loop, and exposes the composed `ScreenGrid` (and the
 * `Screen`) so tests can inspect what was painted.
 */
export class App {
  private readonly session: NethackSession;
  private readonly term: TermIO;
  private readonly screen: Screen;
  private readonly mode: Mode;
  private requestedMode: string;
  private banner: string | null;
  private overlay: Overlay | null = null;
  private overlayReq: unknown = null;
  private readonly queue: KeyEvent[] = [];
  private pendingMsgs: string[] = [];
  private msgChunks: string[] = [''];
  private msgIdx = 0;
  private grid: ScreenGrid | null = null;

  /** @param opts - session, injectable `TermIO`, and the requested mode name. */
  constructor(opts: AppOptions) {
    this.session = opts.session;
    this.term = opts.term;
    this.screen = new Screen(opts.term);
    this.requestedMode = opts.mode ?? 'fps';
    this.mode = new ClassicMode(opts.session);
    this.banner =
      this.requestedMode === 'classic'
        ? null
        : `${this.requestedMode} mode not yet implemented — staying in classic`;

    this.session.on('change', () => this.repaint());
    this.session.on('request', () => {
      this.flushQueue();
      this.repaint();
    });
    this.session.on('message', (m: string) => this.pendingMsgs.push(m));
    this.term.onKey((e) => this.handleKey(e));
  }

  /** The last composed grid (what the screen painted last), for tests. */
  get lastGrid(): ScreenGrid | null {
    return this.grid;
  }

  /** The underlying screen writer (for enter/leave in the CLI). */
  get screenWriter(): Screen {
    return this.screen;
  }

  /** Enter the alternate screen and paint the first frame. */
  enter(): void {
    this.screen.enter();
    this.repaint();
  }

  /** Leave the alternate screen and restore the terminal. */
  leave(): void {
    this.screen.leave();
  }

  /** The requested mode name (`classic` | `fps` | `ortho`). */
  get currentMode(): string {
    return this.requestedMode;
  }

  /** Switch the requested mode; fps/ortho show a banner and stay in classic. */
  switchMode(name: string): void {
    this.requestedMode = name;
    this.banner =
      name === 'classic' ? null : `${name} mode not yet implemented — staying in classic`;
    this.repaint();
  }

  /** Compose and paint one frame. */
  private repaint(): void {
    const w = this.term.columns;
    const h = this.term.rows;
    if (w < MIN_COLS || h < MIN_ROWS) {
      const grid = blankGrid(Math.max(1, w), Math.max(1, h));
      const msg = 'terminal too small (need 80x24)';
      putText(grid, Math.max(0, Math.floor((w - msg.length) / 2)), Math.floor(h / 2), msg.slice(0, w), UI_FG);
      this.grid = grid;
      this.screen.paint(grid);
      return;
    }
    this.syncOverlay();
    if (!this.msgActive) this.recomputeMsg();

    const grid = blankGrid(w, h);
    this.paintMessageLine(grid, w);
    this.mode.paintViewport(grid, { x: 0, y: 1, width: w, height: h - 3 });
    paintStatus(grid, this.session, 0, h - 2);
    if (this.banner) this.paintBanner(grid, w);
    this.overlay?.paint(grid);
    this.grid = grid;
    this.screen.paint(grid);
  }

  /** Whether the message line is currently paging an overflowing batch. */
  private get msgActive(): boolean {
    return this.msgChunks.length > 1;
  }

  /** Whether there are more message chunks to reveal after the current one. */
  private get msgMore(): boolean {
    return this.msgIdx < this.msgChunks.length - 1;
  }

  /** Split the pending messages into one-line chunks (reserving `--More--`). */
  private recomputeMsg(): void {
    const full = this.pendingMsgs.join('  ');
    const width = Math.max(1, this.term.columns);
    if (full.length <= width) {
      this.msgChunks = [full];
      this.msgIdx = 0;
      return;
    }
    const chunkW = Math.max(1, width - 8); // leave room for "--More--"
    const chunks: string[] = [];
    for (let i = 0; i < full.length; i += chunkW) chunks.push(full.slice(i, i + chunkW));
    this.msgChunks = chunks;
    this.msgIdx = 0;
  }

  /** Paint row 0: the latest message (or its first chunk + `--More--`). */
  private paintMessageLine(grid: ScreenGrid, width: number): void {
    const text = this.msgChunks[this.msgIdx] ?? '';
    const line = this.msgMore ? `${text}--More--`.slice(0, width) : text.slice(0, width);
    putText(grid, 0, 0, line, UI_FG, UI_BG);
  }

  /** Paint the "not yet implemented" banner (fps/ortho) at the top of the viewport. */
  private paintBanner(grid: ScreenGrid, width: number): void {
    const text = this.banner ?? '';
    putText(grid, Math.max(0, Math.floor((width - text.length) / 2)), 1, text.slice(0, width), [0, 0, 0], [255, 255, 0]);
  }

  /** Create (or keep) the overlay for the current pending request. */
  private syncOverlay(): void {
    const p = this.session.pending;
    if (p === null) {
      this.overlay = null;
      this.overlayReq = null;
      return;
    }
    if (this.overlayReq === p) return; // same request: keep overlay state
    this.overlayReq = p;
    this.overlay = createOverlay(p, this.session);
  }

  /** Answer a pending key/pos request with the oldest queued key, if any. */
  private flushQueue(): void {
    const p = this.session.pending;
    if (p === null || (p.kind !== 'key' && p.kind !== 'pos')) return;
    const e = this.queue.shift();
    if (!e) return;
    const code = keyToCode(e);
    this.pendingMsgs = [];
    this.session.answer(p.kind === 'pos' ? { kind: 'pos', key: code } : { kind: 'key', key: code });
  }

  /** Route a key: global keys → overlay → message pager → the mode. */
  handleKey(e: KeyEvent): void {
    if (e.key === 'F1' || e.key === 'F2' || e.key === 'F3') {
      this.switchMode(e.key === 'F1' ? 'classic' : e.key === 'F2' ? 'fps' : 'ortho');
      return;
    }
    if (e.ctrl && e.key === 'l') {
      this.screen.invalidate();
      this.repaint();
      return;
    }
    if (e.ctrl && e.key === 'p' && this.overlay === null) {
      const lines = this.session.messages.slice(-20);
      this.overlay = new TextOverlay({ title: 'Message history', lines, onDismiss: () => {} });
      this.repaint();
      return;
    }
    if (this.overlay !== null) {
      if (!this.overlay.handleKey(e)) this.overlay = null;
      this.repaint();
      return;
    }
    if (this.msgMore) {
      this.msgIdx++;
      this.repaint();
      return;
    }
    this.mode.handleKey(e, (k) => this.queue.push(k));
    this.flushQueue();
    this.repaint();
  }
}
