import { describe, expect, it } from 'vitest';
import { clrToRgb, isSolid, makeFrameBuffer } from '../src/model/types.js';

describe('model/types', () => {
  it('classifies walls and closed doors as solid, floors and open doors as passable', () => {
    expect(isSolid('wall')).toBe(true);
    expect(isSolid('door_closed')).toBe(true);
    expect(isSolid('floor')).toBe(false);
    expect(isSolid('door_open')).toBe(false);
  });

  it('allocates a frame buffer with infinite depth', () => {
    const fb = makeFrameBuffer(4, 2);
    expect(fb.rgb.length).toBe(24);
    expect(fb.depth[7]).toBe(Number.POSITIVE_INFINITY);
    expect(fb.overlayCh[0]).toBe(0);
  });

  it('maps unknown colour indices to gray', () => {
    expect(clrToRgb(99)).toEqual([190, 190, 190]);
    expect(clrToRgb(15)).toEqual([255, 255, 255]);
  });
});
