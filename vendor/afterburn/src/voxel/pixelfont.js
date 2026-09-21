// Tiny 3×5 pixel font for in-world stencils and labels (crate words, hull names, pad numbers).
// In-world text is set dressing — anything the player must READ is shown big in the UI.
const G = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
  K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '101111111111101', O: '010101101101010',
  P: '110101110100100', Q: '010101101111011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
  Z: '111001010100111',
  0: '111101101101111', 1: '010110010010111', 2: '110001010100111', 3: '110001010001110', 4: '101101111001001',
  5: '111100110001110', 6: '011100110101010', 7: '111001010010010', 8: '010101010101010', 9: '010101011001110',
  '-': '000000111000000', '.': '000000000000010', ':': '000010000010000', '!': '010010010000010', '/': '001001010100100',
  '>': '100010001010100', '<': '001010100010001', '^': '010101000000000', '+': '000010111010000', ' ': '000000000000000',
};

/** Width in pixels of `text` (3 px glyphs + 1 px gaps). */
export function textWidth(text) { return Math.max(0, String(text).length * 4 - 1); }

/**
 * Stamp text onto a plane using boxes.
 * @param {import('./kit.js').VoxelBuilder} b
 * @param {string} text upper-case letters, digits and - . : ! / < > ^ +
 * @param {number} x @param {number} y @param {number} z  bottom-left corner of the text block, units
 * @param {object} [o]
 * @param {number} [o.px=1] pixel size in units
 * @param {number} [o.depth=0.2] how far pixels stand out
 * @param {'z+'|'z-'|'x+'|'x-'|'y+'} [o.face='z+'] which way the text faces (z+ = toward the default camera; y+ = lying flat, readable from the south)
 * @param {number|string} [o.color='hullDark'] @param {string|object} [o.mat='paint']
 */
export function stampText(b, text, x, y, z, { px = 1, depth = 0.2, face = 'z+', color = 'hullDark', mat = 'paint' } = {}) {
  const s = String(text).toUpperCase();
  for (let i = 0; i < s.length; i++) {
    const g = G[s[i]] || G[' '];
    for (let r = 0; r < 5; r++) {
      let run = -1;
      for (let c = 0; c <= 3; c++) {
        const on = c < 3 && g[r * 3 + c] === '1';
        if (on && run < 0) run = c;
        if (!on && run >= 0) { put(i * 4 + run, 4 - r, c - run); run = -1; }
      }
    }
  }
  function put(cx, cy, len) { // cx,cy in pixels from bottom-left; len pixels wide
    const u = cx * px, v = cy * px, w = len * px;
    if (face === 'z+') b.box(x + u, y + v, z, w, px, depth, color, mat, { j: 0 });
    else if (face === 'z-') b.box(x - u - w, y + v, z - depth, w, px, depth, color, mat, { j: 0 });
    else if (face === 'x+') b.box(x, y + v, z - u - w, depth, px, w, color, mat, { j: 0 });
    else if (face === 'x-') b.box(x - depth, y + v, z + u, depth, px, w, color, mat, { j: 0 });
    else b.box(x + u, y, z - v - px, w, depth, px, color, mat, { j: 0 }); // y+
  }
  return b;
}
