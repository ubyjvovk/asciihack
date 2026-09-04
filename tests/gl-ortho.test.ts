/**
 * Pure side of the browser ortho view (T-0032, web/src/gl/ortho-camera.ts):
 * `placeOrthoCamera` positions the camera NW-above the hero and sizes the
 * frustum so the hero fills ≈ 1/7 of the viewport with the aspect derived
 * from the cell grid; `cutawayCellsFor` reproduces the terminal ortho's
 * "walls in front of the hero" rule from `src/render/ortho.ts:isCutaway`.
 * three.js runs cleanly in node without a `WebGLRenderer`, so all cases are
 * pure.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  cutawayCellsFor,
  HERO_SPRITE_HEIGHT,
  orthoPlacement,
  placeOrthoCamera,
} from '../web/src/gl/ortho-camera.js';

describe('placeOrthoCamera — 3/4 overhead camera in three.js coords', () => {
  it('places the camera north-west-above the hero (x < hero.x, z < hero.y, y > 0)', () => {
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    const hero = { x: 40, y: 10 };
    placeOrthoCamera(cam, hero, 80, 21);
    expect(cam.position.x).toBeLessThan(hero.x);
    expect(cam.position.z).toBeLessThan(hero.y);
    expect(cam.position.y).toBeGreaterThan(0);
  });

  it('frustum height gives the hero ≈ 1/7 of the viewport', () => {
    const p = orthoPlacement({ x: 40, y: 10 }, 80, 21);
    const viewHeight = p.top - p.bottom;
    expect(viewHeight).toBeCloseTo(7 * HERO_SPRITE_HEIGHT);
    // Hero sprite is scaled to (height, height, 1) world units, so it covers
    // height / viewHeight of the vertical extent.
    expect(HERO_SPRITE_HEIGHT / viewHeight).toBeCloseTo(1 / 7);
  });

  it('aspect follows cols / (rows · cellAspect)', () => {
    // Rectangular terminal: 80 columns × 24 rows, cellAspect = 2.
    const p = orthoPlacement({ x: 40, y: 10 }, 80, 24, 2);
    const width = p.right - p.left;
    const height = p.top - p.bottom;
    expect(width / height).toBeCloseTo(80 / (24 * 2));
    // Wider terminal, same rows: aspect widens by the column ratio.
    const q = orthoPlacement({ x: 40, y: 10 }, 160, 24, 2);
    const wq = q.right - q.left;
    const hq = q.top - q.bottom;
    expect(wq / hq).toBeCloseTo(160 / (24 * 2));
  });
});

describe('cutawayCellsFor — walls strictly in front of the hero', () => {
  it('includes (11,11) and excludes (8,8) and (14,14) for a hero at (10,10)', () => {
    const set = cutawayCellsFor({ x: 10, y: 10 });
    // (11,11) is diagonally in front (bigger x+y) and within the 2-cell box.
    expect(set.has('11,11')).toBe(true);
    // (8,8) is behind (smaller x+y) — never cutaway even though it's close.
    expect(set.has('8,8')).toBe(false);
    // (14,14) is far away (|dx|=4 > 2) — outside the box.
    expect(set.has('14,14')).toBe(false);
  });
});
