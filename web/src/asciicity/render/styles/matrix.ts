/**
 * Matrix (digital rain) render style (docs/architecture.md §4.11, §4.20).
 * Pure helpers (`hash3`, `matrixGlyph`, `rainIntensity`, `matrixBrightness`,
 * hex-bitmap decode / ink / mirror / coverage order) are safe to import from
 * node — no top-level side effects touch DOM or WebGL. GPU work lives in
 * `makeUniforms` / `dispose`. The rain phase reads the common `time` uniform,
 * so there is no `update` hook.
 *
 * Glyphs are vendored 8×16 GNU Unifont bitmaps (half-width katakana U+FF66–
 * U+FF9D + digits 0–9), blitted horizontally mirrored, ordered by ink
 * coverage. Zero installed-font dependence.
 */
import * as THREE from 'three';
import type { RenderStyle, StyleContext } from '../style';

/**
 * GNU Unifont 17.0.05 `.hex` rows (32 hex chars = 16 bytes = 8×16). Keyed by
 * codepoint. Bitmap source; see `CREDITS.unifont`.
 */
export const GLYPHS: Record<number, string> = {
  0xff66: '00007E0202027E020202040408106000',
  0xff67: '00000000007E02041408080810102000',
  0xff68: '00000000000204081868080808080800',
  0xff69: '000000000808087F4141010202041800',
  0xff6a: '000000000000003E0808080808087F00',
  0xff6b: '000000000004047F040C142444040C00',
  0xff6c: '000000002020207F1112100808080800',
  0xff6d: '000000000000003C040404047F000000',
  0xff6e: '0000000000007E02027E02027E000000',
  0xff6f: '00000000000000292929020204083000',
  0xff70: '000000000000403F0000000000000000',
  0xff71: '00007F01090A0A080808081010202000',
  0xff72: '000101010202040C1464040404040400',
  0xff73: '000808087F4141410101010202041800',
  0xff74: '0000003E0808080808080808087F0000',
  0xff75: '0004047F040C0C141414242444040C00',
  0xff76: '000808087F0909090911111222224400',
  0xff77: '001010101E7008080F78080804040400',
  0xff78: '0008080F111121410202040408106000',
  0xff79: '002020203F2424440404040808102000',
  0xff7a: '0000007E0202020202020202027E0000',
  0xff7b: '001212127F1212121204040408081000',
  0xff7c: '00003800000071010102020408106000',
  0xff7d: '0000007E020404040808141222214100',
  0xff7e: '00101010101779111212101010080700',
  0xff7f: '00014141210102020204040808102000',
  0xff80: '0008080F111129450202040408106000',
  0xff81: '00020C384808087F0808080810106000',
  0xff82: '00005252524202040404080810204000',
  0xff83: '00003E0000007F080808080810102000',
  0xff84: '00202020202038242220202020202000',
  0xff85: '00080808087F08080808081010204000',
  0xff86: '0000003E0000000000000000007F0000',
  0xff87: '00007F010101221A04060A0911214000',
  0xff88: '000808087F0204040A19294808080800',
  0xff89: '00000202020202040404080810204000',
  0xff8a: '00001212121212111121212121414000',
  0xff8b: '00404040404046784040404040201E00',
  0xff8c: '00007F01010102020204040808102000',
  0xff8d: '00001028284444040202020101010000',
  0xff8e: '000808087F08082A2A2A494949080800',
  0xff8f: '00007E02020204242418181008080800',
  0xff90: '000038060100300C0200700C02010000',
  0xff91: '00080808080810101012222127394100',
  0xff92: '0001010102320A04060A091111204000',
  0xff93: '00003E080808087F0808080808080700',
  0xff94: '00202020277921121210100808080800',
  0xff95: '000000003C04040404040404047F0000',
  0xff96: '0000007E020202027E02020202027E00',
  0xff97: '00003C0000007E020202040408102000',
  0xff98: '00022222222222220204040408081000',
  0xff99: '000008282828282929292A2A4C4C4800',
  0xff9a: '00004040404040424242444448506000',
  0xff9b: '0000007E42424242424242427E420000',
  0xff9c: '00007E42424242020404040808102000',
  0xff9d: '00006010000101010102020408106000',
  0x0030: '00000000182442464A52624224180000',
  0x0031: '000000000818280808080808083E0000',
  0x0032: '000000003C4242020C102040407E0000',
  0x0033: '000000003C4242021C020242423C0000',
  0x0034: '00000000040C142444447E0404040000',
  0x0035: '000000007E4040407C020202423C0000',
  0x0036: '000000001C2040407C424242423C0000',
  0x0037: '000000007E0202040404080808080000',
  0x0038: '000000003C4242423C424242423C0000',
  0x0039: '000000003C4242423E02020204380000',
};

/** Half-width katakana U+FF66–U+FF9D (56) + digits 0–9 (10). */
export const MATRIX_GLYPH_COUNT = 66;

