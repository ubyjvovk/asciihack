import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { App } from '../src/ui/app.js';
import { clrToRgb } from '../src/model/types.js';
import type { ScreenGrid } from '../src/model/types.js';
import type { PendingRequest } from '../src/engine/session.js';
import { NethackSession } from '../src/engine/session.js';
import type { BridgeMsg, RetMsg } from '../src/engine/protocol.js';
import type { KeyEvent } from '../src/term/input.js';
import type { TermIO } from '../src/term/screen.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Test doubles

class FakeTerm implements TermIO {
  columns: number;
  rows: number;
  writes: string[] = [];
  private keyCb: ((e: KeyEvent) => void) | null = null;
  private resizeCb: (() => void) | null = null;
  constructor(cols = 80, rows = 24) {
    this.columns = cols;
    this.rows = rows;
  }
  write(s: string): void {
    this.writes.push(s);
  }
  onKey(cb: (e: KeyEvent) => void): void {
    this.keyCb = cb;
  }
  onResize(cb: () => void): void {
    this.resizeCb = cb;
  }
  key(e: KeyEvent): void {
    this.keyCb?.(e);
  }
  resize(c: number, r: number): void {
    this.columns = c;
    this.rows = r;
    this.resizeCb?.();
  }
}

function ev(key: string, opts: { ctrl?: boolean } = {}): KeyEvent {
  return { key, ctrl: opts.ctrl ?? false, shift: false, alt: false, seq: key };
}

function rowText(g: ScreenGrid, y: number): string {
  let s = '';
  for (let x = 0; x < g.width; x++) s += g.cells[y * g.width + x]!.ch;
  return s;
}

interface RecordedLine {
  reply?: RetMsg;
  t?: string;
  [k: string]: unknown;
}

function loadFixture(name: string): RecordedLine[] {
  const path = resolve(HERE, 'fixtures', 'bridge', name);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as RecordedLine);
}

/** Feed one line per batch (emitting `change`/`request` as the app expects)
 *  until a pending request appears; return where we stopped. */
function feedUntilPending(
  session: NethackSession,
  lines: RecordedLine[],
  start: number,
): { idx: number; pending: PendingRequest | null } {
  let i = start;
  while (i < lines.length) {
    const line = lines[i++]!;
    if ('reply' in line && line.reply) continue;
    session.handleBatch([line as unknown as BridgeMsg]);
    if (session.pending) return { idx: i, pending: session.pending };
  }
  return { idx: i, pending: null };
}

/** Build a session wired to a recording reply (no windows created). */
function freshSession(replies: RetMsg[]): NethackSession {
  return new NethackSession((r) => replies.push(r));
}

// ---------------------------------------------------------------------------
// Classic-mode start.jsonl replay through the App

describe('App — classic mode start.jsonl replay', () => {
  const lines = loadFixture('start.jsonl');

  it.skipIf(lines.length === 0)(
    'replay paints a grid whose map row 10 matches the session, hero is inverse, status and message lines match',
    () => {
      const replies: RetMsg[] = [];
      const session = freshSession(replies);
      const term = new FakeTerm();
      const app = new App({ session, term, mode: 'classic' });

      // Feed until the first blocking request (the Odin intro menu window).
      let r = feedUntilPending(session, lines, 0);
      expect(r.pending?.kind).toBe('display');
      // It's a menu/text window, so it renders as a paged text overlay; ESC dismisses.
      app.handleKey(ev('Escape'));
      expect(session.pending).toBeNull();

      // Feed until the first key request (nh_poskey) — the "start" state.
      r = feedUntilPending(session, lines, r.idx);
      expect(r.pending?.kind).toBe('pos');

      const grid = app.lastGrid!;
      expect(grid.width).toBe(80);
      expect(grid.height).toBe(24);

      // Map row 10 (grid row 11) equals the session map, cell by cell.
      for (let x = 0; x < 80; x++) {
        const cell = session.map.cellAt(x, 10);
        const ch = cell?.top?.ch ?? ' ';
        const fg = clrToRgb(cell?.top?.color ?? 0);
        const gc = grid.cells[11 * 80 + x]!;
        expect(gc.ch).toBe(ch);
        expect([...gc.fg]).toEqual([...fg]);
        expect([...gc.bg]).toEqual([0, 0, 0]);
      }

      // Hero cell is inverse video (ink black on the glyph colour).
      const hero = session.hero!;
      expect(hero).toEqual({ x: 74, y: 16 });
      const hc = grid.cells[(1 + hero.y) * 80 + hero.x]!;
      expect(hc.ch).toBe('@');
      expect([...hc.fg]).toEqual([0, 0, 0]);
      const heroGlyphColor = session.map.cellAt(hero.x, hero.y)?.top?.color ?? 0;
      expect([...hc.bg]).toEqual([...clrToRgb(heroGlyphColor)]);

      // Status rows match statusLines() (truncated to the grid width).
      const [l1, l2] = session.statusLines();
      for (let x = 0; x < 80; x++) {
        expect(grid.cells[22 * 80 + x]!.ch).toBe(l1[x] ?? ' ');
        expect(grid.cells[23 * 80 + x]!.ch).toBe(l2[x] ?? ' ');
      }

      // Message line (row 0) shows the last message.
      const lastMsg = session.messages.at(-1)!;
      expect(lastMsg).toContain('Velkommen');
      expect(rowText(grid, 0).trimEnd()).toBe(lastMsg.slice(0, 80));
    },
  );
});

