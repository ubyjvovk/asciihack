import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { NethackSession, stripGlyphEscape, type Answer } from '../src/engine/session.js';
import type { BridgeMsg, HelloMsg, RetMsg } from '../src/engine/protocol.js';
import type { GlyphInfo } from '../src/model/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers

/** Tiny hello that carries the tables the session actually reads. */
function makeHello(overrides: Partial<HelloMsg> = {}): HelloMsg {
  return {
    t: 'hello',
    proto: 1,
    version: 'test',
    S: { S_stone: 0, S_vwall: 1, S_room: 20, S_ndoor: 12, S_lava: 40 },
    cmap: [],
    nhw: { NHW_MESSAGE: 1, NHW_STATUS: 2, NHW_MAP: 3, NHW_MENU: 4, NHW_TEXT: 5 },
    bl: {
      BL_TITLE: 0,
      BL_STR: 1,
      BL_DX: 2,
      BL_CO: 3,
      BL_IN: 4,
      BL_WI: 5,
      BL_CH: 6,
      BL_ALIGN: 7,
      BL_SCORE: 9,
      BL_GOLD: 10,
      BL_HP: 11,
      BL_HPMAX: 12,
      BL_ENE: 13,
      BL_ENEMAX: 14,
      BL_HUNGER: 17,
      BL_AC: 18,
      BL_XP: 19,
      BL_LEVELDESC: 20,
      BL_TIME: 21,
      BL_CONDITION: 22,
    },
    pick: { PICK_NONE: 0, PICK_ONE: 1, PICK_ANY: 2 },
    atr: { ATR_NONE: 0, ATR_BOLD: 1 },
    mg: { MG_HERO: 0x1, MG_PET: 0x2, MG_INVIS: 0x8, MG_BW_ICE: 0x200 },
    clr: {},
    blmask: { BL_MASK_STONE: 0x1, BL_MASK_HUNGRY: 0x40, BL_MASK_FOODPOIS: 0x2 },
    ...overrides,
  };
}

/** Build a NethackSession that has received hello + the three standard
 *  windows (so WIN_MESSAGE/STATUS/MAP are wired up like a real bridge does).
 *  The map window winds up as id 3 — that's what the tests pass to `curs`,
 *  `clear_nhwindow`, `print_glyph`. */
function fresh(reply?: (r: RetMsg) => void): {
  session: NethackSession;
  hello: HelloMsg;
  replies: RetMsg[];
} {
  const replies: RetMsg[] = [];
  const s = new NethackSession((r) => {
    replies.push(r);
    reply?.(r);
  });
  const h = makeHello();
  s.handle(h);
  // Standard boot: message, status, map — matches NetHack's create_nhwindow order.
  s.handle({ t: 'call', name: 'create_nhwindow', args: [h.nhw.NHW_MESSAGE], id: 1 });
  s.handle({ t: 'call', name: 'create_nhwindow', args: [h.nhw.NHW_STATUS], id: 2 });
  s.handle({ t: 'call', name: 'create_nhwindow', args: [h.nhw.NHW_MAP], id: 3 });
  return { session: s, hello: h, replies };
}

/** Call a synthesised create_nhwindow and hand back the assigned id. */
function createWindow(session: NethackSession, type: number, id: number, replies: RetMsg[]): number {
  session.handle({ t: 'call', name: 'create_nhwindow', args: [type], id });
  const last = replies.at(-1);
  if (!last || last.id !== id || typeof last.ret !== 'number') {
    throw new Error(`create_nhwindow did not reply as expected: ${JSON.stringify(last)}`);
  }
  return last.ret;
}

function tCall(name: string, args: unknown[], id?: number): BridgeMsg {
  return id === undefined
    ? { t: 'call', name, args }
    : { t: 'call', name, args, id };
}

