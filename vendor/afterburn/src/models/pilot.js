// The Pilot — the player character. A young courier pilot who crashed the Sparrow: small, determined, a bit lost.
// He never speaks; body language is everything. The one saturated orange note in a teal-grey world.
// Chunky chibi proportions: 1.45 m tall, 0.5 m helmet, short sturdy legs, mitten gloves, big boots. Faces +Z.
import { VoxelBuilder } from '../voxel/kit.js';
import { FX } from '../voxel/palette.js';

const U = 0.05; // metres per unit — fine character grid (29 units tall)

// ---- rig landmarks (units, model space) ----
const PELVIS_Y = 9.5, WAIST_Y = 10.5, NECK_Y = 19;
const HIP_X = 1.95, HIP_Y = 9, KNEE_Y = 5, ANKLE_Y = 2;
const SHOULDER_X = 4.95, SHOULDER_Y = 17.5, ELBOW_Y = 13.5;
const THIGH = HIP_Y - KNEE_Y, SHIN = KNEE_Y - ANKLE_Y; // leg bone lengths for IK
const HEEL = 2.2, BALL = 3.7; // where the rigid sole rolls: heel edge behind the ankle, toe edge ahead of it
const HELMET_Z = 0.3; // helmet centre sits slightly forward of the spine

const SUIT = { rough: 0.78, metal: 0 }; // coated flight-suit fabric: stays orange in the rain, soft sheen when wet
const GLINT = { rough: 0.08, metal: 0, emissive: 0.55, dry: true }; // warm reflection living in the visor
const BEACON = { rough: 0.4, metal: 0, emissive: 5, fx: FX.flicker, dry: true }; // helmet status light: steady in any mood, flickers since the crash
const SOOT = 0x77726a, SOOT_DARK = 0x4b4843, BURNT = 0x7a3518, TAPE = 0x9aa09c; // crash wear

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const clamp01 = (v) => clamp(v, 0, 1);

/** Run fn for the left limb (+X) or mirrored for the right (−X). */
function sided(b, s, fn) { if (s > 0) fn(); else b.mirrorX(fn); }

/** One stair-stepped rounded-rectangle layer (non-overlapping boxes), centred on x = 0, z = cz. */
function roundLayer(b, y0, y1, r, cz, c1, c2, color, mat, stripe) {
  const h = y1 - y0, a = r - c1, m = r - c2;
  if (stripe) {
    b.box(-a, y0, cz - r, a - stripe.w, h, 2 * r, color, mat);
    b.box(-stripe.w, y0, cz - r, 2 * stripe.w, h, 2 * r, stripe.color, mat);
    b.box(stripe.w, y0, cz - r, a - stripe.w, h, 2 * r, color, mat);
  } else b.box(-a, y0, cz - r, 2 * a, h, 2 * r, color, mat);
  b.bothX(() => {
    b.box(a, y0, cz - m, c1 - c2, h, 2 * m, color, mat);
    b.box(m, y0, cz - a, c2, h, 2 * a, color, mat);
  });
}

/**
 * Ragged scorch or soot on a flat surface: a dark core plate with smaller, fainter plates fringing it, each at its own
 * depth so overlaps never z-fight. face = which way the surface looks ('z+' | 'x+' | 'x-' | 'y+'); tones run core → fringe.
 */
function smudge(b, face, x, y, z, w, h, n, tones, mat = SUIT) {
  for (let i = 0; i < n; i++) {
    const r = i / n; // 0 = core … 1 = fringe
    const size = (r < 0.3 ? 0.42 - 0.5 * r : 0.34 - 0.2 * r), pw = w * size * b.range(0.75, 1.1), ph = h * size * b.range(0.95, 1.4);
    const a = b.range(0, Math.PI * 2), d = r < 0.3 ? 0.35 * r + 0.04 : 0.1 + r * 0.4;
    const u = clamp(w / 2 + Math.cos(a) * d * w - pw / 2, 0, w - pw), v = clamp(h / 2 + Math.sin(a) * d * h - ph / 2, 0, h - ph);
    const tone = tones[Math.min(tones.length - 1, Math.floor(r * tones.length))], t = 0.03 + (n - i) * 0.012; // core proudest
    if (face === 'z+') b.box(x + u, y + v, z, pw, ph, t, tone, mat);
    else if (face === 'x+') b.box(x, y + v, z + u, t, ph, pw, tone, mat);
    else if (face === 'x-') b.box(x - t, y + v, z + u, t, ph, pw, tone, mat);
    else b.box(x + u, y, z + v, pw, t, ph, tone, mat); // y+ : (w, h) span x and z
  }
}

function buildHips(b) {
  b.part('hips', { pivot: [0, PELVIS_Y, 0] });
  b.box(-3.6, 7.9, -2.3, 7.2, 2.6, 4.7, 'suit0', SUIT);
  b.box(-3.8, 9.7, -2.5, 7.6, 1.1, 5.1, 'strap', 'fabric'); // belt
  b.box(-0.85, 9.75, 2.6, 1.7, 1.0, 0.3, 'panel', 'metal'); // buckle
  b.box(-0.4, 10.0, 2.9, 0.8, 0.5, 0.1, 'hullDark', 'darkmetal');
  b.box(-3.4, 8.1, 2.4, 2.0, 1.9, 0.95, 'hull1', 'fabric'); // belt pouch, front right
  b.box(-3.5, 9.35, 2.4, 2.2, 0.75, 1.1, 'canvas', 'fabric');
  b.box(-2.65, 9.25, 3.5, 0.5, 0.45, 0.1, 'brass', 'brass');
  b.box(1.7, 8.6, 2.4, 0.5, 1.2, 0.5, 'panel', 'metal'); // carabiner on the left
  b.box(1.7, 8.2, 2.4, 1.3, 0.4, 0.5, 'panel', 'metal');
  b.box(2.5, 8.6, 2.4, 0.5, 1.2, 0.5, 'panel', 'metal');
}

function buildLeg(b, s) {
  const n = s > 0 ? 'L' : 'R';
  sided(b, s, () => {
    b.part('leg' + n, { pivot: [HIP_X, HIP_Y, 0], parent: 'hips' });
    b.box(0.3, 4.9, -1.85, 3.2, 4.3, 3.75, 'suit0', SUIT); // thigh
    b.box(0.25, 4.7, -1.95, 3.3, 0.7, 3.95, 'suit1', SUIT); // hem above the knee
    b.box(3.5, 5.7, -1.2, 0.45, 2.1, 2.4, 'suit1', SUIT); // cargo pocket
    b.box(3.5, 7.3, -1.3, 0.6, 0.6, 2.6, 'suit1', SUIT); // flap
    b.box(4.1, 7.45, -0.2, 0.1, 0.3, 0.4, 'brass', 'brass'); // snap

    b.part('shin' + n, { pivot: [HIP_X, KNEE_Y, 0], parent: 'leg' + n });
    b.box(0.45, 3.2, -1.7, 2.9, 1.9, 3.4, 'suit0', SUIT); // shin, tucked into the boot
    b.box(0.55, 3.8, 1.7, 2.7, 2.3, 0.7, 'strap', 'rubber'); // knee pad
    b.box(1.0, 4.3, 2.4, 1.8, 1.2, 0.25, 'hullDark', 'rubber');
    b.box(0.3, 4.6, -1.9, 0.5, 0.5, 3.7, 'strap', 'fabric'); // pad strap round the back
    b.box(3.0, 4.6, -1.9, 0.5, 0.5, 3.7, 'strap', 'fabric');
    b.box(0.8, 4.6, -1.95, 2.2, 0.5, 0.25, 'strap', 'fabric');
    b.box(0.15, 1.9, -2.05, 3.5, 1.5, 4.1, 'strap', 'rubber'); // boot shaft
    b.box(0.05, 3.2, -2.15, 3.7, 0.5, 4.3, 'hull1', 'fabric'); // boot cuff
    b.box(3.65, 2.3, -0.5, 0.15, 0.6, 1.0, 'panel', 'metal'); // buckle

    b.part('foot' + n, { pivot: [HIP_X, ANKLE_Y, 0], parent: 'shin' + n });
    b.box(0.0, 0.22, -2.4, 3.9, 0.38, 6.4, 'hullDark', 'rubber'); // sole
    for (let i = 0; i < 4; i++) b.box(0.15, 0, -0.1 + i * 1.05, 3.6, 0.22, 0.7, 'scorch1', 'rubber'); // tread bars
    b.box(0.15, 0, -2.3, 3.6, 0.22, 1.6, 'scorch1', 'rubber'); // heel block
    b.box(0.15, 0.6, -2.2, 3.6, 1.4, 4.7, 'strap', 'rubber'); // upper
    b.box(0.25, 0.6, 2.5, 3.4, 1.05, 1.3, 'strap', 'rubber'); // toe box
    b.box(0.2, 0.6, 3.2, 3.5, 0.8, 0.75, 'panel', 'metal'); // toe cap
    b.box(0.1, 0.6, -2.35, 3.7, 1.1, 0.6, 'hullDark', 'rubber'); // heel counter
    b.box(0.6, 1.65, 1.2, 2.7, 0.3, 1.2, 'hullDark', 'fabric'); // tongue / lace guard
  });
}

