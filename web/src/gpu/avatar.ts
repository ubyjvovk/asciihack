/**
 * Voxel avatars — hero and pet — for the GPU render path (T-0056, docs/gpu-avatar.md).
 *
 * The ported afterburn stack lights a voxel dungeon, and the ticket makes the
 * hero and pet real voxel figures too (the earlier billboards were "a flat
 * tinted quad" — fine for a bat, wrong for the thing you look at). Both
 * builders return a `VoxelModel` from the shared kit so `buildModelObject`
 * meshes them with the same material as the walls, and they are lit by the
 * same stack.
 *
 * ### Scale
 * `HERO_SPRITE_HEIGHT = 0.7` cells (`web/src/gl/ortho-camera.ts`). One cell
 * is one world unit here, not a metre — the pilot's `unit: 0.05 m` does not
 * transfer. The rigs below are authored on a **0.025-cell grid** so:
 *
 *     hero top y = 28 * 0.025 = 0.700 cells
 *     pet  top y = 18 * 0.025 = 0.450 cells
 *
 * Feet sit at y = 0, front faces +Z (same convention as the vendored pilot);
 * `applyAvatarFacing(obj, yaw)` rotates the model to `Pose.yaw` (0 = north =
 * -Z, +π/2 = east = +X — architecture.md §7).
 *
 * ### Palette (from `web/src/voxel/palette.ts`, no invented hexes)
 * Hero: `canvas` skin, `wood0` dark leather, `wood1` medium leather, `moss1`
 * green tunic, `strap` dark cloth, `rubber` boot soles, `brass` buckles,
 * `black` eyes. Not the pilot's orange flight suit — this is a NetHack
 * adventurer, so cloth and leather tones.
 * Pet: `wood0`/`wood1` brown fur, `canvas` belly, `strap` paws, `rust0` inner
 * ears, `eye` (teal) eye whites, `black` pupils. Reads as a small companion
 * from the third-person camera.
 */

import type { Material, Object3D } from 'three/webgpu';
import { VoxelBuilder, type VoxelModel } from '../voxel/kit.js';
import { buildModelObject } from '../voxel/mesh.js';
import { HERO_SPRITE_HEIGHT } from '../gl/ortho-camera.js';

/** Units per author step — 0.025 cells; 28 steps stack to `HERO_SPRITE_HEIGHT`. */
const HERO_UNIT_CELLS = HERO_SPRITE_HEIGHT / 28;
/** Pet grid — 0.03 cells per step; 15 steps stack to 0.45 (a hair over half hero). */
const PET_UNIT_CELLS = 0.03;

/**
 * Build the hero: a chunky NetHack adventurer with cloak, tunic, belt, boots,
 * a small pack on the back and a hint of face. Front faces +Z; feet at y = 0.
 * Well under the 400-box ticket budget so a re-grade can add flourishes.
 */
