/**
 * Boxed overlays for menus, text windows and prompts (docs/architecture.md
 * §4.4, §6.3). One overlay object per pending request (or UI-triggered notice);
 * `paint` draws a centred box, `handleKey` either keeps the overlay open or
 * answers the session request and returns `false` so the app closes it.
 */
import type { NethackSession } from '../engine/session.js';
import type {
  BlockingDisplayRequest,
  ExtCmdRequest,
  GetlinRequest,
  MenuItem,
  MenuRequest,
  PendingRequest,
  YnRequest,
} from '../engine/session.js';
import type { ScreenGrid } from '../model/types.js';
import type { KeyEvent } from '../term/input.js';
import { paintBox, putText, UI_BG, UI_FG } from './grid.js';

/** A UI overlay: paints itself into the grid and consumes keys. */
export interface Overlay {
  /** Paint the overlay box into the grid. */
  paint(grid: ScreenGrid): void;
  /** Handle a key; return `false` when the overlay is done and should close. */
  handleKey(e: KeyEvent): boolean;
}

/** Convert a `KeyEvent` to a NetHack key code (char code, or a named-key code). */
export function keyToCode(e: KeyEvent): number {
  if (e.key.length === 1) return e.key.charCodeAt(0);
  switch (e.key) {
    case 'Enter':
      return 13;
    case 'Escape':
      return 27;
    case 'Backspace':
      return 8;
    case 'Tab':
      return 9;
    case ' ':
      return 32;
    default:
      // Unmapped named key (arrow/function): send the first byte of its raw
      // sequence, which NetHack's tty path interprets as the ESC prefix for
      // the extended command it encodes.
      return e.seq.length > 0 ? e.seq.charCodeAt(0) : 0;
  }
}

/** Effective accelerator for each selectable item, assigning `a-zA-Z` to
 *  items whose NetHack accelerator is empty (docs/architecture.md §4.4). */
