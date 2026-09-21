// Named colours (sRGB hex) and material presets. See docs/ART_BIBLE.md §3–4.
// Models should use these names instead of raw hex wherever a name fits, so the whole game can be re-graded in one place.

export const PAL = {
  // basalt / wet rock
  basalt0: 0x1d2426, basalt1: 0x2a3437, basalt2: 0x35424a, basalt3: 0x46545a,
  // slate / dry rock
  slate0: 0x56636a, slate1: 0x6b777b, slate2: 0x828c8c,
  // ash sand
  ash0: 0x535a58, ash1: 0x666c69, ash2: 0x7f8580,
  // scorch
  scorch0: 0x0e1112, scorch1: 0x1a1917, scorch2: 0x2b2521, ember: 0xff6a2a,
  // moss / lichen
  moss0: 0x43583a, moss1: 0x5f7852, moss2: 0x839a76, lichen: 0xa9b59a,
  // glow flora
  stem: 0x2c4a4a, cap: 0x3f7f78, glow: 0x7ef0d0, berryBlue: 0x5aa0ff, berryRed: 0xff5a4a, bloom: 0xe06aa8,
  // the Sparrow
  hull0: 0xd8d2c4, hull1: 0xbdb6a6, panel: 0x8a8f8e, stripe: 0x2f7d78, hullDark: 0x23292b,
  // pilot
  suit0: 0xd9622b, suit1: 0xb84e20, helmet: 0xe9e4d8, visor: 0x1b2a33, strap: 0x3a3f42,
  // Pip
  pip0: 0xd9cfb8, pip1: 0xb3a88f, brass: 0xa9823c, rubber: 0x2a2c2d, lantern: 0xffb45e, eye: 0x9ff5e0,
  // outpost
  wall0: 0x8d8a7f, wall1: 0x6f6d66, rust0: 0x8a4b2d, rust1: 0xa25a34, frame: 0x3b4346, canvas: 0xb9ad8e,
  wood0: 0x6a5138, wood1: 0x85684a, paper: 0xe6dcc0,
  // crystal
  crystalWarm0: 0xff9d4a, crystalWarm1: 0xffc27a, crystalCold0: 0x6fc3ff, crystalCold1: 0xa8e0ff,
  // practical light
  lamp: 0xffb060, fire: 0xff8a3c, screen: 0x8fe8d8, ledRed: 0xff4a3a, ledGreen: 0x7dff9a,
  // water / misc
  mud: 0x3a3a33, water: 0x1c3a40, white: 0xf2efe6, black: 0x0b0d0e,
};

// fx codes (decoded in the shader from aMat.a): what a box does over time.
export const FX = { none: 0, flicker: 1, pulse: 2, sway: 3, twinkle: 4 };

// Material presets → { rough, metal, emissive, fx, dry }
//  emissive is a multiplier on the box colour (0 = not emissive). Keep emitters SMALL (ART_BIBLE §2).
//  dry: true = never gets wet/puddled (interiors, characters' faces, glowing things).
export const MAT = {
  rock: { rough: 0.92, metal: 0, stone: true },
  wetrock: { rough: 0.55, metal: 0, stone: true },
  sand: { rough: 0.95, metal: 0 },
  mud: { rough: 0.7, metal: 0 },
  moss: { rough: 1.0, metal: 0, fx: FX.none },
  leaf: { rough: 0.85, metal: 0, fx: FX.sway },
  wood: { rough: 0.8, metal: 0 },
  paint: { rough: 0.55, metal: 0.1 },
  metal: { rough: 0.4, metal: 0.85 },
  darkmetal: { rough: 0.5, metal: 0.7 },
  brass: { rough: 0.35, metal: 0.9 },
  rubber: { rough: 0.9, metal: 0 },
  plastic: { rough: 0.5, metal: 0 },
  fabric: { rough: 0.95, metal: 0 },
  glass: { rough: 0.08, metal: 0 },
  crystal: { rough: 0.15, metal: 0, emissive: 0.6, fx: FX.twinkle, dry: true },
  lamp: { rough: 0.4, metal: 0, emissive: 9, dry: true },
  lampOff: { rough: 0.3, metal: 0 },
  led: { rough: 0.4, metal: 0, emissive: 4, fx: FX.pulse, dry: true },
  screen: { rough: 0.2, metal: 0, emissive: 2.5, dry: true },
  ember: { rough: 0.9, metal: 0, emissive: 4, fx: FX.flicker, dry: true },
  fire: { rough: 0.9, metal: 0, emissive: 10, fx: FX.flicker, dry: true },
  glow: { rough: 0.6, metal: 0, emissive: 3, fx: FX.pulse, dry: true },
};

/** Resolve a colour given as palette key, hex number, or '#rrggbb'. Returns 0xRRGGBB. */
export function hexOf(c) {
  if (typeof c === 'number') return c;
  if (typeof c === 'string') {
    if (c in PAL) return PAL[c];
    if (c[0] === '#') return parseInt(c.slice(1), 16);
  }
  throw new Error('Unknown colour: ' + c);
}

/** Resolve a material given as preset name or literal object. */
export function matOf(m) {
  if (!m) return MAT.rock;
  if (typeof m === 'string') {
    const p = MAT[m];
    if (!p) throw new Error('Unknown material preset: ' + m);
    return p;
  }
  return m;
}
