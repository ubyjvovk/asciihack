// Small life of Vesper: Hoppers (shy six-legged rock critters that love shiny things and blue berries) and glow moths.
// A sitting hopper is a mossy pebble. Then it blinks.
import { VoxelBuilder } from '../voxel/kit.js';

export const meta = {
  name: 'critters',
  about: 'Hopper (≈ 0.36 m rock critter; carries a jar of brass bolts or a blue berry) and glow moth (≈ 8 cm night flyer)',
  variants: { carrying: ['none', 'bolts', 'berry'] },
  anims: { loops: ['idle', 'hop', 'sit', 'peek', 'eat', 'fly (moth)'], oneShots: ['sneeze', 'startle', 'trade'] },
};

const HU = 0.02; // hopper: 50 units = 1 m
const LID_SHUT = 5.4; // eyelid scale.y that covers the eye (rest = a thin brow line)
const PHASE_PER_M = 2.4; // radians of p.phase per metre travelled (the viewer's convention, ARCHITECTURE §9)
const HOPS_PER_RAD = 0.62; // → one hop ≈ 0.67 m
const LEGS = [['legL1', 1, 4.4], ['legL2', 1, 0], ['legL3', 1, -4.6], ['legR1', -1, 4.4], ['legR2', -1, 0], ['legR3', -1, -4.6]];
const ROCKS = [
  { low: ['basalt2', 'basalt3'], mid: ['slate0', 'basalt3', 'slate0'], top: ['slate1', 'slate0'], face: 'slate1' },
  { low: ['slate0', 'basalt3'], mid: ['slate1', 'slate0', 'slate1'], top: ['slate2', 'slate1'], face: 'slate2' },
  { low: ['basalt1', 'basalt2'], mid: ['basalt3', 'basalt2', 'slate0'], top: ['slate0', 'basalt3'], face: 'slate0' },
];

/** one stepped "rounded" layer: a centre slab and two narrower cheeks — three boxes, no overlaps */
function roundLayer(b, y0, y1, hx, z0, z1, inX, inZ, cols, mat = 'rock') {
  b.box(-(hx - inX), y0, z0, 2 * (hx - inX), y1 - y0, z1 - z0, b.pick(cols), mat);
  b.bothX(() => b.box(hx - inX, y0, z0 + inZ, inX, y1 - y0, z1 - z0 - 2 * inZ, b.pick(cols), mat));
}

/**
 * Hopper. Faces +Z. Parts: body → head → antL / antR / lidL / lidR; body → legL1..3, legR1..3 (pivot at the shell) and
 * cargo (only when carrying). Anchors: `prompt` (above it), `cargo` (on its back).
 * @param {{seed?: number, carrying?: 'none'|'bolts'|'berry'}} [o]
 */
