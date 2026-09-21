// Reference model: shows the kit's features in ~80 lines. Copy this file's shape for new models.
import { VoxelBuilder } from '../voxel/kit.js';
import { stampText, textWidth } from '../voxel/pixelfont.js';

export const meta = { name: '_demo', about: 'supply crate with a storm lamp and a weed — kit feature tour' };

export function build(opts = {}) {
  const b = new VoxelBuilder({ unit: 0.125, seed: opts.seed ?? 3 }); // 8 units = 1 m

  // crate body: planks with gaps, metal corner straps
  for (let i = 0; i < 4; i++) {
    b.box(0, 1 + i * 2, 0, 10, 1.8, 8, i % 2 ? 'wood0' : 'wood1', 'wood');
  }
  b.box(-0.25, 0, -0.25, 10.5, 1, 8.5, 'frame', 'darkmetal'); // skid
  b.at(5, 0, 0, () => b.bothX(() => { // symmetric about x = 5: move the frame first, then mirror inside it
    b.box(4.25, 1, -0.25, 1, 8, 1, 'frame', 'darkmetal');
    b.box(4.25, 1, 7.25, 1, 8, 1, 'frame', 'darkmetal');
  }));
  // stencil label plate + two rivets
  b.box(2.5, 4, 8, 5, 2.5, 0.15, 'paper', 'paint', { j: 0 });
  b.box(2.8, 6, 8.15, 0.3, 0.3, 0.1, 'brass', 'brass'); b.box(6.9, 6, 8.15, 0.3, 0.3, 0.1, 'brass', 'brass');
  stampText(b, 'SOUP', 5 - textWidth('SOUP') * 0.25 / 2, 4.5, 8.15, { px: 0.25, depth: 0.08, color: 'hullDark' }); // decoration; real reading happens in the UI

  // lid is its own part so the game can swing it open (pivot = back top edge)
  b.part('lid', { pivot: [5, 9, 0] });
  b.box(-0.25, 9, -0.25, 10.5, 1, 8.5, 'wood1', 'wood');
  b.box(4, 10, 6.5, 2, 0.4, 1, 'brass', 'brass'); // handle
  b.root();

  // storm lamp on top: tiny emissive core + a real light request
  b.at(1.5, 10, 1.5, () => {
    b.box(0, 0, 0, 2, 0.5, 2, 'frame', 'darkmetal');
    b.box(0.25, 0.5, 0.25, 1.5, 2, 1.5, 'lamp', 'lamp', { j: 0 });
    b.box(0, 2.5, 0, 2, 0.5, 2, 'frame', 'darkmetal');
    b.line(1, 3, 1, 1, 4.5, 1, 0.25, 'frame', 'darkmetal');
    b.light({ x: 1, y: 1.5, z: 1, color: 'lamp', intensity: 14, distance: 9, flicker: 0.25 });
    b.anchor('lamp', 1, 1.5, 1);
  });

  // a mossy rock made with blob() and a weed with swaying leaves
  b.blob(14, 1.5, 3, 3, 2.2, 2.6, 0.5, (x, y, z, t) => (y > 2 && b.chance(0.5) ? ['moss1', 'moss'] : [b.pick(['basalt2', 'basalt3', 'slate0']), 'rock']));
  b.line(15, 3, 6, 15, 8, 6, 0.5, 'stem', 'leaf');
  for (let i = 0; i < 6; i++) b.box(15 + b.range(-2, 2), 5 + i * 0.6, 6 + b.range(-2, 2), 1, 0.4, 1, b.pick(['moss1', 'moss2', 'cap']), 'leaf');
  b.box(14.75, 8.4, 5.75, 1, 1, 1, 'glow', 'glow', { j: 0 }); // glow bud (fx: pulse)

  // status LED + ember crumbs
  b.box(9.2, 7, 8, 0.4, 0.4, 0.15, 'ledGreen', 'led', { j: 0 });
  for (let i = 0; i < 8; i++) b.box(b.range(-3, 1), 0, b.range(9, 12), 0.4, 0.3, 0.4, 'ember', 'ember');

  return b.build('_demo');
}

// Optional: procedural animation. root.userData.parts.<name> are Object3Ds pivoted where you said.
export function animate(root, t, { anim }) {
  const lid = root.userData.parts.lid;
  if (lid) lid.rotation.x = anim === 'open' ? -Math.min(1.1, (t % 4) * 0.8) : 0;
}
