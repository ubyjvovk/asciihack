/**
 * Alternate looks for the ASCII quantizer (docs/terminal.md — Themes),
 * ported term-for-term from AsciiCity's `ascii.frag` shader. Pure functions:
 * inputs in linear 0..1, outputs in linear 0..1 (caller clamps and scales).
 *
 * In a shader the glyph coverage `mask` is a per-pixel value; in a terminal
 * the terminal draws the glyph itself, so `mask = 1` yields the foreground
 * colour of a cell and `mask = 0` yields the background colour of the same
 * cell.
 */

/** Named alternate looks selectable through `QuantizeOptions.theme`. */
export type Theme = 'cyber' | 'gloom' | 'solarized' | 'amber';

type Rgb = readonly [number, number, number];

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Numeric selector for `themeMix` (amber is not handled by `themeMix`; use `amberMix`). */
export function themeIndex(theme: Exclude<Theme, 'amber'>): number {
  switch (theme) {
    case 'cyber':
      return 0;
    case 'gloom':
      return 1;
    case 'solarized':
      return 2;
  }
}

/**
 * AsciiCity's cyber / gloom / solarized mixer. `tint` is the folded hue
 * (`c/max(v,0.02) · clamp(dens·0.7 + 0.4)`), `v` the exposed max channel.
 * Theme selects: `< 0.5` cyber, `< 1.5` gloom, otherwise solarized.
 */
export function themeMix(tint: Rgb, v: number, mask: number, theme: number): Rgb {
  const normalCol: Rgb = [tint[0] * mask, tint[1] * mask, tint[2] * mask];
  const lumT = 0.299 * tint[0] + 0.587 * tint[1] + 0.114 * tint[2];
  // smoothstep(0.92, 1.0, clamp(v)) — hot keeps sun/moon/lit windows bright
  const sx = clamp01((clamp01(v) - 0.92) / 0.08);
  const hot = sx * sx * (3 - 2 * sx);
  // gloom (theme 1)
  const gWash: Rgb = [
    (lumT + (tint[0] - lumT) * 0.75) * 0.2,
    (lumT + (tint[1] - lumT) * 0.75) * 0.2,
    (lumT + (tint[2] - lumT) * 0.75) * 0.2,
  ];
  const gGlyph: Rgb = [
    gWash[0] + (tint[0] * 0.9 - gWash[0]) * hot,
    gWash[1] + (tint[1] * 0.9 - gWash[1]) * hot,
    gWash[2] + (tint[2] * 0.9 - gWash[2]) * hot,
  ];
  const gloomBg: Rgb = [0.72, 0.73, 0.75];
  const gloomCol: Rgb = [
    gloomBg[0] + (gGlyph[0] - gloomBg[0]) * mask,
    gloomBg[1] + (gGlyph[1] - gloomBg[1]) * mask,
    gloomBg[2] + (gGlyph[2] - gloomBg[2]) * mask,
  ];
  // solarized (theme 2): base00 ink on base3 paper, hot → solarized yellow
  const sInk: Rgb = [
    (0.396 + (tint[0] - 0.396) * 0.5) * 0.75,
    (0.482 + (tint[1] - 0.482) * 0.5) * 0.75,
    (0.514 + (tint[2] - 0.514) * 0.5) * 0.75,
  ];
  const solY: Rgb = [0.71, 0.54, 0.0];
  const sGlyph: Rgb = [
    sInk[0] + (solY[0] - sInk[0]) * hot,
    sInk[1] + (solY[1] - sInk[1]) * hot,
    sInk[2] + (solY[2] - sInk[2]) * hot,
  ];
  const paper: Rgb = [0.992, 0.965, 0.89];
  const solCol: Rgb = [
    paper[0] + (sGlyph[0] - paper[0]) * mask,
    paper[1] + (sGlyph[1] - paper[1]) * mask,
    paper[2] + (sGlyph[2] - paper[2]) * mask,
  ];
  if (theme < 0.5) return normalCol;
  if (theme < 1.5) return gloomCol;
  return solCol;
}

/** Amber's own density curve: black-point cut then a steeper gamma. */
export function amberDensity(v: number, gamma: number, blackPoint: number): number {
  const span = Math.max(1 - blackPoint, 1e-6);
  return Math.pow(clamp01((v - blackPoint) / span), gamma * 1.5);
}

/**
 * Amber phosphor mixer. `rawTint` is the un-folded hue (`c/max(v,0.02)`, i.e.
 * pre-`dens·0.7 + 0.4`). Yields the glyph colour at `mask = 1` and the black
 * phosphor screen at `mask = 0`.
 */
export function amberMix(
  rawTint: Rgb,
  v: number,
  mask: number,
  gamma: number,
  blackPoint: number,
): Rgb {
  const aDens = amberDensity(v, gamma, blackPoint);
  const gr = clamp01((rawTint[1] - 0.5 * (rawTint[0] + rawTint[2])) * 2);
  const chroma: Rgb = [
    1.0 + (0.75 - 1.0) * gr,
    0.62 + (0.85 - 0.62) * gr,
    0.18 + (0.32 - 0.18) * gr,
  ];
  // smoothstep(0.82, 1.0, v)
  const t = clamp01((v - 0.82) / 0.18);
  const aHot = t * t * (3 - 2 * t);
  const scale = 0.18 + 0.82 * aDens;
  const glyphC: Rgb = [
    chroma[0] * scale + (1.0 - chroma[0] * scale) * aHot,
    chroma[1] * scale + (0.88 - chroma[1] * scale) * aHot,
    chroma[2] * scale + (0.58 - chroma[2] * scale) * aHot,
  ];
  return [glyphC[0] * mask, glyphC[1] * mask, glyphC[2] * mask];
}

/**
 * Theme background colour (mask = 0) as an sRGB 0–255 triple: black for
 * `cyber`/`amber`, the grey ground for `gloom`, the cream paper for
 * `solarized`. Used for overlay glyphs and pre-computed once per frame.
 */
export function themeBackground(theme: Theme): [number, number, number] {
  if (theme === 'amber') return [0, 0, 0];
  const mix = themeMix([0, 0, 0], 0, 0, themeIndex(theme));
  return [
    Math.round(clamp01(mix[0]) * 255),
    Math.round(clamp01(mix[1]) * 255),
    Math.round(clamp01(mix[2]) * 255),
  ];
}
