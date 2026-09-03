/**
 * PM-owned wire types for the JSON-lines protocol between the C bridge
 * (`bridge/nh-bridge.c`) and the TypeScript client (docs/architecture.md §3).
 * The bridge writes one JSON object per line on stdout; the client answers
 * `call`s that carry an `id` with one `ret` line on the bridge's stdin.
 * Keep in sync with the C side — the C side is the source of truth for
 * argument order, this file for names and shapes.
 */
import type { GlyphInfo } from '../model/types.js';

/** First line the bridge prints, before NetHack starts. Everything a client needs to decode glyphs. */
export interface HelloMsg {
  t: 'hello';
  /** Protocol version, bumped on incompatible change. Starts at 1. */
  proto: 1;
  /** NetHack version string, e.g. "5.0.0". */
  version: string;
  /** `S_*` cmap symbol name → index (from include/defsym.h), e.g. `{ S_stone: 0, S_vwall: 1, … }`. */
  S: Record<string, number>;
  /** Per cmap index: default character, description, default colour. Index = position. */
  cmap: Array<{ ch: string; desc: string; color: number }>;
  /** Window type name → NHW_* number (NHW_MESSAGE, NHW_STATUS, NHW_MAP, NHW_MENU, NHW_TEXT). */
  nhw: Record<string, number>;
  /** Status field name → BL_* index (BL_TITLE, BL_STR, …, BL_CONDITION, BL_FLUSH, BL_RESET). */
  bl: Record<string, number>;
  /** Menu selection mode name → value (PICK_NONE, PICK_ONE, PICK_ANY). */
  pick: Record<string, number>;
  /** Text attribute name → ATR_* value (ATR_NONE, ATR_BOLD, ATR_DIM, ATR_ULINE, ATR_BLINK, ATR_INVERSE). */
  atr: Record<string, number>;
  /** Glyph flag name → MG_* bit (MG_PET, MG_INVIS, MG_DETECT, MG_OBJPILE, …). */
  mg: Record<string, number>;
  /** Colour name → CLR_* index. */
  clr: Record<string, number>;
  /** Condition bit name → BL_MASK_* value (for BL_CONDITION status updates). */
  blmask: Record<string, number>;
  /** Anything else the bridge finds useful (free-form; clients must not depend on it). */
  extra?: Record<string, unknown>;
}

/** A window-procedure call forwarded by the bridge. `id` is present only when a `ret` reply is required. */
export interface CallMsg {
  t: 'call';
  id?: number;
  /** Window-proc name without the `shim_` prefix, e.g. "putstr", "print_glyph", "nhgetch". */
  name: string;
  /** Arguments in the C order; see architecture.md §3.3 for the per-call shapes. */
  args: unknown[];
}

/** Bridge is exiting: NetHack's main returned (or the bridge gave up). Last line ever printed. */
export interface ExitMsg {
  t: 'exit';
  code: number;
  reason?: string;
}

/** Diagnostic from the bridge (never needs a reply; clients may log it). */
export interface LogMsg {
  t: 'log';
  msg: string;
}

export type BridgeMsg = HelloMsg | CallMsg | ExitMsg | LogMsg;

/** The client's reply to a `call` that carried an `id`. Field meaning depends on the call (§3.3). */
export interface RetMsg {
  id: number;
  /** The primary return value: a number for int/char/boolean returns, a string for getlin, null for "no value". */
  ret: number | string | boolean | null;
  /** select_menu: chosen items as bridge-assigned identifier indices with counts (−1 = "all"). */
  selected?: Array<{ i: number; count: number }>;
  /** nh_poskey: mouse position and modifier when `ret` is 0 (a click). */
  x?: number;
  y?: number;
  mod?: number;
}

/** print_glyph argument shape: `[win, x, y, glyph, background]`. */
export type PrintGlyphArgs = [number, number, number, GlyphInfo, GlyphInfo | null];

/** add_menu argument shape: `[win, glyph|null, identIndex, accelerator, groupAccel, attr, color, text, itemflags]`. */
export type AddMenuArgs = [
  number,
  GlyphInfo | null,
  number,
  string,
  string,
  number,
  number,
  string,
  number,
];