export function buildHopper({ seed = 1, carrying = 'none' } = {}) {
  const pre = new VoxelBuilder({ seed: 4001 + seed * 53 });
  const b = new VoxelBuilder({ unit: HU * pre.range(0.92, 1.1), seed: 4001 + seed * 53, jitter: 0.06 });
  const rock = b.pick(ROCKS), mossy = b.range(0.55, 1), MOSS = ['moss0', 'moss1', 'moss1', 'moss2'];

  // ---- body: pale belly, pebble shell in five stepped layers (widest a third of the way up), moss on the back
  b.part('body', { pivot: [0, 3, 0] });
  b.box(-4.6, 1.7, -6.4, 9.2, 1.3, 12.2, 'ash2', 'rock'); b.box(-3.4, 1.2, -5, 6.8, 0.5, 9.4, 'lichen', 'rock'); // belly
  roundLayer(b, 2.6, 4, 6, -7.6, 6.6, 1.4, 1.6, rock.low);
  roundLayer(b, 4, 7, 6.6, -8.2, 7.2, 1.5, 1.8, rock.mid);
  roundLayer(b, 7, 9, 5.7, -7.2, 6, 1.5, 1.7, rock.mid);
  roundLayer(b, 9, 10.4, 4.3, -5.8, 4.4, 1.3, 1.5, rock.top);
  roundLayer(b, 10.4, 11.2, 2.7, -4, 2.4, 1, 1.2, mossy > 0.7 ? MOSS : rock.top, mossy > 0.7 ? 'moss' : 'rock');
  b.box(-1, 3.2, -9, 2, 1.6, 1, b.pick(rock.low), 'rock'); // tail nub
  // pebble character: a few proud plates and one chipped scar
  for (let k = 0; k < 6; k++) {
    const s = b.pick([-1, 1]), z = b.range(-6, 4), y = b.range(4.2, 7.6);
    b.box(s > 0 ? 6.6 - 0.2 : -6.6 - 0.25, y, z, 0.45, b.range(0.9, 1.8), b.range(1.2, 2.4), b.pick([...rock.top, 'slate2']), 'rock');
  }
  b.box(b.range(-3, 1), 9, -7.45, b.range(1.6, 2.6), 1, 0.3, 'basalt1', 'rock'); b.box(-5.75, 7, b.range(-5, -1), 0.3, 1.2, 1.6, 'basalt1', 'rock');
  const nMoss = Math.round(9 + mossy * 10);
  for (let k = 0; k < nMoss; k++) { // moss and lichen creep down from the crown, thicker toward the rear
    const a = b.range(0, 6.283), d = Math.sqrt(b.rand()) * (0.35 + mossy * 0.55), x = Math.cos(a) * d * 5.2, z = -1 + Math.sin(a) * d * 6.4 - 0.8, r = Math.hypot(x / 5.6, (z + 1) / 7);
    const y = r < 0.42 ? 11.2 : r < 0.7 ? 10.4 : r < 0.95 ? 9 : 7, s = b.pick([0.8, 1, 1.3, 1.7]);
    b.box(x - s / 2, y, z - s / 2, s, b.pick([0.3, 0.4, 0.6]), s * b.range(0.8, 1.3), b.chance(0.2) ? 'lichen' : b.pick(MOSS), 'moss');
  }
  if (b.chance(0.6) && carrying === 'none') { b.box(1.4, 11.2, -2.6, 0.4, 2, 0.4, 'moss1', 'leaf'); b.box(0.9, 12.8, -3, 1.3, 0.35, 0.8, 'moss2', 'leaf'); b.box(1.5, 13.2, -2.5, 0.9, 0.35, 1.1, 'moss2', 'leaf'); } // a sprout has taken root
  b.anchor('cargo', 0, 11.4, -1.4); b.anchor('prompt', 0, 19, 3);

  // ---- legs: stubby, two joints and a pale toe; pivot where they leave the shell
  for (const [name, s, z] of LEGS) {
    b.part(name, { pivot: [s * 4.6, 3.3, z], parent: 'body' });
    const x = (a, w) => (s > 0 ? a : -a - w);
    b.box(x(4.2, 2.6), 2.3, z - 0.9, 2.6, 1.7, 1.8, b.pick(rock.low), 'rock');
    b.box(x(6, 1.5), 0.5, z - 0.75, 1.5, 2.4, 1.5, 'basalt1', 'rock');
    b.box(x(6.2, 1.7), 0, z - 0.85 + 0.25, 1.7, 0.6, 1.9, 'ash2', 'rock');
  }

  // ---- head: tucked under the shell's brim; big glossy eyes with one bright pixel, a small smile, a pale muzzle
  b.part('head', { pivot: [0, 5, 6.4], parent: 'body' });
  b.box(-2.6, 3, 5.6, 5.2, 5, 4.8, rock.face, 'rock'); b.bothX(() => b.box(2.6, 3.5, 5.6, 1.1, 4, 4.1, rock.face, 'rock'));
  b.box(-2.2, 8, 6, 4.4, 0.6, 3.6, b.pick(rock.top), 'rock'); b.box(-1.5, 2.5, 6.4, 3, 0.5, 3.4, 'ash2', 'rock');
  b.box(-1.4, 3.1, 10.4, 2.8, 1.5, 0.35, 'ash2', 'rock', { j: 0.02 }); // muzzle
  b.box(-0.45, 3.5, 10.75, 0.9, 0.22, 0.06, 'basalt0', 'rock', { j: 0 }); b.bothX(() => b.box(0.45, 3.7, 10.75, 0.28, 0.22, 0.06, 'basalt0', 'rock', { j: 0 }));
  for (const s of [-1, 1]) {
    const x0 = s > 0 ? 0.85 : -3.15;
    b.box(x0, 4.7, 10.2, 2.3, 2.6, 0.55, 'visor', 'glass', { j: 0 });
    b.box(x0 + 1.35, 6.35, 10.75, 0.65, 0.65, 0.06, 'eye', 'screen', { j: 0 });
    b.box(x0 + 0.35, 5.15, 10.75, 0.35, 0.35, 0.05, 'stem', 'glass', { j: 0 }); // a second, dim reflection: depth
  }
  for (const [name, s] of [['lidL', 1], ['lidR', -1]]) {
    b.part(name, { pivot: [s * 2, 7.45, 10.8], parent: 'head' });
    b.box(s > 0 ? 0.75 : -3.25, 6.95, 10.3, 2.5, 0.5, 0.62, rock.face, 'rock', { j: 0.01 });
  }
  for (const [name, s] of [['antL', 1], ['antR', -1]]) {
    b.part(name, { pivot: [s * 1.7, 8.5, 8], parent: 'head' });
    b.box(s * 1.7 - 0.3, 8.5, 7.7, 0.6, 2.3, 0.6, 'basalt2', 'rock'); b.box(s * 1.7 - 0.5, 10.6, 7.5, 1, 1, 1, b.pick(['moss2', 'lichen']), 'moss');
  }

  // ---- what it carries: tied on with a twist of stem, sitting in a little moss nest
  if (carrying !== 'none') {
    b.part('cargo', { pivot: [0, 11.2, -1.4], parent: 'body' });
    b.box(-2, 11.2, -3.2, 4, 0.5, 3.6, 'moss0', 'moss');
    if (carrying === 'bolts') {
      b.box(-1.5, 11.7, -2.9, 3, 3.2, 3, 'crystalCold1', 'glass', { j: 0.01 }); b.box(-1.7, 14.9, -3.1, 3.4, 0.7, 3.4, 'rust1', 'paint'); b.box(-0.5, 15.6, -1.9, 1, 0.3, 1, 'brass', 'brass');
      for (const [x, y, z, w] of [[-1.2, 12, 0.1, 1], [0.3, 12.2, 0.1, 0.8], [-0.4, 13, 0.1, 1.1], [0.6, 13.3, 0.1, 0.6], [-1.1, 13.6, 0.1, 0.6]]) b.box(x, y, z - 0.04, w, 0.55, 0.08, 'brass', 'brass', { j: 0.03 });
      for (const [z, y, d] of [[-2.4, 12.1, 0.9], [-1.2, 12.9, 1.1], [-2.2, 13.5, 0.7]]) b.bothX(() => b.box(1.46, y, z, 0.08, 0.55, d, 'brass', 'brass', { j: 0.03 }));
    } else {
      b.box(-1.3, 11.7, -2.7, 2.6, 2.4, 2.6, 'berryBlue', 'glow', { j: 0.02 }); b.box(-0.9, 14.1, -2.3, 1.8, 0.5, 1.8, 'berryBlue', 'glow', { j: 0.02 }); b.bothX(() => b.box(1.3, 12.2, -2.2, 0.45, 1.5, 1.6, 'berryBlue', 'glow', { j: 0.02 }));
      b.box(-0.2, 14.6, -1.6, 0.4, 0.9, 0.4, 'stem', 'leaf'); b.box(0.1, 15.2, -1.9, 1.3, 0.3, 0.8, 'moss1', 'leaf');
    }
    b.box(-2.3, 11.5, -1.7, 4.6, 0.3, 0.4, 'stem', 'fabric');
  }
  return b.build('hopper');
}

