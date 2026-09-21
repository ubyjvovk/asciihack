// VoxelBuilder — the construction kit every model in the game is made with.
// Pure data, no three.js: a model is a list of axis-aligned boxes grouped into named parts.
// See docs/ARCHITECTURE.md §Voxel kit for the full contract and examples.
//
// Coordinates are in *units* (grid cells, `unit` metres each). X = right/east, Y = up, Z = toward the camera/south.
// Fractions are allowed — "voxel-ish" means mixed box sizes, not a rigid grid.

import { hexOf, matOf } from './palette.js';

/** Small fast seeded RNG (mulberry32). */
export function makeRng(seed = 1) {
  let a = (seed >>> 0) || 1;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic 3D value noise in [0,1], smooth. */
export function noise3(x, y, z, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const h = (i, j, k) => {
    let n = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(k, 2147483647) ^ Math.imul(seed + 1, 1274126177);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const l = (a, b, t) => a + (b - a) * t;
  return l(
    l(l(h(xi, yi, zi), h(xi + 1, yi, zi), u), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), u), v),
    l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), u), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), u), v),
    w,
  );
}

/** Fractal noise, [0,1]. */
export function fbm3(x, y, z, octaves = 3, seed = 0) {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let o = 0; o < octaves; o++) { s += a * noise3(x * f, y * f, z * f, seed + o * 17); n += a; a *= 0.5; f *= 2; }
  return s / n;
}

function rgbOf(hex) { return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255]; }

function jitterColor(hex, amt, rand) {
  if (!amt) return rgbOf(hex);
  let [r, g, b] = rgbOf(hex);
  const l = 1 + (rand() - 0.5) * 2 * amt; // lightness
  const t = (rand() - 0.5) * amt * 0.6; // tiny warm/cool drift
  r = r * l * (1 + t); g = g * l; b = b * l * (1 - t);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return [c(r), c(g), c(b)];
}

export class VoxelBuilder {
  /**
   * @param {object} [o]
   * @param {number} [o.unit=0.125] metres per unit
   * @param {number} [o.seed=1]
   * @param {number} [o.jitter=0.05] default per-box lightness jitter (0..0.2)
   */
  constructor({ unit = 0.125, seed = 1, jitter = 0.05 } = {}) {
    this.unit = unit;
    this.jitter = jitter;
    this.rand = makeRng(seed);
    this.seed = seed;
    this.parts = [{ name: 'root', parent: null, pivot: [0, 0, 0], boxes: [] }];
    this._part = this.parts[0];
    this.anchors = {};
    this.lights = [];
    this._xf = [{ tx: 0, ty: 0, tz: 0, sx: 1, sz: 1, rot: 0 }];
  }

  // ---------- random helpers (seeded, deterministic) ----------
  /** float in [a,b) */
  range(a, b) { return a + this.rand() * (b - a); }
  /** int in [a,b] */
  int(a, b) { return Math.floor(a + this.rand() * (b - a + 1)); }
  chance(p) { return this.rand() < p; }
  pick(arr) { return arr[Math.floor(this.rand() * arr.length)]; }
  noise(x, y, z, scale = 1) { return noise3(x * scale, y * scale, z * scale, this.seed); }
  fbm(x, y, z, scale = 1, oct = 3) { return fbm3(x * scale, y * scale, z * scale, oct, this.seed); }

  // ---------- parts (for things that move: limbs, doors, dish, lids) ----------
  /**
   * Start (or switch to) a named part. Boxes added afterwards belong to it.
   * @param {string} name
   * @param {{pivot?: number[], parent?: string}} [o] pivot in units (model space): the point the part rotates around.
   */
  part(name, { pivot = [0, 0, 0], parent = 'root' } = {}) {
    let p = this.parts.find((q) => q.name === name);
    if (!p) { p = { name, parent, pivot: this._pt(pivot[0], pivot[1], pivot[2]), boxes: [] }; this.parts.push(p); }
    this._part = p;
    return this;
  }
  root() { this._part = this.parts[0]; return this; }

