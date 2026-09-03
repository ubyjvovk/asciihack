/**
 * Real terminal `TermIO` over `process.stdin`/`process.stdout`
 * (docs/architecture.md §6.1): raw mode, alternate-screen handled by `Screen`,
 * SIGWINCH → `onResize`, raw stdin bytes decoded by `parseKeys`, and
 * everything restored on exit (also on uncaught errors and SIGTERM). This is
 * the only module that touches `process.stdin`/`process.stdout` directly.
 */
import type { KeyEvent } from './input.js';
import { flushEscape, parseKeys } from './input.js';
import type { TermIO } from './screen.js';

/** Latency before a lone ESC resolves to the `Escape` key (disambiguation window). */
const ESCAPE_TIMEOUT_MS = 25;

/** Real terminal transport: raw-mode stdin → `KeyEvent`s, stdout writes, resize. */
export class TtyTerm implements TermIO {
  private keyCb: ((e: KeyEvent) => void) | null = null;
  private resizeCbs: Array<() => void> = [];
  private pending: Uint8Array = new Uint8Array(0);
  private escapeTimer: NodeJS.Timeout | null = null;
  private restored = false;

  private readonly dataListener = (chunk: string | Buffer): void => this.handleData(chunk);
  private readonly resizeListener = (): void => {
    for (const cb of this.resizeCbs) cb();
  };

  constructor() {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', this.dataListener);
    process.stdout.on('resize', this.resizeListener);
    // Restore the terminal on the way out, however we get there.
    process.on('exit', () => this.restore());
    process.on('SIGTERM', () => {
      this.restore();
      process.exit(0);
    });
    process.on('uncaughtException', (err) => {
      this.restore();
      // Re-throw so the crash is visible after the terminal is usable again.
      setImmediate(() => {
        throw err;
      });
    });
  }

  write(s: string): void {
    process.stdout.write(s);
  }

  get columns(): number {
    return process.stdout.columns || 80;
  }

  get rows(): number {
    return process.stdout.rows || 24;
  }

  onResize(cb: () => void): void {
    this.resizeCbs.push(cb);
  }

  onKey(cb: (e: KeyEvent) => void): void {
    this.keyCb = cb;
  }

  /** Restore the terminal to a usable state (raw mode off, stdin paused) and
   *  drop the stdin/stdout listeners so nothing keeps the event loop alive
   *  after the bridge exits (T-0015: process must exit within 500 ms of the
   *  session `exit` event). */
  restore(): void {
    if (this.restored) return;
    this.restored = true;
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* already detached */
    }
    process.stdin.off('data', this.dataListener);
    process.stdout.off('resize', this.resizeListener);
    process.stdin.pause();
    try {
      process.stdin.unref();
    } catch {
      /* stdin is not a ref-countable handle in every environment */
    }
  }

  /** Feed raw stdin bytes into `parseKeys`, resolving a lone ESC after a timeout. */
  private handleData(chunk: string | Buffer): void {
    if (this.escapeTimer) {
      clearTimeout(this.escapeTimer);
      this.escapeTimer = null;
    }
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    const { events, rest } = parseKeys(buf, this.pending);
    this.pending = rest;
    for (const e of events) this.keyCb?.(e);
    if (this.pending.length > 0 && this.pending[0] === 0x1b) {
      this.escapeTimer = setTimeout(() => {
        this.escapeTimer = null;
        const { event, rest: tail } = flushEscape(this.pending);
        this.pending = tail;
        this.keyCb?.(event);
      }, ESCAPE_TIMEOUT_MS);
    }
  }
}