/**
 * Glow moth, ≈ 8 cm across. Parts: body → wingL / wingR (pivot at the wing root). Origin under its belly; the game flies the root.
 * @param {{seed?: number}} [o]
 */
export function buildGlowMoth({ seed = 1 } = {}) {
  const b = new VoxelBuilder({ unit: 0.01, seed: 5003 + seed * 7, jitter: 0.04 });
  const wing = b.pick(['lichen', 'crystalCold1', 'moss2']), hind = b.pick(['cap', 'stem', 'cap']);
  b.part('body', { pivot: [0, 1.2, 0] });
  b.box(-0.7, 0.6, -2.6, 1.4, 1.2, 2.8, 'glow', 'glow', { j: 0.02 }); b.box(-0.9, 0.5, 0.2, 1.8, 1.5, 1.6, 'stem', 'rock'); b.box(-0.6, 0.7, 1.8, 1.2, 1, 0.8, 'basalt1', 'rock');
  b.bothX(() => b.box(0.3, 1.5, 2.2, 0.2, 0.2, 1.3, 'lichen', 'rock'));
  for (const [name, s] of [['wingL', 1], ['wingR', -1]]) {
    b.part(name, { pivot: [s * 0.8, 1.8, 0.6], parent: 'body' });
    b.box(s > 0 ? 0.8 : -4.6, 1.7, -0.2, 3.8, 0.25, 2.4, wing, 'leaf'); b.box(s > 0 ? 0.8 : -3.6, 1.6, -2.2, 2.8, 0.25, 1.9, hind, 'leaf'); b.box(s > 0 ? 3 : -3.9, 1.95, 0.5, 0.9, 0.06, 0.9, 'glow', 'glow', { j: 0 });
  }
  return b.build('glowMoth');
}

