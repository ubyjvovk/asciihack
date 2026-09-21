/**
 * Behaviour tests for the GPU sprite billboards (T-0042, docs/gpu-sprites.md).
 * `SpriteLayer` builds one camera-facing quad per `Sprite`, yaws it toward
 * the camera every frame, caches its texture + material per tile key, and
 * releases meshes for sprites that disappear. Every rule is exercised through
 * plain data on the pure side — `three/webgpu`'s `Group`, `Mesh`,
 * `PlaneGeometry`, `DataTexture` and `MeshStandardNodeMaterial` construct
 * fine in node without a renderer.
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera } from 'three/webgpu';
import type { Sprite, Tile } from '../src/model/types.js';
import { SpriteLayer } from '../web/src/gpu/sprites.js';

/** Build a solid-blue 16×16 tile so `SpriteLayer` has a real tile key to hash. */
function blueTile(): Tile {
  return {
    w: 16,
    h: 16,
    pixels: new Uint8Array(16 * 16).fill(1),
    palette: [
      [0, 0, 0],
      [40, 90, 200],
    ],
  };
}

/** Build a solid-red 16×16 tile with a distinct palette so its key differs. */
function redTile(): Tile {
  return {
    w: 16,
    h: 16,
    pixels: new Uint8Array(16 * 16).fill(1),
    palette: [
      [0, 0, 0],
      [200, 40, 40],
    ],
  };
}

describe('SpriteLayer — camera-facing billboards on the GPU dungeon', () => {
  it('a sprite quad stands on the floor at its cell centre with its height class', () => {
    const layer = new SpriteLayer();
    const cam = new PerspectiveCamera();
    cam.position.set(0, 0.5, 0);
    // Explicit height (0.9 ≈ humanoid), plus a size-class default fallback.
    const bat: Sprite = { x: 5, y: 6, ch: 'B', rgb: [0.8, 0.8, 0.2], cls: 'mon', height: 0.9 };
    const [batMesh] = layer.update([bat], cam);
    expect(batMesh).toBeDefined();
    // Feet at y = 0 → the quad's centre sits at height / 2.
    expect(batMesh!.position.x).toBeCloseTo(5.5);
    expect(batMesh!.position.z).toBeCloseTo(6.5);
    expect(batMesh!.position.y).toBeCloseTo(0.45);
    // Width equals height for a 1:1 tile (none supplied → aspect 1).
    expect(batMesh!.scale.x).toBeCloseTo(0.9);
    expect(batMesh!.scale.y).toBeCloseTo(0.9);

    // A sprite with no `height` falls back to the 0.7-cell default; its centre
    // is at 0.35 — the same convention the legacy path uses so a monster reads
    // at the same size in either renderer.
    const gnome: Sprite = { x: 2, y: 2, ch: 'G', rgb: [1, 1, 1], cls: 'mon' };
    const meshes = layer.update([gnome], cam);
    expect(meshes[0]!.position.y).toBeCloseTo(0.35);
    expect(meshes[0]!.scale.y).toBeCloseTo(0.7);

    layer.dispose();
  });

  it('the billboard yaws toward the camera and never pitches', () => {
    const layer = new SpriteLayer();
    const cam = new PerspectiveCamera();
    const sprite: Sprite = { x: 3, y: 3, ch: 'd', rgb: [1, 1, 1], cls: 'pet' };

    // Camera east of the sprite → the +Z face of the quad aims east
    // (rotate 90° about +Y). Sprite centre is (3.5, ~, 3.5).
    cam.position.set(10, 5, 3.5);
    const [east] = layer.update([sprite], cam);
    expect(east!.rotation.y).toBeCloseTo(Math.PI / 2);
    // Y-axis only: pitch and roll stay pinned even when the camera is much
    // higher than the sprite — a monster standing under an ortho camera looking
    // straight down must not lie on its back.
    expect(east!.rotation.x).toBe(0);
    expect(east!.rotation.z).toBe(0);

    // Camera south of the sprite → sprite yaws to face +Z.
    cam.position.set(3.5, 5, 20);
    layer.update([sprite], cam);
    expect(east!.rotation.y).toBeCloseTo(0);
    expect(east!.rotation.x).toBe(0);

    // Camera north (smaller z) → yaw is π; still no pitch.
    cam.position.set(3.5, 0.5, -20);
    layer.update([sprite], cam);
    expect(Math.abs(east!.rotation.y)).toBeCloseTo(Math.PI);
    expect(east!.rotation.x).toBe(0);

    layer.dispose();
  });

  it('textures and materials are cached per tile key across frames', () => {
    const layer = new SpriteLayer();
    const cam = new PerspectiveCamera();
    cam.position.set(0, 0.5, 0);
    const blue = blueTile();
    const red = redTile();

    const bA: Sprite = { x: 1, y: 1, ch: 'B', rgb: [0.5, 0.5, 0.5], cls: 'mon', tile: blue };
    const [m1] = layer.update([bA], cam);
    const map1 = (m1!.material as { colorNode?: unknown }).colorNode;
    const material1 = m1!.material;

    // Same sprite next frame — same mesh, same material, same texture cache.
    const [m2] = layer.update([bA], cam);
    expect(m2).toBe(m1);
    expect(m2!.material).toBe(material1);
    expect((m2!.material as { colorNode?: unknown }).colorNode).toBe(map1);

    // A different sprite carrying the *same* tile shares its texture but earns
    // its own material (the tint differs). Move to a different cell so it
    // gets its own pooled mesh.
    const bB: Sprite = { x: 4, y: 4, ch: 'B', rgb: [0.1, 0.2, 0.9], cls: 'mon', tile: blue };
    const [, m3] = layer.update([bA, bB], cam);
    expect(m3!.material).not.toBe(material1);

    // A sprite with a *different* tile builds a fresh texture + material.
    const rA: Sprite = { x: 7, y: 7, ch: 'r', rgb: [0.5, 0.5, 0.5], cls: 'mon', tile: red };
    const [, , m4] = layer.update([bA, bB, rA], cam);
    expect(m4!.material).not.toBe(material1);
    expect(m4!.material).not.toBe(m3!.material);

    layer.dispose();
  });

  it('sprites that left the level are released', () => {
    const layer = new SpriteLayer();
    const cam = new PerspectiveCamera();
    cam.position.set(0, 0.5, 0);
    const a: Sprite = { x: 1, y: 1, ch: 'd', rgb: [1, 0.5, 0.2], cls: 'mon' };
    const b: Sprite = { x: 9, y: 9, ch: 'G', rgb: [0.9, 0.9, 0.9], cls: 'mon' };

    const meshes = layer.update([a, b], cam);
    expect(layer.root.children).toHaveLength(2);
    const meshA = meshes[0]!;
    const meshB = meshes[1]!;
    expect(meshA.parent).toBe(layer.root);
    expect(meshB.parent).toBe(layer.root);

    // `a` walks off the visible level, `b` stays.
    layer.update([b], cam);
    expect(layer.root.children).toHaveLength(1);
    expect(meshA.parent).toBeNull();
    expect(meshB.parent).toBe(layer.root);

    // Empty list drops the remaining mesh too.
    layer.update([], cam);
    expect(layer.root.children).toHaveLength(0);
    expect(meshB.parent).toBeNull();

    layer.dispose();
  });
});
