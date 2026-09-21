/**
 * Behaviour tests for the voxel avatars — hero and pet — used by the GPU
 * render path (T-0056, docs/gpu-avatar.md). The pure-data model builders
 * (`buildHeroModel`, `buildPetModel`) construct in node without a renderer;
 * the wiring is exercised through `SpriteLayer`, which builds the avatar
 * objects lazily and reuses them across frames.
 */
import { describe, expect, it } from 'vitest';
import { MeshBasicMaterial, PerspectiveCamera } from 'three/webgpu';
import type { Pose, Sprite } from '../src/model/types.js';
import { buildHeroModel, buildPetModel } from '../web/src/gpu/avatar.js';
import { SpriteLayer } from '../web/src/gpu/sprites.js';

describe('voxel avatars — hero and pet on the GPU render path', () => {
  it('the hero model stands 0.7 cells tall on its feet at the origin', () => {
    const m = buildHeroModel();
    // Feet on the floor at y = 0; head crown at 0.7 cells (HERO_SPRITE_HEIGHT).
    expect(m.bounds.min[1]).toBeCloseTo(0, 5);
    expect(m.bounds.max[1]).toBeCloseTo(0.7, 5);
    // Centred on the origin in the horizontal plane — the sprite pipeline
    // places the avatar at the cell centre, so the model must straddle x = 0
    // and z = 0.
    expect(m.bounds.min[0]).toBeLessThan(0);
    expect(m.bounds.max[0]).toBeGreaterThan(0);
    expect(m.bounds.min[2]).toBeLessThan(0);
    expect(m.bounds.max[2]).toBeGreaterThan(0);
    // Ticket budget: hero ≤ 400 boxes.
    expect(m.boxCount).toBeLessThanOrEqual(400);
    expect(m.boxCount).toBeGreaterThan(0);
  });

  it('the hero torso is at least three quarters as deep as it is wide', () => {
    // The tunic is the largest-volume box on the rig; before T-0064 its
    // depth/width was ~0.63, a slab that read as cardboard from the diorama
    // camera. The ticket lifted it to ~0.80 and pins the floor at 0.75 so a
    // future re-grade cannot slide back into slab territory.
    const m = buildHeroModel();
    const boxes = m.parts.flatMap((p) => p.boxes);
    let torso = boxes[0]!;
    for (const box of boxes) {
      if (box.w * box.h * box.d > torso.w * torso.h * torso.d) torso = box;
    }
    expect(torso.d / torso.w).toBeGreaterThanOrEqual(0.75);
  });

  it('the pet model stays inside its box budget', () => {
    const p = buildPetModel();
    // Ticket budget: pet ≤ 200 boxes.
    expect(p.boxCount).toBeLessThanOrEqual(200);
    expect(p.boxCount).toBeGreaterThan(0);
    // Roughly 0.45 cells tall (the ticket's target); the exact number is a
    // consequence of the author grid, so pin the range, not a single value.
    const height = p.bounds.max[1] - p.bounds.min[1];
    expect(height).toBeGreaterThan(0.35);
    expect(height).toBeLessThan(0.55);
    // Feet on the floor.
    expect(p.bounds.min[1]).toBeCloseTo(0, 5);
  });

  it('both models are built once and reused across frames', () => {
    const layer = new SpriteLayer({ voxelMaterial: new MeshBasicMaterial() });
    const cam = new PerspectiveCamera();
    const pose: Pose = { x: 5.5, y: 5.5, yaw: 0 };
    const hero: Sprite = { x: 5, y: 5, ch: '@', rgb: [1, 1, 1], cls: 'mon' };
    const pet: Sprite = { x: 6, y: 5, ch: 'd', rgb: [1, 1, 1], cls: 'pet' };

    const first = layer.update([hero, pet], cam, pose);
    const heroObj = first[0]!;
    const petObj = first[1]!;
    expect(heroObj).toBeDefined();
    expect(petObj).toBeDefined();

    // Next frame — same object identities, so nothing was rebuilt.
    const second = layer.update([hero, pet], cam, pose);
    expect(second[0]).toBe(heroObj);
    expect(second[1]).toBe(petObj);

    // The hero walks; the returned object is still the same one (only the
    // transform changed). "Never rebuild per frame" is the ticket's rule.
    const heroMoved: Sprite = { ...hero, x: 10, y: 7 };
    const third = layer.update([heroMoved, pet], cam, pose);
    expect(third[0]).toBe(heroObj);
    expect(third[1]).toBe(petObj);

    layer.dispose();
  });

  it('the avatar rotates about Y to the facing it is given', () => {
    const layer = new SpriteLayer({ voxelMaterial: new MeshBasicMaterial() });
    const cam = new PerspectiveCamera();
    const hero: Sprite = { x: 5, y: 5, ch: '@', rgb: [1, 1, 1], cls: 'mon' };

    // yaw = 0 is north (-Z world); models are authored facing +Z, so a π
    // rotation about Y lands the front where the pose says. Only the Y axis
    // ever moves — an adventurer stays standing under the ortho camera.
    const [north] = layer.update([hero], cam, { x: 5, y: 5, yaw: 0 });
    expect(north!.rotation.y).toBeCloseTo(Math.PI, 6);
    expect(north!.rotation.x).toBe(0);
    expect(north!.rotation.z).toBe(0);

    // yaw = +π/2 is east (+X world); rotation.y becomes π/2.
    const [east] = layer.update([hero], cam, { x: 5, y: 5, yaw: Math.PI / 2 });
    expect(east!.rotation.y).toBeCloseTo(Math.PI / 2, 6);
    expect(east!.rotation.x).toBe(0);
    expect(east!.rotation.z).toBe(0);

    // yaw = π is south (+Z world); rotation.y wraps back to 0.
    const [south] = layer.update([hero], cam, { x: 5, y: 5, yaw: Math.PI });
    expect(south!.rotation.y).toBeCloseTo(0, 6);
    expect(south!.rotation.x).toBe(0);
    expect(south!.rotation.z).toBe(0);

    layer.dispose();
  });
});