const cmapGlyph = (idx: number, ch = '.', color = 7, flags = 0): GlyphInfo => ({
  glyph: 0, ch, color, cls: 'cmap', idx, flags,
});
const monsterGlyph = (ch = 'd', color = 3, flags = 0): GlyphInfo => ({
  glyph: 0, ch, color, cls: 'mon', idx: 1, flags,
});

// ---------------------------------------------------------------------------
// Map / hero / messages

describe('NethackSession — map bookkeeping', () => {
  it('marks cells with the CellKind of the cmap glyph', () => {
    const { session, hello } = fresh();
    session.handle(tCall('print_glyph', [3, 5, 3, cmapGlyph(hello.S.S_room!)]));
    session.handle(tCall('print_glyph', [3, 1, 1, cmapGlyph(hello.S.S_vwall!, '|')]));
    expect(session.map.kindAt(5, 3)).toBe('floor');
    expect(session.map.kindAt(1, 1)).toBe('wall');
  });

  it('non-terrain glyph on an unexplored cell marks it as floor (something walkable is there)', () => {
    const { session } = fresh();
    session.handle(tCall('print_glyph', [3, 10, 10, monsterGlyph()]));
    expect(session.map.kindAt(10, 10)).toBe('floor');
    // The top glyph is the monster, not the (unknown) terrain.
    expect(session.map.cellAt(10, 10)?.top?.cls).toBe('mon');
    expect(session.map.cellAt(10, 10)?.terrain).toBeNull();
  });

  it('clear_nhwindow on the map window resets every cell to unexplored', () => {
    const { session, hello } = fresh();
    session.handle(tCall('print_glyph', [3, 4, 4, cmapGlyph(hello.S.S_room!)]));
    expect(session.map.kindAt(4, 4)).toBe('floor');
    session.handle(tCall('clear_nhwindow', [3]));
    expect(session.map.kindAt(4, 4)).toBe('unexplored');
    expect(session.hero).toBeNull();
  });

  it('curs on the map window sets the hero position', () => {
    const { session } = fresh();
    session.handle(tCall('curs', [3, 42, 11]));
    expect(session.hero).toEqual({ x: 42, y: 11 });
  });

  it('MG_HERO in a glyph cross-checks the hero position', () => {
    const { session, hello } = fresh();
    session.handle(tCall('print_glyph', [3, 7, 8, {
      ...monsterGlyph(), flags: hello.mg.MG_HERO!,
    }]));
    expect(session.hero).toEqual({ x: 7, y: 8 });
  });

  it('putstr on the message window appends to the messages log', () => {
    const replies: RetMsg[] = [];
    const s = new NethackSession((r) => replies.push(r));
    s.handle(makeHello());
    createWindow(s, 1, 1, replies); // NHW_MESSAGE
    s.handle(tCall('putstr', [1, 0, 'Welcome to NetHack.']));
    s.handle(tCall('putstr', [1, 0, 'You hit a jackal!']));
    expect(s.messages).toEqual(['Welcome to NetHack.', 'You hit a jackal!']);
  });

  it('raw_print lands in messages like a putstr on the message window', () => {
    const messages: string[] = [];
    const replies: RetMsg[] = [];
    const s = new NethackSession((r) => replies.push(r));
    s.on('message', (m: string) => messages.push(m));
    s.handle(makeHello());
    createWindow(s, 1, 1, replies); // NHW_MESSAGE (id 1)
    s.handle(tCall('raw_print', ['Velkommen, welcome to NetHack!']));
    // putstr to the message window still works and appends after the raw_print.
    s.handle(tCall('putstr', [1, 0, 'You see here 2 gold pieces.']));
    expect(s.messages).toEqual([
      'Velkommen, welcome to NetHack!',
      'You see here 2 gold pieces.',
    ]);
    // Both a raw_print and a putstr fired a `message` event, in order.
    expect(messages).toEqual(['Velkommen, welcome to NetHack!', 'You see here 2 gold pieces.']);
  });

  it('preference_update and update_positionbar are not messages', () => {
    const messages: string[] = [];
    const replies: RetMsg[] = [];
    const s = new NethackSession((r) => replies.push(r));
    s.on('message', (m: string) => messages.push(m));
    s.handle(makeHello());
    createWindow(s, 1, 1, replies); // NHW_MESSAGE (id 1)
    // Both carry string args that must NOT leak into the message history.
    s.handle(tCall('preference_update', ['statuslines']));
    s.handle(tCall('update_positionbar', ['S:St:14 Dx:10 Co:10']));
    expect(s.messages).toEqual([]);
    expect(messages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Status lines and the gold-glyph escape

describe('NethackSession — status', () => {
  it('assembles two status lines in the classic tty order', () => {
    const { session } = fresh();
    const upd = (idx: number, v: unknown): BridgeMsg =>
      tCall('status_update', [idx, v, 0, 0, 0]);
    session.handle(upd(0, 'Valkyrie the Stripling'));
    session.handle(upd(1, '18'));
    session.handle(upd(2, '13'));
    session.handle(upd(3, '15'));
    session.handle(upd(4, '10'));
    session.handle(upd(5, '10'));
    session.handle(upd(6, '11'));
    session.handle(upd(7, 'Neutral'));
    session.handle(upd(10, '\\G00000F2E:42'));
    session.handle(upd(11, '16'));
    session.handle(upd(12, '16'));
    session.handle(upd(13, '1'));
    session.handle(upd(14, '1'));
    session.handle(upd(18, '6'));
    session.handle(upd(19, '1'));
    session.handle(upd(20, 'Dlvl:1  '));
    session.handle(upd(21, '4'));
    session.handle(upd(22, 0x40)); // HUNGRY condition bit
    const [line1, line2] = session.statusLines();
    // Score never arrived, so `S:` is dropped. Everything else is present and
    // in the classic tty order.
    expect(line1).toBe('Valkyrie the Stripling St:18 Dx:13 Co:15 In:10 Wi:10 Ch:11 Neutral');
    expect(line2).toBe('Dlvl:1 $:42 HP:16(16) Pw:1(1) AC:6 Xp:1 T:4 HUNGRY');
  });

  it('stripGlyphEscape peels NetHack \\G escapes off the gold field', () => {
    expect(stripGlyphEscape('\\G00000F2E:0')).toBe('0');
    expect(stripGlyphEscape('\\G00000F2E:1234')).toBe('1234');
    expect(stripGlyphEscape('plain')).toBe('plain');
  });

  it('BL_CONDITION arrives as a number and BL_FLUSH/BL_RESET as null (no crash, no store)', () => {
    const { session } = fresh();
    // Simulate the shape the ticket calls out: number for BL_CONDITION, null for flushes.
    session.handle(tCall('status_update', [22, 3, 0, 0, 0]));
    session.handle(tCall('status_update', [99, null, 0, 0, 0])); // pretend flush
    expect(session.status.get(22)).toBe(3);
    expect(session.status.has(99)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Menus, requests, answer()

describe('NethackSession — menus and requests', () => {
  it('builds menu items (headers keep identIndex −1, accelerators preserved) and answer() emits selected', () => {
    const replies: RetMsg[] = [];
    const s = new NethackSession((r) => replies.push(r));
    s.handle(makeHello());
    const win = createWindow(s, 4, 1, replies); // NHW_MENU
    s.handle(tCall('start_menu', [win, 0]));
    s.handle(tCall('add_menu', [win, null, -1, '', '', 0, 0, 'Choose an option', 0]));
    s.handle(tCall('add_menu', [win, null, 0, 'y', '', 0, 0, 'Yes, do a tutorial', 0]));
    s.handle(tCall('add_menu', [win, null, 1, 'n', '', 0, 0, 'No, just start play', 0]));
    s.handle(tCall('end_menu', [win, 'Would you like…?']));
    s.handle(tCall('select_menu', [win, 1], 2));

    const p = s.pending;
    expect(p?.kind).toBe('menu');
    if (p?.kind !== 'menu') return;
    expect(p.items).toHaveLength(3);
    expect(p.items[0]!.identIndex).toBe(-1); // header
    expect(p.items[1]!.identIndex).toBe(0);
    expect(p.items[1]!.accel).toBe('y');
    expect(p.items[2]!.accel).toBe('n');
    expect(p.prompt).toBe('Would you like…?');

    s.answer({ kind: 'menu', selected: [{ i: 1, count: -1 }] });
    expect(s.pending).toBeNull();
    const last = replies.at(-1);
    expect(last).toEqual({ id: 2, ret: 1, selected: [{ i: 1, count: -1 }] });
  });

  it('answering an empty menu selection sends ret 0', () => {
    const replies: RetMsg[] = [];
    const s = new NethackSession((r) => replies.push(r));
    s.handle(makeHello());
    const win = createWindow(s, 4, 1, replies);
    s.handle(tCall('start_menu', [win, 0]));
    s.handle(tCall('add_menu', [win, null, 0, 'y', '', 0, 0, 'A', 0]));
    s.handle(tCall('end_menu', [win, null]));
    s.handle(tCall('select_menu', [win, 1], 2));
    s.answer({ kind: 'menu', selected: [] });
    expect(replies.at(-1)).toEqual({ id: 2, ret: 0, selected: [] });
  });

  it('yn / getlin / nhgetch / blocking-display round-trip to the right RetMsg', () => {
    const replies: RetMsg[] = [];
    const s = new NethackSession((r) => replies.push(r));
    s.handle(makeHello());

    // yn_function
    s.handle(tCall('yn_function', ['Really quit?', 'yn', 'n'.charCodeAt(0)], 10));
    expect(s.pending?.kind).toBe('yn');
    s.answer({ kind: 'yn', ch: 'y'.charCodeAt(0) });
    expect(replies.at(-1)).toEqual({ id: 10, ret: 121 });

    // getlin
    s.handle(tCall('getlin', ['What do you want to name?'], 11));
    expect(s.pending?.kind).toBe('getlin');
    s.answer({ kind: 'getlin', text: 'Trusty' });
    expect(replies.at(-1)).toEqual({ id: 11, ret: 'Trusty' });

    // nhgetch
    s.handle(tCall('nhgetch', [], 12));
    expect(s.pending?.kind).toBe('key');
    s.answer({ kind: 'key', key: 'l'.charCodeAt(0) });
    expect(replies.at(-1)).toEqual({ id: 12, ret: 108 });

    // nh_poskey (key path)
    s.handle(tCall('nh_poskey', [], 13));
    expect(s.pending?.kind).toBe('pos');
    s.answer({ kind: 'pos', key: 'x'.charCodeAt(0) });
    expect(replies.at(-1)).toEqual({ id: 13, ret: 120 });

    // nh_poskey (click path)
    s.handle(tCall('nh_poskey', [], 14));
    s.answer({ kind: 'pos', x: 5, y: 6, mod: 1 });
    expect(replies.at(-1)).toEqual({ id: 14, ret: 0, x: 5, y: 6, mod: 1 });

    // display_nhwindow(blocking=true) on the message window → dismiss → ret 0
    const msgWin = createWindow(s, 1, 20, replies);
    s.handle(tCall('display_nhwindow', [msgWin, true], 15));
    expect(s.pending?.kind).toBe('display');
    s.answer({ kind: 'dismiss' });
    expect(replies.at(-1)).toEqual({ id: 15, ret: 0 });
  });

  it('answer() throws when nothing is pending', () => {
    const s = new NethackSession(() => {});
    s.handle(makeHello());
    expect(() => s.answer({ kind: 'key', key: 32 })).toThrow(/no pending request/);
  });

  it('answer rejects an unknown payload kind (cast through unknown) — throws, no reply sent', () => {
    const replies: RetMsg[] = [];
    const s = new NethackSession((r) => replies.push(r));
    s.handle(makeHello());
    s.handle(tCall('nhgetch', [], 1));
    // A kind outside the `Answer` union is rejected before buildRetMsg runs;
    // the `default: throw` in buildRetMsg is the belt-and-suspenders guard
    // that keeps an unhandled payload from ever reaching replyFn as `undefined`.
    expect(() => s.answer({ kind: 'bogus', key: 1 } as unknown as Answer)).toThrow();
    expect(replies).toHaveLength(0);
  });

  it('answer accepts display as a synonym for dismiss', () => {
    const replies: RetMsg[] = [];
    const s = new NethackSession((r) => replies.push(r));
    s.handle(makeHello());
    const msgWin = createWindow(s, 1, 20, replies);
    s.handle(tCall('display_nhwindow', [msgWin, true], 15));
    expect(s.pending?.kind).toBe('display');
    s.answer({ kind: 'display' });
    expect(s.pending).toBeNull();
    expect(replies.at(-1)).toEqual({ id: 15, ret: 0 });
  });

  it('emits change once per handleBatch and request when a pending is set', () => {
    const s = new NethackSession(() => {});
    s.handle(makeHello());
    let changeCount = 0;
    let requestCount = 0;
    s.on('change', () => { changeCount++; });
    s.on('request', () => { requestCount++; });
    s.handleBatch([
      tCall('print_glyph', [3, 1, 1, cmapGlyph(20)]),
      tCall('print_glyph', [3, 2, 2, cmapGlyph(20)]),
      tCall('nhgetch', [], 1),
    ]);
    expect(changeCount).toBe(1);
    expect(requestCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Fixture replay — the payoff test.

interface RecordedLine {
  reply?: RetMsg;
  t?: string;
  [k: string]: unknown;
}

function loadFixture(name: string): RecordedLine[] {
  const path = resolve(HERE, 'fixtures', 'bridge', name);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as RecordedLine);
}

function replay(name: string): NethackSession & { exits: Array<{ code: number; reason?: string }> } {
  const lines = loadFixture(name);
  const s = new NethackSession(() => {}) as NethackSession & {
    exits: Array<{ code: number; reason?: string }>;
  };
  s.exits = [];
  s.on('exit', (code: number, reason?: string) => s.exits.push({ code, reason }));
  for (const line of lines) {
    if ('reply' in line && line.reply) continue; // client replies weren't bridge messages
    s.handle(line as unknown as BridgeMsg);
  }
  return s;
}

describe('NethackSession — fixture replay', () => {
  const startLines = loadFixture('start.jsonl');
  const walkLines = loadFixture('walk.jsonl');

  it.skipIf(startLines.length === 0)(
    'start.jsonl → hero position set, non-unexplored cells drawn, key request pending',
    () => {
      const s = replay('start.jsonl');
      expect(s.hero).not.toBeNull();
      // Count how many map cells the model marked as anything other than
      // 'unexplored'. NetHack's docrt() only forwards non-GLYPH_UNEXPLORED
      // glyphs, so a fresh level draws only the starting room + hero/pet
      // (docs/bridge.md — the T-0002 report set the same floor at 30 for
      // exactly this reason).
      let drawn = 0;
      for (let y = 0; y < s.map.height; y++) {
        for (let x = 0; x < s.map.width; x++) {
          if (s.map.kindAt(x, y) !== 'unexplored') drawn++;
        }
      }
      expect(drawn).toBeGreaterThanOrEqual(30);
      expect(s.pending?.kind === 'key' || s.pending?.kind === 'pos').toBe(true);
    },
  );

  it.skipIf(walkLines.length === 0)('walk.jsonl → replay ends with an exit event', () => {
    const s = replay('walk.jsonl');
    expect(s.exits.length).toBeGreaterThan(0);
    // The bridge emits `exit` with a code; the ticket wanted an exit line to
    // be captured on the walk fixture (save + confirm path).
    expect(typeof s.exits[0]!.code).toBe('number');
  });
});
