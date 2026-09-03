/**
 * ASCII / gloom / solarized / amber render styles (docs/architecture.md §4.8, §4.11).
 * Pure helpers (`DEFAULT_RAMP`, `glyphIndex`, `buildGlyphAtlas`, `themeMix`,
 * `amberDensity`, `amberMix`) are safe to import from node — no top-level
 * side effects touch DOM or WebGL. GPU work lives in `makeUniforms` / `dispose`.
 */
import * as THREE from 'three';
import type { RenderStyle, StyleContext } from '../style';

/** Default glyph ramp: sparsest (space) to densest ($), 68 glyphs. */
export const DEFAULT_RAMP =
  " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$";

/** Canvas `ctx.font` used when rasterising the glyph atlas. */
const ATLAS_FONT = 'bold 24px "DejaVu Sans Mono", "Courier New", monospace';

/**
 * Return the glyph index for a luminance in [0, 1]. Mirrors the fragment
 * shader formula exactly: `floor(clamp(lum,0,1)^gamma · (count−1) + 0.5)`,
 * clamped to `[0, count−1]`.
 */
export function glyphIndex(lum: number, count: number, gamma: number): number {
  const clamped = Math.min(1, Math.max(0, lum));
  const shaped = Math.pow(clamped, gamma);
  const raw = Math.floor(shaped * (count - 1) + 0.5);
  return Math.min(count - 1, Math.max(0, raw));
}

/**
 * Theme colour mixer mirroring the fragment shader's block term-for-term.
 * `theme` selects the output: 0 = cyber (`tint * mask`), 1 = gloom
 * (darker, more colourful glyphs over a bright grey sky, with hot near-white
 * cells kept bright), 2 = solarized (muted ink on cream paper). `v` is the
 * already-exposed max-channel brightness used to derive the `hot` highlight.
 * Pure, for tests.
 */
export function themeMix(
  tint: [number, number, number],
  v: number,
  mask: number,
  theme: number,
): [number, number, number] {
  const normalCol: [number, number, number] = [tint[0] * mask, tint[1] * mask, tint[2] * mask];
  const lumT = 0.299 * tint[0] + 0.587 * tint[1] + 0.114 * tint[2];
  // smoothstep(0.92, 1.0, clamp(v, 0, 1)) — hot keeps sun/moon/lit windows bright.
  const sx = Math.min(1, Math.max(0, (Math.min(1, Math.max(0, v)) - 0.92) / 0.08));
  const hot = sx * sx * (3 - 2 * sx);

  // Gloom theme (1): darker + more colour than T-0037, hot cells → tint * 0.9.
  const gWash: [number, number, number] = [
    (lumT + (tint[0] - lumT) * 0.75) * 0.2,
    (lumT + (tint[1] - lumT) * 0.75) * 0.2,
    (lumT + (tint[2] - lumT) * 0.75) * 0.2,
  ];
  const gGlyph: [number, number, number] = [
    gWash[0] + (tint[0] * 0.9 - gWash[0]) * hot,
    gWash[1] + (tint[1] * 0.9 - gWash[1]) * hot,
    gWash[2] + (tint[2] * 0.9 - gWash[2]) * hot,
  ];
  const gloomBg: [number, number, number] = [0.72, 0.73, 0.75];
  const gloomCol: [number, number, number] = [
    gloomBg[0] + (gGlyph[0] - gloomBg[0]) * mask,
    gloomBg[1] + (gGlyph[1] - gloomBg[1]) * mask,
    gloomBg[2] + (gGlyph[2] - gloomBg[2]) * mask,
  ];

  // Solarized theme (2): base00 ink on base3 paper, hot cells → solarized yellow.
  const sInk: [number, number, number] = [
    (0.396 + (tint[0] - 0.396) * 0.5) * 0.75,
    (0.482 + (tint[1] - 0.482) * 0.5) * 0.75,
    (0.514 + (tint[2] - 0.514) * 0.5) * 0.75,
  ];
  const solarizedYellow: [number, number, number] = [0.71, 0.54, 0.0];
  const sGlyph: [number, number, number] = [
    sInk[0] + (solarizedYellow[0] - sInk[0]) * hot,
    sInk[1] + (solarizedYellow[1] - sInk[1]) * hot,
    sInk[2] + (solarizedYellow[2] - sInk[2]) * hot,
  ];
  const paper: [number, number, number] = [0.992, 0.965, 0.89];
  const solCol: [number, number, number] = [
    paper[0] + (sGlyph[0] - paper[0]) * mask,
    paper[1] + (sGlyph[1] - paper[1]) * mask,
    paper[2] + (sGlyph[2] - paper[2]) * mask,
  ];

  if (theme < 0.5) return normalCol;
  if (theme < 1.5) return gloomCol;
  return solCol;
}