function buildTorso(b, wear) {
  b.part('torso', { pivot: [0, WAIST_Y, 0], parent: 'hips' });
  b.box(-3.3, 10.4, -2.2, 6.6, 2.4, 4.5, 'suit1', SUIT); // waist
  b.box(-3.7, 12.8, -2.5, 7.4, 5.2, 5.2, 'suit0', SUIT); // chest
  b.box(-3.1, 18.0, -2.2, 6.2, 0.5, 4.5, 'suit0', SUIT); // shoulder slope
  b.box(-3.2, 17.4, 2.7, 6.4, 0.6, 0.2, 'suit1', SUIT); // collar flap
  b.box(-2.9, 18.3, -2.5, 5.8, 1.0, 5.5, 'strap', 'rubber'); // neck seal
  b.box(-3.3, 18.9, -2.8, 6.6, 0.5, 6.1, 'panel', 'metal'); // locking ring
  b.box(-0.4, 18.85, 3.3, 0.8, 0.6, 0.25, 'brass', 'brass'); // ring latch

  // chest control panel
  b.box(-1.9, 14.2, 2.7, 3.8, 2.7, 0.6, 'panel', 'paint');
  b.box(-1.6, 15.15, 3.3, 1.7, 1.45, 0.1, 'hullDark', 'glass'); // dead screen
  b.box(0.5, 16.0, 3.3, 0.5, 0.5, 0.15, 'helmet', 'plastic'); // buttons
  b.box(1.2, 16.0, 3.3, 0.5, 0.5, 0.15, 'stripe', 'plastic');
  b.box(0.5, 15.2, 3.3, 1.2, 0.4, 0.1, 'hullDark', 'plastic'); // grille
  b.box(1.25, 14.5, 3.3, 0.4, 0.4, 0.12, 'ledGreen', 'led', { j: 0 }); // the one LED
  b.box(-1.6, 14.5, 3.3, 2.4, 0.35, 0.08, 'hull1', 'paint'); // label strip
  b.box(1.9, 14.6, 2.7, 0.35, 0.5, 0.5, 'strap', 'rubber'); // hose stub to the harness

  // harness: shoulder straps, chest strap, zipper
  b.bothX(() => {
    b.box(2.15, 10.9, 2.3, 0.95, 1.9, 0.22, 'strap', 'fabric');
    b.box(2.15, 12.8, 2.7, 0.95, 5.7, 0.22, 'strap', 'fabric');
    b.box(2.15, 18.5, -2.7, 0.95, 0.22, 5.62, 'strap', 'fabric');
    b.box(2.25, 16.7, 2.92, 0.75, 0.6, 0.15, 'panel', 'metal'); // adjuster
  });
  b.box(-2.15, 13.2, 2.7, 4.3, 0.6, 0.2, 'strap', 'fabric');
  b.box(-0.5, 13.1, 2.9, 1.0, 0.8, 0.2, 'panel', 'metal');
  b.box(-0.12, 10.9, 2.3, 0.24, 2.3, 0.1, 'hullDark', 'metal'); // zipper on the waist
  b.box(-0.2, 12.6, 2.3, 0.4, 0.55, 0.18, 'brass', 'brass');

  // story: scorch licking up his left side from the crash fire
  wear(0.2, () => smudge(b, 'z+', 0.5, 10.6, 2.3, 2.8, 2.2, 10, ['scorch2', BURNT, BURNT, 'suit1']));
  wear(0.2, () => smudge(b, 'x+', 3.3, 10.6, -1.4, 3.4, 2.1, 6, ['scorch2', BURNT, 'suit1']));
  wear(0.45, () => smudge(b, 'x+', 3.7, 12.8, -0.6, 3.0, 2.2, 6, ['scorch2', BURNT, 'suit1']));
}

function buildArm(b, s) {
  const n = s > 0 ? 'L' : 'R';
  sided(b, s, () => {
    b.part('arm' + n, { pivot: [SHOULDER_X, SHOULDER_Y, 0], parent: 'torso' });
    b.box(3.7, 16.3, -1.55, 2.8, 2.1, 3.1, 'suit0', SUIT); // shoulder cap
    b.box(3.85, 13.3, -1.3, 2.45, 3.0, 2.6, 'suit0', SUIT); // upper arm

    b.part('forearm' + n, { pivot: [SHOULDER_X, ELBOW_Y, 0], parent: 'arm' + n });
    b.box(3.9, 11.4, -1.25, 2.35, 2.2, 2.5, 'suit0', SUIT);
    b.box(3.8, 10.9, -1.35, 2.55, 0.6, 2.7, 'suit1', SUIT); // sleeve hem
    b.box(4.0, 12.4, -1.85, 2.15, 1.9, 0.6, 'strap', 'rubber'); // elbow pad
    b.box(4.4, 12.8, -2.05, 1.35, 1.1, 0.2, 'hullDark', 'rubber');
    b.box(3.7, 10.35, -1.45, 2.75, 0.6, 2.9, 'hullDark', 'rubber'); // cuff ring
    b.box(3.7, 8.6, -1.5, 2.75, 1.75, 3.0, 'strap', 'rubber'); // mitten
    b.box(3.95, 8.2, -1.25, 2.25, 0.4, 2.5, 'strap', 'rubber');
    b.box(3.7, 9.0, 1.5, 1.0, 1.2, 0.7, 'strap', 'rubber'); // thumb (inner front)
    b.box(4.2, 9.9, -1.6, 1.8, 0.35, 0.12, 'hull1', 'fabric'); // knuckle tab
  });
}

