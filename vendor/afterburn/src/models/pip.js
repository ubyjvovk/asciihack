// Pip — the companion. An old storm lantern crossed with a loyal little dog: boxy cream body on four stubby legs,
// a big pixel eye-screen for a face, and a caged glass lantern in his chest that lights the world around him.
// Built by Ada, left behind for years: dented, patched, still wearing his paper tag.
import { VoxelBuilder, makeRng } from '../voxel/kit.js';
import { stampText } from '../voxel/pixelfont.js';

export const meta = {
  name: 'pip',
  about: 'Pip, the lantern robot companion (0.04 m units, faces +Z)',
  variants: { state: ['awake', 'asleep'], moss: '0..1', lens: [1, 2], tag: [true, false] },
};

export const gallery = [
  { fn: 'build', opts: {} },
  { fn: 'build', opts: { lens: 2 } },
  { fn: 'build', opts: { state: 'asleep', moss: 1 } },
  { fn: 'build', opts: { moss: 1 } },
];

const U = 0.04;
const HEAD_UP = 0.8; // the head rides this far above where its boxes are authored
// literals (not in the palette yet — see report)
const GLASS_GLOW = { rough: 0.1, metal: 0, emissive: 2.0, dry: true }; // lit lantern glass next to the flame
const GLASS_WARM = { rough: 0.1, metal: 0, emissive: 0.8, dry: true }; // lit lantern glass, further out
const GLASS_EDGE = { rough: 0.1, metal: 0, emissive: 0.25, dry: true }; // lit lantern glass, rim of the globe
const EYE_LIT = { rough: 0.2, metal: 0, emissive: 1.0, dry: true }; // eye pixels: a touch under `screen` so they stay teal, not white
const SCREEN_ON = { rough: 0.08, metal: 0, emissive: 0.8, dry: true }; // faint backlight on the dark eye-screen glass
const EYE_DIM = { rough: 0.2, metal: 0, emissive: 0.45, dry: true }; // sleeping eye line
const AMBER = 0xc8741f; // lantern glass tint
const STENCIL = '#857b68'; // faded stencil paint

const EXPRESSIONS = ['open', 'happy', 'sad', 'closed', 'curious', 'blink'];
const MOSS_PARTS = ['mossHead', 'mossBody'];
// 20 × 10 pixel bitmaps (0.5-unit pixels) on the eye-screen, rows top → bottom
const EYES = {
  open: ['', '....XX........XX', '...XXXX......XXXX', '...XXXX......XXXX', '...XXXX......XXXX', '...XXXX......XXXX', '...XXXX......XXXX', '....XX........XX'],
  happy: ['', '', '', '...XXXX......XXXX', '..XXXXXX....XXXXXX', '.XXX..XXX..XXX..XXX', '.XX....XX..XX....XX'],
  sad: ['', '', '', '......X......X', '....XXX......XXX', '...XXXX......XXXX', '...XXXX......XXXX', '....XX........XX'],
  closed: ['', '', '', '', '', '..XXXXXX....XXXXXX'],
  blink: ['', '', '', '', '...XXXX......XXXX', '...XXXX......XXXX'],
  curious: ['............XXXX', '...........XXXXXX', '...........XXXXXX', '....XX.....XXXXXX', '...XXXX....XXXXXX', '...XXXX....XXXXXX', '....XX......XXXX'],
};

/** Stamp a pixel bitmap ('X' = lit) on a +Z facing plane; identical runs on consecutive rows merge into one box. */
function pixels(b, rows, x0, yTop, z, px, depth, color, mat) {
  const open = new Map(); // "col:len" → first row
  for (let r = 0; r <= rows.length; r++) {
    const row = rows[r] || '', now = new Set();
    for (let c = 0, run = -1; c <= row.length; c++) {
      const on = row[c] === 'X';
      if (on && run < 0) run = c;
      if (!on && run >= 0) { now.add(run + ':' + (c - run)); run = -1; }
    }
    for (const [key, r0] of open) {
      if (now.has(key)) continue;
      const [c, n] = key.split(':').map(Number);
      b.box(x0 + c * px, yTop - r * px, z, n * px, (r - r0) * px, depth, color, mat, { j: 0 });
      open.delete(key);
    }
    for (const key of now) if (!open.has(key)) open.set(key, r);
  }
}

/**
 * @param {object} [opts]
 * @param {'awake'|'asleep'} [opts.state='awake'] asleep = lantern dark, only a dim closed eye, no light request
 * @param {number} [opts.moss=0] 0..1 moss, lichen and leaf bits grown over him (1 = the day we find him)
 * @param {1|2} [opts.lens=1] 2 = the second lens: bigger, brighter lantern housing
 * @param {boolean} [opts.tag=true] Ada's paper tag on his chest
 * @param {number} [opts.seed=11]
 */
export function build(opts = {}) {
  const o = { awake: opts.state !== 'asleep', moss: Math.max(0, Math.min(1, opts.moss ?? 0)), lens: opts.lens === 2 ? 2 : 1, tag: opts.tag !== false };
  const b = new VoxelBuilder({ unit: U, seed: opts.seed ?? 11, jitter: 0.045 });
  buildBody(b, o);
  buildLantern(b, o);
  buildLeg(b, 'legFL', 1, 3.2); buildLeg(b, 'legFR', -1, 3.2);
  buildLeg(b, 'legBL', 1, -5); buildLeg(b, 'legBR', -1, -5);
  buildTail(b);
  b.at(0, HEAD_UP, 0, () => { buildHead(b, o); buildEyes(b, o); buildHandle(b); buildAntenna(b, o); });
  if (o.moss > 0) buildMoss(b, o);
  b.root();
  b.anchor('lantern', 0, 6.9, o.lens === 2 ? 9.6 : 8.4);
  b.anchor('head', 0, 13.9 + HEAD_UP, 2.75);
  b.anchor('back', 0, 9.75, -3.6);
  b.anchor('speech', 0, 26, 2);
  return b.build('pip');
}

// HOW HE IS LIT: the lantern's point light sits INSIDE the glass globe (no shadows). The globe and cage silhouette against
// it, his face catches a warm grazing glow from below, the ground pools with light — and nothing cream sits close enough,
// face-on, to blow out. The price: at these distances any pale face that looks back at the light blazes, however thin. So
// paint wear and lettering are FLUSH mosaics (`skin`), the chest is a brass plate, raised cream plates carry brass caps on
// their lantern-side edge, legs wear rubber gaiters on the faces that see the lantern, undersides are dark gaskets.
const LIGHT = [0, 6.9, 7.6];

/** Pixel runs of a stencil text as [x, y, w, h] rects (px units scaled), via the shared 3×5 font. */
function textRects(text, px) {
  const out = [];
  stampText({ box: (x, y, z, w, h) => out.push([x, y, w, h]) }, text, 0, 0, 0, { px, depth: 1 });
  return out;
}