/** Atlas tile size: 2× nearest-neighbour scale of the 8×16 Unifont cell. */
const TILE_W = 16;
const TILE_H = 32;
const SRC_W = 8;
const SRC_H = 16;

const CHARSET: readonly number[] = (() => {
  const cps: number[] = [];
  for (let cp = 0xff66; cp <= 0xff9d; cp++) cps.push(cp);
  for (let cp = 0x0030; cp <= 0x0039; cp++) cps.push(cp);
  return cps;
})();

/** One coverage-sorted atlas glyph. */
export interface MatrixGlyph {
  /** Unicode codepoint (katakana or digit). */
  codepoint: number;
  /** Decoded 8×16 bitmap, row-major, col 0 = left, before mirroring. */
  bitmap: boolean[][];
  /** Count of set bits in `bitmap`. */
  ink: number;
}

/**
 * Decode a 32-hex-char Unifont row into an 8×16 boolean bitmap.
 * Each pair of hex digits is one row; the MSB is the leftmost pixel.
 */
export function decodeGlyph(hex: string): boolean[][] {
  if (hex.length !== 32) {
    throw new Error(`decodeGlyph: expected 32 hex chars, got ${hex.length}`);
  }
  const rows: boolean[][] = [];
  for (let r = 0; r < SRC_H; r++) {
    const byte = parseInt(hex.slice(r * 2, r * 2 + 2), 16);
    const row: boolean[] = [];
    for (let c = 0; c < SRC_W; c++) {
      row.push((byte & (0x80 >> c)) !== 0);
    }
    rows.push(row);
  }
  return rows;
}

/** Count of set bits in an 8×16 bitmap. */
export function inkCount(bitmap: boolean[][]): number {
  let n = 0;
  for (const row of bitmap) {
    for (const bit of row) if (bit) n++;
  }
  return n;
}

/** Horizontal mirror of an 8×16 bitmap (each row reversed). Does not mutate. */
export function mirrorGlyph(bitmap: boolean[][]): boolean[][] {
  return bitmap.map((row) => {
    const out = row.slice();
    out.reverse();
    return out;
  });
}

function glyphHex(cp: number): string {
  const hex = GLYPHS[cp];
  if (hex === undefined) {
    throw new Error(`matrix: missing Unifont glyph U+${cp.toString(16).toUpperCase()}`);
  }
  return hex;
}

const ORDERED: readonly MatrixGlyph[] = CHARSET.map((codepoint) => {
  const bitmap = decodeGlyph(glyphHex(codepoint));
  return { codepoint, bitmap, ink: inkCount(bitmap) };
}).sort((a, b) => a.ink - b.ink || a.codepoint - b.codepoint);

/**
 * Glyphs in atlas order: ink coverage ascending, codepoint as the
 * deterministic tie-break. Computed once from the vendored bitmaps.
 */
export function orderedGlyphs(): readonly MatrixGlyph[] {
  return ORDERED;
}

/**
 * Rasterise the mirrored Unifont bitmaps onto `canvas` as one row of 16×32
 * tiles, nearest-neighbour (chunky 2×2 pixels). White ink on black.
 * Tile index = coverage rank (see {@link orderedGlyphs}).
 */
export function buildMatrixAtlas(
  canvas: HTMLCanvasElement,
): { canvas: HTMLCanvasElement; count: number } {
  const glyphs = orderedGlyphs();
  const count = glyphs.length;
  canvas.width = count * TILE_W;
  canvas.height = TILE_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('buildMatrixAtlas: 2d context unavailable');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#fff';
  for (let i = 0; i < count; i++) {
    const mirrored = mirrorGlyph(glyphs[i].bitmap);
    const destX = i * TILE_W;
    for (let gy = 0; gy < TILE_H; gy++) {
      const srcY = Math.min(SRC_H - 1, Math.floor((gy * SRC_H) / TILE_H));
      const row = mirrored[srcY];
      for (let gx = 0; gx < TILE_W; gx++) {
        const srcX = Math.min(SRC_W - 1, Math.floor((gx * SRC_W) / TILE_W));
        if (row[srcX]) ctx.fillRect(destX + gx, gy, 1, 1);
      }
    }
  }
  return { canvas, count };
}

/** GLSL `fract`: `x − floor(x)`, always in [0, 1) for finite inputs. */
function fract(x: number): number {
  return x - Math.floor(x);
}

/**
 * Deterministic hash in [0, 1). Mirrors the fragment
 * `fract(sin(a·12.9898 + b·78.233 + c·37.719)·43758.5453)`.
 */
export function hash3(a: number, b: number, c: number): number {
  return fract(Math.sin(a * 12.9898 + b * 78.233 + c * 37.719) * 43758.5453);
}

/**
 * Glyph index for a cell at `timeS`, in `[0, count)`. Window is
 * `floor(timeS · 2 + 7 · hash(cellX, cellY, 0))` — about twice a second,
 * with a per-cell phase — then `floor(hash · count)`.
 */
