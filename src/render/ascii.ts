/**
 * ASCII quantizer (docs/architecture.md §5.4): turns a linear-RGB `FrameBuffer`
 * into a `ScreenGrid` of glyph + 8-bit-colour cells using AsciiCity's ramp /
 * exposure / gamma formulas. Pure: no I/O, no globals.
 */
import type { FrameBuffer, ScreenCell, ScreenGrid } from '../model/types.js';

/** AsciiCity's ramp, sparsest to densest, as written in architecture.md §5.4 (first glyph is a space). */
export const DEFAULT_RAMP =
  " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$";

/** Tuning knobs for the quantizer (the alternate render styles only vary these). */
export interface QuantizeOptions {
  /** Glyph ramp, sparsest to densest. Defaults to `DEFAULT_RAMP`. */
  ramp?: string;
  /** Pre-exposure multiplier on linear RGB. Default 1.7. */
  exposure?: number;
  /** Density power (gamma). Default 0.45. */
  gamma?: number;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Density-to-ramp-index: `idx = clamp(round(dens(lum)^gamma * (count-1)))`
 * using the §5.4 formula. `lum` is the (already exposed) 0..1 brightness.
 */
export function glyphIndex(lum: number, count: number, gamma: number): number {
  const dens = Math.pow(clamp01(lum), gamma);
  return Math.min(Math.max(Math.floor(dens * (count - 1) + 0.5), 0), count - 1);
}

/** Quantize one non-overlay cell from a frame buffer at sample `i`. */
function cellFromRgb(
  rgb: Float32Array,
  off: number,
  ramp: string,
  exposure: number,
  gamma: number,
): ScreenCell {
  const r = rgb[off]! * exposure;
  const g = rgb[off + 1]! * exposure;
  const b = rgb[off + 2]! * exposure;
  const v = Math.max(r, g, b);
  const dens = Math.pow(clamp01(v), gamma);
  const idx = glyphIndex(v, ramp.length, gamma);
  const ch = ramp[idx] ?? ' ';
  const t = Math.max(v, 0.02);
  const boost = clamp01(dens * 0.7 + 0.4);
  const fg: [number, number, number] = [
    Math.round(clamp01((r / t) * boost) * 255),
    Math.round(clamp01((g / t) * boost) * 255),
    Math.round(clamp01((b / t) * boost) * 255),
  ];
  return { ch, fg, bg: [0, 0, 0] };
}

/** Quantize one overlay cell (verbatim glyph, exposed/clamped colour on black). */
function cellFromOverlay(
  overlayRgb: Float32Array,
  off: number,
  ch: string,
  exposure: number,
): ScreenCell {
  const fg: [number, number, number] = [
    Math.round(clamp01(overlayRgb[off]! * exposure) * 255),
    Math.round(clamp01(overlayRgb[off + 1]! * exposure) * 255),
    Math.round(clamp01(overlayRgb[off + 2]! * exposure) * 255),
  ];
  return { ch, fg, bg: [0, 0, 0] };
}

/**
 * Quantize a frame buffer into a freshly allocated `ScreenGrid` (one cell per
 * sample). Options default to exposure 1.7, gamma 0.45, `DEFAULT_RAMP`.
 */
export function quantize(fb: FrameBuffer, opts: QuantizeOptions = {}): ScreenGrid {
  const ramp = opts.ramp ?? DEFAULT_RAMP;
  const exposure = opts.exposure ?? 1.7;
  const gamma = opts.gamma ?? 0.45;
  const n = fb.width * fb.height;
  const cells: ScreenCell[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const overlay = fb.overlayCh[i];
    const off = i * 3;
    cells[i] =
      overlay !== 0
        ? cellFromOverlay(fb.overlayRgb, off, String.fromCharCode(overlay!), exposure)
        : cellFromRgb(fb.rgb, off, ramp, exposure, gamma);
  }
  return { width: fb.width, height: fb.height, cells };
}

/**
 * Quantize a frame buffer into a caller-owned `ScreenGrid`, reusing the grid's
 * cell objects (no per-frame cell allocation). The grid's `width`/`height` are
 * overwritten with the buffer's and cells beyond the needed count are ignored.
 */
export function quantizeInto(fb: FrameBuffer, grid: ScreenGrid, opts: QuantizeOptions = {}): ScreenGrid {
  const ramp = opts.ramp ?? DEFAULT_RAMP;
  const exposure = opts.exposure ?? 1.7;
  const gamma = opts.gamma ?? 0.45;
  grid.width = fb.width;
  grid.height = fb.height;
  const n = fb.width * fb.height;
  for (let i = 0; i < n; i++) {
    let cell = grid.cells[i];
    if (!cell) {
      cell = { ch: ' ', fg: [0, 0, 0], bg: [0, 0, 0] };
      grid.cells[i] = cell;
    }
    const overlay = fb.overlayCh[i];
    const off = i * 3;
    if (overlay !== 0) {
      const c = cellFromOverlay(fb.overlayRgb, off, String.fromCharCode(overlay!), exposure);
      cell.ch = c.ch;
      cell.fg = c.fg;
      cell.bg = [0, 0, 0];
    } else {
      const c = cellFromRgb(fb.rgb, off, ramp, exposure, gamma);
      cell.ch = c.ch;
      cell.fg = c.fg;
      cell.bg = [0, 0, 0];
    }
  }
  return grid;
}