  // ---------- transform stack ----------
  /** Run fn with everything translated by (dx,dy,dz) units. */
  at(dx, dy, dz, fn) { return this._push({ tx: dx, ty: dy, tz: dz }, fn); }
  /** Run fn mirrored across the plane x = 0 of the current frame (use with `both`). */
  mirrorX(fn) { return this._push({ sx: -1 }, fn); }
  mirrorZ(fn) { return this._push({ sz: -1 }, fn); }
  /** Run fn twice: as is, and mirrored across x = 0. Great for symmetric ships/robots. */
  bothX(fn) { fn(1); this.mirrorX(() => fn(-1)); return this; }
  bothZ(fn) { fn(1); this.mirrorZ(() => fn(-1)); return this; }
  /** Run fn rotated about the Y axis by quarter turns (1 = 90° counter-clockwise seen from above). */
  rotY(quarters, fn) { return this._push({ rot: ((quarters % 4) + 4) % 4 }, fn); }

  _push(t, fn) {
    this._xf.push({ tx: 0, ty: 0, tz: 0, sx: 1, sz: 1, rot: 0, ...t });
    try { fn(); } finally { this._xf.pop(); }
    return this;
  }
  /** local box → model-space box through the transform stack (innermost first). */
  _box(x, y, z, w, h, d) {
    for (let i = this._xf.length - 1; i >= 0; i--) {
      const t = this._xf[i];
      if (t.sx < 0) x = -(x + w);
      if (t.sz < 0) z = -(z + d);
      for (let r = 0; r < t.rot; r++) { const nx = z, nz = -(x + w); x = nx; z = nz; const tw = w; w = d; d = tw; }
      x += t.tx; y += t.ty; z += t.tz;
    }
    return [x, y, z, w, h, d];
  }
  _pt(x, y, z) { const b = this._box(x, y, z, 0, 0, 0); return [b[0], b[1], b[2]]; }

  // ---------- primitives ----------
  /**
   * Add a box. (x,y,z) = min corner, (w,h,d) = size, all in units.
   * @param {number|string} color palette key, 0xRRGGBB or '#rrggbb'
   * @param {string|object} [mat='rock'] material preset name (see palette.js MAT) or {rough,metal,emissive,fx,dry,stone}
   * @param {{j?: number}} [o] j = jitter override for this box (0 = exact colour)
   */
  box(x, y, z, w, h, d, color, mat = 'rock', o) {
    if (w < 0) { x += w; w = -w; } if (h < 0) { y += h; h = -h; } if (d < 0) { z += d; d = -d; }
    if (w === 0 || h === 0 || d === 0) return this;
    const m = matOf(mat);
    const [r, g, b] = jitterColor(hexOf(color), o?.j ?? this.jitter, this.rand);
    const [bx, by, bz, bw, bh, bd] = this._box(x, y, z, w, h, d);
    this._part.boxes.push({
      x: bx, y: by, z: bz, w: bw, h: bh, d: bd, r, g, b, rnd: this.rand(),
      rough: m.rough ?? 0.9, metal: m.metal ?? 0, emissive: m.emissive ?? 0, fx: m.fx ?? 0, dry: !!m.dry, stone: !!m.stone,
    });
    return this;
  }
  /** 1×1×1 voxel. */
  voxel(x, y, z, color, mat, o) { return this.box(x, y, z, 1, 1, 1, color, mat, o); }

