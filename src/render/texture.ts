/**
 * Pure, deterministic procedural surface patterns for the raycaster
 * (docs/render.md "Surface detail"). Every function takes plain coordinates —
 * face-fraction (u, v) or world-cell (fX, fY) units — and returns a brightness
 * to apply to a surface colour: body multipliers (≥ 0) multiply the surface
 * base colour, while the `MORTAR` sentinel (−1) tells the raycaster to paint
 * that sample at the absolute seam brightness. No I/O, no allocations.
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

/**
 * Sentinel returned by `brickShade`/`plankShade` for seam cells. The raycaster
 * paints these at the absolute mortar brightness (0.05) rather than treating
 * the value as a multiplier of the surface base colour, so seams stay darker
 * than the body and read as lines instead of fading with the base.
 */
export const MORTAR = -1;

/**
 * Brick-wall brightness for a face at (u, v): v is 0 at the wall top and 1 at
 * the bottom, u across the face. Rows 0.25 tall, bricks 0.5 wide, alternate
 * rows offset by 0.25, 0.05-wide mortar at the `MORTAR` sentinel, and a brick
 * body of 1.0 ± 0.03 hashed by (row, column, seed) so bricks are stable frame
 * to frame. Body is a multiplier; seams signal `MORTAR`.
 */
export function brickShade(u: number, v: number, seed: number): number {
  const row = Math.floor(v / 0.25);
  const vPos = v - row * 0.25;
  if (vPos < 0.05 || vPos > 0.2) return MORTAR; // horizontal mortar line
  const uShift = (u + (row % 2) * 0.25) % 1; // alternate rows offset half a brick
  const col = Math.floor(uShift / 0.5);
  const uPos = uShift - col * 0.5;
  if (uPos < 0.05 || uPos > 0.45) return MORTAR; // vertical mortar line
  return 1.0 + (hash3(row, col, seed) - 0.5) * 0.06;
}

/**
 * Closed-door brightness across its face u: vertical planks 0.2 wide
 * alternating 1.0 / 0.82 with a 0.05-wide dark seam at the `MORTAR` sentinel.
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

/**
 * Flagstone brightness multiplier at world cell coordinates (fX, fY). Stones
 * of side `side` cells (default 0.5), each stone's brightness 0.85–1.15 from
 * the hash of its `(floor(fX/side), floor(fY/side))` index so it is stable per
 * stone; a thin seam (within 0.04 of a stone edge in stone-local units) reads
 * at 0.6. With `seams: false` (corridors) stones are side 1.0 rough rock with
 * no seams.
 */
export function floorShade(fX: number, fY: number, side = 0.5, seams = true): number {
  const ix = Math.floor(fX / side);
  const iy = Math.floor(fY / side);
  const h = hash3(ix, iy, 0);
  if (seams) {
    const fx = fX / side - ix;
    const fy = fY / side - iy;
    if (fx < 0.04 || fx > 0.96 || fy < 0.04 || fy > 0.96) return 0.6;
  }
  return 0.85 + h * 0.3;
}

/**
 * Speckle brightness for the never-seen (`unexplored`) veil: 0 for most
 * samples (no speckle), else one of a small set of values in 0.05–0.10 chosen
 * by the hash over an 8×8 sample grid and the cell `seed`, so each veil cell
 * is a sparse, stable dark static that never reads as masonry or mortar. The
 * rate and values are tuned so, under the quantizer's post-T-0028 black point
 * (0.10 after exposure), the veil comes out as rare `.` glyphs rather than a
 * dense mid-grey field.
 */
export function veilShade(u: number, v: number, seed: number): number {
  const iu = Math.floor(u * 8) & 7;
  const iv = Math.floor(v * 8) & 7;
  const h = hash3(iu, iv, seed);
  if (h >= 0.08) return 0;
  // ≈8 % of samples: one of two discrete speckle levels in 0.05–0.10.
  return Math.floor(h / 0.04) * 0.05 + 0.05;
}
