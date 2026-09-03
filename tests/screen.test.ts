import { describe, expect, it } from 'vitest';
import { diff, Screen, type TermIO } from '../src/term/screen.js';
import type { KeyEvent } from '../src/term/input.js';
import type { ScreenCell, ScreenGrid } from '../src/model/types.js';

type RGB = [number, number, number];

function cell(ch: string, fg: RGB, bg: RGB = [0, 0, 0]): ScreenCell {
  return { ch, fg, bg };
}

function grid(w: number, h: number, fill: (i: number) => ScreenCell): ScreenGrid {
  const cells = new Array<ScreenCell>(w * h);
  for (let i = 0; i < cells.length; i++) cells[i] = fill(i);
  return { width: w, height: h, cells };
}

/** Strip all `CSI …` sequences, leaving only literal characters. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

const RED: RGB = [255, 0, 0];
const GREEN: RGB = [0, 255, 0];
const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];

class FakeTermIO implements TermIO {
  writes: string[] = [];
  columns = 80;
  rows = 24;
  private resizeCb: (() => void) | null = null;
  private keyCb: ((e: KeyEvent) => void) | null = null;
  write(s: string): void {
    this.writes.push(s);
  }
  onResize(cb: () => void): void {
    this.resizeCb = cb;
  }
  onKey(cb: (e: KeyEvent) => void): void {
    this.keyCb = cb;
  }
  fireResize(): void {
    this.resizeCb?.();
  }
}

describe('term/screen diff', () => {
  it('full repaint from null emits exactly one clear and one SGR per colour run', () => {
    const next = grid(2, 1, () => cell('a', RED));
    const out = diff(null, next);
    expect((out.match(/\x1b\[2J/g) ?? []).length).toBe(1);
    expect((out.match(/\x1b\[38;2;/g) ?? []).length).toBe(1);
    expect((out.match(/\x1b\[48;2;/g) ?? []).length).toBe(1);
    expect(out.endsWith('\x1b[0m')).toBe(true);
    expect(stripAnsi(out)).toBe('aa');

    // two colour runs → an extra fg SGR, bg unchanged
    const twoRuns = grid(2, 1, (i) => (i === 0 ? cell('a', RED) : cell('b', GREEN)));
    const out2 = diff(null, twoRuns);
    expect((out2.match(/\x1b\[2J/g) ?? []).length).toBe(1);
    expect((out2.match(/\x1b\[38;2;/g) ?? []).length).toBe(2);
    expect((out2.match(/\x1b\[48;2;/g) ?? []).length).toBe(1);
    expect(stripAnsi(out2)).toBe('ab');
  });

  it('a single changed cell emits one move + at most two SGRs + one char', () => {
    const prev = grid(3, 1, () => cell('a', WHITE));
    const next = grid(3, 1, (i) => (i === 1 ? cell('X', RED) : cell('a', WHITE)));
    const out = diff(prev, next);
    expect((out.match(/\x1b\[\d+;\d+H/g) ?? []).length).toBe(1);
    expect((out.match(/\x1b\[38;2;/g) ?? []).length).toBeLessThanOrEqual(2);
    expect((out.match(/\x1b\[48;2;/g) ?? []).length).toBeLessThanOrEqual(2);
    expect(stripAnsi(out)).toBe('X');
    expect(out.endsWith('\x1b[0m')).toBe(true);
  });

  it('identical grids emit the empty string', () => {
    const g = grid(4, 2, (i) => cell(String.fromCharCode(97 + (i % 26)), WHITE));
    expect(diff(g, g)).toBe('');
    const copy = grid(4, 2, (i) => cell(String.fromCharCode(97 + (i % 26)), WHITE));
    expect(diff(g, copy)).toBe('');
  });

  it('a size change forces a full repaint', () => {
    const prev = grid(2, 1, () => cell('a', WHITE));
    const next = grid(3, 1, () => cell('a', WHITE));
    const out = diff(prev, next);
    expect(out).toContain('\x1b[2J');
    expect(stripAnsi(out)).toBe('aaa');
  });

  it('a changed cell after skipped cells is reached with a move', () => {
    const prev = grid(4, 1, () => cell('a', WHITE));
    const next = grid(4, 1, (i) => (i === 3 ? cell('Z', RED) : cell('a', WHITE)));
    const out = diff(prev, next);
    expect(out).toContain('\x1b[1;4H');
    expect(stripAnsi(out)).toBe('Z');
  });
});

describe('term/screen Screen', () => {
  it('enter() emits alt-screen-on and hide-cursor', () => {
    const t = new FakeTermIO();
    const s = new Screen(t);
    s.enter();
    expect(t.writes.join('')).toBe('\x1b[?1049h\x1b[?25l');
  });

  it('leave() emits alt-screen-off, SGR reset and show-cursor', () => {
    const t = new FakeTermIO();
    const s = new Screen(t);
    s.leave();
    expect(t.writes.join('')).toBe('\x1b[?1049l\x1b[0m\x1b[?25h');
  });

  it('paint writes a diff and a second identical paint writes nothing', () => {
    const t = new FakeTermIO();
    const s = new Screen(t);
    const g = grid(2, 1, () => cell('a', RED));
    s.paint(g);
    expect(t.writes.length).toBe(1);
    expect(t.writes[0]).toContain('\x1b[2J');
    t.writes = [];
    s.paint(g);
    expect(t.writes).toEqual([]);
  });

  it('invalidate() forces the next paint to be a full repaint', () => {
    const t = new FakeTermIO();
    const s = new Screen(t);
    const g = grid(2, 1, () => cell('a', RED));
    s.paint(g);
    s.invalidate();
    s.paint(g);
    expect(t.writes[1]).toContain('\x1b[2J');
  });

  it('a resize callback invalidates the screen', () => {
    const t = new FakeTermIO();
    const s = new Screen(t);
    const g = grid(2, 1, () => cell('a', RED));
    s.paint(g);
    t.fireResize();
    s.paint(g);
    expect(t.writes[1]).toContain('\x1b[2J');
  });

  it('repaints a cell mutated in place in the same grid object', () => {
    const t = new FakeTermIO();
    const s = new Screen(t);
    const g = grid(2, 1, () => cell('a', RED));
    s.paint(g);
    t.writes = [];
    // Simulate quantizeInto reusing the same grid: mutate a cell in place.
    g.cells[1] = cell('X', GREEN);
    s.paint(g);
    expect(t.writes).toHaveLength(1);
    const out = t.writes[0]!;
    expect(out).toContain('\x1b[1;2H');
    expect(out).toContain('X');
    expect(stripAnsi(out)).toBe('X');
  });
});
