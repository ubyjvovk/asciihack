import { describe, expect, it } from 'vitest';
import { DEFAULT_RAMP, quantize } from '../src/render/ascii.js';
import { makeFrameBuffer } from '../src/model/types.js';

const EXPOSURE = 1.7;
const OLD_GAMMA = 0.45;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Pre-theme cyber glyph selection (docs/architecture.md §5.4). fg is not
 *  reproduced by the regression path because darkness-dependent
 *  desaturation is a deliberate new behaviour on every theme. */
function refCyberGlyph(r0: number, g0: number, b0: number): string {
  const r = r0 * EXPOSURE;
  const g = g0 * EXPOSURE;
  const b = b0 * EXPOSURE;
  const v = Math.max(r, g, b);
  const dens = Math.pow(clamp01(v), OLD_GAMMA);
  const idx = Math.min(
    Math.max(Math.floor(dens * (DEFAULT_RAMP.length - 1) + 0.5), 0),
    DEFAULT_RAMP.length - 1,
  );
  return DEFAULT_RAMP[idx]!;
}

function fillMixed(fb: ReturnType<typeof makeFrameBuffer>): void {
  let step = 0;
  for (let i = 0; i < fb.rgb.length; i += 3) {
    fb.rgb[i] = ((step * 7) % 101) / 100;
    fb.rgb[i + 1] = ((step * 13) % 101) / 100;
    fb.rgb[i + 2] = ((step * 29) % 101) / 100;
    step++;
  }
}

describe('render/themes', () => {
  it('veil-like cell [0.03, 0.03, 0.05] quantizes to a space in cyber, gloom and solarized', () => {
    const fb = makeFrameBuffer(1, 1);
    fb.rgb[0] = 0.03;
    fb.rgb[1] = 0.03;
    fb.rgb[2] = 0.05;
    for (const theme of ['cyber', 'gloom', 'solarized'] as const) {
      const cell = quantize(fb, { theme }).cells[0]!;
      expect(cell.ch).toBe(' ');
    }
  });

  it('blackPoint: 0 and gamma: 0.45 reproduce the pre-theme cyber glyph mapping for a mixed buffer', () => {
    const fb = makeFrameBuffer(8, 4);
    fillMixed(fb);
    const grid = quantize(fb, { theme: 'cyber', blackPoint: 0, gamma: OLD_GAMMA });
    for (let i = 0; i < grid.cells.length; i++) {
      const off = i * 3;
      const ref = refCyberGlyph(fb.rgb[off]!, fb.rgb[off + 1]!, fb.rgb[off + 2]!);
      expect(grid.cells[i]!.ch).toBe(ref);
    }
  });

  it('gloom bg is the grey ground [184, 186, 191] for every cell in a mixed buffer', () => {
    const fb = makeFrameBuffer(8, 4);
    fillMixed(fb);
    const grid = quantize(fb, { theme: 'gloom' });
    for (const cell of grid.cells) {
      expect(cell.bg).toEqual([184, 186, 191]);
    }
  });

  it('gloom fg is darker than its bg for a mid-grey input', () => {
    const fb = makeFrameBuffer(1, 1);
    fb.rgb[0] = 0.5;
    fb.rgb[1] = 0.5;
    fb.rgb[2] = 0.5;
    const cell = quantize(fb, { theme: 'gloom' }).cells[0]!;
    const lum = (c: readonly [number, number, number]) =>
      0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
    expect(lum(cell.fg)).toBeLessThan(lum(cell.bg));
  });

  it('solarized bg is the paper [253, 246, 227] for every cell in a mixed buffer', () => {
    const fb = makeFrameBuffer(8, 4);
    fillMixed(fb);
    const grid = quantize(fb, { theme: 'solarized' });
    for (const cell of grid.cells) {
      expect(cell.bg).toEqual([253, 246, 227]);
    }
  });

  it('amber fg of a white input is the hot-bloom colour near [255, 224, 148]', () => {
    const fb = makeFrameBuffer(1, 1);
    fb.rgb[0] = 1;
    fb.rgb[1] = 1;
    fb.rgb[2] = 1;
    const cell = quantize(fb, { theme: 'amber' }).cells[0]!;
    expect(cell.fg[0]).toBe(255);
    expect(cell.fg[1]).toBe(224);
    expect(cell.fg[2]).toBe(148);
  });

  it('amber fg of a dark input is a dim orange with r > g > b', () => {
    const fb = makeFrameBuffer(1, 1);
    fb.rgb[0] = 0.1;
    fb.rgb[1] = 0.1;
    fb.rgb[2] = 0.1;
    const cell = quantize(fb, { theme: 'amber' }).cells[0]!;
    expect(cell.fg[0]).toBeGreaterThan(cell.fg[1]);
    expect(cell.fg[1]).toBeGreaterThan(cell.fg[2]);
    expect(cell.fg[0]).toBeLessThan(200);
  });

  it('overlay glyphs keep their fg and take the theme bg', () => {
    const fb = makeFrameBuffer(1, 1);
    fb.overlayCh[0] = 'd'.charCodeAt(0);
    fb.overlayRgb[0] = 0.5;
    fb.overlayRgb[1] = 0.25;
    fb.overlayRgb[2] = 0;
    const expectedFg = [
      Math.round(0.5 * EXPOSURE * 255),
      Math.round(0.25 * EXPOSURE * 255),
      0,
    ];
    const cases = [
      { theme: 'cyber', bg: [0, 0, 0] },
      { theme: 'gloom', bg: [184, 186, 191] },
      { theme: 'solarized', bg: [253, 246, 227] },
      { theme: 'amber', bg: [0, 0, 0] },
    ] as const;
    for (const { theme, bg } of cases) {
      const cell = quantize(fb, { theme }).cells[0]!;
      expect(cell.ch).toBe('d');
      expect(cell.fg).toEqual(expectedFg);
      expect(cell.bg).toEqual([bg[0], bg[1], bg[2]]);
    }
  });
});
