/**
 * Braille render style (docs/architecture.md §4.11): each 2×4 set of scene
 * sub-samples becomes a Unicode-braille-ordered 8-dot cell, one of 256
 * procedural atlas tiles. Pure helpers (`BRAILLE_THRESHOLDS`, `brailleBits`,
 * `brailleDots`) are safe to import from node — no DOM/WebGL side effects.
 * GPU work lives in `makeUniforms` / `dispose`.
 */
import * as THREE from 'three';
import type { RenderStyle, StyleContext } from '../style';

/**
 * Per-dot thresholds, row-major top-first `T[r][c]` (docs/architecture.md
 * §4.11): dot `(c, r)` is lit when `shaped(bright(sample)) > T[r][c]`.
 */
export const BRAILLE_THRESHOLDS: number[][] = [
  [1 / 9, 5 / 9],
  [7 / 9, 3 / 9],
  [2 / 9, 6 / 9],
  [8 / 9, 4 / 9],
];

/**
 * Dot `(r, c)` for each of the 8 braille bits, in ascending bit order —
 * dots 1–3 left column rows 0–2 (bits 0–2), dots 4–6 right column rows 0–2
 * (bits 3–5), dot 7 left row 3 (bit 6), dot 8 right row 3 (bit 7).
 */
const DOT_CELL: readonly (readonly [number, number])[] = [
  [0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [3, 0], [3, 1],
];

/**
 * Map 8 cell luminances (row-major top-first, `lums[r * 2 + c]`) to a
 * Unicode-braille bitmask: bit `b` set when `lums[r*2+c] > T[r][c]`. Mirrors
 * the fragment shader's bit accumulation term for term.
 */
export function brailleBits(lums: number[]): number {
  let bits = 0;
  for (let b = 0; b < 8; b++) {
    const [r, c] = DOT_CELL[b];
    if (lums[r * 2 + c] > BRAILLE_THRESHOLDS[r][c]) bits |= 1 << b;
  }
  return bits;
}

/**
 * Inverse of `brailleBits`: the lit dots `[c, r][]` for a bitmask, in
 * ascending bit order.
 */
export function brailleDots(bits: number): [number, number][] {
  const dots: [number, number][] = [];
  for (let b = 0; b < 8; b++) {
    if (bits & (1 << b)) {
      const [r, c] = DOT_CELL[b];
      dots.push([c, r]);
    }
  }
  return dots;
}

/**
 * Rasterise the braille atlas: 256 tiles (one per bitmask) in a single row,
 * `16×32` px each, white dots radius 2.5 at x ∈ {4, 12}, y ∈ {4, 12, 20, 28}
 * (top-first), on black. Tile index = bitmask.
 */
export function buildBrailleAtlas(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const TILE_W = 16;
  const TILE_H = 32;
  canvas.width = 256 * TILE_W;
  canvas.height = TILE_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('buildBrailleAtlas: 2d context unavailable');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#fff';
  const XS = [4, 12];
  const YS = [4, 12, 20, 28];
  for (let bits = 0; bits < 256; bits++) {
    for (const [c, r] of brailleDots(bits)) {
      ctx.beginPath();
      ctx.arc(bits * TILE_W + XS[c], YS[r], 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return canvas;
}

/**
 * §4.11 fragment body. The prelude declares the sampler helpers; only `tAtlas`
 * is extra. Each of the 8 sub-samples is compared `shaped(bright(sample)) >
 * T[r][c]` to accumulate the tile bitmask (same test as `brailleBits`); the
 * cell is then tinted by `cellMean` and masked by that tile.
 *
 * `sampleSub` is bottom-first in `sy`; braille rows `r` are top-first, so
 * `sy = 3 − r`. Samples are named `s<c><r>`.
 */
const BRAILLE_FRAGMENT = `
uniform sampler2D tAtlas;
void main() {
  vec2 cell = floor(vUv * grid);
  vec3 s00 = sampleSub(cell, 0.0, 3.0); // c=0 r=0 top-left
  vec3 s10 = sampleSub(cell, 1.0, 3.0); // c=1 r=0 top-right
  vec3 s01 = sampleSub(cell, 0.0, 2.0); // c=0 r=1
  vec3 s11 = sampleSub(cell, 1.0, 2.0); // c=1 r=1
  vec3 s02 = sampleSub(cell, 0.0, 1.0); // c=0 r=2
  vec3 s12 = sampleSub(cell, 1.0, 1.0); // c=1 r=2
  vec3 s03 = sampleSub(cell, 0.0, 0.0); // c=0 r=3 bottom-left
  vec3 s13 = sampleSub(cell, 1.0, 0.0); // c=1 r=3 bottom-right
  vec3 mean = (s00 + s10 + s01 + s11 + s02 + s12 + s03 + s13) / 8.0;

  float bitsF =
      float(shaped(bright(s00)) > 1.0/9.0) * 1.0 +
      float(shaped(bright(s01)) > 7.0/9.0) * 2.0 +
      float(shaped(bright(s02)) > 2.0/9.0) * 4.0 +
      float(shaped(bright(s10)) > 5.0/9.0) * 8.0 +
      float(shaped(bright(s11)) > 3.0/9.0) * 16.0 +
      float(shaped(bright(s12)) > 6.0/9.0) * 32.0 +
      float(shaped(bright(s03)) > 8.0/9.0) * 64.0 +
      float(shaped(bright(s13)) > 4.0/9.0) * 128.0;

  vec2 inCell = fract(vUv * grid);
  float mask = texture2D(tAtlas, vec2((bitsF + inCell.x) / 256.0, inCell.y)).r;
  vec3 outCol = tintOf(mean) * clamp(shaped(bright(mean)) * 0.7 + 0.4, 0.0, 1.0) * mask;
  gl_FragColor = vec4(outCol, 1.0);
}
`;

/** The braille look: cell 6×12, 2×4 sub-samples, no depth texture. */
export const STYLES: readonly RenderStyle[] = [
  {
    id: 'braille',
    label: 'BRAILLE',
    cellW: 6,
    cellH: 12,
    subX: 2,
    subY: 4,
    needsDepth: false,
    fragment: BRAILLE_FRAGMENT,
    makeUniforms(ctx: StyleContext): Record<string, THREE.IUniform> {
      const canvas = buildBrailleAtlas(ctx.makeCanvas(1, 1));
      const atlas = new THREE.CanvasTexture(canvas);
      atlas.minFilter = THREE.LinearFilter;
      atlas.magFilter = THREE.LinearFilter;
      atlas.flipY = true;
      atlas.needsUpdate = true;
      return { tAtlas: { value: atlas } };
    },
    dispose(uniforms: Record<string, THREE.IUniform>): void {
      const tex = uniforms.tAtlas?.value as THREE.Texture | undefined;
      tex?.dispose();
    },
  },
];
