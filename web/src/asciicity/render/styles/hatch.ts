/**
 * Pen-and-ink cross-hatch render style (docs/architecture.md §4.11 "hatch").
 * Pure helpers (`hatchLevel`, `hatchSpacing`, `buildHatchAtlas`) are safe to
 * import from node — no top-level side effects touch DOM or WebGL. GPU work
 * lives inside `makeUniforms` / `dispose`.
 */
import * as THREE from 'three';
import type { RenderStyle, StyleContext } from '../style';

/** Number of density levels in the atlas: 0 = blank paper, LEVEL_MAX = densest. */
const LEVEL_MAX = 7;
/** Atlas tile width in px. Each of the LEVEL_MAX + 1 tiles is a fixed panel. */
const TILE_W = 16;
/** Atlas tile height in px. */
const TILE_H = 32;
/** Ink stroke width in px, as required by §4.11. */
const INK_LINE_WIDTH = 1.5;
/** Density curve exponent; must match `STYLE_PRELUDE.shaped` gamma (§4.8). */
const GAMMA = 0.45;

/**
 * Density level for an exposed cell brightness `v` in [0, 1]. Mirrors the
 * fragment shader term for term: `floor((1 − v^GAMMA) · LEVEL_MAX + 0.5)`.
 * Result is an integer in [0, LEVEL_MAX] — 0 for blank paper, 7 for the
 * densest tile.
 */
export function hatchLevel(v: number): number {
  const clamped = Math.min(1, Math.max(0, v));
  const shaped = Math.pow(clamped, GAMMA);
  const raw = Math.floor((1 - shaped) * LEVEL_MAX + 0.5);
  return Math.min(LEVEL_MAX, Math.max(0, raw));
}

/**
 * Diagonal spacings, in px, for atlas level `level`. `fwd` is the "/" spacing,
 * `back` is the "\" spacing; `null` means "no diagonals of that orientation".
 * Level 0 is blank paper. Levels 1–4 draw "/" only, at spacings 16, 12, 8, 4
 * (`4 · (5 − L)`). Levels 5–7 keep the 4-px "/" set and add "\" at spacings
 * 12, 8, 4.
 */
export function hatchSpacing(level: number): { fwd: number | null; back: number | null } {
  if (level <= 0) return { fwd: null, back: null };
  if (level <= 4) return { fwd: 4 * (5 - level), back: null };
  if (level <= LEVEL_MAX) return { fwd: 4, back: 4 * (8 - level) };
  return { fwd: 4, back: 4 };
}

/**
 * Rasterise the 8-tile hatch atlas: paper-black background, white ink strokes
 * (the shader turns the red channel into a paper/ink `mix`). Tiles are laid
 * out in one horizontal row, `TILE_W · (LEVEL_MAX + 1)` wide by `TILE_H` tall.
 * Each tile is clipped so 45° strokes do not bleed into neighbours. The
 * caller supplies the canvas so the routine is testable in node.
 */
export function buildHatchAtlas(canvas: HTMLCanvasElement): {
  canvas: HTMLCanvasElement;
  count: number;
} {
  const count = LEVEL_MAX + 1;
  canvas.width = TILE_W * count;
  canvas.height = TILE_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('buildHatchAtlas: 2d context unavailable');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = INK_LINE_WIDTH;
  ctx.lineCap = 'butt';
  for (let level = 0; level < count; level++) {
    const spacing = hatchSpacing(level);
    const offsetX = level * TILE_W;
    ctx.save();
    ctx.beginPath();
    ctx.rect(offsetX, 0, TILE_W, TILE_H);
    ctx.clip();
    if (spacing.fwd !== null) drawDiagonals(ctx, offsetX, TILE_W, TILE_H, spacing.fwd, 'fwd');
    if (spacing.back !== null) drawDiagonals(ctx, offsetX, TILE_W, TILE_H, spacing.back, 'back');
    ctx.restore();
  }
  return { canvas, count };
}

/** Draw 45° diagonals through a tile, spaced `spacing` px along the x-axis. */
function drawDiagonals(
  ctx: CanvasRenderingContext2D,
  offsetX: number,
  tileW: number,
  tileH: number,
  spacing: number,
  dir: 'fwd' | 'back',
): void {
  for (let x = -tileH; x < tileW + tileH; x += spacing) {
    ctx.beginPath();
    if (dir === 'fwd') {
      ctx.moveTo(offsetX + x, tileH);
      ctx.lineTo(offsetX + x + tileH, 0);
    } else {
      ctx.moveTo(offsetX + x, 0);
      ctx.lineTo(offsetX + x + tileH, tileH);
    }
    ctx.stroke();
  }
}

/**
 * §4.11 hatch fragment. Prelude already declares tScene/grid/sub/gamma/vUv
 * and the helpers (`sampleSub`, `bright`, `shaped`); only tAtlas/levelCount
 * are extra. Paper/ink constants are inlined to match the spec. `sub` is 1×1
 * so `sampleSub(cell, 0, 0)` is the cell mean without the `cellMean` helper's
 * 8×8 loop (SwiftShader unrolls that loop even when it exits after one
 * iteration, which pushes the e2e cycle test past 60 s).
 */
const HATCH_FRAGMENT = `
uniform sampler2D tAtlas;
uniform float levelCount;
void main() {
  vec2 cell = floor(vUv * grid);
  float v = bright(sampleSub(cell, 0.0, 0.0));
  float lvl = clamp(floor((1.0 - shaped(v)) * (levelCount - 1.0) + 0.5), 0.0, levelCount - 1.0);
  vec2 inCell = fract(vUv * grid);
  float mask = texture2D(tAtlas, vec2((lvl + inCell.x) / levelCount, inCell.y)).r;
  vec3 paper = vec3(0.96, 0.93, 0.86);
  vec3 ink = vec3(0.13, 0.11, 0.10);
  gl_FragColor = vec4(mix(paper, ink, mask), 1.0);
}
`;

/** The `hatch` render style entry. Cell 6×12, sub 1×1, no depth texture. */
export const STYLES: readonly RenderStyle[] = [
  {
    id: 'hatch',
    label: 'HATCH',
    cellW: 6,
    cellH: 12,
    subX: 1,
    subY: 1,
    needsDepth: false,
    fragment: HATCH_FRAGMENT,
    makeUniforms(ctx: StyleContext): Record<string, THREE.IUniform> {
      const canvas = ctx.makeCanvas(1, 1);
      const built = buildHatchAtlas(canvas);
      const atlas = new THREE.CanvasTexture(built.canvas);
      atlas.minFilter = THREE.NearestFilter;
      atlas.magFilter = THREE.NearestFilter;
      atlas.flipY = true;
      atlas.needsUpdate = true;
      return {
        tAtlas: { value: atlas },
        levelCount: { value: built.count },
      };
    },
    dispose(uniforms: Record<string, THREE.IUniform>): void {
      const tex = uniforms.tAtlas?.value as THREE.Texture | undefined;
      tex?.dispose();
    },
  },
];