function buildHead(b, lamp, wear) {
  b.part('head', { pivot: [0, NECK_Y, 0], parent: 'torso' });
  const cz = HELMET_Z, stripe = { w: 0.85, color: 'stripe' };
  roundLayer(b, 19.5, 20.1, 3.4, cz, 1.0, 0.4, 'hull1', 'paint');
  roundLayer(b, 20.1, 21.0, 4.3, cz, 1.3, 0.5, 'hull1', 'paint');
  roundLayer(b, 21.0, 21.9, 5.0, cz, 1.5, 0.5, 'helmet', 'paint');
  roundLayer(b, 26.2, 27.2, 5.0, cz, 1.5, 0.5, 'helmet', 'paint', stripe);
  roundLayer(b, 27.2, 28.1, 4.5, cz, 1.4, 0.5, 'helmet', 'paint', stripe);
  roundLayer(b, 28.1, 28.7, 3.7, cz, 1.2, 0.4, 'helmet', 'paint', stripe);
  roundLayer(b, 28.7, 29.0, 2.5, cz, 0.9, 0.3, 'helmet', 'paint', stripe);

  // visor band (y 21.9–26.2): cream shell behind, wrap-around glass in front, recessed half a unit under the brow
  const y0 = 21.9, h = 4.3, zs = cz - 5;
  b.box(-3.5, y0, zs, 3.5 - stripe.w, h, 9.2, 'helmet', 'paint');
  b.box(-stripe.w, y0, zs, 2 * stripe.w, h, 9.2, 'stripe', 'paint');
  b.box(stripe.w, y0, zs, 3.5 - stripe.w, h, 9.2, 'helmet', 'paint');
  b.bothX(() => {
    b.box(3.5, y0, cz - 4.5, 1.0, h, 6.3, 'helmet', 'paint');
    b.box(4.5, y0, cz - 3.5, 0.5, h, 5.3, 'helmet', 'paint');
    b.box(3.5, y0, cz + 1.8, 1.0, h, 2.7, 'visor', 'glass', { j: 0.02 }); // wrap-around corners
    b.box(4.5, y0, cz + 1.8, 0.5, h, 1.7, 'visor', 'glass', { j: 0.02 });
  });
  b.box(-3.5, y0 + 1.5, cz + 4.2, 7, h - 1.5, 0.3, 'visor', 'glass', { j: 0 });
  b.box(-3.5, y0, cz + 4.2, 7, 1.5, 0.3, 0x22353f, 'glass', { j: 0 }); // the ground, mirrored faintly
  b.box(-2.9, 24.95, cz + 4.5, 1.7, 0.4, 0.06, 'lamp', GLINT, { j: 0 }); // warm reflection strip
  b.box(-0.9, 24.95, cz + 4.5, 0.45, 0.4, 0.06, 'lamp', GLINT, { j: 0 });
  b.box(-2.9, 24.35, cz + 4.5, 0.45, 0.4, 0.06, 0xffd9a8, GLINT, { j: 0 });

  // brow, chin vent, ear cups, rear port
  b.box(-3.9, 26.2, cz + 5, wear.on(0.3) ? 6.9 : 7.8, 0.75, 0.45, 'helmet', 'paint'); // chipped at his left when scuffed
  b.box(-2.3, 20.3, cz + 4.3, 4.6, 1.5, 1.1, 'hull1', 'paint');
  for (let i = 0; i < 3; i++) b.box(-1.45 + i * 1.1, 20.6, cz + 5.4, 0.7, 0.9, 0.08, 'strap', 'rubber');
  b.bothX(() => {
    b.box(5, 22.5, cz - 1.7, 0.7, 3.4, 3.4, 'panel', 'paint');
    b.box(5.7, 23.2, cz - 1.0, 0.25, 2.0, 2.0, 'strap', 'plastic');
    b.box(5.95, 23.95, cz - 0.25, 0.1, 0.5, 0.5, 'brass', 'brass');
  });
  b.box(-1.7, 20.5, cz - 5.5, 3.4, 2.2, 0.5, 'panel', 'paint');
  b.box(-1.2, 21.0, cz - 5.62, 0.9, 0.9, 0.12, 'hullDark', 'rubber');
  b.box(0.3, 21.0, cz - 5.62, 0.9, 0.9, 0.12, 'hullDark', 'rubber');
  b.box(-1.7, 23.2, cz - 5.12, 0.85, 0.3, 0.12, 'strap', 'paint'); // vent slits
  b.box(0.85, 23.2, cz - 5.12, 0.85, 0.3, 0.12, 'strap', 'paint');

  // antenna on his right ear cup — bent by the crash
  b.box(-5.55, 25.9, cz - 0.15, 0.3, 2.4, 0.3, 'strap', 'metal');
  if (wear.on(0.5)) { b.box(-5.85, 28.3, cz - 0.15, 0.6, 0.3, 0.3, 'strap', 'metal'); b.box(-6.15, 28.6, cz - 0.15, 0.3, 1.0, 0.3, 'strap', 'metal'); b.box(-6.25, 29.6, cz - 0.25, 0.5, 0.5, 0.5, 'hull1', 'plastic'); }
  else { b.box(-5.55, 28.3, cz - 0.15, 0.3, 1.3, 0.3, 'strap', 'metal'); b.box(-5.65, 29.6, cz - 0.25, 0.5, 0.5, 0.5, 'hull1', 'plastic'); }

  // lamp rail on his left ear cup; the lamp itself when he has found it
  b.box(5.95, 23.6, cz - 1.3, 0.3, 1.2, 0.5, 'strap', 'metal');
  if (lamp) {
    b.box(5.95, 23.2, cz - 0.7, 0.4, 2.0, 1.6, 'strap', 'darkmetal'); // clamp
    b.box(6.35, 23.1, cz - 0.9, 1.7, 2.2, 3.3, 'frame', 'darkmetal'); // housing
    b.box(6.5, 25.3, cz - 0.5, 1.4, 0.3, 2.0, 'strap', 'rubber'); // grip ribs
    b.box(6.25, 23.0, cz + 2.4, 1.9, 2.4, 0.4, 'panel', 'metal'); // bezel
    b.box(6.75, 23.6, cz + 2.8, 0.9, 1.2, 0.15, 'lamp', 'lamp', { j: 0 }); // lens
    b.box(6.55, 23.4, cz + 2.8, 1.3, 0.2, 0.25, 'strap', 'darkmetal'); // lens guard
    b.box(6.55, 24.8, cz + 2.8, 1.3, 0.2, 0.25, 'strap', 'darkmetal');
    b.box(8.05, 23.9, cz + 0.2, 0.2, 0.6, 0.9, 'rust1', 'paint'); // switch
    // The light rides the head but sits a metre ahead at chest height: a 9 cd point light any closer to the cream helmet
    // burns it out (inverse square); out here it pools on the ground ahead and warms his front instead.
    b.light({ name: 'lamp', x: 4, y: 18, z: cz + 21, color: 'lamp', intensity: 9, distance: 8 });
  }

  // status beacon on the crown — the one thing the high camera can always find in the dark
  b.box(-0.55, 29.0, cz - 1.9, 1.1, 0.25, 1.1, 'strap', 'plastic');
  b.box(-0.3, 29.25, cz - 1.65, 0.6, 0.3, 0.6, 'lamp', BEACON, { j: 0 });

  // soot and scratches
  wear(0.35, () => { // paint scraped to the primer where the helmet hit the canopy
    b.box(5.0, 26.3, cz - 0.4, 0.06, 0.2, 2.6, 'panel', 'paint'); b.box(5.0, 25.9, cz + 0.3, 0.06, 0.2, 2.1, 'panel', 'paint'); b.box(5.0, 26.7, cz + 0.9, 0.06, 0.15, 1.2, 'wall1', 'paint');
    b.box(2.2, 28.1, cz + 1.4, 1.4, 0.06, 0.25, 'panel', 'paint'); b.box(2.6, 28.1, cz + 0.9, 1.5, 0.06, 0.2, 'panel', 'paint');
  });
  const grime = [SOOT_DARK, SOOT, SOOT, 0xb3aea2];
  wear(0.15, () => { smudge(b, 'z+', -4.6, 26.25, cz + 5, 2.2, 0.9, 4, grime, 'paint'); smudge(b, 'x-', -5, 24.6, cz + 1.4, 2.0, 2.4, 5, grime, 'paint'); });
  wear(0.4, () => { smudge(b, 'y+', -4.3, 27.2, cz + 1.6, 2.6, 2.8, 6, grime, 'paint'); smudge(b, 'y+', -3.5, 28.1, cz + 0.2, 2.2, 2.6, 5, grime, 'paint'); });
  wear(0.55, () => { b.box(2.6, 26.7, cz + 5, 1.5, 0.12, 0.06, SOOT_DARK, 'paint'); b.box(3.0, 26.45, cz + 5, 0.7, 0.12, 0.06, SOOT_DARK, 'paint'); }); // scratches on the brow
  wear(0.75, () => { smudge(b, 'y+', -2.8, 27.2, cz - 3.8, 3.2, 2.2, 5, grime, 'paint'); smudge(b, 'x-', -5, 22.2, cz - 3.2, 2.2, 2.6, 5, grime, 'paint'); });
  wear(0.9, () => smudge(b, 'y+', 1.0, 28.7, cz - 1.6, 1.8, 1.8, 4, grime, 'paint'));
}

