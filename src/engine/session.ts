/**
 * NethackSession — the client's model of a running NetHack game
 * (docs/architecture.md §4). Consumes `BridgeMsg`s from the C bridge
 * (`src/engine/bridge.ts`), keeps the level, hero, messages, status,
 * windows and pending request, and dispatches replies through an
 * injected `reply` callback. UI code subscribes to `change` / `request` /
 * `message` / `exit` events; tests drive it via `handle`/`handleBatch`
 * directly.
 */
import { EventEmitter } from 'node:events';
import type {
  BridgeMsg,
  CallMsg,
  ExitMsg,
  HelloMsg,
  RetMsg,
} from './protocol.js';
import type { CellKind, GlyphInfo, LevelView, MapCell } from '../model/types.js';
import { COLNO, ROWNO } from '../model/types.js';
import { cellKindOf, isTerrainGlyph } from './glyphs.js';

// ---------------------------------------------------------------------------
// State types

/** One line in a NetHack text/menu window. */
export interface LineEntry {
  attr: number;
  text: string;
}

/** One entry built up between `start_menu` and `end_menu`. */
export interface MenuItem {
  /** Bridge identifier index; `-1` for a header row (unselectable). */
  identIndex: number;
  /** Single-character accelerator NetHack picked; `''` if none (UI assigns one). */
  accel: string;
  /** Group accelerator; `''` if none. */
  groupAccel: string;
  attr: number;
  color: number;
  text: string;
  glyph: GlyphInfo | null;
  /** Set by `answer({kind:'menu'})` when this item is chosen; the session does not toggle it on its own. */
  selected: boolean;
  /** Chosen count (`-1` = "all"), `-1` until answered. */
  count: number;
}

export interface MenuState {
  items: MenuItem[];
  prompt: string | null;
}

export interface WindowState {
  type: number;
  lines: LineEntry[];
  menu?: MenuState;
}

// ---------------------------------------------------------------------------
// Pending requests — one at a time; answered with `session.answer(...)`.

export interface KeyRequest {
  kind: 'key';
  id: number;
}
export interface PosRequest {
  kind: 'pos';
  id: number;
}
export interface YnRequest {
  kind: 'yn';
  id: number;
  query: string;
  /** Accepted response characters, or `null` for "any key". */
  choices: string | null;
  /** Default character code (from NetHack; `0` if none). */
  def: number;
}
export interface GetlinRequest {
  kind: 'getlin';
  id: number;
  query: string;
}
export interface MenuRequest {
  kind: 'menu';
  id: number;
  win: number;
  how: number;
  items: MenuItem[];
  prompt: string | null;
}
export interface BlockingDisplayRequest {
  kind: 'display';
  id: number;
  win: number;
  /** Window type (NHW_*). Callers use this + hello.nhw to decide layout. */
  windowType: number;
  lines: LineEntry[];
  menu?: MenuState;
}
export interface TextFileRequest {
  kind: 'file';
  id: number;
  name: string;
  complain: boolean;
  text: string | null;
}
export interface ExtCmdRequest {
  kind: 'extcmd';
  id: number;
}
export interface MessageMenuRequest {
  kind: 'message-menu';
  id: number;
  /** Group accelerator letter (NetHack's `let` parameter). */
  let: string;
  how: number;
  mesg: string;
}

export type PendingRequest =
  | KeyRequest
  | PosRequest
  | YnRequest
  | GetlinRequest
  | MenuRequest
  | BlockingDisplayRequest
  | TextFileRequest
  | ExtCmdRequest
  | MessageMenuRequest;

/** Payloads accepted by `session.answer(...)` — one variant per pending kind. */
export type Answer =
  | { kind: 'key'; key: number }
  | { kind: 'pos'; key: number }
  | { kind: 'pos'; x: number; y: number; mod: number }
  | { kind: 'yn'; ch: number }
  | { kind: 'getlin'; text: string }
  | { kind: 'menu'; selected: ReadonlyArray<{ i: number; count: number }> }
  | { kind: 'dismiss' }
  | { kind: 'extcmd'; index: number }
  | { kind: 'message-menu'; ch: number }
  | { kind: 'file'; ret?: number };

// ---------------------------------------------------------------------------
// Helpers

/** Strip NetHack's `\G` glyph escape prefix (`\GHHHHHHHH:value`) from a
 *  status string, keeping only the trailing `value`. Non-escaped strings pass
 *  through unchanged. */
