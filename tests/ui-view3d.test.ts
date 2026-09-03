import { describe, expect, it } from 'vitest';
import { FACINGS, opposite, poseFor, spritesFromMap, strafe, turn, blitGrid, Viewport3D } from '../src/ui/view3d.js';
import { blankGrid } from '../src/ui/grid.js';
import { makeFrameBuffer, type GlyphInfo } from '../src/model/types.js';

function glyph(ch: string, cls: GlyphInfo['cls'] = 'mon'): GlyphInfo {
  return { glyph: 1, ch, color: 7, cls, idx: 0, flags: 0 };
}

/** Small 4×4 session-like map with a hero, a monster and bare terrain. */
function mapStub(hero: { x: number; y: number } | null) {
  return {
    width: 4,
    height: 4,
    kindAt: () => 'floor' as const,
    cellAt: (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= 4 || y >= 4) return null;
      if (hero && x === hero.x && y === hero.y) return { x, y, kind: 'floor' as const, terrain: null, top: glyph('@', 'mon') };
      if (x === 1 && y === 1) return { x, y, kind: 'floor' as const, terrain: null, top: glyph('d', 'pet') };
      if (x === 2 && y === 2) return { x, y, kind: 'floor' as const, terrain: glyph('.', 'cmap'), top: glyph('.', 'cmap') };
      return { x, y, kind: 'unexplored' as const, terrain: null, top: null };
    },
  };
}

describe('view3d facings', () => {
  it('FACINGS run clockwise N NE E SE S SW W NW with vi-keys k u l n j b h y', () => {
    expect(FACINGS.map((f) => f.name)).toEqual(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']);
    expect(FACINGS.map((f) => f.key)).toEqual(['k', 'u', 'l', 'n', 'j', 'b', 'h', 'y']);
    expect(FACINGS[0]!.yaw).toBeCloseTo(0);
    expect(FACINGS[1]!.yaw).toBeCloseTo(Math.PI / 4);
    expect(FACINGS[2]!.yaw).toBeCloseTo(Math.PI / 2);
  });

  it('turn wraps at both ends, opposite is 180°, strafe is ±90°', () => {
    expect(turn(FACINGS[0]!, -1)).toBe(FACINGS[7]!);
    expect(turn(FACINGS[7]!, 1)).toBe(FACINGS[0]!);
    expect(turn(FACINGS[0]!, 1)).toBe(FACINGS[1]!);
    expect(opposite(FACINGS[0]!)).toBe(FACINGS[4]!);
    expect(opposite(FACINGS[3]!)).toBe(FACINGS[7]!);
    expect(strafe(FACINGS[0]!, 1)).toBe(FACINGS[2]!);
    expect(strafe(FACINGS[0]!, -1)).toBe(FACINGS[6]!);
    expect(strafe(FACINGS[7]!, 1)).toBe(FACINGS[1]!);
  });
});

describe('view3d sprites and pose', () => {
  it('spritesFromMap skips cmap/unexplored/nothing and the fps hero', () => {
    const map = mapStub({ x: 0, y: 0 });
    const fps = spritesFromMap(map, { x: 0, y: 0 }, false);
    expect(fps).toHaveLength(1);
    expect(fps[0]!.ch).toBe('d');
    expect(fps[0]!.cls).toBe('pet');
  });

  it('spritesFromMap includes the hero as @ for ortho and normalises colour', () => {
    const map = mapStub({ x: 0, y: 0 });
    const ortho = spritesFromMap(map, { x: 0, y: 0 }, true);
    expect(ortho).toHaveLength(2);
    const hero = ortho.find((s) => s.x === 0 && s.y === 0)!;
    expect(hero.ch).toBe('@');
    for (const s of ortho) for (const c of s.rgb) expect(c).toBeGreaterThanOrEqual(0);
  });

  it('poseFor puts the camera at the hero cell centre', () => {
    const p = poseFor({ x: 4, y: 6 }, Math.PI);
    expect(p.x).toBeCloseTo(4.5);
    expect(p.y).toBeCloseTo(6.5);
    expect(p.yaw).toBeCloseTo(Math.PI);
  });

  it('blitGrid clips to the destination bounds', () => {
    const dst = blankGrid(3, 3);
    const src = blankGrid(4, 4);
    src.cells[15]!.ch = 'Z';
    blitGrid(src, dst, { x: 0, y: 0, width: 4, height: 4 });
    expect(dst.cells[8]!.ch).toBe(' ');
    blitGrid(src, dst, { x: -3, y: -3, width: 4, height: 4 });
    expect(dst.cells[0]!.ch).toBe('Z');
  });

  it('Viewport3D reallocates on size change and renders through the callback', () => {
    const v = new Viewport3D();
    const fb = makeFrameBuffer(2, 2);
    const g1 = v.render({ x: 0, y: 0, width: 2, height: 2 }, (f) => f.rgb.set(fb.rgb), 'cyber');
    expect(g1.width).toBe(2);
    const g2 = v.render({ x: 0, y: 0, width: 2, height: 2 }, (f) => f.rgb.set(fb.rgb), 'cyber');
    expect(g2).toBe(g1);
    const g3 = v.render({ x: 0, y: 0, width: 3, height: 3 }, (f) => f.rgb.set(fb.rgb), 'cyber');
    expect(g3).not.toBe(g1);
    expect(g3.width).toBe(3);
  });
});