/**
 * Flush mosaic skin on one face of a block: rasterise `paints` ([u, v, w, h, id], later wins) over a base colour, then
 * greedy-mesh equal cells into boxes. id = 'colour' | 'colour|mat' | 'colour~tag' | 'none' (hole) (same colour, separate slab → own jitter).
 * axis 'x': (u,v) = (z,y) · 'y': (x,z) · 'z': (x,y). The skin fills [at − thick, at] (thick < 0: [at, at − thick]).
 */
function skin(b, axis, at, thick, u0, v0, u1, v1, cell, paints, base = 'pip0') {
  const nu = Math.round((u1 - u0) / cell), nv = Math.round((v1 - v0) / cell), g = new Array(nu * nv).fill(base);
  const q = (v, o, n) => Math.max(0, Math.min(n, Math.round((v - o) / cell)));
  for (const [pu, pv, pw, ph, id] of paints) for (let j = q(pv, v0, nv); j < q(pv + ph, v0, nv); j++) g.fill(id, j * nu + q(pu, u0, nu), j * nu + q(pu + pw, u0, nu));
  const lo = thick > 0 ? at - thick : at, T = Math.abs(thick);
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const id = g[j * nu + i];
    if (id === null || id === 'none') continue;
    let w = 1, h = 1;
    while (i + w < nu && g[j * nu + i + w] === id) w++;
    const rowIs = (r) => { for (let k = 0; k < w; k++) if (g[r * nu + i + k] !== id) return false; return true; };
    while (j + h < nv && rowIs(j + h)) h++;
    for (let r = j; r < j + h; r++) g.fill(null, r * nu + i, r * nu + i + w);
    const [key, mat] = id.split('|'), col = key.split('~')[0], U0 = u0 + i * cell, V0 = v0 + j * cell;
    if (axis === 'x') b.box(lo, V0, U0, T, h * cell, w * cell, col, mat || 'paint');
    else if (axis === 'y') b.box(U0, lo, V0, w * cell, T, h * cell, col, mat || 'paint');
    else b.box(U0, V0, lo, w * cell, h * cell, T, col, mat || 'paint');
  }
}

function buildBody(b, o) {
  b.part('body', { pivot: [0, 4, -1] });
  b.box(-5, 4.2, -6, 10, 4.9, 11.1, 'pip0', 'paint'); // core (its front face shows either side of the lantern)
  b.box(-4.8, 3.5, -5.8, 9.6, 0.7, 10.2, 'panel', 'metal'); // belly pan
  b.box(-5.62, 4.2, -6.62, 11.24, 0.45, 11.84, 'brass', 'brass'); // skirt band…
  b.box(-5.63, 4.65, -6.63, 11.26, 0.06, 11.86, 'black', 'rubber', { j: 0 }); // …with a shadow line on its lip
  const seam = (x, y, z, w, h, d) => b.box(x, y, z, w, h, d, 'black', 'rubber', { j: 0 }); // gasket lines
  // his left flank (+X): faded stencil (flush), scuffed lower edge; proud vent plate (straddles the light)
  const px = 0.4, letters = textRects('P-1P', px).map(([x, y, w, h]) => [-0.4 - x - w, 6.2 + y, w, h, STENCIL]);
  skin(b, 'x', 5.5, 0.5, -6.5, 4.2, 5.1, 9.6, 0.2, [
    [-6.5, 4.6, 2.8, 1.4, 'pip1'], [-6.5, 4.6, 1.4, 2.4, 'pip1'], [-4.4, 4.6, 2.2, 0.6, 'pip1'], [-6.5, 9.0, 1.8, 1.0, 'pip1'], [-1.2, 9.4, 2.0, 0.6, 'pip1'],
    [-3.6, 4.6, 0.6, 0.4, 'ash2'], ...letters,
    [-3.2, 6.2, 0.8, 0.8, 'pip0'], [-5.4, 7.4, 0.6, 1.0, 'pip0'], [-1.6, 7.8, 0.6, 0.4, 'pip0'], // chips eating the stencil
  ]);
  b.box(5.5, 4.9, 0.9, 0.2, 4.0, 3.8, 'pip0', 'paint');
  for (let i = 0; i < 3; i++) b.box(5.7, 7.5 - i * 0.85, 1.6, 0.06, 0.4, 2.4, 'hullDark', 'darkmetal');
  b.box(5.5, 4.9, 4.7, 0.27, 4.0, 0.3, 'brass', 'brass'); // brass edge strip on the lantern side
  b.box(5.7, 5.2, 1.2, 0.08, 0.3, 0.3, 'brass', 'brass'); b.box(5.7, 8.3, 1.2, 0.08, 0.3, 0.3, 'brass', 'brass');
  seam(5.5, 4.65, 0.35, 0.05, 4.95, 0.12);
  // his right flank (−X): a big dent scuffed through paint → primer → bare metal, rust running from it; proud tool flap
  skin(b, 'x', -5.5, -0.5, -6.5, 4.2, 5.1, 9.6, 0.2, [
    [-5.6, 5.4, 3.8, 3.2, 'none'], [-4.4, 4.6, 0.4, 0.8, 'rust0|rock'], [-3.2, 4.6, 0.4, 0.6, 'rust1|rock'], [-6.2, 5.0, 0.6, 2.4, 'pip1'], [-1.8, 7.6, 0.8, 1.6, 'pip1'],
    [-6.5, 9.2, 2.2, 0.8, 'pip1'], [0.8, 4.6, 2.4, 0.6, 'pip1'], [3.8, 4.6, 1.3, 1.6, 'pip1'],
  ]);
  for (const [y, z, h, d] of [[5.4, -5.6, 0.2, 3.8], [8.4, -5.6, 0.2, 3.8], [5.6, -5.6, 2.8, 0.2], [5.6, -2.0, 2.8, 0.2]]) b.box(-5.54, y, z, 0.54, h, d, 'black', 'rubber', { j: 0 }); // gasket the panel was punched past
  b.box(-5.2, 5.6, -5.4, 0.2, 1.2, 2.2, 'ash2', 'paint'); b.box(-5.2, 6.8, -5.4, 0.2, 1.6, 2.2, 'pip1', 'paint'); b.box(-5.36, 5.6, -3.2, 0.36, 2.8, 1.2, 'pip0', 'paint'); // the dented panel: deepest at the back
  b.box(-5.65, 5.4, 1.2, 0.15, 3.0, 3.2, 'pip0', 'paint'); // tool flap (straddles the light)
  b.box(-5.72, 5.4, 4.4, 0.22, 3.0, 0.3, 'brass', 'brass'); // piano hinge down its lantern-side edge
  b.box(-5.8, 6.6, 1.35, 0.15, 0.6, 0.45, 'brass', 'brass'); // latch
  seam(-5.55, 4.65, 0.35, 0.05, 4.95, 0.12);
  // rear: flush wear, rivets, the small-cell hatch. Awake = cell seated, LED green. Asleep = socket empty, door dropped open.
  skin(b, 'z', -6.5, -0.5, -5, 4.2, 5, 9.6, 0.2, [[-5, 4.6, 2.4, 1.2, 'pip1'], [2.8, 8.2, 2.2, 1.4, 'pip1'], [3.6, 4.6, 1.4, 0.6, 'pip1'], [-5, 9.4, 1.2, 0.6, 'pip1']]);
  b.box(-2.1, 4.7, -6.8, 4.2, 2.7, 0.3, 'frame', 'darkmetal');
  if (o.awake) {
    b.box(-1.6, 5.05, -6.92, 3.2, 2.0, 0.12, 'stripe', 'plastic');
    b.box(-1.2, 6.45, -6.98, 0.5, 0.3, 0.06, 'ledGreen', 'led', { j: 0 });
    b.box(0.3, 5.3, -6.98, 0.9, 1.4, 0.06, 'brass', 'brass');
  } else {
    b.box(-1.6, 5.05, -6.9, 3.2, 2.0, 0.1, 'black', 'rubber', { j: 0 });
    b.box(-0.45, 5.7, -6.95, 0.9, 0.6, 0.05, 'brass', 'brass'); // bare contact
    b.box(-1.9, 4.05, -7.9, 3.8, 0.22, 1.1, 'pip0', 'paint'); // the door, dropped open
  }
  seam(-5.2, 7.75, -6.55, 10.4, 0.12, 0.05);
  for (const rx of [-4.9, -2.9, 2.6, 4.6]) b.box(rx, 8.6, -6.6, 0.3, 0.3, 0.1, 'brass', 'brass');
  // deck: flush wear; rubber cradle mat + clamps for the big cell; deck bolts
  skin(b, 'y', 9.6, 0.5, -5, -6, 5, 5.1, 0.2, [[-5, -6, 1.8, 3.0, 'pip1'], [3.6, -2.4, 1.4, 1.8, 'pip1'], [-5, 3.2, 2.4, 1.9, 'pip1'], [2.2, -6, 2.8, 0.8, 'pip1'], [-5, -1, 10, 1.2, 'pip0~neck']]);
  b.box(-3.7, 9.6, -5.7, 7.4, 0.1, 5.5, 'frame', 'rubber');
  b.bothX(() => { b.box(3.3, 9.7, -4.9, 0.5, 0.7, 1.0, 'frame', 'rubber'); b.box(3.3, 9.7, -1.9, 0.5, 0.7, 1.0, 'frame', 'rubber'); b.box(4.6, 9.6, -6.0, 0.4, 0.1, 0.4, 'brass', 'brass'); });
  // front: brass corner guards
  b.bothX(() => b.box(4.95, 8.95, 4.6, 0.75, 0.9, 0.75, 'brass', 'brass'));
}