export function matrixGlyph(
  cellX: number,
  cellY: number,
  timeS: number,
  count: number,
  S = 0,
): number {
  const window = Math.floor(timeS * 2 + 7 * hash3(cellX, cellY, 0));
  const base = S * (count - 1);
  const jitter = (hash3(cellX, cellY, window) - 0.5) * 8;
  return Math.min(count - 1, Math.max(0, Math.round(base + jitter)));
}

/**
 * Rain-trail intensity `I = pow(trail, 4)` in [0, 1] at column `colX`,
 * screen `y01` (`vUv.y`, 0 = bottom) and time `timeS`.
 * `trail = fract(phase − time · speed · 0.25 − y01)`; the minus on the
 * time term sends the head toward `y01 = 0`. Head when `trail > 0.96`.
 */
export function rainIntensity(colX: number, y01: number, timeS: number): number {
  const speed = 0.3 + 0.7 * hash3(colX, 1, 0);
  const phase = hash3(colX, 2, 0);
  const trail = fract(phase - timeS * speed * 0.25 - y01);
  return Math.pow(trail, 4);
}

/**
 * Body / head RGB (no glyph mask) for scene density `S` and rain `I`.
 * Body: `(0.2, 1.0, 0.3) · (S · (0.7 + 0.3 · I) + 0.25 · I)`.
 * Head: `(0.9, 1.0, 0.9) · (0.6 + 0.4 · S)`.
 */
export function matrixBrightness(
  S: number,
  I: number,
  head: boolean,
): [number, number, number] {
  if (head) {
    const k = 0.6 + 0.4 * S;
    return [0.9 * k, 1.0 * k, 0.9 * k];
  }
  const k = S * (0.7 + 0.3 * I) + 0.25 * I;
  return [0.2 * k, 1.0 * k, 0.3 * k];
}

/**
 * §4.11 matrix fragment. Prelude already declares tScene/grid/exposure/gamma
 * /time/vUv and the helpers; only tAtlas/glyphCount are extra. Local names
 * avoid clashing with `shaped` / `bright`.
 */
const MATRIX_FRAGMENT = `
uniform sampler2D tAtlas;
uniform float glyphCount;
float hash3(float a, float b, float c) {
  return fract(sin(a * 12.9898 + b * 78.233 + c * 37.719) * 43758.5453);
}
vec3 matrixBrightness(float S, float I, bool head) {
  if (head) return vec3(0.9, 1.0, 0.9) * (0.6 + 0.4 * S);
  return vec3(0.2, 1.0, 0.3) * (S * (0.7 + 0.3 * I) + 0.25 * I);
}
void main() {
  vec2 cell = floor(vUv * grid);
  vec3 scene = cellMean(cell);
  float S = shaped(bright(scene));
  float window = floor(time * 2.0 + 7.0 * hash3(cell.x, cell.y, 0.0));
  float jitter = (hash3(cell.x, cell.y, window) - 0.5) * 8.0;
  float idx = clamp(floor(S * (glyphCount - 1.0) + jitter + 0.5), 0.0, glyphCount - 1.0);
  vec2 inCell = fract(vUv * grid);
  float mask = texture2D(tAtlas, vec2((idx + inCell.x) / glyphCount, inCell.y)).r;
  float speed = 0.3 + 0.7 * hash3(cell.x, 1.0, 0.0);
  float phase = hash3(cell.x, 2.0, 0.0);
  float trail = fract(phase - time * speed * 0.25 - vUv.y);
  float I = pow(trail, 4.0);
  vec3 outCol = matrixBrightness(S, I, trail > 0.96) * mask;
  gl_FragColor = vec4(outCol, 1.0);
}
`;

/**
 * Digital-rain style: mirrored Unifont katakana atlas, cell 6×12, sub 1×1,
 * no depth texture.
 */
export const STYLES: readonly RenderStyle[] = [
  {
    id: 'matrix',
    label: 'MATRIX',
    cellW: 6,
    cellH: 12,
    subX: 1,
    subY: 1,
    needsDepth: false,
    fragment: MATRIX_FRAGMENT,
    makeUniforms(ctx: StyleContext): Record<string, THREE.IUniform> {
      const canvas = ctx.makeCanvas(1, 1);
      const built = buildMatrixAtlas(canvas);
      const atlas = new THREE.CanvasTexture(built.canvas);
      atlas.minFilter = THREE.LinearFilter;
      atlas.magFilter = THREE.LinearFilter;
      atlas.flipY = true;
      atlas.needsUpdate = true;
      return {
        tAtlas: { value: atlas },
        glyphCount: { value: built.count },
      };
    },
    dispose(uniforms: Record<string, THREE.IUniform>): void {
      const tex = uniforms.tAtlas?.value as THREE.Texture | undefined;
      tex?.dispose();
    },
  },
];
