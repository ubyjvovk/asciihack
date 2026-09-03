/**
 * T-0020: a SIGWINCH must recompose and paint at the new terminal size
 * without any other event. Regression: `Screen`'s resize handler only
 * invalidated its buffer, so nothing repainted until the next key or bridge
 * message (in tmux, shrinking 215×68 → 120×40 left stale fragments and no
 * status rows until Ctrl+L).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { App } from '../src/ui/app.js';
import { NethackSession } from '../src/engine/session.js';
import type { BridgeMsg, RetMsg } from '../src/engine/protocol.js';
import type { KeyEvent } from '../src/term/input.js';
import type { ScreenGrid } from '../src/model/types.js';
import type { TermIO } from '../src/term/screen.js';

const HERE = dirname(fileURLToPath(import.meta.url));

class FakeTerm implements TermIO {
  columns: number;
  rows: number;
  writes: string[] = [];
  private resizeCbs: Array<() => void> = [];
  private keyCb: ((e: KeyEvent) => void) | null = null;
  constructor(cols: number, rows: number) {
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
    this.resizeCbs.push(cb);
  }
  resize(cols: number, rows: number): void {
    this.columns = cols;
    this.rows = rows;
    for (const cb of this.resizeCbs) cb();
  }
  key(e: KeyEvent): void {
    this.keyCb?.(e);
  }
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

function rowText(g: ScreenGrid, y: number): string {
  let s = '';
  for (let x = 0; x < g.width; x++) s += g.cells[y * g.width + x]!.ch;
  return s;
}

describe('App — resize repaints immediately', () => {
  const lines = loadFixture('start.jsonl');

  it.skipIf(lines.length === 0)(
    'resize repaints without any other event',
    () => {
      const replies: RetMsg[] = [];
      const session = new NethackSession((r) => replies.push(r));
      const term = new FakeTerm(100, 30);
      const app = new App({ session, term, mode: 'classic' });

      // Feed the fixture through so the session has a map, status and messages
      // to compose. Stop before the first blocking request so the paint is not
      // dominated by an overlay.
      for (const line of lines) {
        if ('reply' in line && line.reply) continue;
        session.handleBatch([line as unknown as BridgeMsg]);
        if (session.pending) break;
      }

      // Sanity: the first paint was at 100×30.
      const before = app.lastGrid!;
      expect(before.width).toBe(100);
      expect(before.height).toBe(30);
      const writesBefore = term.writes.length;

      // Simulate a SIGWINCH to 120×40. No key event, no session event.
      term.resize(120, 40);

      // The recompose ran at the new size.
      const after = app.lastGrid!;
      expect(after.width).toBe(120);
      expect(after.height).toBe(40);

      // A new full paint was written (the resize forces a CSI 2 J clear).
      const resizeWrites = term.writes.slice(writesBefore).join('');
      expect(resizeWrites).toContain('\x1b[2J');

      // Status rows land on the bottom two rows (rows 39–40, 1-indexed;
      // 0-indexed 38 and 39) — before the fix nothing repainted, so these
      // would still hold the old 100×30 status positions.
      const [l1, l2] = session.statusLines();
      const width = after.width;
      expect(rowText(after, 38)).toBe((l1.slice(0, width) + ' '.repeat(width)).slice(0, width));
      expect(rowText(after, 39)).toBe((l2.slice(0, width) + ' '.repeat(width)).slice(0, width));
    },
  );
});