// ---------------------------------------------------------------------------
// Classic-mode key routing

describe('App — classic mode key routing', () => {
  it('a key pressed in classic mode reaches session.answer as the key code', () => {
    const replies: RetMsg[] = [];
    const session = freshSession(replies);
    const term = new FakeTerm();
    const app = new App({ session, term, mode: 'classic' });

    session.handle({ t: 'call', name: 'nhgetch', args: [], id: 5 } as unknown as BridgeMsg);
    expect(session.pending?.kind).toBe('key');

    app.handleKey(ev('l'));
    expect(session.pending).toBeNull();
    expect(replies.at(-1)).toEqual({ id: 5, ret: 'l'.charCodeAt(0) });
  });
});

// ---------------------------------------------------------------------------
// Terminal too small

describe('App — terminal too small', () => {
  it('shows the too-small message below 80x24 and recovers on resize', () => {
    const replies: RetMsg[] = [];
    const session = freshSession(replies);
    const term = new FakeTerm(50, 10);
    const app = new App({ session, term, mode: 'classic' });

    session.handleBatch([]); // force a repaint
    const small = app.lastGrid!;
    let all = '';
    for (let y = 0; y < small.height; y++) all += rowText(small, y);
    expect(all).toContain('too small');

    // Recover once the terminal is large enough again.
    term.resize(80, 24);
    session.handleBatch([]);
    const big = app.lastGrid!;
    let bigAll = '';
    for (let y = 0; y < big.height; y++) bigAll += rowText(big, y);
    expect(bigAll).not.toContain('too small');
  });
});

// ---------------------------------------------------------------------------
// Mode switching

describe('App — mode switching', () => {
  it.skipIf(loadFixture('start.jsonl').length === 0)('F2 switches to fps mode', () => {
    const fixture = loadFixture('start.jsonl');
    const replies: RetMsg[] = [];
    const session = freshSession(replies);
    const term = new FakeTerm();
    const app = new App({ session, term, mode: 'classic' });

    // Replay to the start state (dismissing the intro display on the way).
    let r = feedUntilPending(session, fixture, 0);
    expect(r.pending?.kind).toBe('display');
    app.handleKey(ev('Escape'));
    r = feedUntilPending(session, fixture, r.idx);
    expect(r.pending?.kind).toBe('pos');
    const classicRow = rowText(app.lastGrid!, 11);

    app.handleKey(ev('F2'));

    expect(app.currentMode).toBe('fps');
    expect(app.activeMode.name).toBe('fps');
    const grid = app.lastGrid!;
    expect(rowText(grid, 1)).not.toContain('not yet implemented');
    // The viewport now shows the 3D view, not the classic map row.
    expect(rowText(grid, 11)).not.toBe(classicRow);
  });
});