function buildPack(b, wear) {
  b.part('pack', { pivot: [0, 14.5, -2.5], parent: 'torso' });
  b.box(-3.0, 11.6, -3.1, 6.0, 5.9, 0.6, 'strap', 'plastic'); // back plate
  b.box(-3.1, 11.5, -5.3, 6.2, 5.0, 2.2, 'hull1', 'paint'); // shell
  b.box(-3.3, 16.5, -5.5, 6.6, 0.9, 2.5, 'hull0', 'paint'); // lid
  b.box(-3.35, 12.0, -5.0, 0.25, 3.6, 1.6, 'panel', 'paint'); // side rails
  b.box(3.1, 12.0, -5.0, 0.25, 3.6, 1.6, 'panel', 'paint');
  // the parcel he never got to deliver, lashed to the back
  b.box(-2.5, 12.0, -6.3, 3.4, 2.7, 1.0, 'paper', 'fabric');
  b.box(-2.55, 13.15, -6.36, 3.5, 0.22, 1.12, 'wood0', 'fabric'); // twine
  b.box(-1.15, 11.95, -6.36, 0.22, 2.8, 1.12, 'wood0', 'fabric');
  b.box(-0.6, 13.6, -6.37, 1.2, 0.8, 0.07, 'white', 'paint', { j: 0 }); // address label
  b.box(-0.45, 13.95, -6.41, 0.9, 0.12, 0.05, 'hullDark', 'paint', { j: 0 });
  b.box(-0.45, 13.72, -6.41, 0.6, 0.12, 0.05, 'hullDark', 'paint', { j: 0 });
  b.box(-2.2, 12.3, -6.37, 0.7, 0.7, 0.07, 'stripe', 'paint', { j: 0 }); // courier stamp
  b.box(-2.75, 12.6, -6.42, 3.9, 0.5, 0.12, 'strap', 'fabric'); // lashing strap
  b.box(0.2, 12.5, -6.5, 0.6, 0.7, 0.15, 'panel', 'metal');
  b.box(-2.6, 15.4, -5.42, 0.7, 1.4, 0.14, 'strap', 'fabric'); // lid straps
  b.box(0.4, 15.4, -5.42, 0.7, 1.4, 0.14, 'strap', 'fabric');
  b.box(-2.65, 15.3, -5.5, 0.8, 0.5, 0.2, 'panel', 'metal');
  b.box(0.35, 15.3, -5.5, 0.8, 0.5, 0.2, 'panel', 'metal');
  b.box(0.45, 14.2, -5.5, 0.6, 1.2, 0.1, 'strap', 'fabric'); // strap end hanging loose
  b.box(0.55, 13.5, -5.55, 0.5, 0.8, 0.1, 'strap', 'fabric');
  b.box(3.35, 13.2, -4.6, 0.12, 1.5, 1.1, 'paper', 'fabric'); // route tag
  b.box(3.4, 14.7, -4.15, 0.1, 0.5, 0.2, 'wood0', 'fabric');
  b.box(3.47, 13.5, -4.4, 0.05, 0.2, 0.7, 'stripe', 'paint', { j: 0 });

  // air tank, rear left
  b.box(1.5, 11.9, -6.6, 1.5, 3.9, 1.3, 'panel', 'paint');
  b.box(1.65, 15.8, -6.45, 1.2, 0.4, 1.0, 'wall1', 'paint');
  b.box(1.45, 14.0, -6.65, 1.6, 0.6, 1.4, 'stripe', 'paint');
  b.box(1.95, 16.2, -6.15, 0.6, 0.5, 0.5, 'brass', 'brass'); // valve
  b.box(2.55, 16.3, -6.05, 0.5, 0.3, 0.3, 'brass', 'brass');
  b.box(1.95, 11.6, -6.2, 0.6, 0.3, 0.5, 'strap', 'rubber');

  // rolled camp blanket across the top
  const roll = (x0, x1, r, color) => {
    for (const [z0, z1, hh] of [[-1, -0.7, 0.5], [-0.7, -0.38, 0.82], [-0.38, 0.38, 1], [0.38, 0.7, 0.82], [0.7, 1, 0.5]]) {
      b.box(x0, 18.62 - hh * r, -4.4 + z0 * r, x1 - x0, 2 * hh * r, (z1 - z0) * r, color, 'fabric');
    }
  };
  roll(-3.9, 3.9, 1.2, 'moss1');
  roll(-3.35, -2.75, 1.27, 'moss2'); // woven stripes at one end
  roll(-2.45, -2.15, 1.27, 'moss2');
  roll(-1.3, -0.6, 1.33, 'strap'); roll(1.7, 2.4, 1.33, 'strap'); // lashing
  b.box(-1.2, 17.2, -5.78, 0.5, 0.7, 0.14, 'panel', 'metal'); b.box(1.8, 17.2, -5.78, 0.5, 0.7, 0.14, 'panel', 'metal');
  b.bothX(() => { b.box(3.9, 18.0, -5.0, 0.07, 1.25, 1.2, 'moss0', 'fabric'); b.box(3.97, 18.4, -4.6, 0.06, 0.45, 0.45, 'moss2', 'fabric'); });

  // tin mug clipped to his right side
  b.box(-4.5, 12.4, -4.9, 1.15, 1.3, 1.3, 'white', 'paint');
  b.box(-4.55, 13.7, -4.95, 1.25, 0.2, 1.4, 'stripe', 'paint');
  b.box(-4.2, 13.72, -4.6, 0.55, 0.2, 0.7, 'hullDark', 'paint', { j: 0 }); // it's empty
  b.box(-4.15, 12.7, -5.3, 0.4, 0.8, 0.4, 'white', 'paint');
  b.box(-3.6, 13.9, -4.45, 0.3, 0.6, 0.3, 'panel', 'metal'); // clip

  wear(0.25, () => { b.box(3.2, 17.9, -5.64, 0.75, 1.1, 0.07, 'scorch2', 'fabric'); b.box(2.9, 19.82, -4.9, 1.05, 0.07, 1.0, 'scorch2', 'fabric'); b.box(3.5, 19.6, -5.3, 0.45, 0.07, 0.5, SOOT_DARK, 'fabric'); }); // singed end
  wear(0.6, () => { b.box(3.36, 12.2, -4.6, 0.06, 1.6, 1.0, SOOT_DARK, 'paint'); b.box(1.2, 17.4, -5.4, 1.6, 0.07, 1.2, SOOT, 'paint'); });
}

/** Asymmetric details and crash wear on the limbs. */
function buildLimbStory(b, wear) {
  b.part('armL'); // shoulder patch in the Sparrow's stripe teal
  b.box(6.5, 14.4, -1.0, 0.14, 1.9, 2.0, 'stripe', 'paint');
  b.box(6.64, 15.4, -0.7, 0.06, 0.35, 1.4, 'helmet', 'paint', { j: 0 });
  b.box(6.64, 14.8, -0.3, 0.06, 0.35, 0.6, 'helmet', 'paint', { j: 0 });
  b.part('armR'); // name tape
  b.box(-6.62, 15.0, -0.9, 0.12, 0.7, 1.8, 'hull1', 'fabric');

  wear(0.3, () => { b.part('shinR'); b.box(-3.1, 3.9, 2.42, 1.6, 0.5, 0.12, TAPE, 'plastic'); b.box(-2.6, 3.5, 2.42, 0.5, 1.3, 0.14, TAPE, 'plastic'); }); // taped knee pad
  wear(0.1, () => {
    b.part('legL'); // burnt thigh
    smudge(b, 'z+', 0.5, 5.4, 1.9, 2.9, 3.4, 12, ['scorch2', BURNT, BURNT, 'suit1']);
    smudge(b, 'x+', 3.5, 4.8, -1.0, 2.6, 1.0, 4, [BURNT, 'suit1']);
  });
  wear(0.5, () => { b.part('forearmR'); smudge(b, 'x-', -6.35, 11.1, -1.1, 2.2, 2.2, 6, [BURNT, 'suit1', 'suit1']); });
  wear(0.2, () => {
    b.part('footL'); b.box(0.6, 0.6, 3.95, 2.0, 0.6, 0.08, 'ash1', 'rock'); b.box(3.75, 0.7, -1.0, 0.08, 0.7, 2.6, 'ash0', 'rock');
    b.part('footR'); b.box(-3.2, 0.6, 3.95, 1.6, 0.5, 0.08, 'ash1', 'rock'); b.box(-3.83, 0.7, 0.2, 0.08, 0.9, 2.2, 'ash0', 'rock');
  });
  wear(0.65, () => { b.part('shinL'); b.box(3.65, 1.9, -1.4, 0.08, 1.1, 2.2, 'ash0', 'rock'); b.part('legR'); smudge(b, 'z+', -3.2, 5.0, 1.9, 2.4, 2.0, 6, [BURNT, 'suit1', 'suit1']); });
}