  /**
   * Fill a region voxel by voxel. fn(x,y,z) → colour | [colour, mat] | null. `step` = voxel size in units.
   * Runs along X are merged when colour+mat match, so big fills stay cheap.
   */
  fill(x0, y0, z0, x1, y1, z1, fn, step = 1) {
    const nx = Math.round((x1 - x0) / step), ny = Math.round((y1 - y0) / step), nz = Math.round((z1 - z0) / step);
    for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
      const y = y0 + j * step, z = z0 + k * step;
      let run = null;
      for (let i = 0; i <= nx; i++) {
        const x = x0 + i * step;
        const v = i < nx ? fn(x, y, z) : null;
        const col = v == null ? null : Array.isArray(v) ? v[0] : v;
        const mat = Array.isArray(v) ? v[1] : undefined;
        if (run && (col !== run.col || mat !== run.mat)) { this.box(run.x, y, z, x - run.x, step, step, run.col, run.mat); run = null; }
        if (!run && col != null) run = { x, col, mat };
      }
    }
    return this;
  }

  /** Hollow box: walls of thickness t. `open` lists faces to leave out: any of 'top','bottom','n','s','e','w'. */
  shell(x, y, z, w, h, d, t, color, mat, open = []) {
    const has = (f) => !open.includes(f);
    if (has('bottom')) this.box(x, y, z, w, t, d, color, mat);
    if (has('top')) this.box(x, y + h - t, z, w, t, d, color, mat);
    if (has('w')) this.box(x, y + t, z, t, h - 2 * t, d, color, mat);
    if (has('e')) this.box(x + w - t, y + t, z, t, h - 2 * t, d, color, mat);
    if (has('n')) this.box(x + t, y + t, z, w - 2 * t, h - 2 * t, t, color, mat);
    if (has('s')) this.box(x + t, y + t, z + d - t, w - 2 * t, h - 2 * t, t, color, mat);
    return this;
  }

  /** Stair-stepped line of s×s×s voxels from a to b (for cables, struts, antennas, branches). */
  line(ax, ay, az, bx, by, bz, s, color, mat) {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay), Math.abs(bz - az)) / s));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const q = (v) => Math.round(v / s) * s;
      this.box(q(ax + (bx - ax) * t), q(ay + (by - ay) * t), q(az + (bz - az) * t), s, s, s, color, mat);
    }
    return this;
  }

  /**
   * Stepped "blob": an ellipsoid-ish mound made of voxels of size s (rocks, bushes, smoke puffs, mounds).
   * colorFn(x,y,z, t) → colour | [colour, mat] | null, where t = 0 at the core, 1 at the surface.
   */
  blob(cx, cy, cz, rx, ry, rz, s, colorFn, { rough = 0.35, hollow = true } = {}) {
    const inside = (x, y, z) => {
      const nx = (x + s / 2 - cx) / rx, ny = (y + s / 2 - cy) / ry, nz = (z + s / 2 - cz) / rz;
      const r = Math.sqrt(nx * nx + ny * ny + nz * nz);
      return r + (this.noise(x, y, z, 0.35 / s) - 0.5) * rough * 2;
    };
    const q = (v) => Math.floor(v / s) * s;
    this.fill(q(cx - rx) - s, q(cy - ry) - s, q(cz - rz) - s, q(cx + rx) + 2 * s, q(cy + ry) + 2 * s, q(cz + rz) + 2 * s, (x, y, z) => {
      const r = inside(x, y, z);
      if (r > 1) return null;
      if (hollow && r < 0.55 && inside(x, y + s, z) < 0.9) return null; // skip deep interior
      return colorFn(x, y, z, r);
    }, s);
    return this;
  }

  // ---------- metadata ----------
  /** Named point in model space (units). Used by the game to attach lights, particles, prompts, carried items. */
  anchor(name, x, y, z) { this.anchors[name] = this._pt(x, y, z); return this; }

  /**
   * Request a real light. Keep them few (≤ 3 per model). Units for position; metres for distance.
   * @param {{x:number,y:number,z:number,color?:number|string,intensity?:number,distance?:number,flicker?:number,name?:string,castShadow?:boolean}} l
   */
  light(l) {
    const [x, y, z] = this._pt(l.x, l.y, l.z);
    this.lights.push({ name: l.name || 'light' + this.lights.length, x, y, z, color: hexOf(l.color ?? 'lamp'), intensity: l.intensity ?? 8, distance: l.distance ?? 8, flicker: l.flicker ?? 0, castShadow: !!l.castShadow, part: this._part.name });
    return this;
  }

  /** Stamp another model-building function at an offset/rotation. fn receives this builder. */
  stamp(fn, x = 0, y = 0, z = 0, quarters = 0) { return this.at(x, y, z, () => this.rotY(quarters, () => fn(this))); }

  /** Finish. Returns a plain-data VoxelModel. */
  build(name = 'model') {
    const u = this.unit;
    let n = 0;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const p of this.parts) for (const b of p.boxes) {
      n++;
      min[0] = Math.min(min[0], b.x); min[1] = Math.min(min[1], b.y); min[2] = Math.min(min[2], b.z);
      max[0] = Math.max(max[0], b.x + b.w); max[1] = Math.max(max[1], b.y + b.h); max[2] = Math.max(max[2], b.z + b.d);
    }
    if (!n) { min.fill(0); max.fill(0); }
    const anchors = {};
    for (const k in this.anchors) anchors[k] = this.anchors[k].map((v) => v * u);
    return {
      name, unit: u, boxCount: n,
      parts: this.parts.filter((p) => p.boxes.length || p.name === 'root' || this.parts.some((q) => q.parent === p.name)),
      anchors,
      lights: this.lights.map((l) => ({ ...l, x: l.x * u, y: l.y * u, z: l.z * u })),
      bounds: { min: min.map((v) => v * u), max: max.map((v) => v * u) },
    };
  }
}
