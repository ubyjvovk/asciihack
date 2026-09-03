/**
 * ASCII quantizer (docs/architecture.md §5.4): turns a linear-RGB `FrameBuffer`
 * into a `ScreenGrid` of glyph + 8-bit-colour cells using AsciiCity's ramp /
 * exposure / gamma formulas, with a selectable `theme` for the colour mix
 * (see `src/render/themes.ts` and docs/terminal.md — Themes). Pure: no I/O,
 * no globals.
 */
import type { FrameBuffer, ScreenCell, ScreenGrid } from '../model/types.js';
import {
  amberDensity,
  amberMix,
  themeBackground,
  themeIndex,
  themeMix,
  type Theme,
} from './themes.js';

/** AsciiCity's ramp, sparsest to densest, as written in architecture.md §5.4 (first glyph is a space). */
export const DEFAULT_RAMP =
  " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$";

/** Tuning knobs for the quantizer (the alternate render styles vary these and `theme`). */
export interface QuantizeOptions {
  /** Glyph ramp, sparsest to densest. Defaults to `DEFAULT_RAMP`. */
  ramp?: string;
  /** Pre-exposure multiplier on linear RGB. Default 1.7. */
  exposure?: number;
  /** Density power (gamma). Default 0.9. */
  gamma?: number;
  /** Black-point cutoff on the exposed brightness `v`: `vc = clamp((v − bp)/(1 − bp))`. Default 0.10. */
  blackPoint?: number;
  /** Colour theme (see docs/terminal.md — Themes). Default `'cyber'`. */
  theme?: Theme;
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

/** Round a linear 0..1 mix to an sRGB 0–255 triple (clamping negatives / >1). */
function toRgb255(mix: readonly [number, number, number]): [number, number, number] {
  return [
    Math.round(clamp01(mix[0]) * 255),
    Math.round(clamp01(mix[1]) * 255),
    Math.round(clamp01(mix[2]) * 255),
  ];
}

/** Quantize one non-overlay cell from a frame buffer at sample offset `off`. */
function cellFromRgb(
  rgb: Float32Array,
  off: number,
  ramp: string,
  exposure: number,
  gamma: number,
  blackPoint: number,
  theme: Theme,
  bg: readonly [number, number, number],
): ScreenCell {
  const r = rgb[off]! * exposure;
  const g = rgb[off + 1]! * exposure;
  const b = rgb[off + 2]! * exposure;
  const v = Math.max(r, g, b);
  const t = Math.max(v, 0.02);
  const rawTint: [number, number, number] = [r / t, g / t, b / t];

  if (theme === 'amber') {
    const aDens = amberDensity(v, gamma, blackPoint);
    const idx = Math.min(
      Math.max(Math.floor(aDens * (ramp.length - 1) + 0.5), 0),
      ramp.length - 1,
    );
    const fg = toRgb255(amberMix(rawTint, v, 1, gamma, blackPoint));
    return { ch: ramp[idx] ?? ' ', fg, bg: [bg[0], bg[1], bg[2]] };
  }

  const span = Math.max(1 - blackPoint, 1e-6);
  const vc = clamp01((v - blackPoint) / span);
  const dens = Math.pow(vc, gamma);
  const idx = Math.min(
    Math.max(Math.floor(dens * (ramp.length - 1) + 0.5), 0),
    ramp.length - 1,
  );
  const grey = 0.299 * rawTint[0] + 0.587 * rawTint[1] + 0.114 * rawTint[2];
  const sat = clamp01(dens * 1.5);
  const desat: [number, number, number] = [
    grey + (rawTint[0] - grey) * sat,
    grey + (rawTint[1] - grey) * sat,
    grey + (rawTint[2] - grey) * sat,
  ];
  const boost = clamp01(dens * 0.7 + 0.4);
  const tint: [number, number, number] = [desat[0] * boost, desat[1] * boost, desat[2] * boost];
  const fg = toRgb255(themeMix(tint, v, 1, themeIndex(theme)));
  return { ch: ramp[idx] ?? ' ', fg, bg: [bg[0], bg[1], bg[2]] };
}

/** Quantize one overlay cell (verbatim glyph, exposed/clamped colour on the theme bg). */
function cellFromOverlay(
  overlayRgb: Float32Array,
  off: number,
  ch: string,
  exposure: number,
  bg: readonly [number, number, number],
): ScreenCell {
  const fg: [number, number, number] = [
    Math.round(clamp01(overlayRgb[off]! * exposure) * 255),
    Math.round(clamp01(overlayRgb[off + 1]! * exposure) * 255),
    Math.round(clamp01(overlayRgb[off + 2]! * exposure) * 255),
  ];
  return { ch, fg, bg: [bg[0], bg[1], bg[2]] };
}

/**
 * Quantize a frame buffer into a freshly allocated `ScreenGrid` (one cell per
 * sample). Options default to exposure 1.7, gamma 0.9, blackPoint 0.10,
 * `DEFAULT_RAMP`, theme `'cyber'`.
 */
export function quantize(fb: FrameBuffer, opts: QuantizeOptions = {}): ScreenGrid {
  const ramp = opts.ramp ?? DEFAULT_RAMP;
  const exposure = opts.exposure ?? 1.7;
  const gamma = opts.gamma ?? 0.9;
  const blackPoint = opts.blackPoint ?? 0.10;
  const theme = opts.theme ?? 'cyber';
  const bg = themeBackground(theme);
  const n = fb.width * fb.height;
  const cells: ScreenCell[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const overlay = fb.overlayCh[i];
    const off = i * 3;
    cells[i] =
      overlay !== 0
        ? cellFromOverlay(fb.overlayRgb, off, String.fromCharCode(overlay!), exposure, bg)
        : cellFromRgb(fb.rgb, off, ramp, exposure, gamma, blackPoint, theme, bg);
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
  const gamma = opts.gamma ?? 0.9;
  const blackPoint = opts.blackPoint ?? 0.10;
  const theme = opts.theme ?? 'cyber';
  const bg = themeBackground(theme);
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
    const c =
      overlay !== 0
        ? cellFromOverlay(fb.overlayRgb, off, String.fromCharCode(overlay!), exposure, bg)
        : cellFromRgb(fb.rgb, off, ramp, exposure, gamma, blackPoint, theme, bg);
    cell.ch = c.ch;
    cell.fg = c.fg;
    cell.bg = c.bg;
  }
  return grid;
}