function buildLantern(b, o) { // a little hurricane lantern let into his chest: tank, stepped glass globe, crown, guard wires
  b.part('body');
  const lit = o.awake;
  const glass = (x, y, z, w, h, d, level) => b.box(x, y, z, w, h, d, lit ? [AMBER, 'lamp', 'lantern'][level] : ['hullDark', 'basalt1', 'basalt2'][level], lit ? [GLASS_EDGE, GLASS_WARM, GLASS_GLOW][level] : 'glass');
  b.box(-5.5, 4.2, 5.1, 11, 5.4, 0.2, 'frame', 'darkmetal'); // dark iron chest plate: the glow reads against it
  b.box(-3.9, 4.0, 5.0, 7.8, 0.9, 3.2, 'brass', 'brass'); // tank
  b.box(-3.85, 4.9, 5.0, 7.7, 0.12, 3.15, 'frame', 'rubber'); // gasket
  b.box(-3.0, 4.9, 5.0, 6.0, 0.4, 2.7, 'frame', 'darkmetal'); // burner collar
  b.box(-3.0, 8.5, 5.0, 6.0, 0.35, 2.7, 'frame', 'darkmetal');
  b.box(-3.9, 8.85, 5.0, 7.8, 0.55, 3.2, 'brass', 'brass'); // crown
  b.box(-2.2, 9.4, 5.3, 4.4, 0.35, 2.4, 'brass', 'brass'); // chimney
  glass(-2.4, 5.3, 5.0, 4.8, 0.6, 2.5, 0); glass(-3.0, 5.9, 5.0, 6.0, 2.0, 2.9, 0); glass(-2.4, 7.9, 5.0, 4.8, 0.6, 2.5, 0); // globe tiers
  glass(-2.4, 6.1, 7.9, 4.8, 1.6, 0.06, 1); glass(-1.4, 6.25, 7.9, 2.8, 1.3, 0.1, 2); // glow through the front…
  glass(-1.6, 5.4, 7.5, 3.2, 0.4, 0.06, 1); glass(-1.6, 8.0, 7.5, 3.2, 0.4, 0.06, 1);
  b.bothX(() => { glass(3.0, 6.1, 5.5, 0.06, 1.6, 2.0, 1); glass(3.0, 6.3, 6.0, 0.1, 1.2, 1.0, 2); }); // …and the sides
  b.box(-0.6, 6.4, 7.9, 1.2, 1.0, 0.16, lit ? 'lantern' : 'slate0', lit ? 'lamp' : 'lampOff', { j: 0 }); // the flame: tiny, white-hot
  b.bothX(() => {
    b.box(3.4, 4.9, 5.9, 0.55, 3.95, 0.6, 'brass', 'brass'); // side tubes
    b.box(1.4, 5.3, 7.9, 0.3, 3.2, 0.4, 'brass', 'brass'); // guard wires
    b.box(3.0, 5.85, 5.0, 0.3, 0.25, 3.3, 'brass', 'brass'); b.box(3.0, 7.75, 5.0, 0.3, 0.25, 3.3, 'brass', 'brass');
  });
  b.box(-3.3, 5.85, 7.9, 6.6, 0.25, 0.4, 'brass', 'brass'); b.box(-3.3, 7.75, 7.9, 6.6, 0.25, 0.4, 'brass', 'brass');
  if (o.lens === 2) { // the second lens: a fat bullseye in a stepped brass ring, bracketed to the side tubes
    b.box(-2.6, 5.2, 8.3, 5.2, 3.4, 0.9, 'brass', 'brass'); b.box(-1.7, 4.3, 8.3, 3.4, 5.2, 0.9, 'brass', 'brass');
    glass(-2.0, 5.8, 9.2, 4.0, 2.2, 0.1, 2); glass(-1.1, 4.9, 9.2, 2.2, 4.0, 0.1, 2);
    b.box(-1.0, 5.9, 9.2, 2.0, 2.0, 0.22, lit ? 'lantern' : 'slate0', lit ? 'lamp' : 'lampOff', { j: 0 });
    b.bothX(() => b.box(2.6, 6.6, 6.5, 1.35, 0.6, 2.2, 'frame', 'darkmetal'));
    b.box(1.9, 8.55, 8.4, 0.8, 0.8, 0.7, 'frame', 'darkmetal'); // focus knob
  }
  if (lit) b.light({ name: 'lantern', x: LIGHT[0], y: LIGHT[1], z: LIGHT[2], color: 'lantern', intensity: o.lens === 2 ? 16 : 10, distance: o.lens === 2 ? 13 : 9, flicker: 0.12 });
}