export function buildHeroModel(): VoxelModel {
  const b = new VoxelBuilder({ unit: HERO_UNIT_CELLS, seed: 7, jitter: 0.04 });

  // Legs (symmetric): pants from ankle to hip; boot around the ankle; sole
  // slightly wider so the boot reads on a mid-tone floor.
  b.bothX(() => {
    b.box(0.3, 2.0, -1.5, 2.6, 11.0, 3.0, 'strap', 'fabric'); // pant leg
    b.box(0.2, 12.5, -1.7, 2.8, 1.2, 3.4, 'wood0', 'fabric'); // pant hem cuffed over boot
    b.box(0.15, 0.5, -1.9, 2.9, 2.3, 3.9, 'wood0', 'fabric'); // boot upper
    b.box(0.1, 0.0, -2.0, 3.0, 0.6, 4.0, 'rubber', 'rubber'); // sole
    b.box(0.5, 0.4, 1.7, 2.4, 0.6, 0.4, 'brass', 'brass'); // toe cap glint
  });

  // Hips and belt — the horizontal band that anchors the eye.
  b.box(-3.2, 13.5, -2.0, 6.4, 1.3, 4.0, 'wood0', 'fabric'); // belt leather
  b.box(-0.5, 13.65, 1.9, 1.0, 1.0, 0.25, 'brass', 'brass'); // buckle
  b.box(-0.2, 13.85, 2.02, 0.4, 0.55, 0.1, 'wood1', 'fabric'); // buckle tongue

  // Torso — moss-green tunic over a lighter canvas undershirt hem. The vertical
  // wood-tone strip is the tunic's lace panel; hides the plane between chest
  // boxes and gives the front a readable "adventurer" note.
  b.box(-3.0, 14.8, -1.9, 6.0, 7.2, 3.8, 'moss1', 'fabric'); // tunic
  b.box(-3.1, 14.8, -2.0, 6.2, 0.5, 4.0, 'canvas', 'fabric'); // undershirt hem
  b.box(-0.6, 15.3, 1.88, 1.2, 5.5, 0.18, 'wood1', 'fabric'); // lace panel
  for (let i = 0; i < 4; i++) {
    b.box(-0.5, 15.6 + i * 1.35, 1.99, 1.0, 0.15, 0.08, 'brass', 'brass'); // lace hooks
  }

  // Shoulders and arms.
  b.bothX(() => {
    b.box(2.9, 20.5, -1.6, 1.9, 1.5, 3.2, 'moss1', 'fabric'); // shoulder pad
    b.box(3.0, 17.4, -1.5, 1.7, 3.4, 3.0, 'moss1', 'fabric'); // upper arm
    b.box(2.95, 14.2, -1.4, 1.8, 3.3, 2.8, 'canvas', 'fabric'); // forearm / rolled sleeve
    b.box(2.9, 13.4, -1.4, 1.9, 0.9, 2.8, 'wood0', 'fabric'); // sleeve hem
    b.box(2.95, 12.2, -1.2, 1.85, 1.3, 2.4, 'wood0', 'fabric'); // glove
    b.box(2.9, 12.2, 1.1, 1.9, 0.9, 0.5, 'wood0', 'fabric'); // thumb front
  });

  // Cloak / cape draped down the back (-Z side). One tall slab plus a slightly
  // shorter, offset second slab so it reads as folded fabric, not a plank.
  b.box(-3.4, 14.8, -2.5, 6.8, 8.2, 0.35, 'wood0', 'fabric'); // main drape
  b.box(-3.3, 14.8, -2.15, 6.6, 5.5, 0.3, 'wood1', 'fabric'); // inner lining, slightly ahead
  b.box(-3.5, 22.5, -2.55, 7.0, 0.5, 0.5, 'wood0', 'fabric'); // shoulder yoke
  b.box(-2.7, 22.95, -2.45, 5.4, 0.35, 0.35, 'brass', 'brass'); // clasp band

  // Small travel pack strapped to the back — the courier note kept from the
  // pilot, but muted (no parcel graphics).
  b.box(-2.0, 16.5, -3.05, 4.0, 4.0, 0.6, 'wood1', 'fabric'); // pack body
  b.box(-2.1, 16.5, -3.15, 4.2, 0.4, 0.8, 'strap', 'fabric'); // bottom strap
  b.box(-2.1, 20.1, -3.15, 4.2, 0.4, 0.8, 'strap', 'fabric'); // top strap
  b.box(-0.4, 18.2, -3.2, 0.8, 0.4, 0.15, 'brass', 'brass'); // pack buckle
  b.box(-1.3, 19.5, -3.2, 2.6, 0.35, 0.15, 'wood0', 'fabric'); // flap fold

  // Neck.
  b.box(-1.1, 22.0, -1.1, 2.2, 1.0, 2.2, 'canvas', 'plastic');

  // Head — a boxy skull with a hair cap. Skin uses `canvas` (warm tan) since
  // the palette has no explicit skin tone; the hair cap is `wood0` (dark
  // brown), and eyes are small `black` inserts at brow height.
  b.box(-2.2, 23.0, -2.0, 4.4, 4.5, 4.0, 'canvas', 'plastic'); // face
  b.box(-2.3, 26.2, -2.1, 4.6, 1.8, 4.2, 'wood0', 'fabric'); // hair cap
  b.box(-2.5, 25.6, -2.2, 0.4, 1.2, 4.4, 'wood0', 'fabric'); // side hair L
  b.box(2.1, 25.6, -2.2, 0.4, 1.2, 4.4, 'wood0', 'fabric'); // side hair R
  b.box(-1.35, 25.0, 1.95, 0.7, 0.6, 0.12, 'black', 'plastic'); // eye L
  b.box(0.65, 25.0, 1.95, 0.7, 0.6, 0.12, 'black', 'plastic'); // eye R
  b.box(-0.9, 24.1, 2.0, 1.8, 0.25, 0.1, 'wood0', 'fabric'); // mouth line

  b.anchor('feet', 0, 0, 0);
  b.anchor('head', 0, 28, 0);
  return b.build('hero');
}

/**
 * Build the pet: a small quadruped ~0.45 cells tall (brown fur, cream belly,
 * teal eyes). Reads as a companion at the diorama camera distance; front
 * (nose) faces +Z so the same facing rotation works for both.
 */
