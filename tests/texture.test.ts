/**
 * Unit tests for the procedural surface patterns in src/render/texture.ts
 * (docs/render.md "Surface detail"). Pure pattern functions, tested in plain
 * node with no renderer or I/O.
 */
import { describe, expect, it } from 'vitest';
import { barsShade, brickShade, floorShade, gridShade, MORTAR, plankShade, veilShade } from '../src/render/texture.js';

describe('texture/brickShade', () => {
  it('returns the MORTAR sentinel at row and column boundaries and a brick body ± 0.03 elsewhere', () => {
    const seed = 3 * 80 + 5;
    // horizontal mortar at the top/bottom of a 0.25-tall row
    expect(brickShade(0.25, 0.0, seed)).toBe(MORTAR);
    expect(brickShade(0.25, 0.25, seed)).toBe(MORTAR);
    // vertical mortar at the edges of a 0.5-wide brick (row 0, no offset)
    expect(brickShade(0.0, 0.12, seed)).toBe(MORTAR);
    expect(brickShade(0.5, 0.12, seed)).toBe(MORTAR);
    // brick body in the middle of a brick, not mortar, in 1.0 ± 0.03
    const body = brickShade(0.25, 0.12, seed);
    expect(body).not.toBe(MORTAR);
    expect(body).toBeGreaterThanOrEqual(0.97);
    expect(body).toBeLessThanOrEqual(1.03);
  });

  it('offsets alternate rows by half a brick so their mortar columns differ', () => {
    const seed = 0;
    // u=0.5 is a vertical mortar line in row 0 (no offset)…
    expect(brickShade(0.5, 0.12, seed)).toBe(MORTAR);
    // …but in row 1 the half-brick offset moves it to body, and u=0.25 becomes mortar
    expect(brickShade(0.5, 0.37, seed)).not.toBe(MORTAR);
    expect(brickShade(0.25, 0.37, seed)).toBe(MORTAR);
  });

  it('is stable for a given seed (deterministic), differing across seeds', () => {
    const a = brickShade(0.25, 0.12, 42);
    expect(brickShade(0.25, 0.12, 42)).toBe(a); // same seed, same body
    const other = brickShade(0.25, 0.12, 43);
    expect(other).toBeGreaterThanOrEqual(0.97);
    expect(other).toBeLessThanOrEqual(1.03);
  });
});

describe('texture/plankShade', () => {
  it('draws dark seams (MORTAR) between alternating 1.0 / 0.82 planks', () => {
    // plank bodies alternate
    expect(plankShade(0.1)).toBe(1.0);
    expect(plankShade(0.3)).toBe(0.82);
    // the 0.05-wide seam at each plank edge is dark (mortar sentinel)
    expect(plankShade(0.02)).toBe(MORTAR);
    expect(plankShade(0.19)).toBe(MORTAR);
  });
});

describe('texture/barsShade', () => {
  it('shows 0.2-wide bars at 1.0 with 0.3 gaps at 0.25', () => {
    expect(barsShade(0.1)).toBe(1.0);
    expect(barsShade(0.25)).toBe(0.25);
    expect(barsShade(0.3)).toBe(0.25); // in the gap after the first bar
  });
});

describe('texture/gridShade', () => {
  it('dims to the edge factor within 0.05 of a cell edge and stays 1.0 in the middle', () => {
    expect(gridShade(0.03, 0.5)).toBe(0.7); // near an x edge
    expect(gridShade(0.5, 0.98)).toBe(0.7); // near a y edge
    expect(gridShade(0.5, 0.5)).toBe(1.0); // cell middle
  });

  it('uses a stronger edge factor for stairs', () => {
    expect(gridShade(0.03, 0.5, 0.5)).toBe(0.5);
  });
});

describe('texture/floorShade', () => {
  it('gives flagstone brightness in 0.85–1.15, seams at 0.6, stable per stone', () => {
    // stone bodies are in 0.85–1.15 and repeat for the same stone index
    const a = floorShade(0.3, 0.3);
    const b = floorShade(0.45, 0.35); // same stone index as (0.3, 0.3)
    expect(a).toBeGreaterThanOrEqual(0.85);
    expect(a).toBeLessThanOrEqual(1.15);
    expect(b).toBeGreaterThanOrEqual(0.85);
    expect(b).toBeLessThanOrEqual(1.15);
    expect(floorShade(0.3, 0.3)).toBe(a); // stable per sample
    expect(floorShade(0.45, 0.35)).toBe(b); // stable per stone index
    // thin seams: within 0.04 of a stone edge (stone side 0.5)
    expect(floorShade(0.01, 0.3)).toBe(0.6); // near the x edge of stone (0,0)
    expect(floorShade(0.3, 0.01)).toBe(0.6); // near the y edge
    // corridors: side 1.0 rough rock with no seams
    expect(floorShade(0.01, 0.5, 1.0, false)).toBeGreaterThanOrEqual(0.85);
  });
});

describe('texture/veilShade', () => {
  it('is sparse (≈12 % ± 4 % non-zero) and stable, with non-zero values in 0.10–0.22', () => {
    let nonZero = 0;
    const samples = 10000;
    const seed = 7;
    for (let s = 0; s < samples; s++) {
      const u = (s % 80) / 80;
      const v = (s % 60) / 60;
      const val = veilShade(u, v, seed);
      if (val !== 0) {
        nonZero++;
        expect(val).toBeGreaterThanOrEqual(0.1);
        expect(val).toBeLessThanOrEqual(0.22);
      }
      // same inputs must give the same output (stable per cell and per sample)
      expect(veilShade(u, v, seed)).toBe(val);
    }
    const frac = nonZero / samples;
    expect(frac).toBeGreaterThanOrEqual(0.08);
    expect(frac).toBeLessThanOrEqual(0.16);
  });
});
