import { describe, expect, it } from 'vitest';
import { DEFAULT_RAMP, glyphIndex, quantize, quantizeInto } from '../src/render/ascii.js';
import { makeFrameBuffer } from '../src/model/types.js';

const GAMMA = 0.45;

/** The §5.4 reference formula for the ramp index, for comparison. */
function refIndex(lum: number, count: number): number {
  const dens = Math.pow(Math.min(Math.max(lum, 0), 1), GAMMA);
  return Math.min(Math.max(Math.floor(dens * (count - 1) + 0.5), 0), count - 1);
}

describe('render/ascii', () => {
  it('glyphIndex at 0, 1 and mid-range matches the §5.4 formula', () => {
    const count = DEFAULT_RAMP.length;
    expect(glyphIndex(0, count, GAMMA)).toBe(refIndex(0, count));
    expect(glyphIndex(1, count, GAMMA)).toBe(refIndex(1, count));
    const mid = 0.5;
    expect(glyphIndex(mid, count, GAMMA)).toBeCloseTo(refIndex(mid, count));
    // sanity: black is the sparsest slot, white the densest
    expect(glyphIndex(0, count, GAMMA)).toBe(0);
    expect(glyphIndex(1, count, GAMMA)).toBe(count - 1);
  });

  it('maps black to a space and white to the densest ramp glyph', () => {
    const fb = makeFrameBuffer(2, 1);
    fb.rgb[0] = 0;
    fb.rgb[1] = 0;
    fb.rgb[2] = 0;
    fb.rgb[3] = 1;
    fb.rgb[4] = 1;
    fb.rgb[5] = 1;
    const grid = quantize(fb);
    expect(grid.cells[0]!.ch).toBe(' ');
    expect(grid.cells[0]!.fg).toEqual([0, 0, 0]);
    expect(grid.cells[1]!.ch).toBe('$');
    expect(grid.cells[1]!.fg).toEqual([255, 255, 255]);
  });

  it('keeps a red-dominant fg for a pure red cell', () => {
    const fb = makeFrameBuffer(1, 1);
    fb.rgb[0] = 1;
    fb.rgb[1] = 0;
    fb.rgb[2] = 0;
    const fg = quantize(fb).cells[0]!.fg;
    expect(fg[0]).toBeGreaterThan(fg[1]);
    expect(fg[0]).toBeGreaterThan(fg[2]);
    expect(fg[1]).toBe(0);
    expect(fg[2]).toBe(0);
  });

  it('passes overlay glyph and colour through on black', () => {
    const fb = makeFrameBuffer(1, 1);
    fb.rgb[0] = 0;
    fb.rgb[1] = 0;
    fb.rgb[2] = 0;
    fb.overlayCh[0] = 'd'.charCodeAt(0);
    fb.overlayRgb[0] = 0.5;
    fb.overlayRgb[1] = 0.25;
    fb.overlayRgb[2] = 0;
    const cell = quantize(fb).cells[0]!;
    expect(cell.ch).toBe('d');
    expect(cell.fg).toEqual([Math.round(0.5 * 1.7 * 255), Math.round(0.25 * 1.7 * 255), 0]);
    expect(cell.bg).toEqual([0, 0, 0]);
  });

  it('quantizeInto reuses the grid cell objects', () => {
    const fb = makeFrameBuffer(2, 1);
    fb.rgb[0] = 0;
    fb.rgb[1] = 0;
    fb.rgb[2] = 0;
    fb.rgb[3] = 1;
    fb.rgb[4] = 1;
    fb.rgb[5] = 1;
    const grid = quantize(fb);
    const before = grid.cells.slice();
    const out = quantizeInto(fb, grid);
    expect(out).toBe(grid);
    expect(grid.cells[0]).toBe(before[0]);
    expect(grid.cells[1]).toBe(before[1]);
    expect(grid.cells[1]!.ch).toBe('$');
    // mutating the frame buffer and re-quantizing updates in place, same refs
    fb.rgb[3] = 0;
    fb.rgb[4] = 0;
    fb.rgb[5] = 0;
    quantizeInto(fb, grid);
    expect(grid.cells[0]).toBe(before[0]);
    expect(grid.cells[1]).toBe(before[1]);
    expect(grid.cells[1]!.ch).toBe(' ');
  });

  it('never emits a character outside the ramp for non-overlay cells', () => {
    const fb = makeFrameBuffer(16, 4);
    const ramp = new Set(DEFAULT_RAMP);
    let step = 0;
    for (let i = 0; i < fb.rgb.length; i += 3) {
      fb.rgb[i] = ((step * 7) % 101) / 100;
      fb.rgb[i + 1] = ((step * 13) % 101) / 100;
      fb.rgb[i + 2] = ((step * 29) % 101) / 100;
      step++;
    }
    for (const cell of quantize(fb).cells) {
      expect(ramp.has(cell.ch)).toBe(true);
    }
  });
});
