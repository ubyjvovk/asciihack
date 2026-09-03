/**
 * The terminal application shell (docs/architecture.md §6.3): owns the
 * compose-and-paint loop, message/status handling, overlay routing, mode
 * switching and global keys (Ctrl+L, Ctrl+P, F1–F5). Composition is
 * `paintMessageLine` + the mode's `paintViewport` + `paintStatus` + the
 * pending request's overlay; keys go to the overlay, then the message pager,
 * then the mode. Fps/ortho modes render the dungeon in 3D with a minimap;
 * the fps mode animates turns via `tick`/`requestFrame` (see docs/ui.md).
 */
import type { NethackSession } from '../engine/session.js';
import type { ScreenGrid } from '../model/types.js';
import type { KeyEvent } from '../term/input.js';
import type { Theme } from '../render/themes.js';
import { Screen, type TermIO } from '../term/screen.js';
import { blankGrid, putText, UI_BG, UI_FG } from './grid.js';
import { ClassicMode, type Mode } from './modes/classic.js';
import { FpsMode } from './modes/fps.js';
import { OrthoMode } from './modes/ortho.js';
import { createOverlay, keyToCode, TextOverlay, type Overlay } from './overlays.js';
import { paintStatus } from './status.js';

/** Minimum terminal width for the classic layout (80×21 map + message + 2 status). */
export const MIN_COLS = 80;
/** Minimum terminal height for the classic layout. */
export const MIN_ROWS = 24;
/** Frame pacing for turn animations: at most one repaint per 33 ms (≈30 fps). */
export const FRAME_MS = 33;

/** Theme cycle order for F5 (cyber → gloom → solarized → amber). */
export const THEMES: readonly Theme[] = ['cyber', 'gloom', 'solarized', 'amber'];

/** Options accepted by the `App` constructor. */
export interface AppOptions {
  session: NethackSession;
  term: TermIO;
  /** Requested mode name: `classic`, `fps` or `ortho` (default `fps`). */
  mode?: string;
  /** Initial render theme for the fps/ortho modes (default `cyber`). */
  theme?: Theme;
  /** Show the minimap in fps/ortho modes (default `true`). */
  minimap?: boolean;
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
  private readonly modes: Record<string, Mode>;
  private mode: Mode;
  private requestedMode: string;
  private theme: Theme;
  private showMinimap: boolean;
  private overlay: Overlay | null = null;
  private overlayReq: unknown = null;
  private readonly queue: KeyEvent[] = [];
  private pendingMsgs: string[] = [];
  private msgChunks: string[] = [''];
  private msgIdx = 0;
  private grid: ScreenGrid | null = null;
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;

  /** @param opts - session, injectable `TermIO`, requested mode, theme and minimap flag. */
  constructor(opts: AppOptions) {
    this.session = opts.session;
    this.term = opts.term;
    this.screen = new Screen(opts.term);
    this.now = () => Date.now();
    this.theme = opts.theme ?? 'cyber';
    this.showMinimap = opts.minimap ?? true;
    this.modes = {
      classic: new ClassicMode(opts.session),
      fps: new FpsMode(opts.session),
      ortho: new OrthoMode(opts.session),
    };
    this.requestedMode = opts.mode ?? 'fps';
    if (!this.modes[this.requestedMode]) this.requestedMode = 'fps';
    this.mode = this.modes[this.requestedMode]!;
    this.syncModeSettings();

    this.session.on('change', () => this.repaint());
    this.session.on('request', () => {
      this.flushQueue();
      this.autoDismissSaving();
      this.repaint();
    });
    this.session.on('message', (m: string) => this.pendingMsgs.push(m));
    this.session.on('exit', () => this.onExit());
    this.term.onKey((e) => this.handleKey(e));
  }

  /**
   * Belt-and-suspenders exit guard: if the bridge went away while a `display`
   * overlay is still pending, drop it and leave. With `autoDismissSaving`
   * live the pre-save `--More--` never survives to see `exit`, but this keeps
   * us from hanging on an unexpected trailing display.
   */
  private onExit(): void {
    const p = this.session.pending;
    if (p !== null && p.kind === 'display') {
      this.overlay = null;
      this.overlayReq = null;
    }
    this.leave();
  }