/**
 * Build the Pilot.
 * @param {{lamp?: boolean, scuffed?: number, seed?: number}} [opts]
 *   lamp — helmet-side lamp with a real light request named 'lamp'; scuffed — 0..1 soot and dirt from the crash (default 0.6)
 * @returns {object} VoxelModel
 */
export function build(opts = {}) {
  const lamp = !!opts.lamp;
  const scuffed = clamp01(opts.scuffed ?? 0.6);
  const b = new VoxelBuilder({ unit: U, seed: opts.seed ?? 11, jitter: 0.04 });
  const wear = (threshold, fn) => { if (scuffed > threshold) fn(); };
  wear.on = (threshold) => scuffed > threshold;

  buildHips(b);
  buildLeg(b, 1); buildLeg(b, -1);
  buildTorso(b, wear);
  buildArm(b, 1); buildArm(b, -1);
  buildHead(b, lamp, wear);
  buildPack(b, wear);
  buildLimbStory(b, wear);
  b.root();

  b.anchor('hand_l', SHOULDER_X, 8.8, 0.3);
  b.anchor('hand_r', -SHOULDER_X, 8.8, 0.3);
  b.anchor('carry', 0, 14.2, 7.0);
  b.anchor('head', 0, 29, HELMET_Z);
  b.anchor('lamp', 7.2, 24.2, HELMET_Z + 3.0);
  b.anchor('feet', 0, 0, 0);
  return b.build('pilot');
}

export const gallery = [
  { fn: 'build', opts: { scuffed: 0 } },
  { fn: 'build', opts: {} },
  { fn: 'build', opts: { lamp: true } },
  { fn: 'build', opts: { lamp: true, scuffed: 1 } },
];

// =====================================================================================================================
// Animation. A pose is a flat array of channels; every frame the whole pose is rebuilt from (anim, t, p) and written
// to the rig absolutely. Legs are solved with two-bone IK so planted feet stay planted while the hips move.
// =====================================================================================================================

const HPX = 0, HPY = 1, HPZ = 2, HRX = 3, HRY = 4, HRZ = 5; // hips offset (units) and rotation
const TOX = 6, TOY = 7, TOZ = 8, HDX = 9, HDY = 10, HDZ = 11, PKX = 12; // torso, head, pack
const ALX = 13, ARX = 20; // arm blocks: shoulder x,y,z · elbow x,y,z · shoulder lift (units)
const LLX = 27, LRX = 31; // leg blocks: hip x (swing), hip z (roll), knee x, ankle x
const NCH = 35;

const TAU = Math.PI * 2;
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const bell = (x, a, b, c, d) => smooth(a, b, x) * (1 - smooth(c, d, x)); // rise a→b, hold, fall c→d
const hash = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

// gaits: stance = fraction of the cycle a foot is planted; sweep = how far (units) the planted foot travels under the hips
const WALK = { stance: 0.6, front: 4.5, sweep: 11, lift: 1.5, drop: 0.5, bob: 0.3, strike: 0.34, toeOff: 0.66, width: 0.45 };
const CARRY = { stance: 0.64, front: 3.4, sweep: 8, lift: 1.0, drop: 0.55, bob: 0.2, strike: 0.22, toeOff: 0.5, width: 0.2 };
const JOG = { stance: 0.38, front: 3.4, sweep: 11.4, lift: 2.6, drop: 0.95, bob: 0.4, strike: 0.12, toeOff: 0.95, width: 0.7 };
const cycleOf = (g) => Math.round((g.sweep * U / g.stance) * 100) / 100;

export const meta = {
  name: 'pilot',
  about: 'the Pilot — player character: orange flight suit, cream helmet, dark visor, compact backpack',
  variants: { lamp: 'boolean — helmet-side lamp + light request "lamp"', scuffed: '0..1 soot/dirt from the crash (default 0.6)' },
  /** which part each anchor rides on (anchors are rest-pose model-space points) */
  anchorParts: { hand_r: 'forearmR', hand_l: 'forearmL', carry: 'torso', head: 'head', lamp: 'head', feet: 'root' },
  /** metres travelled per 2π of p.phase for slide-free feet: phase += distance * 2π / gait[anim].cycle */
  gait: { walk: { cycle: cycleOf(WALK) }, carry: { cycle: cycleOf(CARRY) }, jog: { cycle: cycleOf(JOG) } },
  loops: ['idle', 'walk', 'jog', 'carry', 'sit', 'lie', 'look_up'],
  oneShots: ['getup', 'interact', 'pickup', 'wave', 'cheer', 'shrug'],
};

/**
 * Blend one arm toward a pose given in anatomical terms, by weight w (1 = set it).
 * swing + forward · out + away from the body · twist + inward · bend + elbow flexion ·
 * side + folds the forearm further out/up in the arm's frontal plane · lift = shoulder shrug in units.
 */
function arm(P, s, w, swing, out, twist, bend, side = 0, lift = 0) {
  const o = s > 0 ? ALX : ARX;
  P[o] += (-swing - P[o]) * w; P[o + 1] += (-s * twist - P[o + 1]) * w; P[o + 2] += (s * out - P[o + 2]) * w;
  P[o + 3] += (-bend - P[o + 3]) * w; P[o + 4] *= 1 - w; P[o + 5] += (s * side - P[o + 5]) * w; P[o + 6] += (lift - P[o + 6]) * w;
}

/** Leg by joint angles: swing (+ forward), out (+ away), knee (+ flexion), foot (+ toes down, relative to the shin). */
function setLeg(P, s, swing, out, knee, foot) {
  const o = s > 0 ? LLX : LRX;
  P[o] = -swing; P[o + 1] = s * out; P[o + 2] = knee; P[o + 3] = foot;
}

/**
 * Two-bone leg IK. Ankle target = rest ankle + (fx, fy, fz) in model space (units); pitch = world pitch of the sole
 * (+ toes down). Uses the hips channels already written to P, so set the hips first.
 */
function solveLeg(P, s, fx, fy, fz, pitch) {
  const a = Math.cos(P[HRX]), bb = Math.sin(P[HRX]), c = Math.cos(P[HRY]), d = Math.sin(P[HRY]), e = Math.cos(P[HRZ]), f = Math.sin(P[HRZ]);
  const m00 = c * e, m01 = -c * f, m10 = a * f + bb * e * d, m11 = a * e - bb * f * d, m20 = bb * f - a * e * d, m21 = bb * e + a * f * d;
  const m02 = d, m12 = -bb * c, m22 = a * c;
  const hx = s * HIP_X, hy = HIP_Y - PELVIS_Y; // hip joint relative to the pelvis pivot
  const vx = s * HIP_X + fx - (P[HPX] + m00 * hx + m01 * hy);
  const vy = ANKLE_Y + fy - (PELVIS_Y + P[HPY] + m10 * hx + m11 * hy);
  const vz = fz - (P[HPZ] + m20 * hx + m21 * hy);
  const dx = m00 * vx + m10 * vy + m20 * vz, dy = m01 * vx + m11 * vy + m21 * vz, dz = m02 * vx + m12 * vy + m22 * vz; // into the hips frame
  const down = -dy;
  const roll = Math.atan2(dx, Math.max(down, 2.5)); // lean of the leg plane; fades out when the leg points forward
  const D = down > 0 ? Math.hypot(down, dx * clamp01(down / 2.5)) : down;
  const r = clamp(Math.hypot(D, dz), 1.2, THIGH + SHIN - 0.002);
  const A = Math.acos(clamp((THIGH * THIGH + r * r - SHIN * SHIN) / (2 * THIGH * r), -1, 1));
  const K = Math.acos(clamp((THIGH * THIGH + SHIN * SHIN - r * r) / (2 * THIGH * SHIN), -1, 1));
  const o = s > 0 ? LLX : LRX;
  P[o] = -(Math.atan2(dz, D) + A); P[o + 1] = roll; P[o + 2] = Math.PI - K; P[o + 3] = pitch - P[o] - P[o + 2] - P[HRX];
}