// ---------------------------------------------------------------------------------------------------------------------
// animation — stateless: every frame the whole pose is rebuilt from (t, p). No allocation.
// ---------------------------------------------------------------------------------------------------------------------
const sstep = (a, c, x) => { const t = Math.max(0, Math.min(1, (x - a) / (c - a))); return t * t * (3 - 2 * t); };
const bump = (a, c, x) => (x <= a || x >= c ? 0 : Math.sin(((x - a) / (c - a)) * Math.PI)); // 0 → 1 → 0 across [a, c]
const lerp = (a, c, t) => a + (c - a) * t;
const every = (t, period, at, len) => bump(at, at + len, t % period); // a short event that recurs
const POSE = { y: 0, z: 0, pitch: 0, roll: 0, yaw: 0, sy: 1, hx: 0, hy: 0, hz: 0, hPitch: 0, hYaw: 0, hRoll: 0, lid: 0, antP: 0, antS: 0, antTw: 0, swing: 0, lift: 0, gait: 0, splay: 0, cx: 0, cy: 0, cz: 0, cRoll: 0 };

function animateMoth(parts, t, p) {
  const fly = p.anim === 'fly' || (p.speed || 0) > 0, f = fly ? 34 : 1.6, a = fly ? 0.95 : 0.1;
  const flap = Math.sin(t * f) * a + (fly ? 0.25 : 1.05); // resting: wings folded up over the back, slowly fanning
  parts.wingL.rotation.z = flap; parts.wingR.rotation.z = -flap;
  const body = parts.body, rest = body.userData.rest;
  if (!rest) return;
  body.position.y = rest.y + (fly ? Math.sin(t * 5.3) * 0.012 + Math.sin(t * 2.1 + 1) * 0.02 : 0);
  body.rotation.x = fly ? -0.25 + Math.sin(t * 5.3 + 0.8) * 0.12 : 0;
  body.rotation.z = fly ? Math.sin(t * 1.7) * 0.2 : 0;
}

/**
 * animate(root, t, p) — ARCHITECTURE §9. Hopper loops: idle · hop (p.phase; falls back to time when it isn't moving) ·
 * sit · peek · eat. One-shots by p.k: sneeze · startle · trade. p.headYaw / p.headPitch are added on top. Moth: fly (else it rests).
 */
