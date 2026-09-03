/**
 * Blocks render style — ANSI quadrant art (docs/architecture.md §4.11).
 * Each 6×12 cell is split into four 3×6 quadrants; every quadrant is a solid
 * block that is lit when its shaded brightness exceeds the cell mean. All
 * pixel work is analytic (no atlas), so there is nothing to rasterise in
 * `makeUniforms`. The pure helpers (`quadrantBits`, `splitMeans`) mirror the
 * fragment term for term and never touch DOM/WebGL.
 */
import type * as THREE from 'three';
import type { RenderStyle, StyleContext } from '../style';

/** Default γ (matches §4.8) used by the pure helpers when none is given. */
export const GAMMA = 0.45;

/** Bits per quadrant, index q = bit q (q0 BL, q1 BR, q2 TL, q3 TR). */
const QUADRANT_ON = 0b1111;

/**
 * Which quadrants are "on". `lums` holds the four per-quadrant shaded
 * brightnesses in `sampleSub` order — 0 bottom-left, 1 bottom-right, 2
 * top-left, 3 top-right. A quadrant is on when `lums[q] > m + 1e-4`, where
 * `m` is the mean of the four; when all four are equal every quadrant is on
 * (all 15 bits). Mirrors the fragment's threshold test.
 */
export function quadrantBits(lums: readonly number[]): number {
  const l0 = lums[0];
  const l1 = lums[1];
  const l2 = lums[2];
  const l3 = lums[3];
  if (l0 === l1 && l1 === l2 && l2 === l3) return QUADRANT_ON;
  const m = (l0 + l1 + l2 + l3) / 4;
  let bits = 0;
  if (l0 > m + 1e-4) bits |= 1;
  if (l1 > m + 1e-4) bits |= 2;
  if (l2 > m + 1e-4) bits |= 4;
  if (l3 > m + 1e-4) bits |= 8;
  return bits;
}

/** Apply the shared `tintOf(mean) · shaped(bright(mean))` colour rule. */
function quadrantColour(mean: [number, number, number], gamma: number): [number, number, number] {
  const b = Math.min(1, Math.max(0, Math.max(mean[0], mean[1], mean[2])));
  const s = Math.pow(Math.min(1, Math.max(0, b)), gamma);
  const d = Math.max(b, 0.02);
  return [(mean[0] / d) * s, (mean[1] / d) * s, (mean[2] / d) * s];
}

/**
 * Split a cell's four exposed quadrant colours by `bits`: `fg` is the mean
 * colour of the on quadrants and `bg` the mean of the off ones, each rendered
 * as `tintOf(mean) · shaped(bright(mean))`. When every quadrant is on there
 * are no off quadrants, so `bg` is black. Mirrors the fragment's accumulation.
 */
export function splitMeans(
  colours: readonly (readonly [number, number, number])[],
  bits: number,
  gamma: number = GAMMA,
): { fg: [number, number, number]; bg: [number, number, number] } {
  let fr = 0;
  let fgc = 0;
  let fb = 0;
  let br = 0;
  let bgc = 0;
  let bb = 0;
  let nOn = 0;
  let nOff = 0;
  for (let q = 0; q < 4; q++) {
    const c = colours[q];
    if (bits & (1 << q)) {
      fr += c[0];
      fgc += c[1];
      fb += c[2];
      nOn++;
    } else {
      br += c[0];
      bgc += c[1];
      bb += c[2];
      nOff++;
    }
  }
  const fgRaw: [number, number, number] = nOn ? [fr / nOn, fgc / nOn, fb / nOn] : [0, 0, 0];
  const bgRaw: [number, number, number] = nOff ? [br / nOff, bgc / nOff, bb / nOff] : [0, 0, 0];
  return { fg: quadrantColour(fgRaw, gamma), bg: quadrantColour(bgRaw, gamma) };
}

/**
 * §4.11 "blocks" fragment body. No extra uniforms. Samples the four
 * quadrants, derives on/off bits from the shaded brightnesses, accumulates
 * the on/off means, tints them, then colours each pixel by its own quadrant's
 * bit. String interpolation only for the bit names; otherwise static.
 */
const BLOCKS_FRAGMENT = `
void main() {
  vec2 cell = floor(vUv * grid);
  vec3 c0 = sampleSub(cell, 0.0, 0.0); // bottom-left
  vec3 c1 = sampleSub(cell, 1.0, 0.0); // bottom-right
  vec3 c2 = sampleSub(cell, 0.0, 1.0); // top-left
  vec3 c3 = sampleSub(cell, 1.0, 1.0); // top-right
  float l0 = shaped(bright(c0));
  float l1 = shaped(bright(c1));
  float l2 = shaped(bright(c2));
  float l3 = shaped(bright(c3));
  float m = (l0 + l1 + l2 + l3) / 4.0;
  bool allEq = (l0 == l1) && (l1 == l2) && (l2 == l3);
  float b0 = step(m + 1e-4, l0);
  float b1 = step(m + 1e-4, l1);
  float b2 = step(m + 1e-4, l2);
  float b3 = step(m + 1e-4, l3);
  if (allEq) { b0 = 1.0; b1 = 1.0; b2 = 1.0; b3 = 1.0; }
  vec3 fgSum = vec3(0.0);
  vec3 bgSum = vec3(0.0);
  float nOn = 0.0;
  float nOff = 0.0;
  fgSum += c0 * b0; nOn += b0; bgSum += c0 * (1.0 - b0); nOff += (1.0 - b0);
  fgSum += c1 * b1; nOn += b1; bgSum += c1 * (1.0 - b1); nOff += (1.0 - b1);
  fgSum += c2 * b2; nOn += b2; bgSum += c2 * (1.0 - b2); nOff += (1.0 - b2);
  fgSum += c3 * b3; nOn += b3; bgSum += c3 * (1.0 - b3); nOff += (1.0 - b3);
  vec3 fgRaw = fgSum / max(nOn, 0.001);
  vec3 bgRaw = bgSum / max(nOff, 0.001);
  vec3 fg = tintOf(fgRaw) * shaped(bright(fgRaw));
  vec3 bg = tintOf(bgRaw) * shaped(bright(bgRaw));
  vec2 inCell = fract(vUv * grid);
  float thisOn;
  if (inCell.x < 0.5 && inCell.y < 0.5) { thisOn = b0; }
  else if (inCell.x >= 0.5 && inCell.y < 0.5) { thisOn = b1; }
  else if (inCell.x < 0.5 && inCell.y >= 0.5) { thisOn = b2; }
  else { thisOn = b3; }
  gl_FragColor = vec4(mix(bg, fg, thisOn), 1.0);
}
`;

/**
 * The blocks look: cell 6×12, sub 2×2 (four quadrants), analytic drawing, no
 * depth texture or atlas.
 */
export const STYLES: readonly RenderStyle[] = [
  {
    id: 'blocks',
    label: 'BLOCKS',
    cellW: 6,
    cellH: 12,
    subX: 2,
    subY: 2,
    needsDepth: false,
    fragment: BLOCKS_FRAGMENT,
    makeUniforms(_ctx: StyleContext): Record<string, THREE.IUniform> {
      return {};
    },
  },
];
