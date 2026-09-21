import { describe, expect, it } from 'vitest';
import {
  createPoseSmoother,
  FACINGS,
  opposite,
  POSE_SMOOTH_CELL_SECONDS,
  poseFor,
  spritesFromMap,
  strafe,
  turn,
  blitGrid,
  Viewport3D,
} from '../src/ui/view3d.js';
import { blankGrid } from '../src/ui/grid.js';
import { makeFrameBuffer, type GlyphInfo } from '../src/model/types.js';
import { NethackSession } from '../src/engine/session.js';
import type { BridgeMsg, TablesMsg } from '../src/engine/protocol.js';

function glyph(ch: string, cls: GlyphInfo['cls'] = 'mon'): GlyphInfo {
  return { glyph: 1, ch, color: 7, cls, idx: 0, flags: 0 };
}

/** A session whose cells carry the given `top` glyphs (fed via print_glyph). */
function sessionWith(top: Record<string, GlyphInfo>): NethackSession {
  const s = new NethackSession(() => {});
  for (const [key, gi] of Object.entries(top)) {
    const [x, y] = key.split(',').map(Number);
    s.handle({ t: 'call', name: 'print_glyph', args: [3, x, y, gi] } as BridgeMsg);
  }
  return s;
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
    const s = sessionWith({
      '0,0': glyph('@', 'mon'), // hero
      '1,1': glyph('d', 'pet'),
      '2,2': glyph('.', 'cmap'),
    });
    const fps = spritesFromMap(s, { x: 0, y: 0 }, false);
    expect(fps).toHaveLength(1);
    expect(fps[0]!.ch).toBe('d');
    expect(fps[0]!.cls).toBe('pet');
  });

  it('spritesFromMap includes the hero as @ for ortho and normalises colour', () => {
    const s = sessionWith({
      '0,0': glyph('@', 'mon'),
      '1,1': glyph('d', 'pet'),
    });
    const ortho = spritesFromMap(s, { x: 0, y: 0 }, true);
    expect(ortho).toHaveLength(2);
    const hero = ortho.find((sp) => sp.x === 0 && sp.y === 0)!;
    expect(hero.ch).toBe('@');
    for (const sp of ortho) for (const c of sp.rgb) expect(c).toBeGreaterThanOrEqual(0);
  });

  it('spritesFromMap attaches height 0.5 + jackal tile to a d whose idx maps to jackal, and height 0.35 + potion tile to a !', () => {
    const s = new NethackSession(() => {});
    s.handle({ t: 'tables', monsters: [{ name: 'jackal', male: null, female: null, letter: 'd', size: 1, color: 3 }], objects: [{ name: null, descr: 'potion', cls: '!' }] } as TablesMsg);
    s.handle({ t: 'call', name: 'print_glyph', args: [3, 1, 1, { glyph: 0, ch: 'd', color: 3, cls: 'mon', idx: 0, flags: 0 }] } as BridgeMsg);
    s.handle({ t: 'call', name: 'print_glyph', args: [3, 2, 2, { glyph: 0, ch: '!', color: 2, cls: 'obj', idx: 0, flags: 0 }] } as BridgeMsg);
    const sprites = spritesFromMap(s, { x: 0, y: 0 }, false);
    const jackal = sprites.find((sp) => sp.ch === 'd')!;
    expect(jackal.height).toBe(0.5); // small (size 1)
    expect(jackal.tile?.w).toBe(16);
    expect(jackal.tile?.h).toBe(16);
    const potion = sprites.find((sp) => sp.ch === '!')!;
    expect(potion.height).toBe(0.35); // object
    expect(potion.tile?.w).toBe(16);
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

  it('the smoothed pose eases toward the cell centre over about 120 ms', () => {
    const s = createPoseSmoother({ cellSeconds: POSE_SMOOTH_CELL_SECONDS });
    // First call snaps to the starting cell — no gliding into the scene.
    const start = s.update({ x: 0, y: 0 }, 0, 0.016);
    expect(start.x).toBeCloseTo(0.5);
    expect(start.y).toBeCloseTo(0.5);
    // Step across one cell in dt = 1 ms increments up to 120 ms total. An
    // exponential damper with tau = 120 ms covers 1 − 1/e ≈ 63.2 % of one
    // cell in that time (framerate-independent, so the sum of small steps
    // matches a single τ-second step).
    let p = s.update({ x: 1, y: 0 }, 0, 0);
    for (let i = 0; i < 120; i++) p = s.update({ x: 1, y: 0 }, 0, 0.001);
    // Started at 0.5, target is 1.5, so ~63 % of the way lands near 1.13.
    expect(p.x).toBeGreaterThan(0.5);
    expect(p.x).toBeLessThan(1.5);
    expect(p.x).toBeCloseTo(0.5 + (1 - Math.exp(-1)), 2);
    // Push further: ~9τ leaves less than 0.01 % remaining.
    for (let i = 0; i < 1000; i++) p = s.update({ x: 1, y: 0 }, 0, 0.001);
    expect(p.x).toBeCloseTo(1.5, 3);
  });

  it('a jump of more than two cells snaps instead of gliding', () => {
    const s = createPoseSmoother({ cellSeconds: POSE_SMOOTH_CELL_SECONDS });
    s.update({ x: 0, y: 0 }, 0, 0.016);
    // Level change / teleport: hero appears three cells over. One frame must
    // land exactly on the new cell centre — no easing across the map.
    const p = s.update({ x: 3, y: 0 }, 0, 0.016);
    expect(p.x).toBeCloseTo(3.5);
    expect(p.y).toBeCloseTo(0.5);
    // Two-cell diagonal (Δ = √8 ≈ 2.83 > 1.9) is also a snap.
    const q = s.update({ x: 5, y: 2 }, 0, 0.016);
    expect(q.x).toBeCloseTo(5.5);
    expect(q.y).toBeCloseTo(2.5);
  });

  it('the smoother is framerate independent', () => {
    // Two smoothers advanced over the same total time (200 ms) with very
    // different frame budgets should agree to within a few % — the whole
    // point of `1 − e^(−dt/τ)`.
    const coarse = createPoseSmoother({ cellSeconds: POSE_SMOOTH_CELL_SECONDS });
    const fine = createPoseSmoother({ cellSeconds: POSE_SMOOTH_CELL_SECONDS });
    coarse.update({ x: 0, y: 0 }, 0, 0);
    fine.update({ x: 0, y: 0 }, 0, 0);
    // Coarse: 4 × 50 ms (≈ 20 fps).
    let c = coarse.update({ x: 1, y: 0 }, 0, 0);
    for (let i = 0; i < 4; i++) c = coarse.update({ x: 1, y: 0 }, 0, 0.05);
    // Fine: 200 × 1 ms (≈ 1000 fps, closer to the analytic value).
    let f = fine.update({ x: 1, y: 0 }, 0, 0);
    for (let i = 0; i < 200; i++) f = fine.update({ x: 1, y: 0 }, 0, 0.001);
    expect(c.x).toBeCloseTo(f.x, 3);
    // And both must be at (1 − e^(−200/120)) ≈ 81 % of the way to 1.5.
    const expected = 0.5 + (1 - Math.exp(-0.2 / POSE_SMOOTH_CELL_SECONDS));
    expect(f.x).toBeCloseTo(expected, 3);
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