function assignAccels(items: readonly MenuItem[]): Array<{ accel: string; item: MenuItem }> {
  const out: Array<{ accel: string; item: MenuItem }> = [];
  let lower = 'a'.charCodeAt(0);
  let upper = 'A'.charCodeAt(0);
  for (const item of items) {
    if (item.identIndex === -1) continue; // header rows are not selectable
    let accel = item.accel;
    if (!accel) {
      if (lower <= 'z'.charCodeAt(0)) accel = String.fromCharCode(lower++);
      else if (upper <= 'Z'.charCodeAt(0)) accel = String.fromCharCode(upper++);
      else accel = ' ';
    }
    out.push({ accel, item });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Menu overlay

/** Boxed menu overlay with paging (`>`/`<`), accelerators and PICK_* behaviour. */
export class MenuOverlay implements Overlay {
  private readonly req: MenuRequest;
  private readonly session: NethackSession;
  private readonly accels: Array<{ accel: string; item: MenuItem }>;
  private readonly pickAny: boolean;
  private readonly pickNone: boolean;
  private page = 0;
  private readonly selected = new Set<number>();
  private countPrefix: number | null = null;

  /** @param req - the pending `menu` request this overlay answers. */
  constructor(req: MenuRequest, session: NethackSession) {
    this.req = req;
    this.session = session;
    this.accels = assignAccels(req.items);
    const how = req.how;
    this.pickAny = how === 2; // PICK_ANY
    this.pickNone = how === 0; // PICK_NONE
  }

  paint(grid: ScreenGrid): void {
    const items = this.req.items;
    const bodyW = Math.min(
      Math.max(24, ...items.map((it) => it.text.length + 6)),
      grid.width - 4,
    );
    const bodyH = Math.min(18, items.length);
    const boxW = bodyW + 2;
    const boxH = bodyH + 4;
    const inner = paintBox(grid, Math.floor(grid.width / 2), Math.floor(grid.height / 2), boxW, boxH, this.req.prompt ?? 'Menu');
    const perPage = Math.max(1, inner.height - 1);
    const pages = Math.max(1, Math.ceil(items.length / perPage));
    if (this.page >= pages) this.page = pages - 1;
    const start = this.page * perPage;
    let row = inner.y;
    for (let k = start; k < Math.min(items.length, start + perPage); k++) {
      const it = items[k]!;
      if (it.identIndex === -1) {
        putText(grid, inner.x, row, it.text.slice(0, inner.width), [150, 150, 150]);
      } else {
        const acc = this.accels.find((a) => a.item === it)?.accel ?? it.accel;
        const marker = this.selected.has(it.identIndex) ? '*' : ' ';
        const line = ` ${marker} ${acc}) ${it.text}`;
        putText(grid, inner.x, row, line.slice(0, inner.width));
      }
      row++;
    }
    const footer =
      pages > 1
        ? `p${this.page + 1}/${pages}  >/< page  Esc cancel`
        : this.pickAny
          ? 'Enter ok  Esc cancel'
          : 'Esc cancel';
    putText(grid, inner.x, inner.y + inner.height - 1, footer.slice(0, inner.width), [180, 180, 180]);
  }

  handleKey(e: KeyEvent): boolean {
    if (e.key === 'Escape') {
      this.cancel();
      return false;
    }
    if (this.pickNone) {
      // Informational menu: any key dismisses with no selection.
      this.session.answer({ kind: 'menu', selected: [] });
      return false;
    }
    if (e.key === 'Enter') {
      if (this.pickAny) {
        this.confirm();
        return false;
      }
      if (this.accels.length === 1) {
        this.answerOne(this.accels[0]!.item);
        return false;
      }
      return true;
    }
    if (e.key === '>' || e.key === '<') {
      const pages = Math.max(1, Math.ceil(this.req.items.length / 18));
      this.page = Math.max(0, Math.min(pages - 1, this.page + (e.key === '>' ? 1 : -1)));
      return true;
    }
    if (this.pickAny && /^[0-9]$/.test(e.key)) {
      this.countPrefix = Number(e.key);
      return true;
    }
    const hit = this.accels.find((a) => a.accel === e.key);
    if (hit) {
      if (this.pickAny) {
        // Toggle the item; a pending count prefix applies to this toggle.
        if (this.selected.has(hit.item.identIndex)) this.selected.delete(hit.item.identIndex);
        else this.selected.add(hit.item.identIndex);
        this.countPrefix = null;
        return true;
      }
      this.answerOne(hit.item);
      return false;
    }
    return true;
  }

  private answerOne(item: MenuItem): void {
    this.session.answer({
      kind: 'menu',
      selected: [{ i: item.identIndex, count: this.countPrefix ?? -1 }],
    });
  }

  private confirm(): void {
    const selected = [...this.selected].map((i) => ({ i, count: -1 }));
    this.session.answer({ kind: 'menu', selected });
  }

  private cancel(): void {
    // ESC → `ret -1` (cancelled). Enter-with-nothing goes through `confirm`
    // and sends `ret 0` — NetHack distinguishes the two on some prompts
    // (docs/engine.md, T-0015).
    this.session.answer({ kind: 'menu', cancelled: true });
  }
}

// ---------------------------------------------------------------------------
// Text overlay

/** Boxed, paged text window (blocking display of a menu/text window, a file,
 *  or the UI's own message history). Any key pages; ESC dismisses. */
export class TextOverlay implements Overlay {
  private readonly title: string;
  private readonly lines: readonly string[];
  private readonly onDismiss: () => void;
  private page = 0;

  /**
   * @param opts.title - overlay box title.
   * @param opts.lines - the text to page through.
   * @param opts.onDismiss - called once when the overlay closes (answers the
   *   underlying request, or is a no-op for UI-triggered history).
   */
  constructor(opts: { title: string; lines: readonly string[]; onDismiss: () => void }) {
    this.title = opts.title;
    this.lines = opts.lines;
    this.onDismiss = opts.onDismiss;
  }

  paint(grid: ScreenGrid): void {
    const maxLine = Math.max(16, ...this.lines.map((l) => l.length));
    const boxW = Math.min(maxLine + 4, grid.width - 2);
    const bodyH = Math.min(18, this.lines.length);
    const inner = paintBox(grid, Math.floor(grid.width / 2), Math.floor(grid.height / 2), boxW, bodyH + 4, this.title);
    const perPage = Math.max(1, inner.height - 1);
    const pages = Math.max(1, Math.ceil(this.lines.length / perPage));
    if (this.page >= pages) this.page = pages - 1;
    const start = this.page * perPage;
    let row = inner.y;
    for (let k = start; k < Math.min(this.lines.length, start + perPage); k++) {
      putText(grid, inner.x, row++, this.lines[k]!.slice(0, inner.width));
    }
    const footer = pages > 1 ? `p${this.page + 1}/${pages}  any key  Esc close` : 'any key  Esc close';
    putText(grid, inner.x, inner.y + inner.height - 1, footer.slice(0, inner.width), [180, 180, 180]);
  }

  handleKey(e: KeyEvent): boolean {
    if (e.key === 'Escape') {
      this.onDismiss();
      return false;
    }
    const perPage = 18;
    const pages = Math.max(1, Math.ceil(this.lines.length / perPage));
    if (this.page >= pages - 1) {
      this.onDismiss();
      return false;
    }
    this.page++;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Yn prompt

/** `yn_function` prompt overlay. ESC follows the `q`/`n`/default rule from
 *  `wintty.c`; otherwise only the offered choices are accepted. */
export class YnOverlay implements Overlay {
  private readonly req: YnRequest;
  private readonly session: NethackSession;

  /** @param req - the pending `yn` request. */
  constructor(req: YnRequest, session: NethackSession) {
    this.req = req;
    this.session = session;
  }

  paint(grid: ScreenGrid): void {
    // Format like `wintty.c`: `query [choices] (def)`. Only bracket real
    // choices ("(any key)" is a placeholder, not a choice list), and only
    // show the default when it is printable ASCII — NetHack sometimes hands
    // in a control character when there is no meaningful default (T-0015).
    const choices =
      this.req.choices !== null ? `[${this.req.choices}]` : '(any key)';
    const d = this.req.def;
    const def = d >= 0x21 && d <= 0x7e ? ` (${String.fromCharCode(d)})` : '';
    const text = `${this.req.query} ${choices}${def}`;
    const boxW = Math.min(text.length + 4, grid.width - 2);
    const inner = paintBox(grid, Math.floor(grid.width / 2), Math.floor(grid.height / 2), boxW, 5, 'Question');
    putText(grid, inner.x, inner.y + 1, text.slice(0, inner.width));
  }

  handleKey(e: KeyEvent): boolean {
    if (e.key === 'Escape') {
      const ch = this.escChoice();
      this.session.answer({ kind: 'yn', ch });
      return false;
    }
    if (this.req.choices === null) {
      this.session.answer({ kind: 'yn', ch: keyToCode(e) });
      return false;
    }
    const ch = e.key;
    if (ch.length === 1 && this.req.choices.includes(ch)) {
      this.session.answer({ kind: 'yn', ch: ch.charCodeAt(0) });
      return false;
    }
    return true; // invalid response: stay open
  }

  /** ESC → 'q' if offered, else 'n' if offered, else the default (wintty.c). */
  private escChoice(): number {
    const choices = this.req.choices ?? '';
    if (choices.includes('q')) return 'q'.charCodeAt(0);
    if (choices.includes('n')) return 'n'.charCodeAt(0);
    return this.req.def !== 0 ? this.req.def : 0;
  }
}

// ---------------------------------------------------------------------------
// Getlin prompt

/** `getlin` line editor overlay: typing + Backspace, Enter commits, ESC cancels to `""`. */
export class GetlinOverlay implements Overlay {
  private readonly req: GetlinRequest;
  private readonly session: NethackSession;
  private buffer = '';

  /** @param req - the pending `getlin` request. */
  constructor(req: GetlinRequest, session: NethackSession) {
    this.req = req;
    this.session = session;
  }

  paint(grid: ScreenGrid): void {
    const boxW = Math.min(Math.max(20, this.req.query.length + 4), grid.width - 2);
    const inner = paintBox(grid, Math.floor(grid.width / 2), Math.floor(grid.height / 2), boxW, 5, this.req.query);
    putText(grid, inner.x, inner.y + 1, (this.buffer + ' ').slice(0, inner.width));
  }

  handleKey(e: KeyEvent): boolean {
    if (e.key === 'Escape') {
      this.session.answer({ kind: 'getlin', text: '' });
      return false;
    }
    if (e.key === 'Enter') {
      this.session.answer({ kind: 'getlin', text: this.buffer });
      return false;
    }
    if (e.key === 'Backspace') {
      this.buffer = this.buffer.slice(0, -1);
      return true;
    }
    if (e.key.length === 1 && e.key.charCodeAt(0) >= 0x20) {
      this.buffer += e.key;
      return true;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Extended-command prompt

/** `#` extended-command line with prefix completion over `hello.extra.extcmds`.
 *  Enter answers the first matching command's index, ESC answers −1. */
export class ExtCmdOverlay implements Overlay {
  private readonly req: ExtCmdRequest;
  private readonly session: NethackSession;
  private buffer = '';

  /** @param req - the pending `extcmd` request. */
  constructor(req: ExtCmdRequest, session: NethackSession) {
    this.req = req;
    this.session = session;
  }

  /** The extended-command table from the hello message (`[{name, desc, flags}]`). */
  private get cmds(): Array<{ name: string; desc: string | null; flags: number }> {
    const extra = this.session.hello?.extra;
    const list = extra && Array.isArray(extra['extcmds']) ? (extra['extcmds'] as unknown[]) : [];
    return list.filter((c): c is { name: string; desc: string | null; flags: number } => {
      const o = c as Record<string, unknown>;
      return typeof o['name'] === 'string';
    });
  }

  paint(grid: ScreenGrid): void {
    const matches = this.cmds.filter((c) => c.name.startsWith(this.buffer));
    const shown = matches.slice(0, 10);
    const width = Math.min(36, grid.width - 2);
    const bodyH = Math.min(10, shown.length);
    const inner = paintBox(grid, Math.floor(grid.width / 2), Math.floor(grid.height / 2), width, bodyH + 4, 'Extended command');
    putText(grid, inner.x, inner.y, `#${this.buffer}`, UI_FG);
    for (let k = 0; k < shown.length; k++) {
      putText(grid, inner.x, inner.y + 1 + k, `${k}) ${shown[k]!.name}`, [200, 200, 200]);
    }
    putText(grid, inner.x, inner.y + inner.height - 1, 'Tab: complete  Esc: cancel', [150, 150, 150]);
  }

  handleKey(e: KeyEvent): boolean {
    if (e.key === 'Escape') {
      this.session.answer({ kind: 'extcmd', index: -1 });
      return false;
    }
    if (e.key === 'Enter') {
      const match = this.cmds.find((c) => c.name.startsWith(this.buffer));
      const index = match ? this.cmds.indexOf(match) : -1;
      this.session.answer({ kind: 'extcmd', index });
      return false;
    }
    if (e.key === 'Backspace') {
      this.buffer = this.buffer.slice(0, -1);
      return true;
    }
    if (e.key === 'Tab') {
      const match = this.cmds.find((c) => c.name.startsWith(this.buffer) && c.name.length > this.buffer.length);
      if (match) this.buffer = match.name;
      return true;
    }
    if (e.key.length === 1 && e.key.charCodeAt(0) >= 0x20) {
      this.buffer += e.key;
      return true;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Message-menu and --More--

/** `message_menu` overlay: shows the message, any key answers its code. */
export class MessageMenuOverlay implements Overlay {
  private readonly req: PendingRequest & { kind: 'message-menu' };
  private readonly session: NethackSession;

  constructor(req: PendingRequest & { kind: 'message-menu' }, session: NethackSession) {
    this.req = req;
    this.session = session;
  }

  paint(grid: ScreenGrid): void {
    const text = this.req.mesg;
    const boxW = Math.min(text.length + 4, grid.width - 2);
    const inner = paintBox(grid, Math.floor(grid.width / 2), Math.floor(grid.height / 2), boxW, 5, 'Message');
    putText(grid, inner.x, inner.y + 1, text.slice(0, inner.width));
  }

  handleKey(e: KeyEvent): boolean {
    this.session.answer({ kind: 'message-menu', ch: keyToCode(e) });
    return false;
  }
}

/** NetHack's own `--More--`: a blocking display on the message window. Any key
 *  dismisses it (docs/architecture.md §4.4). */
export class MoreOverlay implements Overlay {
  private readonly req: BlockingDisplayRequest;
  private readonly session: NethackSession;

  /** @param req - the blocking display request on the message window. */
  constructor(req: BlockingDisplayRequest, session: NethackSession) {
    this.req = req;
    this.session = session;
  }

  paint(grid: ScreenGrid): void {
    const text = '--More--';
    putText(grid, Math.floor((grid.width - text.length) / 2), 0, text, UI_FG, UI_BG);
  }

  handleKey(): boolean {
    this.session.answer({ kind: 'dismiss' });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Factory

/**
 * Build the overlay for a pending request, or `null` when it needs no overlay
 * (a plain `key`/`pos` request is handled by the active mode, not an overlay).
 */
export function createOverlay(
  p: PendingRequest,
  session: NethackSession,
): Overlay | null {
  switch (p.kind) {
    case 'menu':
      return new MenuOverlay(p, session);
    case 'yn':
      return new YnOverlay(p, session);
    case 'getlin':
      return new GetlinOverlay(p, session);
    case 'extcmd':
      return new ExtCmdOverlay(p, session);
    case 'message-menu':
      return new MessageMenuOverlay(p, session);
    case 'display':
      if (p.windowType === session.hello?.nhw['NHW_MESSAGE']) return new MoreOverlay(p, session);
      return new TextOverlay({
        title: 'Text',
        lines: p.lines.map((l) => l.text),
        onDismiss: () => session.answer({ kind: 'dismiss' }),
      });
    case 'file':
      return new TextOverlay({
        title: p.name,
        lines: (p.text ?? '').split('\n'),
        onDismiss: () => session.answer({ kind: 'file' }),
      });
    case 'key':
    case 'pos':
      return null;
    default: {
      const _exhaustive: never = p;
      return null;
    }
  }
}