  /**
   * NetHack's `dosave()` prints "Saving..." then does a blocking
   * `display_nhwindow(WIN_MESSAGE, TRUE)` to make sure the player sees the
   * word before exit — but the game is already committed to exiting, so no
   * one needs to press a key. When the pending request is exactly that
   * (message-window display, previous message === "Saving..."), answer
   * `dismiss` right away. Death messages, DYWYPI and every other blocking
   * message display keep pausing for a key.
   */
  private autoDismissSaving(): void {
    const p = this.session.pending;
    if (p === null || p.kind !== 'display') return;
    if (p.windowType !== this.session.hello?.nhw['NHW_MESSAGE']) return;
    if (this.pendingMsgs[this.pendingMsgs.length - 1] !== 'Saving...') return;
    this.session.answer({ kind: 'dismiss' });
  }

  /** The last composed grid (what the screen painted last), for tests. */
  get lastGrid(): ScreenGrid | null {
    return this.grid;
  }

  /** The underlying screen writer (for enter/leave in the CLI). */
  get screenWriter(): Screen {
    return this.screen;
  }

  /** The active mode object (for tests). */
  get activeMode(): Mode {
    return this.mode;
  }

  /** Enter the alternate screen and paint the first frame. */
  enter(): void {
    this.screen.enter();
    this.repaint();
  }

  /** Leave the alternate screen and restore the terminal. */
  leave(): void {
    if (this.frameTimer !== null) {
      clearTimeout(this.frameTimer);
      this.frameTimer = null;
    }
    this.screen.leave();
  }

  /** The requested mode name (`classic` | `fps` | `ortho`). */
  get currentMode(): string {
    return this.requestedMode;
  }

  /** Switch the active mode (`classic` | `fps` | `ortho`). */
  switchMode(name: string): void {
    const next = this.modes[name];
    if (!next || next === this.mode) {
      this.requestedMode = next ? name : this.requestedMode;
      this.repaint();
      return;
    }
    this.mode.onLeave();
    this.requestedMode = name;
    this.mode = next;
    this.syncModeSettings();
    this.mode.onEnter();
    this.repaint();
    this.maybeScheduleFrame();
  }

  /**
   * Ask for another frame (used by modes animating a turn). While the active
   * mode's `tick` keeps returning true, frames are repainted at ≤ 30 fps via
   * `setTimeout` — never a busy loop. Safe to call when no animation runs.
   */
  requestFrame(): void {
    if (this.frameTimer !== null) return;
    this.frameTimer = setTimeout(() => {
      this.frameTimer = null;
      this.repaint();
      this.maybeScheduleFrame();
    }, FRAME_MS);
    if (this.frameTimer && typeof (this.frameTimer as unknown as { unref?: () => void }).unref === 'function') {
      (this.frameTimer as unknown as { unref: () => void }).unref();
    }
  }

  /** Push the App-level theme/minimap settings into the fps/ortho modes. */
  private syncModeSettings(): void {
    for (const m of Object.values(this.modes)) {
      if (m instanceof FpsMode || m instanceof OrthoMode) {
        m.theme = this.theme;
        m.showMinimap = this.showMinimap;
      }
    }
  }

  /** Schedule another frame while the active mode's `tick` asks for one. */
  private maybeScheduleFrame(): void {
    const tick = (this.mode as { tick?: (nowMs: number) => boolean }).tick;
    if (typeof tick === 'function' && tick.call(this.mode, this.now())) {
      this.requestFrame();
    }
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
    if (e.key === 'F4') {
      this.showMinimap = !this.showMinimap;
      this.syncModeSettings();
      this.repaint();
      return;
    }
    if (e.key === 'F5') {
      this.theme = THEMES[(THEMES.indexOf(this.theme) + 1) % THEMES.length]!;
      this.syncModeSettings();
      this.repaint();
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
    this.maybeScheduleFrame();
  }
}