// Foot scratch: ankle offset y, z and sole pitch. A typed array, because doubles written to module-level `let`s are
// boxed afresh on every write — and this runs several times a frame.
const FOOT = new Float64Array(3);
/** Ankle of a planted foot whose flat-ankle reference is at zref, rolled onto the heel (pitch < 0) or the toe (pitch > 0). */
function plantedAnkle(zref, pitch) {
  const c = Math.cos(pitch), sn = Math.sin(pitch), k = pitch < 0 ? HEEL : -BALL;
  FOOT[0] = ANKLE_Y * c - k * sn - ANKLE_Y; FOOT[1] = zref - k + ANKLE_Y * sn + k * c; FOOT[2] = pitch;
}
/** Foot path for gait g at cycle position u ∈ [0,1): stance (heel strike → flat → toe-off), then swing. Result in FOOT. */
function footPath(g, u) {
  if (u < g.stance) {
    const q = u / g.stance;
    plantedAnkle(g.front - q * g.sweep, q < 0.2 ? -g.strike * (1 - q / 0.2) : q > 0.5 ? g.toeOff * smooth(0.5, 1, q) : 0);
    return;
  }
  const w = (u - g.stance) / (1 - g.stance), e = w * w * (3 - 2 * w);
  plantedAnkle(g.front - g.sweep, g.toeOff); const y0 = FOOT[0], z0 = FOOT[1]; // where it left the ground
  plantedAnkle(g.front, -g.strike); const y1 = FOOT[0], z1 = FOOT[1]; // where it will land
  FOOT[0] = y0 + (y1 - y0) * w + g.lift * Math.sin(Math.PI * Math.pow(w, 0.85));
  FOOT[1] = z0 + (z1 - z0) * (0.35 * w + 0.65 * e);
  FOOT[2] = g.toeOff + (-g.strike - g.toeOff) * smooth(0.15, 0.95, w);
}

/** Arms held forward around a carried object; w blends it over whatever the arms were doing. */
function carryArms(P, w, bounce) {
  if (w <= 0) return;
  arm(P, 1, w, 0.62 + bounce, -0.1, 0.3, 0.85 - bounce * 0.5);
  arm(P, -1, w, 0.62 + bounce, -0.1, 0.3, 0.85 - bounce * 0.5);
}

/** Occasional glance left/right, a pure function of time. */
function glance(P, t, period, amount) {
  const slot = Math.floor(t / period), u = t / period - slot, h1 = hash(slot), h2 = hash(slot + 71.3);
  const env = bell(u, 0.5, 0.6, 0.84, 0.95) * amount;
  const yaw = (h1 < 0.5 ? -1 : 1) * (0.45 + 0.4 * h2) * env;
  P[HDY] += yaw * 0.8; P[TOY] += yaw * 0.2; P[HDX] += (h2 - 0.65) * 0.3 * env;
}

function standing(P, t, carry) {
  const br = Math.sin(t * 1.7), sh = Math.sin(t * 0.43 + 0.9 * Math.sin(t * 0.43)); // breathing; lingering weight shift
  P[HPX] = 0.55 * sh; P[HPY] = -0.14 - 0.12 * sh * sh + 0.05 * br; P[HRZ] = -0.04 * sh; P[HRY] = 0.05 * sh;
  P[TOZ] = 0.06 * sh; P[TOX] = 0.025 + 0.012 * br; P[TOY] = -0.04 * sh;
  P[HDZ] = -0.03 * sh; P[HDX] = -0.02 - 0.01 * br; P[PKX] = 0.01 * br;
  for (let s = 1; s >= -1; s -= 2) {
    arm(P, s, 1, 0.04 - 0.03 * s * sh, 0.1 + 0.015 * br, 0.15, 0.18 + 0.02 * br, 0, 0.06 * br);
    solveLeg(P, s, s * 0.3, 0, 0, 0);
  }
  carryArms(P, carry, 0.01 * br);
}

function animGait(P, t, p, g, jog, carry) {
  const ph = p.phase ?? t * 4, c1 = Math.cos(ph), speed = p.speed ?? 1.5;
  const u = ph / TAU - Math.floor(ph / TAU);
  // hips: lowest in double support when walking; lowest mid-stance, highest in flight when jogging
  const beat = jog ? -Math.cos(2 * (ph - g.stance * Math.PI)) : -Math.cos(2 * (ph - 0.2));
  P[HPY] = -g.drop + g.bob * beat;
  P[HPX] = (jog ? 0.2 : 0.35) * Math.sin(ph - 0.3);
  P[HRY] = -(jog ? 0.16 : 0.12) * c1 * (1 - 0.5 * carry); P[HRZ] = 0.035 * Math.sin(ph - 0.3);
  const lean = jog ? 0.2 + 0.03 * speed : 0.045 + 0.03 * speed;
  P[TOX] = lean * (1 - carry) - 0.06 * carry + 0.015 * beat;
  P[TOY] = (jog ? 0.34 : 0.26) * c1 * (1 - 0.6 * carry); P[TOZ] = -0.03 * Math.sin(ph - 0.3);
  P[HDY] = -P[TOY] * 0.75 - P[HRY]; P[HDX] = -lean * 0.55 * (1 - carry) + 0.05 * carry - 0.03 * beat; P[HDZ] = 0.02 * Math.sin(ph);
  P[PKX] = -0.035 * beat * (jog ? 1.6 : 1);
  for (let s = 1; s >= -1; s -= 2) {
    const ul = s > 0 ? u : u + 0.5 - Math.floor(u + 0.5);
    footPath(g, ul);
    solveLeg(P, s, -s * g.width, FOOT[0], FOOT[1], FOOT[2]);
    const sw = s * Math.cos(ph - 0.35); // + when this arm is back (its own leg is forward)
    if (jog) arm(P, s, 1, -0.95 * sw + 0.1, 0.16, 0.35, 1.45 - 0.35 * sw, 0, 0.12 * beat);
    else arm(P, s, 1, -0.5 * sw + 0.04, 0.09, 0.2, 0.25 - 0.22 * Math.min(0, sw), 0, 0.04 * beat);
  }
  carryArms(P, carry, 0.02 * beat);
}

// Sitting on the ground, knees up, forearms draped over them. The feet stay where he stood; the hips drop back behind them.
// prop = 1 leans him back on his right hand (the first beat of getting up).
function poseSit(P, prop) {
  P[HPY] = -7.25; P[HPZ] = -5.0; P[HRX] = -0.32 - 0.3 * prop; P[HRY] = -0.22 * prop; P[HRZ] = -0.06 * prop;
  P[TOX] = 0.42 - 0.12 * prop; P[TOY] = 0.2 * prop; P[HDX] = 0.12 - 0.1 * prop; P[HDY] = 0.1 * prop; P[PKX] = -0.04;
  solveLeg(P, 1, 0.6, 0, 0.3, 0); solveLeg(P, -1, -0.6, 0, 0.3 + 0.8 * prop, 0);
  arm(P, 1, 1, 0.55, 0.1, 0.6, 0.45);
  arm(P, -1, 1, 0.55 - 1.35 * prop, 0.1 + 0.4 * prop, 0.6 - 0.7 * prop, 0.45 - 0.3 * prop);
}
function animSit(P, t) {
  poseSit(P, 0);
  const br = Math.sin(t * 1.5);
  P[TOX] += 0.015 * br; P[HDX] -= 0.01 * br; P[ALX] -= 0.012 * br; P[ARX] -= 0.012 * br;
  glance(P, t + 2, 8, 0.8);
  const slot = Math.floor(t / 11), up = bell(t / 11 - slot, 0.3, 0.42, 0.62, 0.75); // now and then he looks up at the sky
  P[HDX] -= 0.6 * up; P[TOX] -= 0.1 * up;
}

