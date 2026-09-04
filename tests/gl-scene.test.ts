/**
 * Pure-side of the WebGL viewport (T-0031, web/src/gl/scene-builder.ts):
 * `SceneBuilder` produces one `InstancedMesh` per structural material from
 * a `LevelView`, rebuilds only when the set of known cells changes, and
 * places sprite billboards with their feet at y = 0 and centre at the cell
 * centre. three.js runs cleanly in node without a `WebGLRenderer`, so all
 * four cases are pure.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { SceneBuilder } from '../web/src/gl/scene-builder.js';
import type { CellKind, LevelView, Sprite } from '../src/model/types.js';
import { ROOM, levelFromAscii } from './fixtures/levels.js';

describe('SceneBuilder — structural geometry from a LevelView', () => {
  it('ROOM yields 41 wall cubes and 79 floor quads (78 floors + doorway)', () => {
    // ROOM has one doorway (D), which contributes both a floor quad (people
    // walk through it) and two door posts, but no wall cube.
    const b = new SceneBuilder();
    b.refresh(ROOM);
    expect(b.counts.walls).toBe(41);
    expect(b.counts.floors).toBe(79);
  });

  it("a closed door produces a box; open door and doorway each produce 2 posts", () => {
    const closed: LevelView = levelFromAscii([
      '###',
      '#+#', // closed door in the middle of walls
      '###',
    ]);
    const b1 = new SceneBuilder();
    b1.refresh(closed);
    expect(b1.counts.doorBoxes).toBe(1);
    expect(b1.counts.doorPosts).toBe(0);
    expect(b1.counts.walls).toBe(8); // all cells except the door

    const open: LevelView = levelFromAscii([
      '###',
      "#'#", // open door
      '###',
    ]);
    const b2 = new SceneBuilder();
    b2.refresh(open);
    expect(b2.counts.doorBoxes).toBe(0);
    expect(b2.counts.doorPosts).toBe(2);
    expect(b2.counts.floors).toBe(1);

    // ROOM's D is a doorway; it also contributes exactly one pair of posts.
    const b3 = new SceneBuilder();
    b3.refresh(ROOM);
    expect(b3.counts.doorPosts).toBe(2);
  });

  it('refresh rebuilds only when the cell-kind grid actually changes', () => {
    const b = new SceneBuilder();
    expect(b.refresh(ROOM)).toBe(true);
    expect(b.refresh(ROOM)).toBe(false);
    // A LevelView with one cell mutated (turn a floor into stairs_up).
    const mutated: LevelView = {
      width: ROOM.width,
      height: ROOM.height,
      kindAt(x: number, y: number): CellKind {
        if (x === 3 && y === 3) return 'stairs_up';
        return ROOM.kindAt(x, y);
      },
      cellAt(x, y) {
        return ROOM.cellAt(x, y);
      },
    };
    expect(b.refresh(mutated)).toBe(true);
    // Same view again: no rebuild.
    expect(b.refresh(mutated)).toBe(false);
    // Stairs count went from 0 to 1.
    expect(b.counts.stairs).toBe(1);
  });

  it('sprite billboards stand on the floor at the cell centre', () => {
    const b = new SceneBuilder();
    const sprite: Sprite = { x: 5, y: 6, ch: 'd', rgb: [1, 0.5, 0.2], cls: 'pet', height: 0.9 };
    const meshes = b.updateSprites([sprite]);
    expect(meshes).toHaveLength(1);
    const m = meshes[0]!;
    // Cell (5, 6) centre = (5.5, ?, 6.5); feet at y = 0 → centre.y = height / 2.
    expect(m.position.x).toBeCloseTo(5.5);
    expect(m.position.z).toBeCloseTo(6.5);
    expect(m.position.y).toBeCloseTo(0.45);
    expect(m.scale.x).toBeCloseTo(0.9);
    expect(m.scale.y).toBeCloseTo(0.9);
    // Default height (0.7) when the sprite omits one.
    const defaultH: Sprite = { x: 0, y: 0, ch: '@', rgb: [1, 1, 1], cls: 'mon' };
    const [only] = b.updateSprites([defaultH]);
    expect(only!.position.y).toBeCloseTo(0.35);
    expect(only).toBeInstanceOf(THREE.Sprite);
  });
});