export function stripGlyphEscape(v: string): string {
  if (v.length >= 10 && v.charCodeAt(0) === 0x5c && v.charCodeAt(1) === 0x47 /* "\G" */) {
    const colon = v.indexOf(':');
    if (colon >= 0) return v.slice(colon + 1);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Session

/**
 * Model of a live NetHack session. Feed it `BridgeMsg`s (one at a time via
 * `handle`, or in chunks via `handleBatch`), read the current state through
 * the getters, and answer pending requests with `answer(...)`.
 */
export class NethackSession extends EventEmitter {
  private _hello: HelloMsg | null = null;
  private cells: MapCell[];
  private _hero: { x: number; y: number } | null = null;
  private _messages: string[] = [];
  private _status = new Map<number, string | number>();
  private _windows = new Map<number, WindowState>();
  private _pending: PendingRequest | null = null;

  private nextWinId = 1;
  private WIN_MAP = -1;
  private WIN_MESSAGE = -1;
  private WIN_STATUS = -1;
  private bl: Record<string, number> = {};
  private blmask: Record<string, number> = {};
  private nhw: Record<string, number> = {};
  private S: Record<string, number> = {};
  private mg: Record<string, number> = {};

  private replyFn: (r: RetMsg) => void;
  private playerName: string;

  /**
   * @param reply - callback that writes one reply line to the bridge (usually
   *   `bridge.reply.bind(bridge)`); if omitted, `answer(...)` throws.
   * @param opts - `playerName` is auto-replied to `askname` (NetHack normally
   *   picks it up from `-u`/NETHACKOPTIONS first, but the shim still asks if
   *   the buffer is empty).
   */
  constructor(reply?: (r: RetMsg) => void, opts?: { playerName?: string }) {
    super();
    this.replyFn =
      reply ??
      ((): void => {
        throw new Error('NethackSession: no reply function configured');
      });
    this.playerName = opts?.playerName ?? '';
    this.cells = this.makeCells();
  }

  // -------------------------------------------------------------------------
  // State accessors

  /** Immutable view of the level for renderers. */
  get map(): LevelView {
    const cells = this.cells;
    return {
      width: COLNO,
      height: ROWNO,
      kindAt: (x, y) => {
        if (x < 0 || x >= COLNO || y < 0 || y >= ROWNO) return 'unexplored';
        return cells[y * COLNO + x]!.kind;
      },
      cellAt: (x, y) => {
        if (x < 0 || x >= COLNO || y < 0 || y >= ROWNO) return null;
        return cells[y * COLNO + x]!;
      },
    };
  }
  get hero(): { x: number; y: number } | null {
    return this._hero;
  }
  get messages(): readonly string[] {
    return this._messages;
  }
  get status(): ReadonlyMap<number, string | number> {
    return this._status;
  }
  get windows(): ReadonlyMap<number, WindowState> {
    return this._windows;
  }
  get pending(): PendingRequest | null {
    return this._pending;
  }
  get hello(): HelloMsg | null {
    return this._hello;
  }

  // -------------------------------------------------------------------------
  // Ingest

  /** Process one bridge message; may emit `message` / `request` / `exit`. */
  handle(msg: BridgeMsg): void {
    switch (msg.t) {
      case 'hello':
        this.handleHello(msg);
        return;
      case 'exit':
        this.handleExit(msg);
        return;
      case 'log':
        return;
      case 'call':
        this.handleCall(msg);
        return;
    }
  }

  /** Process a chunk of messages and emit one coalesced `change` event. */
  handleBatch(msgs: readonly BridgeMsg[]): void {
    for (const m of msgs) this.handle(m);
    this.emit('change');
  }

  // -------------------------------------------------------------------------
  // answer()

  /**
   * Answer the current `pending` request. Throws if nothing is pending or
   * the payload's `kind` does not match. Serialises the `RetMsg` through the
   * `reply` callback passed to the constructor and clears `pending`.
   */
  answer(a: Answer): void {
    const p = this._pending;
    if (!p) throw new Error('NethackSession.answer: no pending request');
    if (p.kind !== a.kind && !(p.kind === 'display' && a.kind === 'dismiss')) {
      throw new Error(
        `NethackSession.answer: kind mismatch (pending=${p.kind}, answer=${a.kind})`,
      );
    }
    const ret: RetMsg = this.buildRetMsg(p, a);
    this._pending = null;
    this.replyFn(ret);
  }

  private buildRetMsg(p: PendingRequest, a: Answer): RetMsg {
    switch (a.kind) {
      case 'key':
        return { id: p.id, ret: a.key };
      case 'pos':
        if ('x' in a) return { id: p.id, ret: 0, x: a.x, y: a.y, mod: a.mod };
        return { id: p.id, ret: a.key };
      case 'yn':
        return { id: p.id, ret: a.ch };
      case 'getlin':
        return { id: p.id, ret: a.text };
      case 'menu': {
        if (a.selected.length === 0) return { id: p.id, ret: 0, selected: [] };
        return {
          id: p.id,
          ret: a.selected.length,
          selected: a.selected.map((s) => ({ i: s.i, count: s.count })),
        };
      }
      case 'dismiss':
        return { id: p.id, ret: 0 };
      case 'extcmd':
        return { id: p.id, ret: a.index };
      case 'message-menu':
        return { id: p.id, ret: a.ch };
      case 'file':
        return { id: p.id, ret: a.ret ?? 0 };
    }
  }

  // -------------------------------------------------------------------------
  // Message handlers

  private handleHello(msg: HelloMsg): void {
    this._hello = msg;
    this.S = msg.S;
    this.bl = msg.bl;
    this.blmask = msg.blmask;
    this.nhw = msg.nhw;
    this.mg = msg.mg;
  }

  private handleExit(msg: ExitMsg): void {
    this.emit('exit', msg.code, msg.reason);
  }

  private handleCall(msg: CallMsg): void {
    const args = msg.args;
    const id = msg.id;
    switch (msg.name) {
      case 'init_nhwindows':
        return;
      case 'create_nhwindow': {
        const type = args[0] as number;
        const winId = this.nextWinId++;
        this._windows.set(winId, { type, lines: [] });
        this.rememberSpecialWindow(winId, type);
        if (typeof id === 'number') this.replyFn({ id, ret: winId });
        return;
      }
      case 'destroy_nhwindow': {
        const win = args[0] as number;
        this._windows.delete(win);
        return;
      }
      case 'clear_nhwindow': {
        const win = args[0] as number;
        const w = this._windows.get(win);
        if (w) w.lines = [];
        if (win === this.WIN_MAP) {
          this.resetMap();
        }
        return;
      }
      case 'display_nhwindow': {
        const win = args[0] as number;
        const blocking = args[1] as boolean;
        if (blocking && typeof id === 'number') {
          const w = this._windows.get(win);
          const type = w?.type ?? -1;
          const req: BlockingDisplayRequest = {
            kind: 'display',
            id,
            win,
            windowType: type,
            lines: w ? w.lines.slice() : [],
          };
          if (w?.menu) req.menu = w.menu;
          this.setPending(req);
        }
        return;
      }
      case 'curs': {
        const win = args[0] as number;
        const x = args[1] as number;
        const y = args[2] as number;
        if (win === this.WIN_MAP) {
          this._hero = { x, y };
        }
        return;
      }
      case 'putstr': {
        const win = args[0] as number;
        const attr = args[1] as number;
        const text = args[2] as string;
        const w = this._windows.get(win);
        if (w) w.lines.push({ attr, text });
        if (win === this.WIN_MESSAGE) {
          this._messages.push(text);
          this.emit('message', text);
        }
        return;
      }
      case 'print_glyph':
        return this.doPrintGlyph(msg);
      case 'start_menu': {
        const win = args[0] as number;
        const w = this._windows.get(win);
        if (w) w.menu = { items: [], prompt: null };
        return;
      }
      case 'add_menu': {
        const win = args[0] as number;
        const glyph = args[1] as GlyphInfo | null;
        const identIndex = args[2] as number;
        const accel = args[3] as string;
        const groupAccel = args[4] as string;
        const attr = args[5] as number;
        const color = args[6] as number;
        const text = args[7] as string;
        const w = this._windows.get(win);
        if (w) {
          if (!w.menu) w.menu = { items: [], prompt: null };
          w.menu.items.push({
            identIndex,
            accel: accel ?? '',
            groupAccel: groupAccel ?? '',
            attr,
            color,
            text,
            glyph,
            selected: false,
            count: -1,
          });
        }
        return;
      }
      case 'end_menu': {
        const win = args[0] as number;
        const prompt = args[1] as string | null;
        const w = this._windows.get(win);
        if (w?.menu) w.menu.prompt = prompt;
        return;
      }
      case 'select_menu': {
        const win = args[0] as number;
        const how = args[1] as number;
        const w = this._windows.get(win);
        const items = w?.menu?.items ?? [];
        const prompt = w?.menu?.prompt ?? null;
        if (typeof id === 'number') {
          this.setPending({
            kind: 'menu',
            id,
            win,
            how,
            items: items.map((it) => ({ ...it })),
            prompt,
          });
        }
        return;
      }
      case 'yn_function': {
        const query = (args[0] as string | null) ?? '';
        const choices = args[1] as string | null;
        const def = args[2] as number;
        if (typeof id === 'number') {
          this.setPending({ kind: 'yn', id, query, choices, def });
        }
        return;
      }
      case 'getlin': {
        const query = (args[0] as string | null) ?? '';
        if (typeof id === 'number') this.setPending({ kind: 'getlin', id, query });
        return;
      }
      case 'nhgetch': {
        if (typeof id === 'number') this.setPending({ kind: 'key', id });
        return;
      }
      case 'nh_poskey': {
        if (typeof id === 'number') this.setPending({ kind: 'pos', id });
        return;
      }
      case 'get_ext_cmd': {
        if (typeof id === 'number') this.setPending({ kind: 'extcmd', id });
        return;
      }
      case 'message_menu': {
        const let_ = args[0] as string;
        const how = args[1] as number;
        const mesg = args[2] as string;
        if (typeof id === 'number') {
          this.setPending({ kind: 'message-menu', id, let: let_, how, mesg });
        }
        return;
      }
      case 'display_file': {
        const name = args[0] as string;
        const complain = args[1] as boolean;
        const text = (args[2] as string | null) ?? null;
        if (typeof id === 'number') {
          this.setPending({ kind: 'file', id, name, complain, text });
        }
        return;
      }
      case 'status_update':
        return this.doStatusUpdate(msg);
      case 'status_enablefield':
      case 'status_init':
      case 'number_pad':
      case 'change_color':
      case 'change_background':
      case 'preference_update':
      case 'update_positionbar':
      case 'raw_print':
      case 'raw_print_bold':
      case 'get_nh_event':
      case 'resume_nhwindows':
      case 'suspend_nhwindows':
      case 'exit_nhwindows':
      case 'putmsghistory':
      case 'update_inventory':
      case 'cliparound':
      case 'mark_synch':
      case 'wait_synch':
      case 'nhbell':
      case 'delay_output':
        return;
      case 'player_selection': {
        if (typeof id === 'number') this.replyFn({ id, ret: 0 });
        return;
      }
      case 'player_selection_or_tty': {
        if (typeof id === 'number') this.replyFn({ id, ret: false });
        return;
      }
      case 'askname': {
        if (typeof id === 'number') this.replyFn({ id, ret: this.playerName });
        return;
      }
      case 'doprev_message': {
        if (typeof id === 'number') this.replyFn({ id, ret: 0 });
        return;
      }
      default: {
        if (typeof id === 'number') this.replyFn({ id, ret: null });
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Print-glyph and map bookkeeping

  private doPrintGlyph(msg: CallMsg): void {
    const args = msg.args;
    const x = args[1] as number;
    const y = args[2] as number;
    const gi = args[3] as GlyphInfo | null;
    const cell = this.cellRef(x, y);
    if (!cell || !gi) return;
    if (isTerrainGlyph(gi)) {
      const kind = cellKindOf(gi, this.S) ?? 'other';
      cell.terrain = gi;
      cell.kind = kind;
      cell.top = gi;
    } else {
      // Non-terrain: mark the top-of-cell glyph. If we still don't know what
      // this cell contains, mark it walkable so renderers do not treat the
      // creature as floating in unexplored void (§4.2).
      cell.top = gi;
      if (cell.kind === 'unexplored') cell.kind = 'floor';
    }
    // MG_HERO cross-check — keep hero position in sync when the map redraws
    // the hero before a `curs` arrives (§4.3).
    const hero = this.mg['MG_HERO'];
    if (hero !== undefined && (gi.flags & hero) !== 0) {
      this._hero = { x, y };
    }
  }

  private doStatusUpdate(msg: CallMsg): void {
    const args = msg.args;
    const idx = args[0] as number;
    const value = args[1] as unknown;
    if (value === null) return; // BL_FLUSH / BL_RESET
    if (typeof value === 'number') {
      this._status.set(idx, value);
      return;
    }
    if (typeof value === 'string') {
      const isGold = this.bl['BL_GOLD'] === idx;
      this._status.set(idx, isGold ? stripGlyphEscape(value) : value);
    }
  }

  private cellRef(x: number, y: number): MapCell | null {
    if (x < 0 || x >= COLNO || y < 0 || y >= ROWNO) return null;
    return this.cells[y * COLNO + x]!;
  }

  private makeCells(): MapCell[] {
    const arr: MapCell[] = new Array(COLNO * ROWNO);
    for (let y = 0; y < ROWNO; y++) {
      for (let x = 0; x < COLNO; x++) {
        arr[y * COLNO + x] = { x, y, kind: 'unexplored', terrain: null, top: null };
      }
    }
    return arr;
  }

  private resetMap(): void {
    for (const c of this.cells) {
      c.kind = 'unexplored';
      c.terrain = null;
      c.top = null;
    }
    this._hero = null;
  }

  private rememberSpecialWindow(id: number, type: number): void {
    if (type === this.nhw['NHW_MESSAGE']) this.WIN_MESSAGE = id;
    else if (type === this.nhw['NHW_STATUS']) this.WIN_STATUS = id;
    else if (type === this.nhw['NHW_MAP']) this.WIN_MAP = id;
  }

  private setPending(req: PendingRequest): void {
    this._pending = req;
    this.emit('request', req);
  }

  // -------------------------------------------------------------------------
  // Status line assembly (docs/architecture.md §6.3)

  /**
   * Assemble NetHack's classic two status lines from `status`. Field order
   * follows `nethack/win/tty/wintty.c`: title / stats / align / score on line
   * 1; Dlvl / gold / HP / Pw / AC / Xp / T / hunger / conditions on line 2.
   * Fields that never arrived (or arrived empty) are skipped.
   */
  statusLines(): [string, string] {
    const s = this._status;
    const bl = this.bl;
    const get = (name: string): string | number | undefined => {
      const idx = bl[name];
      if (idx === undefined) return undefined;
      return s.get(idx);
    };
    const str = (name: string): string => {
      const v = get(name);
      return v === undefined ? '' : String(v);
    };

    const line1: string[] = [];
    const title = str('BL_TITLE');
    if (title) line1.push(title);
    const stats: Array<[string, string]> = [
      ['St', str('BL_STR')],
      ['Dx', str('BL_DX')],
      ['Co', str('BL_CO')],
      ['In', str('BL_IN')],
      ['Wi', str('BL_WI')],
      ['Ch', str('BL_CH')],
    ];
    for (const [label, value] of stats) if (value) line1.push(`${label}:${value}`);
    const align = str('BL_ALIGN');
    if (align) line1.push(align);
    const score = str('BL_SCORE');
    if (score) line1.push(`S:${score}`);

    const line2: string[] = [];
    const dlvl = str('BL_LEVELDESC').trim();
    if (dlvl) line2.push(dlvl);
    const gold = str('BL_GOLD');
    if (gold) line2.push(`$:${gold}`);
    const hp = str('BL_HP');
    if (hp) {
      const hpmax = str('BL_HPMAX');
      line2.push(hpmax ? `HP:${hp}(${hpmax})` : `HP:${hp}`);
    }
    const pw = str('BL_ENE');
    if (pw) {
      const pwmax = str('BL_ENEMAX');
      line2.push(pwmax ? `Pw:${pw}(${pwmax})` : `Pw:${pw}`);
    }
    const ac = str('BL_AC');
    if (ac) line2.push(`AC:${ac}`);
    const xp = str('BL_XP');
    const hd = str('BL_HD');
    if (xp) line2.push(hd ? `Xp:${xp}/${hd}` : `Xp:${xp}`);
    const time = str('BL_TIME');
    if (time) line2.push(`T:${time}`);
    const hunger = str('BL_HUNGER');
    if (hunger) line2.push(hunger);
    const enc = str('BL_CAP');
    if (enc) line2.push(enc);
    const condIdx = bl['BL_CONDITION'];
    if (condIdx !== undefined) {
      const raw = s.get(condIdx);
      if (typeof raw === 'number' && raw !== 0) {
        const names = decodeConditions(raw, this.blmask);
        if (names.length) line2.push(names.join(' '));
      }
    }

    return [line1.join(' '), line2.join(' ')];
  }
}

/** Decode a `BL_CONDITION` bitmask into the names set on the mask
 *  (in the order they appear in `blmask`). */
export function decodeConditions(
  mask: number,
  blmask: Readonly<Record<string, number>>,
): string[] {
  const out: string[] = [];
  for (const [name, bit] of Object.entries(blmask)) {
    if ((mask & bit) !== 0) out.push(name.replace(/^BL_MASK_/, ''));
  }
  return out;
}

/**
 * Convenience: pump every batch from `bridge.batches` into `session`,
 * yielding one `change` event per stdout chunk. Resolves when the bridge
 * closes its stdout.
 */
export async function runSession(
  bridge: { batches: AsyncIterable<BridgeMsg[]> },
  session: NethackSession,
): Promise<void> {
  for await (const batch of bridge.batches) {
    session.handleBatch(batch);
  }
}