/**
 * Amber-theme density: black-point cut then a steeper gamma curve.
 * Mirrors the fragment shader: `pow(clamp((v − 0.06) / 0.94, 0, 1), gamma · 1.5)`.
 */
export function amberDensity(v: number, gamma: number): number {
  const aV = Math.min(1, Math.max(0, (v - 0.06) / 0.94));
  return Math.pow(aV, gamma * 1.5);
}

/**
 * Amber colour mixer mirroring the fragment shader term-for-term.
 * `rawTint` is the hue at full brightness (before the ascii luminance fold);
 * `v` is the exposed max-channel brightness (for density and the hot bloom);
 * `mask` is the glyph atlas coverage. Pure, for tests.
 */
export function amberMix(
  rawTint: [number, number, number],
  v: number,
  mask: number,
  gamma: number,
): [number, number, number] {
  const aDens = amberDensity(v, gamma);
  const gr = Math.min(1, Math.max(0, (rawTint[1] - 0.5 * (rawTint[0] + rawTint[2])) * 2));
  const chroma: [number, number, number] = [
    1.0 + (0.75 - 1.0) * gr,
    0.62 + (0.85 - 0.62) * gr,
    0.18 + (0.32 - 0.18) * gr,
  ];
  // smoothstep(0.82, 1.0, v) — hot cells (lamps, windows, sun/moon) bloom warm white.
  const t = Math.min(1, Math.max(0, (v - 0.82) / 0.18));
  const aHot = t * t * (3 - 2 * t);
  const scale = 0.18 + 0.82 * aDens;
  const glyphC: [number, number, number] = [
    chroma[0] * scale + (1.0 - chroma[0] * scale) * aHot,
    chroma[1] * scale + (0.88 - chroma[1] * scale) * aHot,
    chroma[2] * scale + (0.58 - chroma[2] * scale) * aHot,
  ];
  return [glyphC[0] * mask, glyphC[1] * mask, glyphC[2] * mask];
}

/**
 * Rasterise the glyph atlas: one row of `ramp.length` tiles, each `tileW×tileH`,
 * white glyph on black. The caller supplies the canvas so the routine is
 * testable in node with a fake canvas/context.
 */
export function buildGlyphAtlas(
  ramp: string,
  tileW: number,
  tileH: number,
  font: string,
  canvas: HTMLCanvasElement,
): { canvas: HTMLCanvasElement; count: number } {
  canvas.width = ramp.length * tileW;
  canvas.height = tileH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('buildGlyphAtlas: 2d context unavailable');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  for (let i = 0; i < ramp.length; i++) {
    ctx.fillText(ramp[i], i * tileW + tileW / 2, tileH / 2);
  }
  return { canvas, count: ramp.length };
}

/**
 * §4.8 / §4.11 fragment body. Prelude already declares tScene/grid/exposure/gamma/vUv
 * (and the helpers); only tAtlas/glyphCount/theme are extra. Local density is
 * `dens` so it does not clash with the prelude's `shaped()` helper. Themes 0–2
 * stay pixel-identical; theme ≥ 2.5 is amber (black-point density + warm chroma).
 */
