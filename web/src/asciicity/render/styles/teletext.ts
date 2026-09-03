/**
 * Teletext (Ceefax sixel mosaic) render style (docs/architecture.md §4.11).
 * Pure helpers (`TELETEXT_PALETTE`, `teletextIndex`, `sixelBits`) are safe
 * to import from node — no top-level side effects touch DOM or WebGL.
 * Drawing is analytic (no atlas); `makeUniforms` returns `{}`.
 */
import type { RenderStyle, StyleContext } from '../style';

/** One RGB triple with channels in [0, 1]. */
export type TeletextRgb = readonly [number, number, number];

/**
 * The eight teletext colours in index order: black, red, green, yellow,
 * blue, magenta, cyan, white. Every component is 0 or 1.
 */
export const TELETEXT_PALETTE: readonly TeletextRgb[] = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, 1],
];

/** Hue-independent brightness: clamp(max channel, 0, 1). Mirrors `bright()`. */
function bright3(r: number, g: number, b: number): number {
  return Math.min(1, Math.max(0, Math.max(r, g, b)));
}

/**
 * Return the palette index of `rgb` (the mean exposed colour of on sixels).
 * Black (0) only when `bright(rgb) < 0.15`; otherwise nearest of the eight
 * 0/1 colours to `tintOf(rgb)` after normalising so its max channel is 1.
 * Mirrors the fragment shader term-for-term.
 */