// Lying where he was thrown: half on his back, rolled onto his right side against the pack. His feet are at the
// origin and the body stretches away behind it (−Z), so getting up ends exactly where idle stands.
function poseLie(P) {
  P[HRX] = -Math.PI / 2 + 0.08; P[HRY] = -0.8; P[HPY] = -(PELVIS_Y - 4.3); P[HPZ] = -9.2;
  P[TOY] = 0.2; P[TOX] = 0.06; P[HDY] = -0.35; P[HDX] = 0.12; P[HDZ] = 0.08;
  arm(P, 1, 1, 0.55, 0.15, 0.9, 1.5); // left hand on his belly
  arm(P, -1, 1, 0.3, 1.45, -0.4, 0.5); // right arm flung out on the ground
  setLeg(P, 1, 0.75, 0.1, 1.35, 0.5);
  setLeg(P, -1, 0.05, 0.22, 0.25, 0.55);
}
function animLie(P, t) {
  poseLie(P);
  const br = Math.sin(t * 1.3);
  P[TOX] += 0.012 * br; P[ALX + 3] += 0.03 * br; P[HDY] += 0.03 * Math.sin(t * 0.37);
}

function animLookUp(P, t) {
  standing(P, t, 0);
  const sway = Math.sin(t * 0.5);
  P[HPZ] = -0.4; P[HRX] = -0.06; P[TOX] = -0.2; P[HDX] = -0.62 + 0.03 * Math.sin(t * 0.9); P[HDY] = 0.14 * sway; P[TOY] += 0.06 * sway;
  solveLeg(P, 1, 0.5, 0, 0.3, 0); solveLeg(P, -1, -0.5, 0, -0.9, 0);
  arm(P, -1, 1, 2.75, 0.15, 1.2, 0.65); // right hand shades the visor
  arm(P, 1, 1, -0.25, 0.3, 0.1, 0.35);
}

// ---- one-shots (k: 0 → 1) ----
function animInteract(P, t, k) {
  standing(P, t, 0);
  const e = bell(k, 0, 0.36, 0.62, 1), press = bell(k, 0.38, 0.48, 0.5, 0.62);
  P[HPZ] = 0.8 * e; P[HPY] -= 0.35 * e; P[TOX] += 0.22 * e + 0.05 * press; P[TOY] += 0.32 * e; P[HDX] += 0.14 * e; P[HDY] -= 0.24 * e;
  solveLeg(P, 1, 0.3, 0, 0, 0); solveLeg(P, -1, -0.3, 0, 0, 0);
  arm(P, -1, e, 1.5 + 0.12 * press, 0.05, 0.25, 0.3 - 0.22 * press);
  arm(P, 1, e, -0.35, 0.2, 0.15, 0.3);
}

function animPickup(P, t, k, carry) {
  standing(P, t, 0);
  const e = bell(k, 0, 0.42, 0.56, 0.96), grab = bell(k, 0.34, 0.46, 0.5, 0.6), held = carry ? smooth(0.5, 0.85, k) : 0;
  P[HPX] *= 1 - e; P[HPY] -= 4.3 * e; P[HPZ] = -1.7 * e; P[HRX] = 0.22 * e;
  P[TOX] += 0.5 * e; P[HDX] -= 0.28 * e;
  solveLeg(P, 1, 0.6, 0, 0.2, 0); solveLeg(P, -1, -0.6, 0, 0.2, 0);
  for (let s = 1; s >= -1; s -= 2) arm(P, s, e, -0.3, 0.12 - 0.22 * grab, 0.4, 0.2 + 0.25 * grab);
  carryArms(P, held, 0);
}

function animWave(P, t, k) {
  standing(P, t, 0);
  const e = bell(k, 0, 0.2, 0.8, 1), w = Math.sin(k * TAU * 3.5);
  P[TOZ] += 0.07 * e; P[HDZ] -= 0.12 * e; P[HDX] -= 0.08 * e; P[HPY] += 0.12 * e * Math.abs(w);
  arm(P, -1, e, 0.2, 2.0 + 0.12 * w, 0, 0.1, 0.85 + 0.5 * w, 0.5);
  arm(P, 1, e, 0, 0.22, 0.15, 0.25);
}

function animCheer(P, t, k) {
  standing(P, t, 0);
  const up = bell(k, 0.14, 0.32, 0.8, 1), back = bell(k, 0, 0.12, 0.14, 0.3); // arms wind back, then fly up through the front
  const crouch = bell(k, 0, 0.16, 0.2, 0.3) + 0.7 * bell(k, 0.52, 0.6, 0.62, 0.74);
  const air = k > 0.22 && k < 0.56 ? Math.sin(Math.PI * (k - 0.22) / 0.34) : 0;
  const pump = (0.5 - 0.5 * Math.cos(k * TAU * 4)) * bell(k, 0.56, 0.62, 0.8, 0.9);
  P[HPX] *= 1 - up; P[HPY] += -1.5 * crouch + 3.2 * air; P[TOX] += 0.22 * crouch - 0.14 * up; P[HDX] += -0.3 * up + 0.15 * crouch;
  solveLeg(P, 1, 0.7, 4.4 * air, 0.2 * air, 0.5 * air); solveLeg(P, -1, -0.7, 3.9 * air, -0.3 * air, 0.6 * air);
  for (let s = 1; s >= -1; s -= 2) arm(P, s, Math.max(up, back), -0.7 * back + (2.95 - 0.4 * pump) * up, 0.12 + 0.4 * up, 0, 0.3 * back + (0.5 * pump - 0.15) * up, 0, 0.5 * up);
}

function animShrug(P, t, k) {
  standing(P, t, 0);
  const e = bell(k, 0, 0.3, 0.68, 1);
  P[HDZ] += 0.22 * e; P[HDY] += 0.12 * e; P[HDX] += 0.05 * e; P[TOX] -= 0.06 * e; P[HPY] += 0.1 * e;
  for (let s = 1; s >= -1; s -= 2) arm(P, s, e, 0.2, 0.42, -0.95, 1.3, 0, 1.0);
}

// getup: lie → stir → sit up, propped on the right hand → rock forward onto the right knee → stand → dust off.
// Key poses are baked once; k blends between them, and the planted left foot is re-solved every frame so it never slides.
const KEY_T = [0, 0.1, 0.3, 0.5, 0.74];
const KEYS = KEY_T.map(() => new Float32Array(NCH));
function bakeGetupKeys() {
  poseLie(KEYS[0]);
  let P = KEYS[1]; poseLie(P); // he stirs: head comes up, hand slides off his belly
  P[HDX] = -0.35; P[HDY] = 0.1; P[TOX] = 0.18; arm(P, 1, 1, 0.3, 0.5, 0.3, 0.9);
  poseSit(KEYS[2], 1);
  P = KEYS[3]; // right knee down, left foot planted, left hand pushing on the left knee
  P[HPY] = -2.65; P[HPZ] = -2.8; P[HRX] = 0.2; P[HRY] = 0.12; P[TOX] = 0.32; P[TOY] = -0.1; P[HDX] = -0.25;
  solveLeg(P, 1, 0.6, 0, 0.3, 0);
  setLeg(P, -1, -0.15, 0.08, 1.75, 0.9);
  arm(P, 1, 1, -0.85, 0.12, 0.5, 1.05); arm(P, -1, 1, 0.1, 0.3, 0.1, 0.35);
}
bakeGetupKeys();

