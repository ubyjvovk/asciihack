/**
 * Pure, deterministic procedural surface patterns for the raycaster
 * (docs/render.md "Surface detail"). Every function takes plain coordinates —
 * face-fraction (u, v) or world-cell (fX, fY) units — and returns a brightness
 * multiplier to apply to a surface colour. No I/O, no allocations.
 */

/**
 * Deterministic 32-bit hash of three integers, mapped to [0,1). Bitwise ops
 * keep it exact across platforms and call orders.
 */
function hash3(a: number, b: number, c: number): number {
  let h = (a * 374761393 + b * 668265263 + c * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

/** Shared brightness for mortar and plank seams. */
const MORTAR = 0.65;

/**
 * Brick-wall brightness for a face at (u, v): v is 0 at the wall top and 1 at
 * the bottom, u across the face. Rows 0.25 tall, bricks 0.5 wide, alternate
 * rows offset by 0.25, 0.05-wide mortar at 0.65, and a brick body of
 * 1.0 ± 0.08 hashed by (row, column, seed) so bricks are stable frame to frame.
 */
export function brickShade(u: number, v: number, seed: number): number {
  const row = Math.floor(v / 0.25);
  const vPos = v - row * 0.25;
  if (vPos < 0.05 || vPos > 0.2) return MORTAR; // horizontal mortar line
  const uShift = (u + (row % 2) * 0.25) % 1; // alternate rows offset half a brick
  const col = Math.floor(uShift / 0.5);
  const uPos = uShift - col * 0.5;
  if (uPos < 0.05 || uPos > 0.45) return MORTAR; // vertical mortar line
  return 1.0 + (hash3(row, col, seed) - 0.5) * 0.16;
}

/**
 * Closed-door brightness across its face u: vertical planks 0.2 wide
 * alternating 1.0 / 0.82 with a 0.05-wide dark seam between them.
 */
export function plankShade(u: number): number {
  const pos = u % 0.2;
  if (pos < 0.05 || pos > 0.15) return MORTAR; // seam
  return Math.floor(u / 0.2) % 2 === 0 ? 1.0 : 0.82;
}

/**
 * Bars brightness across its face u: 0.2-wide bars at 1.0 separated by 0.3
 * gaps at 0.25.
 */
export function barsShade(u: number): number {
  return u % 0.5 < 0.2 ? 1.0 : 0.25;
}

/**
 * Floor-grid brightness at world cell coordinates (fX, fY): `edge` (default
 * 0.7) within 0.05 of a cell edge in either axis, else 1.0.
 */
export function gridShade(fX: number, fY: number, edge = 0.7): number {
  const fx = fX - Math.floor(fX);
  const fy = fY - Math.floor(fY);
  const dx = Math.min(fx, 1 - fx);
  const dy = Math.min(fy, 1 - fy);
  if (dx < 0.05 || dy < 0.05) return edge;
  return 1.0;
}