function buildLeg(b, name, sx, hz) {
  b.part(name, { pivot: [sx * 4.1, 4.4, hz], parent: 'body' });
  b.at(sx * 4.1, 0, hz, () => {
    b.box(-1.3, 1.7, -1.3, 2.6, 3.4, 2.6, 'pip0', 'paint'); // sleeve (its top hides inside the belly)
    b.box(sx > 0 ? -1.42 : 1.3, 1.7, -1.3, 0.12, 3.4, 2.6, 'frame', 'rubber'); // rubber liner, inner face
    b.box(-1.3, 1.7, 1.3, 2.6, 3.4, 0.12, 'frame', 'rubber'); // rubber gaiter, front face
    b.box(-1.05, 1.1, -1.05, 2.1, 0.6, 2.1, 'brass', 'brass'); // ankle ring
    b.box(-1.6, 0, -1.7, 3.2, 1.2, 3.7, 'rubber', 'rubber'); // paw
    for (const tx of [-1.5, -0.45, 0.6]) b.box(tx, 0, 2.0, 0.9, 0.8, 0.45, 'rubber', 'rubber'); // toes
    b.box(sx > 0 ? 1.3 : -1.6, 2.6, -0.8, 0.3, 1.6, 1.6, 'brass', 'brass'); // knee cap, outer side
  });
}

function buildTail(b) { // a plug on a short cable: how he talks to the Sparrow
  b.part('tail', { pivot: [0, 8.2, -6.5], parent: 'body' });
  b.box(-0.7, 7.5, -6.9, 1.4, 1.4, 0.5, 'brass', 'brass');
  b.box(-0.3, 7.9, -7.9, 0.6, 0.6, 1.1, 'rubber', 'rubber');
  b.box(-0.3, 8.3, -8.5, 0.6, 0.6, 0.8, 'rubber', 'rubber');
  b.box(-0.3, 8.7, -8.9, 0.6, 1.3, 0.6, 'rubber', 'rubber');
  b.box(-0.55, 10.0, -9.15, 1.1, 1.2, 1.1, 'frame', 'plastic');
  b.bothX(() => b.box(0.15, 11.2, -8.75, 0.2, 0.55, 0.3, 'brass', 'brass'));
}

function buildHead(b, o) {
  b.part('head', { pivot: [0, 9.4, 2.75], parent: 'body' }); // (everything head-side is built inside b.at(0, HEAD_UP, 0))
  b.box(-2.2, 8.8, 0.6, 4.4, 0.9, 4.3, 'rubber', 'rubber'); // neck bellows
  b.box(-2.8, 9.15, 0.1, 5.6, 0.3, 5.3, 'brass', 'brass'); // collar
  b.box(-4.2, 9.7, 0.5, 8.4, 0.6, 4.5, 'black', 'darkmetal'); // swivel block: the stepped underside lets the head nod, tilt and look up
  b.box(-6.06, 10.3, -1.56, 12.12, 0.2, 8.62, 'black', 'rubber'); // jaw gasket: the underside looks straight at the lantern light
  b.box(-5.5, 10.5, -1, 11, 6.5, 8, 'pip0', 'paint'); // skull core; its front face is the cream round the bezel
  // left temple (+X): rust weeping from the riveted patch. Right temple (−X): a small heart somebody painted, long ago
  skin(b, 'x', 6, 0.5, -1.5, 10.5, 7, 17, 0.25, [[-1.5, 10.5, 2.5, 1.0, 'pip1'], [5.0, 10.5, 2.0, 0.75, 'pip1'], [-0.25, 10.5, 0.5, 1.25, 'rust0|rock'], [0.75, 10.75, 0.25, 0.75, 'rust1|rock'], [4.5, 15.5, 2.5, 1.5, 'pip1']]);
  const heart = ['XX.XX', 'XXXXX', 'XXXXX', '.XXX.', '..X..'].flatMap((row, r) => [...row].map((c, i) => (c === 'X' ? [-0.75 + i * 0.25, 13 - r * 0.25, 0.25, 0.25, 'rust1'] : null)).filter(Boolean));
  skin(b, 'x', -6, -0.5, -1.5, 10.5, 7, 17, 0.25, [[-1.5, 10.5, 3.0, 1.25, 'pip1'], [4.25, 10.5, 2.75, 1.0, 'pip1'], [-1.5, 15.75, 1.5, 1.25, 'pip1'], [3.5, 14.5, 3.5, 2.5, 'pip1'], [5.0, 14.75, 1.5, 1.5, 'ash2'], ...heart]);
  skin(b, 'z', -1.5, -0.5, -5.5, 10.5, 5.5, 17, 0.25, [[-5.5, 10.5, 3.0, 1.0, 'pip1'], [3.5, 15.5, 2.0, 1.5, 'pip1'], [1.0, 10.5, 2.5, 0.5, 'pip1']]);
  // lid with a brim over the screen; its front-right corner took a knock: chipped away and folded down
  skin(b, 'y', 17.5, 0.5, -6.25, -1.75, 6.25, 7.75, 0.25, [
    [-6.25, 5.5, 1.5, 2.25, 'none'], [-4.75, 6.75, 11, 1.0, 'pip1'], [-4.75, 5.25, 1.5, 1.5, 'pip1'], [3.75, -1.75, 2.5, 2.0, 'pip1'], [-6.25, -1.75, 2.0, 1.25, 'pip1'],
    [-3.0, 0.0, 6.0, 0.5, 'pip1'], [-3.0, 4.75, 6.0, 0.5, 'pip1'], [-3.0, 0.5, 0.75, 4.25, 'pip1'], [2.25, 0.5, 0.75, 4.25, 'pip1'], [4.5, 3.0, 1.0, 1.5, 'ash2'],
  ]);
  b.box(-6.2, 16.85, -1.7, 12.4, 0.15, 7.2, 'black', 'rubber'); b.box(-4.75, 16.85, 5.5, 10.95, 0.15, 2.2, 'black', 'rubber'); // gasket under the lid
  b.box(-6.15, 16.4, 5.6, 1.35, 0.55, 2.05, 'pip1', 'paint'); b.box(-6.2, 15.9, 6.9, 0.7, 0.5, 0.8, 'ash2', 'paint'); // the folded corner
  b.box(-2.2, 17.5, 0.6, 4.4, 0.5, 4.4, 'brass', 'brass'); // chimney cap
  b.box(-1.4, 18, 1.4, 2.8, 0.35, 2.8, 'brass', 'brass');
  b.bothX(() => b.box(2.2, 17.62, 1.3, 0.06, 0.25, 3.0, 'hullDark', 'darkmetal')); // vent slits
  // face: stepped brass bezel, dark glass standing proud of it (no inner rim to catch the light)
  b.box(-5.6, 11.9, 7, 11.2, 4.0, 0.3, 'brass', 'brass'); b.box(-5.1, 11.4, 7, 10.2, 5.0, 0.3, 'brass', 'brass'); b.box(-4.6, 10.9, 7, 9.2, 6.0, 0.3, 'brass', 'brass');
  b.box(-5, 12.4, 7.3, 10, 3.0, 0.12, 'visor', o.awake ? SCREEN_ON : 'glass', { j: 0 }); b.box(-4.5, 11.9, 7.3, 9, 4.0, 0.12, 'visor', o.awake ? SCREEN_ON : 'glass', { j: 0 }); b.box(-4, 11.4, 7.3, 8, 5.0, 0.12, 'visor', o.awake ? SCREEN_ON : 'glass', { j: 0 });
  for (const [sx, sy] of [[-5.45, 14.0], [5.15, 14.0]]) b.box(sx, sy, 7.3, 0.3, 0.3, 0.08, 'frame', 'darkmetal'); // bezel screws
  // ear bosses for the bail
  b.bothX(() => { b.box(6, 13.4, 1.65, 0.45, 2.2, 2.2, 'brass', 'brass'); b.box(6.45, 14.0, 2.25, 0.3, 1.0, 1.0, 'frame', 'darkmetal'); });
  if (o.tag) { // Ada's paper tag, tied to his right ear boss
    b.box(-6.1, 12.9, 2.7, 0.1, 0.6, 0.12, 'strap', 'fabric');
    b.box(-6.14, 10.7, 2.0, 0.14, 2.3, 1.5, 'paper', 'fabric');
    for (let i = 0; i < 3; i++) b.box(-6.17, 12.3 - i * 0.5, i === 2 ? 2.7 : 2.25, 0.03, 0.14, i === 2 ? 0.55 : 1.0, 'strap', 'fabric', { j: 0 });
  }
  // riveted patch on his left temple
  b.box(6, 11.6, -0.9, 0.2, 3.4, 2.2, 'panel', 'metal');
  for (const [py, pz] of [[11.8, -0.7], [11.8, 0.8], [14.5, -0.7], [14.5, 0.8]]) b.box(6.2, py, pz, 0.12, 0.3, 0.3, 'brass', 'brass');
  // back of the head: grille, four memory-card slots (one card left), antenna bracket
  for (let i = 0; i < 4; i++) b.box(-2.4, 14.0 + i * 0.6, -1.56, 4.8, 0.3, 0.06, 'hullDark', 'darkmetal');
  for (let i = 0; i < 4; i++) b.box(-3.6 + i * 1.9, 12.0, -1.56, 1.4, 0.4, 0.06, 'hullDark', 'darkmetal');
  b.box(-3.5, 12.05, -1.85, 1.2, 0.3, 0.3, 'stripe', 'plastic');
  b.box(3.2, 15.2, -2.0, 1.6, 1.8, 0.5, 'brass', 'brass');
}