function animGetup(P, t, k) {
  standing(KEYS[KEYS.length - 1].fill(0), t, 0); // the last key is live, so k = 1 lands exactly on idle
  let i = 0; while (i < KEY_T.length - 2 && k > KEY_T[i + 1]) i++;
  const w = smooth(KEY_T[i], KEY_T[i + 1], k), A = KEYS[i], B = KEYS[i + 1];
  for (let c = 0; c < NCH; c++) P[c] = A[c] + (B[c] - A[c]) * w;
  // keep the left foot nailed to the ground from the moment it plants
  const plant = smooth(0.14, 0.3, k);
  if (plant > 0) {
    const a0 = P[LLX], a1 = P[LLX + 1], a2 = P[LLX + 2], a3 = P[LLX + 3];
    solveLeg(P, 1, 0.6 - 0.3 * smooth(0.5, 0.74, k), 0, 0.3 * (1 - smooth(0.5, 0.74, k)), 0);
    P[LLX] = a0 + (P[LLX] - a0) * plant; P[LLX + 1] = a1 + (P[LLX + 1] - a1) * plant; P[LLX + 2] = a2 + (P[LLX + 2] - a2) * plant; P[LLX + 3] = a3 + (P[LLX + 3] - a3) * plant;
  }
  // dust off: brisk alternating pats on thighs and chest
  const e = bell(k, 0.76, 0.82, 0.93, 1), pat = Math.sin(k * TAU * 9);
  if (e > 0) {
    P[TOX] += 0.22 * e; P[HDX] += 0.18 * e; P[TOY] += 0.1 * pat * e;
    for (let s = 1; s >= -1; s -= 2) { const hit = 0.5 + 0.5 * s * pat; arm(P, s, e, 0.35 + 0.3 * hit, 0.1, 0.7, 0.5 + 0.5 * hit); }
  }
}

const FADE = { sit: 0.6, lie: 0.7, look_up: 0.45 };
const TARGET = new Float32Array(NCH), STAND = new Float32Array(NCH); // scratch poses — nothing is allocated per frame
const STILL = { speed: 0 };

/** Locomotion: the gait at speed, easing into the standing pose as he slows to a stop (whatever the phase is doing). */
function animMove(P, t, p, g, jog, carry) {
  const go = smooth(0.02, 0.3, p.speed ?? 1.5);
  if (go > 0) animGait(P, t, p, g, jog, carry);
  if (go < 1) {
    const S = go > 0 ? STAND.fill(0) : P;
    standing(S, t, carry); glance(S, t, 6.5, 0.6);
    if (go > 0) for (let c = 0; c < NCH; c++) P[c] = S[c] + (P[c] - S[c]) * go;
  }
}

function evaluate(P, anim, t, p) {
  const k = clamp01(p.k ?? 0), carry = p.carry ? 1 : 0;
  switch (anim) {
    case 'walk': animMove(P, t, p, carry ? CARRY : WALK, false, carry); break;
    case 'jog': animMove(P, t, p, JOG, true, carry); break;
    case 'carry': animMove(P, t, p.speed === undefined ? STILL : p, CARRY, false, 1); break;
    case 'sit': animSit(P, t); break;
    case 'lie': animLie(P, t); break;
    case 'look_up': animLookUp(P, t); break;
    case 'getup': animGetup(P, t, k); break;
    case 'interact': animInteract(P, t, k); break;
    case 'pickup': animPickup(P, t, k, !!p.carry); break;
    case 'wave': animWave(P, t, k); break;
    case 'cheer': animCheer(P, t, k); break;
    case 'shrug': animShrug(P, t, k); break;
    default: standing(P, t, carry); glance(P, t, 6.5, carry ? 0.6 : 1);
  }
  // look-at from the game: yaw + = toward his left, pitch + = up; shared between head and chest
  const yaw = clamp(p.headYaw ?? 0, -1.3, 1.3), pitch = clamp(p.headPitch ?? 0, -0.7, 0.7);
  P[HDY] += yaw * 0.75; P[TOY] += yaw * 0.25; P[HDX] -= pitch * 0.85; P[TOX] -= pitch * 0.15;
}

const PART_NAMES = ['hips', 'torso', 'head', 'pack', 'armL', 'forearmL', 'armR', 'forearmR', 'legL', 'shinL', 'footL', 'legR', 'shinR', 'footR'];

/** One-time rig setup per instance (cached on the root): part lookups, rest offsets, Euler orders, blend buffers. */
function rigOf(root) {
  const cached = root.userData.pilotRig;
  if (cached !== undefined) return cached;
  const parts = root.userData.parts;
  let rig = null;
  if (parts && PART_NAMES.every((n) => parts[n])) {
    rig = { cur: new Float32Array(NCH), from: new Float32Array(NCH), anim: null, fade: 1, dur: 0.2 };
    for (const n of PART_NAMES) rig[n] = parts[n];
    const h = rig.hips.position;
    rig.hx = h.x; rig.hy = h.y; rig.hz = h.z; rig.armLy = rig.armL.position.y; rig.armRy = rig.armR.position.y;
    rig.legL.rotation.order = rig.legR.rotation.order = 'ZXY'; // swing in the sagittal plane, then lean the whole leg plane
  }
  root.userData.pilotRig = rig; // null for anything that is not a pilot (e.g. the viewer's gallery root)
  return rig;
}

function applyArm(P, o, upper, lower, restY) {
  upper.rotation.set(P[o], P[o + 1], P[o + 2]);
  lower.rotation.set(P[o + 3], P[o + 4], P[o + 5]);
  upper.position.y = restY + P[o + 6] * U;
}
function applyLeg(P, o, leg, shin, foot) {
  leg.rotation.set(P[o], 0, P[o + 1]); shin.rotation.x = P[o + 2]; foot.rotation.x = P[o + 3];
}

/**
 * Procedural animation (ARCHITECTURE §9). Loops: idle · walk · jog · carry · sit · lie · look_up.
 * One-shots driven by p.k 0→1: getup · interact · pickup · wave · cheer · shrug.
 * Honours p.phase (gait), p.speed (lean), p.carry, p.headYaw (+ left) / p.headPitch (+ up). Changes of p.anim cross-fade.
 * @param {import('three').Object3D} root object from buildModelObject(build())
 * @param {number} t seconds
 * @param {{anim?: string, dt?: number, speed?: number, phase?: number, k?: number, carry?: boolean, headYaw?: number, headPitch?: number}} [p]
 */
export function animate(root, t, p = {}) {
  const rig = rigOf(root);
  if (!rig) return;
  const anim = p.anim || 'idle', P = TARGET;
  P.fill(0);
  evaluate(P, anim, t, p);

  const C = rig.cur;
  if (rig.anim === null) { C.set(P); rig.fade = 1; }
  else if (rig.anim !== anim) { rig.from.set(C); rig.fade = 0; rig.dur = Math.max(FADE[anim] ?? 0.2, FADE[rig.anim] ?? 0.2); }
  rig.anim = anim;
  if (rig.fade < 1) {
    rig.fade = Math.min(1, rig.fade + (p.dt ?? 1 / 60) / rig.dur);
    const w = rig.fade * rig.fade * (3 - 2 * rig.fade), F = rig.from;
    for (let i = 0; i < NCH; i++) C[i] = F[i] + (P[i] - F[i]) * w;
  } else C.set(P);

  rig.hips.position.set(rig.hx + C[HPX] * U, rig.hy + C[HPY] * U, rig.hz + C[HPZ] * U);
  rig.hips.rotation.set(C[HRX], C[HRY], C[HRZ]);
  rig.torso.rotation.set(C[TOX], C[TOY], C[TOZ]);
  rig.head.rotation.set(C[HDX], C[HDY], C[HDZ]);
  rig.pack.rotation.x = C[PKX];
  applyArm(C, ALX, rig.armL, rig.forearmL, rig.armLy);
  applyArm(C, ARX, rig.armR, rig.forearmR, rig.armRy);
  applyLeg(C, LLX, rig.legL, rig.shinL, rig.footL);
  applyLeg(C, LRX, rig.legR, rig.shinR, rig.footR);
}
