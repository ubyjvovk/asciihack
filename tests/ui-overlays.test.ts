import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/ui/app.js';
import { NethackSession } from '../src/engine/session.js';
import type { HelloMsg, RetMsg } from '../src/engine/protocol.js';
import type { ScreenGrid } from '../src/model/types.js';
import type { KeyEvent } from '../src/term/input.js';
import type { TermIO } from '../src/term/screen.js';

// ---------------------------------------------------------------------------
// Test doubles

class FakeTerm implements TermIO {
  columns = 80;
  rows = 24;
  writes: string[] = [];
  private keyCb: ((e: KeyEvent) => void) | null = null;
  private resizeCb: (() => void) | null = null;
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

function ev(key: string): KeyEvent {
  return { key, ctrl: false, shift: false, alt: false, seq: key };
}

/** Reconstruct every row of the grid as text (for finding overlay content). */
function gridText(g: ScreenGrid): string {
  let s = '';
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) s += g.cells[y * g.width + x]!.ch;
    s += '\n';
  }
  return s;
}

function makeHello(): HelloMsg {
  return {
    t: 'hello',
    proto: 1,
    version: 'test',
    S: { S_stone: 0 },
    cmap: [],
    nhw: { NHW_MESSAGE: 1, NHW_STATUS: 2, NHW_MAP: 3, NHW_MENU: 4, NHW_TEXT: 5 },
    bl: { BL_TITLE: 0, BL_STR: 1 },
    pick: { PICK_NONE: 0, PICK_ONE: 1, PICK_ANY: 2 },
    atr: { ATR_NONE: 0 },
    mg: {},
    clr: {},
    blmask: {},
    extra: {
      extcmds: [
        { name: 'inventory', desc: 'show your inventory', flags: 0 },
        { name: 'apply', desc: 'apply a tool', flags: 0 },
        { name: 'annotate', desc: 'name the level', flags: 0 },
      ],
    },
  };
}

/** A session with the three standard windows created (so the map/message/status
 *  ids are known), a recording reply, and an `App` wired to a fake terminal. */
function makeReady(mode = 'classic'): {
  session: NethackSession;
  app: App;
  replies: RetMsg[];
  hello: HelloMsg;
} {
  const replies: RetMsg[] = [];
  const session = new NethackSession((r) => replies.push(r));
  const h = makeHello();
  session.handle(h);
  session.handle({ t: 'call', name: 'create_nhwindow', args: [h.nhw.NHW_MESSAGE], id: 1 });
  session.handle({ t: 'call', name: 'create_nhwindow', args: [h.nhw.NHW_STATUS], id: 2 });
  session.handle({ t: 'call', name: 'create_nhwindow', args: [h.nhw.NHW_MAP], id: 3 });
  const term = new FakeTerm();
  const app = new App({ session, term, mode });
  return { session, app, replies, hello: h };
}

// ---------------------------------------------------------------------------
// Menus