function buildEyes(b, o) {
  for (const name of EXPRESSIONS) {
    if (!o.awake && name !== 'closed') continue;
    b.part('eye_' + name, { pivot: [0, 13.9, 7.4], parent: 'head' });
    pixels(b, EYES[name], -5, 16.4, 7.42, 0.5, 0.08, o.awake ? 'eye' : 'cap', o.awake ? EYE_LIT : EYE_DIM);
  }
}

function buildHandle(b) { // the bail: hangs from the ear bosses, wooden grip
  b.part('handle', { pivot: [0, 14.5, 2.75], parent: 'head' });
  b.bothX(() => {
    b.box(6.75, 14.1, 2.45, 0.5, 5.2, 0.6, 'brass', 'brass');
    b.box(6.2, 19.3, 2.45, 1.05, 0.55, 0.6, 'brass', 'brass');
    b.box(5.4, 19.85, 2.45, 1.3, 0.55, 0.6, 'brass', 'brass');
    b.box(2.6, 20.4, 2.45, 3.3, 0.55, 0.6, 'brass', 'brass');
  });
  b.box(-2.7, 20.25, 2.3, 5.4, 0.85, 0.9, 'wood1', 'wood');
  b.box(-2.9, 20.3, 2.35, 0.3, 0.75, 0.8, 'brass', 'brass'); b.box(2.6, 20.3, 2.35, 0.3, 0.75, 0.8, 'brass', 'brass');
}

function buildAntenna(b, o) { // two segments so it can whip; taped where it snapped once
  b.part('antenna', { pivot: [4, 17, -1.75], parent: 'head' });
  b.box(3.5, 16.9, -2.3, 1.0, 0.9, 1.0, 'frame', 'rubber'); // spring boot
  b.box(3.8, 17.8, -2.0, 0.4, 2.2, 0.4, 'panel', 'metal');
  b.part('antenna2', { pivot: [4, 20.0, -1.8], parent: 'antenna' });
  b.box(3.65, 19.9, -2.15, 0.7, 0.6, 0.7, 'canvas', 'fabric');
  b.box(3.85, 20.5, -1.95, 0.3, 1.8, 0.3, 'panel', 'metal');
  b.box(3.65, 22.3, -2.15, 0.7, 0.7, 0.7, o.awake ? 'eye' : 'basalt2', o.awake ? 'led' : 'lampOff', { j: 0 });
}

const MOSS = ['moss0', 'moss0', 'moss1', 'moss1', 'moss2'];

/** Moss cushions on an up-facing surface: fbm coverage (more where `bias` says), low pads with thicker cores (X-runs merged), a few lumps. */
function mossField(b, m, x0, z0, x1, z1, y, cell, bias, hole) {
  const T = 0.84 - 0.3 * m;
  const cover = (x, z) => (hole && hole(x, z) ? 0 : b.fbm(x, y * 3.1, z, 0.21) + bias(x, z));
  for (let z = z0; z < z1 - 1e-6; z += cell) {
    let run = null;
    const flush = (x) => { if (run) b.box(run.x, y, z, x - run.x, run.h, cell, run.col, 'moss'); run = null; };
    for (let x = x0; x < x1 - 1e-6; x += cell) {
      const c = cover(x, z), on = c > T;
      const col = on ? MOSS[Math.min(4, Math.floor(b.noise(x, y, z, 0.4) * 5))] : null, h = c > T + 0.09 ? 0.6 : 0.3;
      if (run && (col !== run.col || h !== run.h)) flush(x);
      if (on && !run) run = { x, col, h };
    }
    flush(x1);
  }
  for (let i = 0, n = Math.round((x1 - x0) * (z1 - z0) * 0.16); i < n; i++) {
    const s = b.range(0.45, 1.0), x = b.range(x0, x1 - s), z = b.range(z0, z1 - s), c = cover(x, z);
    if (c > T + 0.04) b.box(x, y + 0.25, z, s, b.range(0.5, 0.95), s * b.range(0.7, 1.2), b.pick(MOSS), 'moss');
  }
}

