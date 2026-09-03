/**
 * PICO-8 render style (docs/architecture.md §4.11). Cell 4×4, sub 1×1.
 * The exposed scene sample is gamma-corrected, offset by a 4×4 Bayer
 * threshold and snapped to the nearest of the 16 PICO-8 palette colours
 * (squared-RGB distance). Pure helpers (`PICO8_PALETTE`, `bayer4`,
 * `nearestPico8`) are unit-tested in node; the fragment shader mirrors
 * them term for term.
 */
import * as THREE from 'three';
import type { RenderStyle, StyleContext } from '../style';

/** Parse `RRGGBB` into a normalised `[r, g, b]` in `[0, 1]`. */
function hex(rrggbb: string): readonly [number, number, number] {
  const n = parseInt(rrggbb, 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

/**
 * The 16 canonical PICO-8 palette colours in canonical index order
 * (docs/architecture.md §4.11): 0 black, 7 near-white (#FFF1E8), 11
 * pure green (#00E436).
 */
export const PICO8_PALETTE: readonly (readonly [number, number, number])[] = [
  hex('000000'), hex('1D2B53'), hex('7E2553'), hex('008751'),
  hex('AB5236'), hex('5F574F'), hex('C2C3C7'), hex('FFF1E8'),
  hex('FF004D'), hex('FFA300'), hex('FFEC27'), hex('00E436'),
  hex('29ADFF'), hex('83769C'), hex('FF77A8'), hex('FFCCAA'),
];

/**
 * The 4×4 Bayer matrix M (docs/architecture.md §4.11). Row `y`, column `x`;
 * `bayer4(x, y) = (M[y][x] + 0.5) / 16`.
 */
const BAYER4_M: readonly (readonly number[])[] = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/**
 * Bayer4 threshold at cell `(x, y)` (integer, non-negative; wraps mod 4).
 * Returns one of the 16 distinct values `(0.5/16, 1.5/16, …, 15.5/16)`,
 * strictly inside `(0, 1)`.
 */
export function bayer4(x: number, y: number): number {
  const bx = ((Math.floor(x) % 4) + 4) % 4;
  const by = ((Math.floor(y) % 4) + 4) % 4;
  return (BAYER4_M[by][bx] + 0.5) / 16;
}

/**
 * Index of the palette entry with the smallest squared-RGB distance to
 * `rgb`. Ties break to the lower index (first hit wins).
 */
export function nearestPico8(rgb: readonly [number, number, number]): number {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < PICO8_PALETTE.length; i++) {
    const [pr, pg, pb] = PICO8_PALETTE[i];
    const dr = rgb[0] - pr;
    const dg = rgb[1] - pg;
    const db = rgb[2] - pb;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * §4.11 fragment. `palette[16]` is a `vec3` array uniform (avoids any
 * texture lookups in the palette scan); `bayer4` is computed inline via
 * the recursive `M4[y][x] = M2[y/2][x/2] + 4·M2[y%2][x%2]` construction
 * (`M2 = [[0, 2], [3, 1]]`), which produces exactly the §4.11 matrix —
 * the same values `bayer4(x, y)` reads from `BAYER4_M`.
 */
const PICO8_FRAGMENT = `
uniform vec3 palette[16];
float bayer2at(float x, float y) {
  float a = step(0.5, x);
  float b = step(0.5, y);
  return mix(mix(0.0, 3.0, b), mix(2.0, 1.0, b), a);
}
float bayer4M(float bx, float by) {
  // M4[by][bx] = M2[by>>1][bx>>1] + 4·M2[by&1][bx&1], matching bayer4() = BAYER4_M.
  float x2 = mod(bx, 2.0);
  float y2 = mod(by, 2.0);
  float x1 = floor(bx * 0.5);
  float y1 = floor(by * 0.5);
  return bayer2at(x1, y1) + 4.0 * bayer2at(x2, y2);
}
void main() {
  vec2 cell = floor(vUv * grid);
  vec3 c = pow(clamp(sampleSub(cell, 0.0, 0.0), 0.0, 1.0), vec3(gamma));
  float bx = mod(cell.x, 4.0);
  float by = mod(cell.y, 4.0);
  // (bayer + 0.5)/16 − 0.5)/8 = (bayer − 7.5) / 128, pre-baked to save two divides per pixel.
  c += vec3((bayer4M(bx, by) - 7.5) * 0.0078125);
  // Prime with palette[0] so the loop only has to visit the remaining 15 entries;
  // channels are bounded so any bestDist ≥ 3.0 works as the initial upper bound.
  vec3 dInit = c - palette[0];
  float bestDist = dot(dInit, dInit);
  vec3 best = palette[0];
  for (int i = 1; i < 16; i++) {
    vec3 p = palette[i];
    vec3 d = c - p;
    float dist = dot(d, d);
    if (dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  gl_FragColor = vec4(best, 1.0);
}
`;

/** PICO-8 palette look, cell 4×4, no depth. `R` cycles, `?render=pico8`. */
export const STYLES: readonly RenderStyle[] = [
  {
    id: 'pico8',
    label: 'PICO8',
    cellW: 4,
    cellH: 4,
    subX: 1,
    subY: 1,
    needsDepth: false,
    fragment: PICO8_FRAGMENT,
    makeUniforms(_ctx: StyleContext): Record<string, THREE.IUniform> {
      const palette = PICO8_PALETTE.map(([r, g, b]) => new THREE.Vector3(r, g, b));
      return { palette: { value: palette } };
    },
  },
];