describe('MenuOverlay', () => {
  it('PICK_ONE renders items with accelerators and an accelerator answers with the selected item', () => {
    const { session, app, replies, hello } = makeReady();
    session.handle({ t: 'call', name: 'create_nhwindow', args: [hello.nhw.NHW_MENU], id: 4 });
    const win = replies.at(-1)!.ret as number;
    session.handle({ t: 'call', name: 'start_menu', args: [win, 0] });
    session.handle({ t: 'call', name: 'add_menu', args: [win, null, 0, 'a', '', 0, 0, 'Apple', 0] });
    session.handle({ t: 'call', name: 'add_menu', args: [win, null, 1, 'b', '', 0, 0, 'Bread', 0] });
    session.handle({ t: 'call', name: 'end_menu', args: [win, 'Choose'] });
    session.handle({ t: 'call', name: 'select_menu', args: [win, 1], id: 10 });

    expect(session.pending?.kind).toBe('menu');
    expect(gridText(app.lastGrid!)).toContain('a) Apple');
    expect(gridText(app.lastGrid!)).toContain('b) Bread');

    app.handleKey(ev('a'));
    expect(session.pending).toBeNull();
    expect(replies.at(-1)).toEqual({ id: 10, ret: 1, selected: [{ i: 0, count: -1 }] });
  });

  it('PICK_ANY toggles items then Enter confirms the toggled set', () => {
    const { session, app, replies, hello } = makeReady();
    session.handle({ t: 'call', name: 'create_nhwindow', args: [hello.nhw.NHW_MENU], id: 4 });
    const win = replies.at(-1)!.ret as number;
    session.handle({ t: 'call', name: 'start_menu', args: [win, 0] });
    session.handle({ t: 'call', name: 'add_menu', args: [win, null, 0, 'a', '', 0, 0, 'Apple', 0] });
    session.handle({ t: 'call', name: 'add_menu', args: [win, null, 1, 'b', '', 0, 0, 'Bread', 0] });
    session.handle({ t: 'call', name: 'end_menu', args: [win, null] });
    session.handle({ t: 'call', name: 'select_menu', args: [win, 2], id: 11 });

    app.handleKey(ev('a'));
    app.handleKey(ev('b'));
    app.handleKey(ev('Enter'));
    expect(session.pending).toBeNull();
    expect(replies.at(-1)).toEqual({
      id: 11,
      ret: 2,
      selected: [
        { i: 0, count: -1 },
        { i: 1, count: -1 },
      ],
    });
  });

  it('ESC cancels the menu with ret -1 (cancelled) while Enter with nothing selected sends ret 0 (T-0015)', () => {
    const cancel = makeReady();
    cancel.session.handle({ t: 'call', name: 'create_nhwindow', args: [cancel.hello.nhw.NHW_MENU], id: 4 });
    const cancelWin = cancel.replies.at(-1)!.ret as number;
    cancel.session.handle({ t: 'call', name: 'start_menu', args: [cancelWin, 0] });
    cancel.session.handle({ t: 'call', name: 'add_menu', args: [cancelWin, null, 0, 'a', '', 0, 0, 'Apple', 0] });
    cancel.session.handle({ t: 'call', name: 'end_menu', args: [cancelWin, null] });
    // PICK_ANY so Enter is a distinct "confirm" path from ESC.
    cancel.session.handle({ t: 'call', name: 'select_menu', args: [cancelWin, 2], id: 12 });
    cancel.app.handleKey(ev('Escape'));
    expect(cancel.session.pending).toBeNull();
    expect(cancel.replies.at(-1)).toEqual({ id: 12, ret: -1 });

    const empty = makeReady();
    empty.session.handle({ t: 'call', name: 'create_nhwindow', args: [empty.hello.nhw.NHW_MENU], id: 4 });
    const emptyWin = empty.replies.at(-1)!.ret as number;
    empty.session.handle({ t: 'call', name: 'start_menu', args: [emptyWin, 0] });
    empty.session.handle({ t: 'call', name: 'add_menu', args: [emptyWin, null, 0, 'a', '', 0, 0, 'Apple', 0] });
    empty.session.handle({ t: 'call', name: 'end_menu', args: [emptyWin, null] });
    empty.session.handle({ t: 'call', name: 'select_menu', args: [emptyWin, 2], id: 13 });
    empty.app.handleKey(ev('Enter'));
    expect(empty.session.pending).toBeNull();
    expect(empty.replies.at(-1)).toEqual({ id: 13, ret: 0, selected: [] });
  });
});

// ---------------------------------------------------------------------------
// getlin / yn

describe('GetlinOverlay and YnOverlay', () => {
  it('getlin: typing + Backspace + Enter returns the edited string', () => {
    const { session, app, replies } = makeReady();
    session.handle({ t: 'call', name: 'getlin', args: ['Name?'], id: 20 });
    expect(session.pending?.kind).toBe('getlin');

    for (const ch of 'Fido') app.handleKey(ev(ch));
    app.handleKey(ev('Backspace')); // drop 'o'
    app.handleKey(ev('o')); // fix it back
    app.handleKey(ev('Enter'));
    expect(session.pending).toBeNull();
    expect(replies.at(-1)).toEqual({ id: 20, ret: 'Fido' });
  });

  it('getlin ESC cancels to the empty string', () => {
    const { session, app, replies } = makeReady();
    session.handle({ t: 'call', name: 'getlin', args: ['Name?'], id: 21 });
    app.handleKey(ev('Escape'));
    expect(replies.at(-1)).toEqual({ id: 21, ret: '' });
  });

  it('yn with choices "ynq" and ESC returns q', () => {
    const { session, app, replies } = makeReady();
    session.handle({
      t: 'call',
      name: 'yn_function',
      args: ['Really quit?', 'ynq', 'y'.charCodeAt(0)],
      id: 30,
    });
    expect(session.pending?.kind).toBe('yn');
    app.handleKey(ev('Escape'));
    expect(replies.at(-1)).toEqual({ id: 30, ret: 'q'.charCodeAt(0) });
  });

  it('yn prompt formats as `query [choices] (def)` when def is printable and omits (def) when it is a control char (T-0015)', () => {
    const printable = makeReady();
    printable.session.handle({
      t: 'call',
      name: 'yn_function',
      args: ['Really save?', 'yn', 'n'.charCodeAt(0)],
      id: 32,
    });
    expect(gridText(printable.app.lastGrid!)).toContain('Really save? [yn] (n)');

    const ctrl = makeReady();
    ctrl.session.handle({
      t: 'call',
      name: 'yn_function',
      args: ['Really save?', 'yn', 0x00], // NUL — the pre-T-0015 bug printed `[]`
      id: 33,
    });
    const rendered = gridText(ctrl.app.lastGrid!);
    expect(rendered).toContain('Really save? [yn]');
    expect(rendered).not.toContain('()');
  });

  it('yn accepts a valid offered choice and ignores an invalid one', () => {
    const { session, app, replies } = makeReady();
    session.handle({
      t: 'call',
      name: 'yn_function',
      args: ['Save?', 'yn', 'y'.charCodeAt(0)],
      id: 31,
    });
    app.handleKey(ev('x')); // not offered → stays open
    expect(session.pending?.kind).toBe('yn');
    app.handleKey(ev('y'));
    expect(replies.at(-1)).toEqual({ id: 31, ret: 'y'.charCodeAt(0) });
  });
});