const ASCII_FRAGMENT = `
uniform sampler2D tAtlas;
uniform float glyphCount;
uniform float theme;
void main() {
  vec2 cell = floor(vUv * grid);
  vec3 c = texture2D(tScene, (cell + 0.5) / grid).rgb * exposure;
  float v = max(max(c.r, c.g), c.b);                 // hue-independent brightness
  float dens = clamp(pow(clamp(v, 0.0, 1.0), gamma), 0.0, 1.0);
  float aV = clamp((v - 0.06) / 0.94, 0.0, 1.0);
  float aDens = pow(aV, gamma * 1.5);
  float idx = floor((theme < 2.5 ? dens : aDens) * (glyphCount - 1.0) + 0.5);
  vec2 inCell = fract(vUv * grid);
  float mask = texture2D(tAtlas, vec2((idx + inCell.x) / glyphCount, inCell.y)).r;
  vec3 tint = c / max(v, 0.02);                      // hue at full brightness…
  vec3 rawTint = tint;
  tint = tint * clamp(dens * 0.7 + 0.4, 0.0, 1.0);   // …density carries most of the luminance
  vec3 normalCol = tint * mask;
  float lumT = dot(tint, vec3(0.299, 0.587, 0.114));
  float hot = smoothstep(0.92, 1.0, clamp(v, 0.0, 1.0)); // sun/moon/lit windows stay bright
  vec3 gWash = mix(vec3(lumT), tint, 0.75) * 0.20;        // darker + more colour than T-0037
  vec3 gGlyph = mix(gWash, tint * 0.9, hot);
  vec3 gloomCol = mix(vec3(0.72, 0.73, 0.75), gGlyph, mask);
  vec3 sInk = mix(vec3(0.396, 0.482, 0.514), tint, 0.5) * 0.75; // solarized base00 ink
  vec3 sGlyph = mix(sInk, vec3(0.71, 0.54, 0.0), hot);          // hot → solarized yellow
  vec3 solCol = mix(vec3(0.992, 0.965, 0.890), sGlyph, mask);   // base3 paper
  float gr = clamp((rawTint.g - 0.5 * (rawTint.r + rawTint.b)) * 2.0, 0.0, 1.0);
  vec3 chroma = mix(vec3(1.00, 0.62, 0.18), vec3(0.75, 0.85, 0.32), gr);
  float aHot = smoothstep(0.82, 1.0, v);
  vec3 glyphC = mix(chroma * (0.18 + 0.82 * aDens), vec3(1.00, 0.88, 0.58), aHot);
  vec3 amberCol = glyphC * mask;
  vec3 outCol = theme < 0.5 ? normalCol : (theme < 1.5 ? gloomCol : solCol);
  outCol = theme < 2.5 ? outCol : amberCol;
  gl_FragColor = vec4(outCol, 1.0);
}
`;

/**
 * Build one ASCII-family style (`ascii` / `gloom` / `solarized` / `amber`).
 * Cell 6×12, sub 1×1, no depth texture.
 */
export function asciiStyle(id: string, label: string, theme: number): RenderStyle {
  return {
    id,
    label,
    cellW: 6,
    cellH: 12,
    subX: 1,
    subY: 1,
    needsDepth: false,
    fragment: ASCII_FRAGMENT,
    makeUniforms(ctx: StyleContext): Record<string, THREE.IUniform> {
      const canvas = ctx.makeCanvas(1, 1);
      const built = buildGlyphAtlas(DEFAULT_RAMP, 16, 32, ATLAS_FONT, canvas);
      const atlas = new THREE.CanvasTexture(built.canvas);
      atlas.minFilter = THREE.LinearFilter;
      atlas.magFilter = THREE.LinearFilter;
      atlas.flipY = true;
      atlas.needsUpdate = true;
      return {
        tAtlas: { value: atlas },
        glyphCount: { value: built.count },
        theme: { value: theme },
      };
    },
    dispose(uniforms: Record<string, THREE.IUniform>): void {
      const tex = uniforms.tAtlas?.value as THREE.Texture | undefined;
      tex?.dispose();
    },
  };
}

/** The four ASCII-family looks (`theme` 0–3). */
export const STYLES: readonly RenderStyle[] = [
  asciiStyle('ascii', 'ASCII', 0),
  asciiStyle('gloom', 'GLOOM', 1),
  asciiStyle('solarized', 'SOLARIZED', 2),
  asciiStyle('amber', 'AMBER', 3),
];