export function teletextIndex(rgb: TeletextRgb): number {
  const r = rgb[0];
  const g = rgb[1];
  const b = rgb[2];
  const br = bright3(r, g, b);
  if (br < 0.15) return 0;
  // tintOf: divide by max(bright, 0.02), then normalise max channel to 1
  // (exposed samples can exceed 1, so tintOf alone would not sit on the cube).
  const tintDenom = Math.max(br, 0.02);
  let n0 = r / tintDenom;
  let n1 = g / tintDenom;
  let n2 = b / tintDenom;
  const peak = Math.max(n0, n1, n2);
  n0 /= peak;
  n1 /= peak;
  n2 /= peak;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < TELETEXT_PALETTE.length; i++) {
    const p = TELETEXT_PALETTE[i];
    const dr = n0 - p[0];
    const dg = n1 - p[1];
    const db = n2 - p[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Pack the six sixel bits. `lums` is six shaped-brightness values in
 * bottom-first order: sample `(x, y)` → index `y·2 + x` (`y` = 0 bottom).
 * Bit `k` is on when `lums[k] > mean`; all-equal (none strictly above the
 * mean) → 63 (every sixel on).
 */
export function sixelBits(lums: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < 6; i++) sum += lums[i];
  const mean = sum / 6;
  let bits = 0;
  for (let i = 0; i < 6; i++) {
    if (lums[i] > mean) bits |= 1 << i;
  }
  return bits === 0 ? 63 : bits;
}

/**
 * §4.11 teletext fragment. Prelude already declares tScene/grid/sub/exposure
 * /gamma/vUv and the helpers; no extra uniforms. Sixel geometry is analytic
 * from `fract(vUv * grid)` — 2×3, bottom-first, matching `sampleSub`.
 */
const TELETEXT_FRAGMENT = `
void main() {
  vec2 cell = floor(vUv * grid);
  vec3 s0 = sampleSub(cell, 0.0, 0.0);
  vec3 s1 = sampleSub(cell, 1.0, 0.0);
  vec3 s2 = sampleSub(cell, 0.0, 1.0);
  vec3 s3 = sampleSub(cell, 1.0, 1.0);
  vec3 s4 = sampleSub(cell, 0.0, 2.0);
  vec3 s5 = sampleSub(cell, 1.0, 2.0);
  float l0 = shaped(bright(s0));
  float l1 = shaped(bright(s1));
  float l2 = shaped(bright(s2));
  float l3 = shaped(bright(s3));
  float l4 = shaped(bright(s4));
  float l5 = shaped(bright(s5));
  float mean = (l0 + l1 + l2 + l3 + l4 + l5) / 6.0;
  float b0 = l0 > mean ? 1.0 : 0.0;
  float b1 = l1 > mean ? 1.0 : 0.0;
  float b2 = l2 > mean ? 1.0 : 0.0;
  float b3 = l3 > mean ? 1.0 : 0.0;
  float b4 = l4 > mean ? 1.0 : 0.0;
  float b5 = l5 > mean ? 1.0 : 0.0;
  float onCount = b0 + b1 + b2 + b3 + b4 + b5;
  if (onCount < 0.5) {
    b0 = 1.0;
    b1 = 1.0;
    b2 = 1.0;
    b3 = 1.0;
    b4 = 1.0;
    b5 = 1.0;
    onCount = 6.0;
  }
  vec3 meanOn = (s0 * b0 + s1 * b1 + s2 * b2 + s3 * b3 + s4 * b4 + s5 * b5) / onCount;

  float br = bright(meanOn);
  vec3 fg = vec3(0.0);
  if (br >= 0.15) {
    vec3 n = tintOf(meanOn);
    float peak = max(n.r, max(n.g, n.b));
    n = n / peak;
    float bestD = 1.0e9;
    vec3 pal = vec3(0.0, 0.0, 0.0);
    vec3 dlt = n - pal;
    float d = dot(dlt, dlt);
    if (d < bestD) { bestD = d; fg = pal; }
    pal = vec3(1.0, 0.0, 0.0);
    dlt = n - pal;
    d = dot(dlt, dlt);
    if (d < bestD) { bestD = d; fg = pal; }
    pal = vec3(0.0, 1.0, 0.0);
    dlt = n - pal;
    d = dot(dlt, dlt);
    if (d < bestD) { bestD = d; fg = pal; }
    pal = vec3(1.0, 1.0, 0.0);
    dlt = n - pal;
    d = dot(dlt, dlt);
    if (d < bestD) { bestD = d; fg = pal; }
    pal = vec3(0.0, 0.0, 1.0);
    dlt = n - pal;
    d = dot(dlt, dlt);
    if (d < bestD) { bestD = d; fg = pal; }
    pal = vec3(1.0, 0.0, 1.0);
    dlt = n - pal;
    d = dot(dlt, dlt);
    if (d < bestD) { bestD = d; fg = pal; }
    pal = vec3(0.0, 1.0, 1.0);
    dlt = n - pal;
    d = dot(dlt, dlt);
    if (d < bestD) { bestD = d; fg = pal; }
    pal = vec3(1.0, 1.0, 1.0);
    dlt = n - pal;
    d = dot(dlt, dlt);
    if (d < bestD) { bestD = d; fg = pal; }
  }

  vec2 inCell = fract(vUv * grid);
  float sx = inCell.x < 0.5 ? 0.0 : 1.0;
  float sy = min(floor(inCell.y * 3.0), 2.0);
  float k = sy * 2.0 + sx;
  float mask = 0.0;
  if (k < 0.5) mask = b0;
  else if (k < 1.5) mask = b1;
  else if (k < 2.5) mask = b2;
  else if (k < 3.5) mask = b3;
  else if (k < 4.5) mask = b4;
  else mask = b5;

  gl_FragColor = vec4(fg * mask, 1.0);
}
`;

/**
 * Ceefax sixel mosaic. Cell 6×12, sub 2×3, no depth texture. Analytic
 * drawing — `makeUniforms` has nothing to allocate.
 */
export const STYLES: readonly RenderStyle[] = [
  {
    id: 'teletext',
    label: 'TELETEXT',
    cellW: 6,
    cellH: 12,
    subX: 2,
    subY: 3,
    needsDepth: false,
    fragment: TELETEXT_FRAGMENT,
    makeUniforms(_ctx: StyleContext) {
      return {};
    },
  },
];