// ---------------------------------------------------------------------------
// Text / --More-- / ext-cmd

describe('TextOverlay and MoreOverlay', () => {
  it('a blocking display on the message window shows --More-- and any key dismisses', () => {
    const { session, app, replies } = makeReady();
    session.handle({ t: 'call', name: 'putstr', args: [1, 0, 'The message window waits.'] });
    session.handle({ t: 'call', name: 'display_nhwindow', args: [1, true], id: 40 });
    expect(session.pending?.kind).toBe('display');
    expect((session.pending as { windowType?: number }).windowType).toBe(1); // NHW_MESSAGE
    expect(gridText(app.lastGrid!)).toContain('--More--');

    app.handleKey(ev(' '));
    expect(session.pending).toBeNull();
    expect(replies.at(-1)).toEqual({ id: 40, ret: 0 });
  });

  it('a blocking display on a text window renders a paged overlay that ESC dismisses', () => {
    const { session, app, replies, hello } = makeReady();
    session.handle({ t: 'call', name: 'create_nhwindow', args: [hello.nhw.NHW_TEXT], id: 5 });
    const win = replies.at(-1)!.ret as number;
    session.handle({ t: 'call', name: 'putstr', args: [win, 0, 'Line one'] });
    session.handle({ t: 'call', name: 'putstr', args: [win, 0, 'Line two'] });
    session.handle({ t: 'call', name: 'display_nhwindow', args: [win, true], id: 41 });
    expect(session.pending?.kind).toBe('display');
    expect((session.pending as { windowType?: number }).windowType).toBe(5); // NHW_TEXT
    expect(gridText(app.lastGrid!)).toContain('Line one');

    app.handleKey(ev('Escape'));
    expect(session.pending).toBeNull();
    expect(replies.at(-1)).toEqual({ id: 41, ret: 0 });
  });
});

describe('ExtCmdOverlay', () => {
  it('Enter answers the index of the completed command; ESC answers -1', () => {
    const { session, app, replies } = makeReady();
    session.handle({ t: 'call', name: 'get_ext_cmd', args: [], id: 50 });
    expect(session.pending?.kind).toBe('extcmd');

    for (const ch of 'inv') app.handleKey(ev(ch));
    app.handleKey(ev('Enter'));
    expect(session.pending).toBeNull();
    expect(replies.at(-1)).toEqual({ id: 50, ret: 0 }); // index of "inventory"

    // ESC cancels with −1.
    session.handle({ t: 'call', name: 'get_ext_cmd', args: [], id: 51 });
    app.handleKey(ev('Escape'));
    expect(replies.at(-1)).toEqual({ id: 51, ret: -1 });
  });
});

// ---------------------------------------------------------------------------
// Exit while a --More-- is pending (T-0015)

describe('App — session exit', () => {
  it('a session `exit` while a --More-- overlay is pending calls leave() without a keypress', () => {
    const { session, app } = makeReady();
    session.handle({ t: 'call', name: 'putstr', args: [1, 0, 'Saving...'] });
    session.handle({ t: 'call', name: 'display_nhwindow', args: [1, true], id: 60 });
    expect(session.pending?.kind).toBe('display');
    expect(gridText(app.lastGrid!)).toContain('--More--');

    const leaveSpy = vi.spyOn(app, 'leave');
    session.handle({ t: 'exit', code: 0 });
    expect(leaveSpy).toHaveBeenCalledTimes(1);
  });
});