function buildMoss(b, o) {
  const keep = b.rand, m = o.moss;
  b.rand = makeRng(911); // own random stream: the robot underneath is identical for every moss value
  b.at(0, HEAD_UP, 0, () => {
  b.part('mossHead', { pivot: [0, 17.5, 2.75], parent: 'head' });
  mossField(b, m, -6.25, -1.75, 6.25, 7.75, 17.5, 0.75, (x, z) => -x * 0.018 - z * 0.012 + (Math.abs(x) > 4.6 || z < -0.4 ? 0.1 : 0), (x, z) => x > -2.9 && x < 2.2 && z > -0.1 && z < 5);
  mossField(b, m, -1.4, 1.4, 1.4, 4.2, 18.35, 0.7, () => 0.06);
  for (let i = 0; i < 9; i++) { // beards hanging off the lid's back and right edges
    const t = b.range(-5.8, 5.2), len = b.range(0.5, 2.0), w = b.range(0.5, 1.0), back = i % 3 > 0, on = b.rand() < m * 0.9;
    if (on && back) b.box(t, 17.5 - len, -1.95, w, len + 0.2, 0.22, b.pick(MOSS), 'moss');
    if (on && !back) b.box(-6.45, 17.5 - len, t * 0.7 + 2.5, 0.22, len + 0.2, w, b.pick(MOSS), 'moss');
  }
  if (m > 0.35) { // a sprout took root up there
    b.box(-4.1, 17.7, 0.4, 0.3, 1.7, 0.3, 'moss0', 'leaf'); b.box(-5.0, 19.0, 0.2, 1.0, 0.3, 0.7, 'moss2', 'leaf'); b.box(-3.9, 19.4, 0.3, 1.1, 0.3, 0.6, 'moss1', 'leaf'); b.box(-4.3, 18.3, 0.6, 0.7, 0.25, 0.8, 'cap', 'leaf');
  }
  });
  b.part('mossBody', { pivot: [0, 9.6, -1], parent: 'body' });
  mossField(b, m, -5.5, -6.5, 5.5, -1.4, 9.7, 0.75, (x, z) => 0.08 - x * 0.012 - z * 0.01);
  mossField(b, m, -3.9, 5.2, 3.9, 8.2, 9.4, 0.7, () => 0, (x, z) => Math.abs(x) < 2.2 && z > 5.3 && z < 7.7);
  mossField(b, m, -2.2, 5.3, 2.2, 7.7, 9.75, 0.7, () => 0.05);
  for (let i = 0; i < 8; i++) { // beards off the deck edge, lichen blooms on the flanks
    const z = b.range(-6.2, 3.8), len = b.range(0.6, 2.2), side = i % 2 ? 1 : -1, on = b.rand() < m * 0.85;
    if (on) b.box(side > 0 ? 5.5 : -5.72, 9.6 - len, z, 0.22, len, b.range(0.5, 1.0), b.pick(MOSS), 'moss');
  }
  for (let i = 0; i < 7; i++) {
    const z = b.range(-6, 3), y = b.range(4.8, 8.6), s = b.range(0.6, 1.3), side = i % 2 ? 1 : -1, on = b.rand() < m * 0.7;
    if (on) b.box(side > 0 ? 5.5 : -5.58, y, z, 0.08, s * 0.8, s, 'lichen', 'moss');
  }
  if (m > 0.6) { b.box(2.4, 9.8, -4.6, 0.25, 1.1, 0.25, 'moss0', 'leaf'); b.box(1.8, 10.8, -4.8, 0.9, 0.25, 0.6, 'moss2', 'leaf'); }
  b.rand = keep;
}

// ---------------------------------------------------------------------------------------------------------------------
// Animation. Poses are weighted sums written into one module-level scratch object, then applied: every transform is SET
// each frame (nothing accumulates) and nothing is allocated.
const LEGS = ['legFL', 'legFR', 'legBL', 'legBR']; // L = his left = +X. Trot pairs: FL+BR, FR+BL
const GAIT = 4; // leg-cycle radians per radian of p.phase: tiny legs take many steps per metre
const LEG = 4.4 * U; // hip → sole
const HANDLE_REST = -0.22; // the bail hangs a little behind the vertical
const DEFAULT_EXPR = { sleep: 'closed', sad: 'sad', happy: 'happy' };
const P = { y: 0, air: 0, pitch: 0, yaw: 0, roll: 0, plant: 1, hY: 0, hPitch: 0, hYaw: 0, hRoll: 0, handle: 0, antX: 0, antZ: 0, tipX: 0, tipZ: 0, tailX: 0, tailY: 0, moss: 1, swing: [0, 0, 0, 0], lift: [0, 0, 0, 0], splay: [0, 0, 0, 0] };

