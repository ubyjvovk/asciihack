/**
 * Dither + Game Boy render styles (docs/architecture.md §4.11): ordered
 * Bayer 8×8 thresholding, either 1-bit phosphor white or the 4-shade DMG
 * green palette. Pure helpers (`BAYER8`, `bayer8`, `ditherOn`,
 * `gameboyLevel`, `GAMEBOY_PALETTE`) are safe to import from node.
 */
import type { RenderStyle, StyleContext } from '../style';

/**
 * Standard 8×8 Bayer index matrix `M[y][x]` from architecture.md §4.11.
 * Threshold is `(M[y][x] + 0.5) / 64`.
 */
export const BAYER8: readonly (readonly number[])[] = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

/** Classic DMG 4-shade green, darkest → lightest (`#0f380f` `#306230` `#8bac0f` `#9bbc0f`). */
export const GAMEBOY_PALETTE: readonly [number, number, number][] = [
  hexToRgb('#0f380f'),
  hexToRgb('#306230'),
  hexToRgb('#8bac0f'),
  hexToRgb('#9bbc0f'),
];

/** Convert `#rrggbb` to a 0–1 RGB triple. */
function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * Bayer 8×8 threshold in (0, 1) for cell `(x, y)`. Wraps both axes by 8
 * (`bayer8(x, y) === bayer8(x + 8k, y + 8m)`).
 */
export function bayer8(x: number, y: number): number {
  const ix = ((Math.floor(x) % 8) + 8) % 8;
  const iy = ((Math.floor(y) % 8) + 8) % 8;
  return (BAYER8[iy][ix] + 0.5) / 64;
}

/**
 * Ordered-dither on/off for already-shaped brightness `v`. Mirrors the
 * fragment: `v > bayer8(x, y)`.
 */
export function ditherOn(v: number, x: number, y: number): boolean {
  return v > bayer8(x, y);
}

/**
 * 4-level Game Boy shade for already-shaped brightness `v`. Mirrors the
 * fragment: `clamp(floor(v·3 + bayer8(x, y)), 0, 3)`.
 */
export function gameboyLevel(v: number, x: number, y: number): number {
  return Math.min(3, Math.max(0, Math.floor(v * 3 + bayer8(x, y))));
}

/**
 * GLSL ES 1.0 Bayer lookup matching {@link bayer8} / {@link BAYER8} for
 * integer cell coordinates. Recursive 2×2 construction, finest bits first.
 */
const BAYER8_GLSL = `
float bayer8(vec2 cell) {
  vec2 q = mod(floor(cell), 8.0);
  vec2 t = mod(q, 2.0);
  float v = mix(
    mix(0.0, 3.0, step(1.0, t.y)),
    mix(2.0, 1.0, step(1.0, t.y)),
    step(1.0, t.x)
  );
  float s = 2.0;
  for (int i = 0; i < 2; i++) {
    vec2 u = mod(floor(q / s), 2.0);
    float off = mix(
      mix(0.0, 3.0, step(1.0, u.y)),
      mix(2.0, 1.0, step(1.0, u.y)),
      step(1.0, u.x)
    );
    v = 4.0 * v + off;
    s *= 2.0;
  }
  return (v + 0.5) / 64.0;
}
`;

/** 1-bit phosphor: on = `(0.9, 0.95, 0.9)`, off = black. */
const DITHER_FRAGMENT = `
${BAYER8_GLSL}
void main() {
  vec2 cell = floor(vUv * grid);
  float v = shaped(bright(cellMean(cell)));
  float b = bayer8(cell);
  vec3 col = v > b ? vec3(0.9, 0.95, 0.9) : vec3(0.0);
  gl_FragColor = vec4(col, 1.0);
}
`;

/** Four-shade DMG green from {@link GAMEBOY_PALETTE}. */
const GAMEBOY_FRAGMENT = `
${BAYER8_GLSL}
vec3 gbPalette(float level) {
  if (level < 0.5) return vec3(15.0, 56.0, 15.0) / 255.0;
  if (level < 1.5) return vec3(48.0, 98.0, 48.0) / 255.0;
  if (level < 2.5) return vec3(139.0, 172.0, 15.0) / 255.0;
  return vec3(155.0, 188.0, 15.0) / 255.0;
}
void main() {
  vec2 cell = floor(vUv * grid);
  float v = shaped(bright(cellMean(cell)));
  float b = bayer8(cell);
  float level = clamp(floor(v * 3.0 + b), 0.0, 3.0);
  gl_FragColor = vec4(gbPalette(level), 1.0);
}
`;

/**
 * Shared cell geometry for both looks: 2×2 px cells, one scene sample,
 * no depth texture (architecture.md §4.11).
 */
function ditherStyle(id: string, label: string, fragment: string): RenderStyle {
  return {
    id,
    label,
    cellW: 2,
    cellH: 2,
    subX: 1,
    subY: 1,
    needsDepth: false,
    fragment,
    makeUniforms(_ctx: StyleContext) {
      return {};
    },
  };
}

/** Ordered dither then Game Boy, matching `STYLE_ORDER`. */
export const STYLES: readonly RenderStyle[] = [
  ditherStyle('dither', 'DITHER', DITHER_FRAGMENT),
  ditherStyle('gameboy', 'GAMEBOY', GAMEBOY_FRAGMENT),
];