export function buildPetModel(): VoxelModel {
  const b = new VoxelBuilder({ unit: PET_UNIT_CELLS, seed: 13, jitter: 0.05 });

  // Legs — four short posts. Front pair near +Z (nose end); back pair near -Z.
  b.bothX(() => {
    b.box(1.3, 0.7, 2.5, 1.6, 4.5, 1.6, 'wood0', 'fabric'); // front leg
    b.box(1.3, 0.7, -4.1, 1.6, 4.5, 1.6, 'wood0', 'fabric'); // back leg
    b.box(1.1, 0.0, 2.4, 2.0, 0.8, 1.8, 'strap', 'rubber'); // front paw
    b.box(1.1, 0.0, -4.2, 2.0, 0.8, 1.8, 'strap', 'rubber'); // back paw
  });

  // Body — brown fur on top, cream belly underneath. Torso runs -4.5..+4.5 in
  // Z so the pet has a real length under its head.
  b.box(-2.5, 5.0, -4.5, 5.0, 4.6, 9.0, 'wood0', 'fabric'); // torso back
  b.box(-2.6, 5.0, -4.6, 5.2, 1.8, 9.2, 'canvas', 'fabric'); // belly stripe
  b.box(-2.5, 5.0, -4.5, 5.0, 4.6, 0.5, 'wood1', 'fabric'); // rump highlight

  // Head — sat forward and up so it clears the shoulder line.
  b.box(-2.4, 8.5, 4.0, 4.8, 4.5, 4.0, 'wood0', 'fabric'); // head block
  b.box(-2.5, 8.5, 3.9, 5.0, 1.8, 4.2, 'canvas', 'fabric'); // chin / lower jaw

  // Ears — pointy triangles suggested with a small tapered stack.
  b.bothX(() => {
    b.box(1.4, 13.0, 4.5, 1.3, 2.0, 1.6, 'wood0', 'fabric'); // outer ear
    b.box(1.7, 13.1, 4.6, 0.7, 1.6, 1.2, 'rust0', 'fabric'); // inner ear (pink-ish)
  });

  // Snout + nose.
  b.box(-1.2, 8.8, 7.8, 2.4, 2.0, 1.2, 'canvas', 'fabric'); // snout
  b.box(-0.4, 10.0, 8.85, 0.8, 0.55, 0.15, 'black', 'plastic'); // nose

  // Eyes: teal iris + dark pupil, small but readable.
  b.bothX(() => {
    b.box(0.7, 10.7, 7.9, 1.0, 1.0, 0.16, 'eye', 'plastic'); // eye white
    b.box(0.95, 10.85, 8.03, 0.55, 0.65, 0.14, 'black', 'plastic'); // pupil
  });

  // Whiskers (tiny slabs at the muzzle sides).
  b.bothX(() => {
    b.box(1.1, 9.5, 8.5, 1.5, 0.1, 0.05, 'canvas', 'fabric');
    b.box(1.1, 9.1, 8.5, 1.5, 0.1, 0.05, 'canvas', 'fabric');
  });

  // Tail — curled up behind (a low arc, three short segments).
  b.box(-0.4, 7.2, -5.5, 0.8, 3.0, 1.0, 'wood0', 'fabric'); // base
  b.box(-0.4, 9.8, -5.5, 0.8, 1.0, 1.0, 'wood0', 'fabric'); // knee of curl
  b.box(-0.4, 10.3, -4.7, 0.8, 0.8, 0.8, 'wood0', 'fabric'); // tip

  // Collar — a small brass ring around the neck; a nod to "pet".
  b.box(-2.3, 8.0, 4.2, 4.6, 0.35, 0.4, 'brass', 'brass');

  b.anchor('feet', 0, 0, 0);
  return b.build('pet');
}

/**
 * Rotate `obj` about the world-Y axis to face the given `yaw` (radians;
 * `Pose.yaw` convention: 0 = north, +π/2 = east). The models are authored
 * facing +Z, so `rotation.y = π - yaw` sends the model's front where the pose
 * says it should be. Pitch and roll are pinned to 0 — an adventurer must
 * stay standing when the ortho camera looks down at them.
 */
export function applyAvatarFacing(obj: Object3D, yaw: number): void {
  obj.rotation.set(0, Math.PI - yaw, 0);
}

/**
 * Build the hero avatar `Object3D` (mesh hierarchy + parts) using `material`.
 * Call **once**; the returned object is meant to be reused every frame with
 * only position and rotation changing.
 */
export function createHeroAvatar(material: Material): Object3D {
  const obj = buildModelObject(buildHeroModel(), material, { castShadow: false, receiveShadow: true });
  obj.name = 'avatar-hero';
  return obj;
}

/**
 * Build the pet avatar `Object3D`. Same lifecycle as the hero: build once,
 * update transform per frame.
 */
export function createPetAvatar(material: Material): Object3D {
  const obj = buildModelObject(buildPetModel(), material, { castShadow: false, receiveShadow: true });
  obj.name = 'avatar-pet';
  return obj;
}
