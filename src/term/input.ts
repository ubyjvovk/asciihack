/**
 * Raw stdin key parser (docs/architecture.md §6.2): a pure incremental
 * `parseKeys` that decodes bytes into `KeyEvent`s and returns any incomplete
 * tail as `rest`, plus `flushEscape` to resolve a lone ESC after a timeout.
 */

/** A decoded key: `key` is the character or one of the named keys; `seq` is the raw input. */
export interface KeyEvent {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  seq: string;
}

/** Sentinel returned by the escape parsers when more bytes are required. */
const INCOMPLETE = Symbol('incomplete');

interface Parsed {
  event: KeyEvent;
  next: number;
}

/** Build a `KeyEvent` with the standard flag defaults and its raw `seq`. */
function ev(key: string, seq: string, f: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}): KeyEvent {
  return { key, ctrl: f.ctrl ?? false, shift: f.shift ?? false, alt: f.alt ?? false, seq };
}

/** Decode a UTF-8 sequence starting at `data[i]`; null if incomplete, else {char, len}. */
function decodeUtf8(data: Uint8Array, i: number): { char: string; len: number } | null {
  const b0 = data[i]!;
  let len = 0;
  let code = 0;
  if (b0 >= 0xc2 && b0 <= 0xdf) {
    len = 2;
    code = b0 & 0x1f;
  } else if (b0 >= 0xe0 && b0 <= 0xef) {
    len = 3;
    code = b0 & 0x0f;
  } else if (b0 >= 0xf0 && b0 <= 0xf7) {
    len = 4;
    code = b0 & 0x07;
  } else {
    return null; // invalid lead byte or bare continuation → caller skips it
  }
  if (i + len > data.length) return null; // incomplete at the buffer end
  for (let k = 1; k < len; k++) {
    const b = data[i + k]!;
    if (b < 0x80 || b > 0xbf) return null; // not a continuation byte → invalid
    code = (code << 6) | (b & 0x3f);
  }
  return { char: String.fromCodePoint(code), len };
}

/** Map a CSI numeric code (from `~` sequences) to a named key, or null. */
function tildeKey(code: string): string | null {
  switch (code) {
    case '1':
    case '7':
      return 'Home';
    case '2':
      return 'Insert';
    case '3':
      return 'Delete';
    case '4':
    case '8':
      return 'End';
    case '5':
      return 'PageUp';
    case '6':
      return 'PageDown';
    case '11':
      return 'F1';
    case '12':
      return 'F2';
    case '13':
      return 'F3';
    case '14':
      return 'F4';
    case '15':
      return 'F5';
    case '17':
      return 'F6';
    case '18':
      return 'F7';
    case '19':
      return 'F8';
    case '20':
      return 'F9';
    case '21':
      return 'F10';
    case '23':
      return 'F11';
    case '24':
      return 'F12';
    default:
      return null;
  }
}

/** Map a CSI/SS3 final letter to a named key (arrows, Home/End, Shift+Tab). */
function letterKey(ch: string): string | null {
  switch (ch) {
    case 'A':
      return 'Up';
    case 'B':
      return 'Down';
    case 'C':
      return 'Right';
    case 'D':
      return 'Left';
    case 'H':
      return 'Home';
    case 'F':
      return 'End';
    case 'Z':
      return 'Tab';
    default:
      return null;
  }
}

/** Map an SS3 final letter (application cursor keys + F1–F4). */
function ss3Key(ch: string): string | null {
  switch (ch) {
    case 'A':
      return 'Up';
    case 'B':
      return 'Down';
    case 'C':
      return 'Right';
    case 'D':
      return 'Left';
    case 'H':
      return 'Home';
    case 'F':
      return 'End';
    case 'P':
      return 'F1';
    case 'Q':
      return 'F2';
    case 'R':
      return 'F3';
    case 'S':
      return 'F4';
    default:
      return null;
  }
}

/** Parse an xterm modifier number (`;2` shift, `;3` alt, `;5` ctrl, bitmask-combined). */
function parseModifier(raw: string | undefined): { shift: boolean; alt: boolean; ctrl: boolean } {
  const mod = raw && raw !== '' ? parseInt(raw, 10) : 0;
  const bits = mod > 0 ? mod - 1 : 0;
  return { shift: (bits & 1) !== 0, alt: (bits & 2) !== 0, ctrl: (bits & 4) !== 0 };
}