const sat = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const ramp = (a, b, x) => { const t = sat((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const bump = (a, b, c, d, x) => ramp(a, b, x) * (1 - ramp(c, d, x)); // 0 → 1 over a..b, back to 0 over c..d

function resetPose() {
  for (const k in P) if (typeof P[k] === 'number') P[k] = 0;
  P.plant = 1; P.moss = 1;
  P.swing.fill(0); P.lift.fill(0); P.splay.fill(0);
}

/** Alive but still: breathing, slow look-around, antenna sway, the odd tail wag. */
function addIdle(t, w) {
  P.y += w * Math.sin(t * 1.9) * 0.0035;
  P.pitch += w * Math.sin(t * 0.95 + 0.4) * 0.008;
  P.roll += w * Math.sin(t * 0.6) * 0.012;
  P.hYaw += w * (Math.sin(t * 0.37) * 0.24 + Math.sin(t * 0.83 + 1.3) * 0.08);
  P.hPitch += w * (Math.sin(t * 0.51 + 0.7) * 0.05 - 0.02);
  P.hRoll += w * Math.sin(t * 0.29 + 2) * 0.05;
  P.antZ += w * Math.sin(t * 1.3) * 0.05; P.antX += w * Math.sin(t * 0.9 + 1) * 0.04;
  P.tipZ += w * Math.sin(t * 1.3 - 0.9) * 0.09; P.tipX += w * Math.sin(t * 0.9 + 0.2) * 0.06;
  P.handle += w * Math.sin(t * 1.1 + 0.5) * 0.03;
  P.tailY += w * Math.sin(t * 2.4) * 0.3 * (0.5 + 0.5 * Math.sin(t * 0.31)); P.tailX -= w * 0.1;
}

/** Diagonal-pair trot. phi = leg-cycle phase; amp 0..1; A swing (rad), up foot lift, bob, sway roll, lean (rad). */
function addGait(phi, amp, A, up, bob, sway, lean) {
  for (let i = 0; i < 4; i++) {
    const sign = i === 0 || i === 3 ? 1 : -1, s = Math.sin(phi) * sign, c = Math.cos(phi) * sign, a = A * s * amp;
    P.swing[i] -= a; // −X rotation swings the paw forward
    P.lift[i] += Math.max(0, c) * up * amp - LEG * (1 - Math.cos(a)); // airborne while it travels forward; stance paws trace the ground, not an arc
  }
  const c2 = Math.cos(2 * phi), l = lean * amp;
  P.y -= bob * c2 * amp; // lowest at mid-stance of each pair, highest as the pairs change over
  P.roll += sway * Math.sin(phi) * amp; P.yaw += 0.03 * Math.sin(phi) * amp;
  P.pitch += l + 0.02 * Math.sin(2 * phi + 0.6) * amp;
  P.hPitch -= l * 0.7 + 0.03 * Math.sin(2 * phi + 0.2) * amp; P.hRoll -= sway * 0.5 * Math.sin(phi) * amp; // head stays level-ish
  P.hY -= bob * 0.6 * Math.cos(2 * phi - 0.9) * amp; // …and bobs late
  P.antX += -l * 1.5 + Math.sin(2 * phi - 1.2) * 0.1 * amp; P.tipX += -l * 2 + Math.sin(2 * phi - 2.2) * 0.18 * amp; // antenna streams back and whips
  P.antZ += Math.sin(phi - 1) * 0.05 * amp; P.tipZ += Math.sin(phi - 1.8) * 0.09 * amp;
  P.handle += -l * 2 + Math.sin(2 * phi - 1.0) * 0.1 * amp; // the bail clanks along
  P.tailY += Math.sin(phi) * 0.45 * amp; P.tailX += Math.sin(2 * phi) * 0.1 * amp - l;
}

/** Heavier, lower, wider: he has the big cell on his back. */
function addCarryStance(w) {
  P.y -= 0.012 * w; P.hPitch -= 0.05 * w; P.tailX -= 0.3 * w;
  for (let i = 0; i < 4; i++) P.splay[i] += 0.13 * w;
}

function addSad(t, w) {
  P.y += w * (Math.sin(t * 1.1) * 0.003 - 0.012); P.pitch += 0.09 * w;
  P.hPitch += 0.27 * w; P.hRoll += 0.06 * w; P.hYaw += Math.sin(t * 0.45) * 0.07 * w;
  P.antX -= 0.15 * w; P.antZ -= 0.75 * w; P.tipZ -= 0.85 * w; // antenna wilts over his shoulder
  P.handle -= 0.5 * w; P.tailX -= 0.7 * w;
}

/** Powered down: belly on the ground, slumped onto his left side, legs folded out, everything limp. */
function addSleep(w, wFront, wBack) {
  P.plant -= w; P.y -= 0.094 * w; P.roll -= 0.2 * w; P.pitch += 0.05 * w;
  P.hPitch += 0.2 * w; P.hRoll -= 0.15 * w; P.hYaw += 0.1 * w;
  P.antX -= 0.2 * w; P.antZ -= 0.9 * w; P.tipZ -= 0.9 * w; P.handle -= 0.55 * w; P.tailX -= 0.9 * w; P.tailY += 0.3 * w;
  for (let i = 0; i < 4; i++) {
    const f = i < 2 ? wFront : wBack, low = i % 2 === 0; // his left side is the low side
    P.swing[i] += (i < 2 ? -1.35 : 1.25) * f; P.splay[i] += (low ? 0.5 : 0.22) * f; P.lift[i] += (low ? 0.02 : 0) * f;
  }
}

function poseWake(t, k) {
  const front = ramp(0.28, 0.5, k), back = ramp(0.44, 0.72, k), up = (front + back) / 2;
  addSleep(1 - up, 1 - front, 1 - back);
  P.pitch -= 0.2 * (front - back); // front legs push first: nose comes up, then the back end follows
  addIdle(t, ramp(0.9, 1, k));
  const sh = bump(0.04, 0.1, 0.24, 0.32, k); // power arrives: he shudders
  P.roll += Math.sin(k * 210) * 0.02 * sh; P.y += Math.abs(Math.sin(k * 170)) * 0.003 * sh; P.hRoll += Math.sin(k * 260) * 0.03 * sh; P.tipZ += Math.sin(k * 300) * 0.2 * sh;
  const wet = bump(0.74, 0.78, 0.9, 0.96, k), q = k * 95; // on his feet: a wet-dog shake throws the moss off
  P.roll += Math.sin(q) * 0.14 * wet; P.yaw += Math.sin(q + 1.5) * 0.06 * wet; P.hRoll += Math.sin(q - 0.9) * 0.2 * wet;
  P.handle += Math.sin(q - 1.6) * 0.35 * wet; P.antZ += Math.sin(q - 2) * 0.3 * wet; P.tipZ += Math.sin(q - 2.6) * 0.45 * wet; P.tailY += Math.sin(q - 2.4) * 0.7 * wet;
  P.moss = 1 - ramp(0.79, 0.92, k);
  if (k < 0.12) return 'closed';
  if (k < 0.4) return Math.sin(k * 173) > 0.1 ? 'blink' : 'closed'; // the screen flickers into life
  return k < 0.52 ? 'blink' : k < 0.93 ? 'open' : 'happy';
}

function poseHappy(t, k) {
  addIdle(t, 0.5);
  const h = Math.sin(Math.PI * sat((k - 0.24) / 0.38)), env = Math.sqrt(Math.sin(Math.PI * sat(k))), wig = bump(0.64, 0.7, 0.9, 1, k);
  P.y -= 0.014 * bump(0, 0.18, 0.2, 0.3, k) + 0.012 * bump(0.6, 0.66, 0.7, 0.82, k); // crouch … land
  P.air += 0.13 * h; P.plant -= sat(h * 4);
  P.pitch -= 0.1 * h; P.hPitch -= 0.14 * h;
  for (let i = 0; i < 4; i++) { P.swing[i] += (i < 2 ? -0.55 : 0.55) * h; P.splay[i] += 0.25 * h; P.lift[i] += 0.015 * h; } // star jump
  P.yaw += Math.sin(k * 60) * 0.16 * wig; P.roll += Math.sin(k * 60 + 1) * 0.05 * wig; P.hRoll += Math.sin(k * 60 + 2) * 0.12 * wig;
  P.tailY += Math.sin(k * 120) * 0.8 * env; P.handle += Math.sin(k * 50) * 0.25 * env; P.tipZ += Math.sin(k * 70) * 0.3 * env; P.antZ += Math.sin(k * 70 + 0.8) * 0.15 * env;
}

/**
 * Procedural animation (ARCHITECTURE §9): animate(root, t, { anim, speed, phase, k, expr, carry, headYaw, headPitch, moss? }).
 * Loops: idle · walk · jog · carry · talk · sad · sleep. One-shots on k 0→1: wake · happy · nod · look_up.
 * expr ∈ open|happy|sad|closed|curious|blink (default by anim; `open` blinks by itself). moss 0..1 scales the moss parts.
 */
export function animate(root, t, p = {}) {
  const parts = root.userData.parts;
  if (!parts.head) { for (const child of root.children) if (child.userData.parts?.head) animate(child, t, p); return; } // viewer gallery
  const anim = p.anim || 'idle', k = sat(p.k ?? 0), phi = (p.phase ?? 0) * GAIT, carry = !!p.carry || anim === 'carry';
  let expr = p.expr || DEFAULT_EXPR[anim] || 'open';
  // the game speaks a slightly wider vocabulary ('talk', 'sleepy', …): map anything unknown onto a face we have
  if (!EXPRESSIONS.includes(expr)) expr = expr === 'sleepy' ? 'closed' : expr === 'talk' ? (Math.sin(t * 9) > 0.55 ? 'happy' : 'open') : 'open';
  resetPose();
  if (anim === 'walk') addGait(phi, 1, carry ? 0.34 : 0.42, carry ? 0.016 : 0.028, carry ? 0.004 : 0.006, carry ? 0.06 : 0.035, carry ? 0.02 : 0.04);
  else if (anim === 'jog') addGait(phi, 1, carry ? 0.42 : 0.5, carry ? 0.025 : 0.05, carry ? 0.009 : 0.017, 0.05, carry ? 0.07 : 0.14);
  else if (anim === 'carry') { const amp = sat((p.speed ?? 0) / 0.5); addGait(phi, amp, 0.34, 0.016, 0.004, 0.06, 0.02); addIdle(t, 0.6 * (1 - amp)); }
  else if (anim === 'talk') {
    addIdle(t, 0.6);
    const e = 0.55 + 0.45 * Math.sin(t * 2.3), n = Math.sin(t * 8.2);
    P.hPitch += (n * 0.045 + 0.02) * e; P.y += Math.abs(n) * 0.002; P.hRoll += Math.sin(t * 3.1) * 0.04;
    P.antZ += Math.sin(t * 16) * 0.1 * e; P.tipZ += Math.sin(t * 16 - 1) * 0.16 * e; P.handle += Math.sin(t * 8.2 - 0.6) * 0.04 * e; P.tailY += Math.sin(t * 6) * 0.3;
  } else if (anim === 'sad') { addIdle(t, 0.25); addSad(t, 1); }
  else if (anim === 'sleep') addSleep(1, 1, 1);
  else if (anim === 'wake') { const e = poseWake(t, k); if (!p.expr) expr = e; }
  else if (anim === 'happy') poseHappy(t, k);
  else if (anim === 'nod') { addIdle(t, 0.5); const n = (1 - Math.cos(k * Math.PI * 4)) * 0.5 * Math.sin(Math.PI * k); P.hPitch += 0.26 * n; P.pitch += 0.03 * n; P.tipX += 0.3 * Math.sin(k * Math.PI * 4 - 1.2) * Math.sin(Math.PI * k); }
  else if (anim === 'look_up') { const w = bump(0, 0.3, 0.85, 1, k); addIdle(t, 1 - 0.6 * w); P.hPitch -= 0.4 * w; P.pitch -= 0.1 * w; P.antX -= 0.2 * w; P.handle -= 0.2 * w; P.hRoll += 0.05 * w * Math.sin(t * 0.8); }
  else addIdle(t, 1);
  if (carry && anim !== 'sleep') addCarryStance(1);
  if (expr === 'curious' && anim !== 'sleep') P.hRoll += 0.17; // the head tilt that goes with the big eye
  P.hYaw += clamp(p.headYaw ?? 0, -1, 1); P.hPitch += clamp(p.headPitch ?? 0, -0.45, 0.3); P.yaw += 0.12 * clamp(p.headYaw ?? 0, -1, 1);
  if (typeof p.moss === 'number') P.moss = Math.min(P.moss, sat(p.moss));

  // ---- apply ----
  const body = parts.body, br = body.userData.rest, plant = sat(P.plant), sp = Math.sin(P.pitch), sr = Math.sin(P.roll);
  body.position.set(br.x, br.y + P.y + P.air, br.z); body.rotation.set(P.pitch, P.yaw, P.roll);
  for (let i = 0; i < 4; i++) {
    const leg = parts[LEGS[i]], r = leg.userData.rest; // r = hip offset from the body pivot
    leg.position.set(r.x, r.y + P.lift[i] + plant * (r.z * sp - r.x * sr - P.y), r.z); // planted paws stay down while the body bobs, pitches and rolls over them
    leg.rotation.set(P.swing[i], 0, (i % 2 === 0 ? 1 : -1) * P.splay[i]);
  }
  const head = parts.head, hr = head.userData.rest;
  head.position.set(hr.x, hr.y + P.hY, hr.z); head.rotation.set(clamp(P.hPitch, -0.5, 0.34), P.hYaw, clamp(P.hRoll, -0.27, 0.27));
  parts.handle.rotation.x = clamp(HANDLE_REST + P.handle, -0.95, 0.5);
  parts.antenna.rotation.set(P.antX, 0, P.antZ); parts.antenna2.rotation.set(P.tipX, 0, P.tipZ);
  parts.tail.rotation.set(P.tailX, P.tailY, 0);
  for (const name of MOSS_PARTS) { const m = parts[name]; if (m) { m.visible = P.moss > 0.02; m.scale.setScalar(Math.max(0.02, P.moss)); } }

  // ---- face: exactly one expression part visible; `open` blinks on its own every few seconds ----
  if (expr === 'open') {
    const bt = (t + 0.4 * Math.sin(t * 0.7)) % 3.9, second = Math.floor(t / 3.9) % 3 === 2 ? bt - 0.36 : -1;
    const phase = bt < 0.2 ? bt : second >= 0 && second < 0.2 ? second : -1;
    if (phase >= 0) expr = phase > 0.05 && phase < 0.14 ? 'closed' : 'blink';
  }
  if (!parts['eye_' + expr]) expr = 'closed'; // asleep builds only carry the dim closed line
  for (const name of EXPRESSIONS) { const e = parts['eye_' + name]; if (e) e.visible = name === expr; }
}