export function animate(root, t, p = {}) {
  const parts = root.userData?.parts;
  if (!parts || !parts.body) return;
  if (parts.wingL) { animateMoth(parts, t, p); return; }
  const u = root.userData.model?.unit || HU, P = POSE, anim = p.anim === 'walk' || p.anim === 'jog' ? 'hop' : p.anim || 'idle', k = Math.max(0, Math.min(1, p.k || 0));
  for (const key in P) P[key] = key === 'sy' ? 1 : 0;

  // shared idle life: breathing, a glance now and then, antenna flicks, blinks (one in three is a double)
  const breath = Math.sin(t * 2.1);
  P.sy = 1 + breath * 0.018; P.hYaw = Math.sin(t * 0.43) * 0.16 + Math.sin(t * 1.1 + 2) * 0.05; P.hPitch = Math.sin(t * 0.7 + 1) * 0.04;
  P.antP = 0.12 + Math.sin(t * 1.3) * 0.06; P.antS = 0.18; P.antTw = every(t, 2.9, 0.4, 0.35) * Math.sin(t * 46) * 0.4;
  P.lid = Math.max(every(t, 3.4, 0.2, 0.17), every(t, 10.2, 0.47, 0.15));

  if (anim === 'hop') {
    const moving = (p.speed || 0) > 0 || !!p.phase, c = (moving ? (p.phase || 0) * HOPS_PER_RAD : t * 1.3) % 1; // c: 0 crouch · .22 spring · .34 air · .8 land
    const air = bump(0.3, 0.84, c), crouch = bump(0, 0.3, c) * 0.9 + bump(0.78, 1.02, c) * 1.1;
    P.y = air * 6.2 - crouch * 1.3; P.sy = 1 - crouch * 0.09 + bump(0.24, 0.5, c) * 0.07;
    P.pitch = -bump(0.2, 0.56, c) * 0.3 + bump(0.56, 0.95, c) * 0.24;
    P.lift = crouch * 0.42 + air * 0.85 - bump(0.22, 0.36, c) * 0.5; P.swing = -bump(0.2, 0.42, c) * 0.7 + bump(0.5, 0.9, c) * 0.55;
    P.antP = -0.2 - air * 0.75 + bump(0.8, 1, c) * 0.9; P.hPitch = bump(0.3, 0.6, c) * -0.15 + bump(0.8, 1, c) * 0.2; P.lid = bump(0.8, 0.95, c) * 0.5;
    if (moving) { // keep the feet planted while it gathers and lands: the body hangs back, then catches up in the air
      const L = 1 / (HOPS_PER_RAD * PHASE_PER_M), g0 = 0.32, g1 = 0.8, s = c < g0 ? c + (1 - g1) : c > g1 ? c - g1 : -1, ground = g0 + 1 - g1;
      P.z = ((s >= 0 ? ground / 2 - s : -ground / 2 + ((c - g0) / (g1 - g0)) * ground) * L) / u;
    }
  } else if (anim === 'sit') { // a pebble: legs and head drawn in, eyes half shut, slow breath
    P.y = -2.35; P.sy = 1 + breath * 0.01; P.lift = -0.75; P.splay = -0.5; P.hz = -3.1; P.hy = -0.7; P.hYaw *= 0.2; P.hPitch = 0.1;
    P.antP = -1.35; P.antS = 0.05; P.antTw *= 0.3; P.lid = Math.max(0.55, every(t, 5.2, 1, 0.5));
  } else if (anim === 'peek') { // up on its toes, antennae high, looking about
    const look = Math.sin(t * 0.9);
    P.y = 1.5 + Math.sin(t * 1.7) * 0.15; P.lift = -0.5; P.pitch = -0.13; P.hy = 0.7; P.hz = 0.6; P.hPitch = -0.22; P.hYaw = look * 0.5; P.hRoll = Math.sin(t * 0.9 + 1.2) * 0.16;
    P.antP = 0.32 + Math.sin(t * 3.1) * 0.12; P.antS = 0.34 + Math.sin(t * 2.3) * 0.1; P.lid = -0.45 + every(t, 4.1, 0.3, 0.15) * 1.45;
  } else if (anim === 'eat') { // nose down, quick nibbles, a bigger bite every beat, a pause to chew and look up
    const chew = Math.sin(t * 17) * 0.5 + 0.5, bite = every(t, 1.5, 0, 0.5), pause = every(t, 6, 4.4, 1.3);
    P.pitch = lerp(0.2, 0.02, pause); P.y = lerp(-0.5, 0, pause); P.lift = lerp(0.18, 0, pause); P.hPitch = lerp(0.38 + bite * 0.22 + chew * 0.07, -0.12, pause); P.hy = lerp(-0.6 - bite * 0.5, 0, pause); P.hz = lerp(0.7, 0, pause); P.hYaw *= pause;
    P.antP = lerp(0.75 + chew * 0.08, 0.2, pause); P.lid = Math.max(P.lid, 0.22 * (1 - pause)); P.sy += chew * 0.012 * (pause > 0.5 ? 1 : 0);
  } else if (anim === 'sneeze') { // (red berry!) rears back, eyes screw shut … CHOO … shakes it off, dazed
    const wind = sstep(0, 0.42, k) * (1 - sstep(0.44, 0.5, k)), snap = bump(0.44, 0.62, k), shake = sstep(0.5, 0.58, k) * (1 - sstep(0.62, 0.95, k)), daze = bump(0.6, 1, k);
    P.pitch = -wind * 0.34 + snap * 0.3; P.y = wind * 0.8 + snap * 1.6; P.sy = 1 + wind * 0.09 - snap * 0.12; P.lift = -wind * 0.3 - snap * 0.5;
    P.hPitch = -wind * 0.45 + snap * 0.6; P.hz = -wind * 0.8 + snap * 1.4; P.roll = shake * Math.sin(k * 95) * 0.22; P.hYaw = shake * Math.sin(k * 95 + 1) * 0.3; P.hRoll = daze * Math.sin(k * 21) * 0.12;
    P.antP = -wind * 0.9 + snap * 1.1 + daze * Math.sin(k * 40) * 0.25; P.antS = 0.18 + daze * 0.35; P.antTw = 0; P.lid = Math.max(sstep(0.12, 0.4, k) * (1 - sstep(0.7, 0.82, k)), bump(0.86, 0.96, k));
  } else if (anim === 'startle') { // pops straight up, legs out, eyes huge — lands flat and freezes — then dares to rise
    const jump = bump(0, 0.26, k), flat = sstep(0.2, 0.3, k) * (1 - sstep(0.62, 1, k)), tremble = flat * Math.sin(k * 160) * 0.5;
    P.y = jump * 4.4 - flat * 1.7; P.sy = 1 + jump * 0.06 - flat * 0.06; P.lift = jump * 0.55 + flat * 0.5; P.splay = jump * 0.5; P.roll = tremble * 0.03;
    P.hz = -flat * 1.8; P.hYaw = 0; P.hPitch = -jump * 0.2; P.antP = lerp(0.45, -0.9, flat) * (1 - sstep(0.85, 1, k)) + 0.12 * sstep(0.85, 1, k); P.antS = 0.18 + jump * 0.4; P.antTw = tremble * 0.2;
    P.lid = -0.6 * (1 - sstep(0.75, 1, k));
  } else if (anim === 'trade') { // dips its nose, shrugs the cargo up over its head and lets it drop; backs off a step and looks up, pleased
    const dip = sstep(0, 0.25, k) * (1 - sstep(0.5, 0.68, k)), slide = sstep(0.08, 0.42, k), fall = sstep(0.4, 0.58, k), bounce = bump(0.58, 0.72, k) * 0.9 + bump(0.72, 0.8, k) * 0.3, after = sstep(0.62, 0.85, k);
    P.pitch = dip * 0.34 - after * 0.08; P.y = -dip * 0.5; P.lift = dip * 0.2; P.z = -after * 1.6; P.hPitch = dip * 0.42 - after * 0.3; P.hy = -dip * 0.9; P.hYaw *= 1 - dip;
    P.cz = slide * 9 + fall * 6.5; P.cy = bump(0.08, 0.5, k) * 2.2 - fall * 10.6 + bounce; P.cRoll = (slide - fall) * 0.5;
    P.antP = 0.12 + dip * 0.6 + after * 0.25; P.antS = 0.18 + after * 0.2; P.lid = Math.max(every(k, 2, 0.86, 0.05), every(k, 2, 0.93, 0.05));
  }

  const body = parts.body, head = parts.head, rest = body.userData.rest;
  if (!rest || !head) return;
  body.position.set(rest.x, rest.y + P.y * u, rest.z + P.z * u); body.rotation.set(P.pitch, P.yaw, P.roll); body.scale.set(1 + (1 - P.sy) * 0.5, P.sy, 1 + (1 - P.sy) * 0.5);
  const hr = head.userData.rest;
  head.position.set(hr.x, hr.y + P.hy * u, hr.z + P.hz * u); head.rotation.set(P.hPitch + (p.headPitch || 0), P.hYaw + (p.headYaw || 0), P.hRoll);
  const lid = Math.max(0.35, 1 + P.lid * (LID_SHUT - 1));
  if (parts.lidL) { parts.lidL.scale.y = lid; parts.lidR.scale.y = lid; }
  if (parts.antL) { parts.antL.rotation.set(P.antP + P.antTw, 0, -P.antS); parts.antR.rotation.set(P.antP - P.antTw * 0.7, 0, P.antS); }
  for (let i = 0; i < 6; i++) { // left = +X. swing + = foot forward, lift + = foot up, splay + = foot outward
    const leg = parts[LEGS[i][0]], s = LEGS[i][1];
    if (!leg) continue;
    const row = (i % 3) - 1; // −1 front … +1 rear: front legs reach, rear legs push
    leg.rotation.set(0, -s * (P.swing * (1 - row * 0.25) + P.splay * -row * 0.5), s * (P.lift + P.splay * 0.35));
  }
  const cargo = parts.cargo;
  if (cargo) { const cr = cargo.userData.rest; cargo.position.set(cr.x + P.cx * u, cr.y + P.cy * u, cr.z + P.cz * u); cargo.rotation.set(P.cRoll, 0, 0); }
}

export const gallery = [
  { fn: 'buildHopper', opts: { seed: 1 } }, { fn: 'buildHopper', opts: { seed: 2, carrying: 'bolts' } }, { fn: 'buildHopper', opts: { seed: 3, carrying: 'berry' } },
  { fn: 'buildHopper', opts: { seed: 4 } }, { fn: 'buildHopper', opts: { seed: 5 } },
  { fn: 'buildGlowMoth', opts: { seed: 1 } }, { fn: 'buildGlowMoth', opts: { seed: 2 } },
];