/**
 * Parse a CSI (`ESC [ ...`) or SS3 (`ESC O ...`) sequence starting at `data[i]`.
 * Returns a parsed event, `INCOMPLETE`, or null (invalid → skip one byte).
 */
function parseSequence(data: Uint8Array, i: number, isSs3: boolean): Parsed | typeof INCOMPLETE | null {
  const start = i + 2;
  let j = start;
  while (j < data.length && !(data[j]! >= 0x40 && data[j]! <= 0x7e)) j++;
  if (j >= data.length) return INCOMPLETE;
  const final = data[j]!;
  const paramStr = String.fromCharCode(...data.subarray(start, j));
  const params = paramStr.split(';');
  const mod = parseModifier(params[1]);
  const seq = String.fromCharCode(...data.subarray(i, j + 1));
  const finalCh = String.fromCharCode(final);
  let key: string | null = null;
  if (final === 0x7e /* '~' */) {
    key = tildeKey(params[0] ?? '');
  } else {
    key = isSs3 ? ss3Key(finalCh) : letterKey(finalCh);
    // `Z` (Shift+Tab) via CSI implies shift.
    if (finalCh === 'Z') mod.shift = true;
  }
  if (key === null) return null;
  return { event: ev(key, seq, mod), next: j + 1 };
}

/** Parse an escape sequence starting at `data[i]` (which must be ESC). */
function parseEscape(data: Uint8Array, i: number): Parsed | typeof INCOMPLETE | null {
  if (i + 1 >= data.length) return INCOMPLETE; // lone ESC
  const b2 = data[i + 1]!;
  if (b2 === 0x5b /* '[' */) return parseSequence(data, i, false);
  if (b2 === 0x4f /* 'O' */) return parseSequence(data, i, true);
  if (b2 >= 0x20 && b2 <= 0x7e) {
    return { event: ev(String.fromCharCode(b2), '\x1b' + String.fromCharCode(b2), { alt: true }), next: i + 2 };
  }
  return INCOMPLETE;
}

/**
 * Incrementally parse raw key bytes. `pending` is the leftover from the previous
 * call (a lone ESC or an incomplete sequence); `buf` is newly arrived data. All
 * complete events are decoded; whatever cannot yet be decoded (a lone ESC, a
 * partial CSI/SS3, or a partial UTF-8 char) is returned as `rest`.
 */
export function parseKeys(buf: Uint8Array, pending: Uint8Array): { events: KeyEvent[]; rest: Uint8Array } {
  const data = new Uint8Array(pending.length + buf.length);
  data.set(pending, 0);
  data.set(buf, pending.length);
  const events: KeyEvent[] = [];
  let i = 0;
  while (i < data.length) {
    const b = data[i]!;
    if (b === 0x1b) {
      const res = parseEscape(data, i);
      if (res === INCOMPLETE) break;
      if (res === null) {
        i++;
        continue;
      }
      events.push(res.event);
      i = res.next;
    } else if (b === 0x0d) {
      events.push(ev('Enter', String.fromCharCode(b)));
      i++;
    } else if (b === 0x09) {
      events.push(ev('Tab', String.fromCharCode(b)));
      i++;
    } else if (b === 0x08 || b === 0x7f) {
      events.push(ev('Backspace', String.fromCharCode(b)));
      i++;
    } else if (b >= 0x01 && b <= 0x1a) {
      events.push(ev(String.fromCharCode(b + 96), String.fromCharCode(b), { ctrl: true }));
      i++;
    } else if (b >= 0x20 && b <= 0x7e) {
      events.push(ev(String.fromCharCode(b), String.fromCharCode(b)));
      i++;
    } else if (b >= 0x80) {
      const u = decodeUtf8(data, i);
      if (u === null) break; // partial or invalid UTF-8 → hold the tail in rest
      events.push(ev(u.char, String.fromCharCode(...data.subarray(i, i + u.len))));
      i += u.len;
    } else {
      i++; // other control byte: ignore
    }
  }
  return { events, rest: data.subarray(i) };
}

/**
 * Resolve a lone ESC held in `pending` into the `Escape` event after the caller's
 * 25 ms timeout. Consumes a leading ESC if present and returns the remaining rest.
 */
export function flushEscape(pending: Uint8Array): { event: KeyEvent; rest: Uint8Array } {
  if (pending.length > 0 && pending[0] === 0x1b) {
    return { event: ev('Escape', '\x1b'), rest: pending.subarray(1) };
  }
  return { event: ev('Escape', '\x1b'), rest: pending };
}
