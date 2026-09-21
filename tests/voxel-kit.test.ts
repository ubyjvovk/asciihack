/**
 * Behaviour tests for the voxel construction kit and mesher
 * (web/src/voxel/{kit,palette,mesh}.ts). Each case pins one specific piece of
 * the port that a future model file (or scene builder) relies on.
 */
import { describe, expect, it } from 'vitest';
import { VoxelBuilder, type VoxelBox } from '../web/src/voxel/kit.js';
import { PAL } from '../web/src/voxel/palette.js';
import { EMISSIVE_RANGE, GeoWriter, hiddenFaces } from '../web/src/voxel/mesh.js';

describe('voxel kit — ported from vendor/afterburn/src/voxel', () => {
  it('a box carries its palette colour, material preset and a stable per-box random', () => {
    const b1 = new VoxelBuilder({ seed: 42, jitter: 0 });
    b1.box(0, 0, 0, 1, 1, 1, 'hull0', 'metal');
    const box1 = b1.parts[0]!.boxes[0]!;
    expect([box1.r, box1.g, box1.b]).toEqual([(PAL['hull0']! >> 16) & 255, (PAL['hull0']! >> 8) & 255, PAL['hull0']! & 255]);
    expect(box1.rough).toBeCloseTo(0.4, 5);
    expect(box1.metal).toBeCloseTo(0.85, 5);
    expect(box1.stone).toBe(false);
    expect(box1.dry).toBe(false);
    expect(box1.rnd).toBeGreaterThanOrEqual(0);
    expect(box1.rnd).toBeLessThan(1);

    const b2 = new VoxelBuilder({ seed: 42, jitter: 0 });
    b2.box(0, 0, 0, 1, 1, 1, 'hull0', 'metal');
    expect(b2.parts[0]!.boxes[0]!.rnd).toBe(box1.rnd);
  });

  it('fill merges runs along X and skips cells whose callback returns null', () => {
    const b = new VoxelBuilder({ seed: 1, jitter: 0 });
    b.fill(0, 0, 0, 3, 1, 1, (x) => (x < 2 ? 'white' : null), 1);
    const boxes = b.parts[0]!.boxes;
    expect(boxes.length).toBe(1);
    const only = boxes[0]!;
    expect([only.x, only.y, only.z]).toEqual([0, 0, 0]);
    expect([only.w, only.h, only.d]).toEqual([2, 1, 1]);
  });

  it('transforms nest innermost-first: at() around bothX() mirrors about the offset', () => {
    const b = new VoxelBuilder({ seed: 1, jitter: 0 });
    b.at(5, 0, 0, () => b.bothX(() => b.box(0, 0, 0, 1, 1, 1, 'white')));
    const boxes = b.parts[0]!.boxes;
    expect(boxes.length).toBe(2);
    const xs = boxes.map((v) => v.x).sort((a, c) => a - c);
    expect(xs).toEqual([4, 5]);
    for (const v of boxes) expect([v.y, v.z, v.w, v.h, v.d]).toEqual([0, 0, 1, 1, 1]);
  });

  it('the same seed builds an identical model twice', () => {
    const buildOnce = (): VoxelBox[] => {
      const b = new VoxelBuilder({ seed: 7, jitter: 0.1 });
      b.box(0, 0, 0, 2, 3, 1, 'wall0', 'rock');
      b.at(4, 0, 0, () => b.box(0, 0, 0, 1, 1, 1, 'lamp', 'lamp'));
      b.fill(0, 5, 0, 3, 6, 1, (x, _y, _z) => (x % 2 === 0 ? 'moss1' : null), 1);
      return b.build('test').parts.flatMap((p) => p.boxes);
    };
    const a = buildOnce();
    const c = buildOnce();
    expect(c.length).toBe(a.length);
    for (let i = 0; i < a.length; i++) {
      const ai = a[i]!, ci = c[i]!;
      expect(ci).toEqual(ai);
    }
  });

  it('hiddenFaces culls the shared face between two touching boxes', () => {
    const mk = (x: number): VoxelBox => ({
      x, y: 0, z: 0, w: 1, h: 1, d: 1,
      r: 128, g: 128, b: 128, rnd: 0.5,
      rough: 0.9, metal: 0, emissive: 0, fx: 0, dry: false, stone: false,
    });
    const boxes = [mk(0), mk(1)];
    const hid = hiddenFaces(boxes);
    // Box 0's +X face is hidden (bit 0 = FACE_PX = 1); its other 5 faces are not.
    expect(hid[0]! & 1).toBe(1);
    expect(hid[0]! & ~1).toBe(0);
    // Box 1's -X face is hidden (bit 1 = FACE_NX = 2); its other 5 faces are not.
    expect(hid[1]! & 2).toBe(2);
    expect(hid[1]! & ~2).toBe(0);
  });

  it('the mesher packs roughness, metalness, emissive/EMISSIVE_RANGE and the fx+flag byte', () => {
    const b: VoxelBox = {
      x: 0, y: 0, z: 0, w: 1, h: 1, d: 1,
      r: 200, g: 100, b: 50, rnd: 0.5,
      rough: 0.4, metal: 0.85, emissive: 8, fx: 2, dry: true, stone: true, ground: false,
    };
    const w = new GeoWriter(1);
    w.box(b, 1);
    expect(w.mat[0]).toBe(Math.round(0.4 * 255));
    expect(w.mat[1]).toBe(Math.round(0.85 * 255));
    expect(w.mat[2]).toBe(Math.round(Math.min(1, 8 / EMISSIVE_RANGE) * 255));
    expect(w.mat[3]).toBe((2 & 31) | 32 | 128); // fx | stone | dry
    // Every one of the 24 vertices (6 faces × 4 corners) carries the same mat bytes.
    for (let v = 0; v < 24; v++) {
      expect(w.mat[v * 4 + 0]).toBe(w.mat[0]);
      expect(w.mat[v * 4 + 3]).toBe(w.mat[3]);
    }
  });
});
