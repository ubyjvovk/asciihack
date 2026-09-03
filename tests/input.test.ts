import { describe, expect, it } from 'vitest';
import { flushEscape, parseKeys, type KeyEvent } from '../src/term/input.js';

const EMPTY = new Uint8Array(0);

function esc(s: string): Uint8Array {
  return new Uint8Array([...s].map((c) => c.charCodeAt(0)));
}

function keys(s: string): KeyEvent[] {
  return parseKeys(esc(s), EMPTY).events;
}

function one(s: string): KeyEvent {
  const evs = keys(s);
  expect(evs).toHaveLength(1);
  return evs[0]!;
}

describe('term/input', () => {
  it('decodes every named key from its escape sequence', () => {
    const table: Array<[string, string]> = [
      ['\x1b[A', 'Up'],
      ['\x1b[B', 'Down'],
      ['\x1b[C', 'Right'],
      ['\x1b[D', 'Left'],
      ['\x1b[H', 'Home'],
      ['\x1b[F', 'End'],
      ['\x1b[1~', 'Home'],
      ['\x1b[4~', 'End'],
      ['\x1b[5~', 'PageUp'],
      ['\x1b[6~', 'PageDown'],
      ['\x1b[2~', 'Insert'],
      ['\x1b[3~', 'Delete'],
      ['\x1bOP', 'F1'],
      ['\x1bOQ', 'F2'],
      ['\x1bOR', 'F3'],
      ['\x1bOS', 'F4'],
      ['\x1b[15~', 'F5'],
      ['\x1b[17~', 'F6'],
      ['\x1b[18~', 'F7'],
      ['\x1b[19~', 'F8'],
      ['\x1b[20~', 'F9'],
      ['\x1b[21~', 'F10'],
      ['\x1b[23~', 'F11'],
      ['\x1b[24~', 'F12'],
      ['\r', 'Enter'],
      ['\t', 'Tab'],
      ['\x7f', 'Backspace'],
    ];
    for (const [seq, key] of table) {
      expect(one(seq).key, seq).toBe(key);
    }
    expect(one('\x08').key).toBe('Backspace');
  });

  it('parses ;2 shift and ;5 ctrl modifiers on arrows', () => {
    const shift = one('\x1b[1;2A');
    expect(shift.key).toBe('Up');
    expect(shift.shift).toBe(true);
    expect(shift.ctrl).toBe(false);

    const ctrl = one('\x1b[1;5C');
    expect(ctrl.key).toBe('Right');
    expect(ctrl.ctrl).toBe(true);
    expect(ctrl.shift).toBe(false);

    const alt = one('\x1b[1;3B');
    expect(alt.key).toBe('Down');
    expect(alt.alt).toBe(true);

    const ctrlShift = one('\x1b[1;6D');
    expect(ctrlShift.key).toBe('Left');
    expect(ctrlShift.ctrl).toBe(true);
    expect(ctrlShift.shift).toBe(true);
  });

  it('decodes Ctrl+letter bytes 1..26 as Ctrl+c etc.', () => {
    const c = one('\x03');
    expect(c.key).toBe('c');
    expect(c.ctrl).toBe(true);
    const a = one('\x01');
    expect(a.key).toBe('a');
    expect(a.ctrl).toBe(true);
    const z = one('\x1a');
    expect(z.key).toBe('z');
    expect(z.ctrl).toBe(true);
  });

  it('holds a lone ESC in rest, then flushEscape returns the Escape event', () => {
    const { events, rest } = parseKeys(new Uint8Array([0x1b]), EMPTY);
    expect(events).toEqual([]);
    expect(rest).toEqual(new Uint8Array([0x1b]));
    const f = flushEscape(rest);
    expect(f.event.key).toBe('Escape');
    expect(f.event.seq).toBe('\x1b');
    expect(f.rest).toEqual(EMPTY);
  });

  it('decodes a sequence split across two parseKeys calls', () => {
    let r = parseKeys(new Uint8Array([0x1b]), EMPTY);
    expect(r.events).toEqual([]);
    expect(r.rest).toEqual(new Uint8Array([0x1b]));
    r = parseKeys(esc('[A'), r.rest);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.key).toBe('Up');
    expect(r.events[0]!.seq).toBe('\x1b[A');
    expect(r.rest).toEqual(EMPTY);
  });

  it('decodes a UTF-8 é (single buffer and split across calls)', () => {
    expect(one('\xc3\xa9').key).toBe('é');
    let r = parseKeys(new Uint8Array([0xc3]), EMPTY);
    expect(r.events).toEqual([]);
    expect(r.rest).toEqual(new Uint8Array([0xc3]));
    r = parseKeys(new Uint8Array([0xa9]), r.rest);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.key).toBe('é');
  });

  it('decodes mixed printable and arrow input in one buffer', () => {
    const evs = keys('a\x1b[B');
    expect(evs.map((e) => e.key)).toEqual(['a', 'Down']);
    expect(evs[0]!.ctrl).toBe(false);
  });

  it('treats ESC followed by a letter as Alt+letter', () => {
    const e = one('\x1bx');
    expect(e.key).toBe('x');
    expect(e.alt).toBe(true);
  });

  it('skips an invalid UTF-8 lead byte', () => {
    const r = parseKeys(new Uint8Array([0xff, 0x61]), EMPTY);
    expect(r.events.map((e) => e.key)).toEqual(['a']);
    expect(r.rest).toEqual(EMPTY);
  });

  it('skips a bare continuation byte', () => {
    const r = parseKeys(new Uint8Array([0x80, 0x61]), EMPTY);
    expect(r.events.map((e) => e.key)).toEqual(['a']);
    expect(r.rest).toEqual(EMPTY);
  });

  it('holds a partial UTF-8 sequence until it completes', () => {
    // First two bytes of € (U+20AC = E2 82 AC): not complete → held.
    let r = parseKeys(new Uint8Array([0xe2, 0x82]), EMPTY);
    expect(r.events).toEqual([]);
    expect(r.rest).toEqual(new Uint8Array([0xe2, 0x82]));
    // The third byte completes it.
    r = parseKeys(new Uint8Array([0xac]), r.rest);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.key).toBe('€');
    expect(r.rest).toEqual(EMPTY);
  });

  it('drops an unknown CSI sequence whole', () => {
    // Focus-in report ESC [ I, then a printable k → only k survives.
    const r = parseKeys(esc('\x1b[Ik'), EMPTY);
    expect(r.events.map((e) => e.key)).toEqual(['k']);
    expect(r.rest).toEqual(EMPTY);
  });

  it('drops an SGR mouse report whole', () => {
    // ESC [ <0;10;20M then j → only j survives.
    const r = parseKeys(esc('\x1b[<0;10;20Mj'), EMPTY);
    expect(r.events.map((e) => e.key)).toEqual(['j']);
    expect(r.rest).toEqual(EMPTY);
  });
});
