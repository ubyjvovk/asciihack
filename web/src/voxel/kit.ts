/**
 * VoxelBuilder — the construction kit every model in the game is made with.
 * Ported from vendor/afterburn/src/voxel/kit.js: pure data, no three.js. A model
 * is a list of axis-aligned boxes grouped into named parts.
 *
 * Coordinates are in *units* (grid cells, `unit` metres each). X = right/east,
 * Y = up, Z = toward the camera/south. Fractions are allowed — "voxel-ish"
 * means mixed box sizes, not a rigid grid.
 */

import { hexOf, matOf, type ColorRef, type MatPreset, type MatRef } from './palette.js';

/** Options for `new VoxelBuilder({...})`. */
export interface BuilderOptions {
  /** Metres per unit. Default 0.125 (8 voxels per one-metre cell edge). */
  unit?: number;
  /** RNG seed (mulberry32). */
  seed?: number;
  /** Default per-box lightness jitter (0..0.2). */
  jitter?: number;
}

/** A cooked axis-aligned box in model space (units). Written by `VoxelBuilder`. */
export interface VoxelBox {
  x: number; y: number; z: number;
  w: number; h: number; d: number;
  r: number; g: number; b: number;
  /** Per-box random in [0,1), stable across builds with the same seed. */
  rnd: number;
  rough: number;
  metal: number;
  emissive: number;
  fx: number;
  dry: boolean;
  stone: boolean;
  /** Terrain flag (set by scenery bakers, not by kit primitives). */
  ground?: boolean;
}

/** A named group of boxes with a pivot. Rotating the part rotates its boxes. */
export interface VoxelPart {
  name: string;
  parent: string | null;
  pivot: [number, number, number];
  boxes: VoxelBox[];
}

/** Named point in model space (metres, post-build). */
export type VoxelAnchors = Record<string, [number, number, number]>;

/** A requested real light. Positions are in metres after build. */
export interface VoxelLight {
  name: string;
  x: number; y: number; z: number;
  color: number;
  intensity: number;
  distance: number;
  flicker: number;
  castShadow: boolean;
  part: string;
}

/** Return value of `VoxelBuilder.build()`. */
export interface VoxelModel {
  name: string;
  unit: number;
  boxCount: number;
  parts: VoxelPart[];
  anchors: VoxelAnchors;
  lights: VoxelLight[];
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

/** What a `fill` / `blob` callback may return. */
export type FillResult = ColorRef | [ColorRef, MatRef?] | null;

/** Extra per-box options passed to `box`/`voxel`. */
export interface BoxOptions {
  /** Jitter override for this box (0 = exact colour). */
  j?: number;
}

interface Transform {
  tx: number; ty: number; tz: number;
  sx: number; sz: number;
  rot: number;
}

/** Small fast seeded RNG (mulberry32). */
export function makeRng(seed: number = 1): () => number {
  let a = (seed >>> 0) || 1;
  return function rand(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic 3D value noise in [0,1], smooth. */
export function noise3(x: number, y: number, z: number, seed: number = 0): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const h = (i: number, j: number, k: number): number => {
    let n = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(k, 2147483647) ^ Math.imul(seed + 1, 1274126177);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const l = (a: number, b: number, t: number): number => a + (b - a) * t;
  return l(
    l(l(h(xi, yi, zi), h(xi + 1, yi, zi), u), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), u), v),
    l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), u), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), u), v),
    w,
  );
}

/** Fractal noise in [0,1]. */
export function fbm3(x: number, y: number, z: number, octaves: number = 3, seed: number = 0): number {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let o = 0; o < octaves; o++) { s += a * noise3(x * f, y * f, z * f, seed + o * 17); n += a; a *= 0.5; f *= 2; }
  return s / n;
}

function rgbOf(hex: number): [number, number, number] { return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255]; }

function jitterColor(hex: number, amt: number, rand: () => number): [number, number, number] {
  if (!amt) return rgbOf(hex);
  let [r, g, b] = rgbOf(hex);
  const l = 1 + (rand() - 0.5) * 2 * amt;
  const t = (rand() - 0.5) * amt * 0.6;
  r = r * l * (1 + t); g = g * l; b = b * l * (1 - t);
  const c = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  return [c(r), c(g), c(b)];
}

/** Construction kit: build a `VoxelModel` by stacking boxes, primitives and transforms. */
export class VoxelBuilder {
  unit: number;
  jitter: number;
  rand: () => number;
  seed: number;
  parts: VoxelPart[];
  anchors: Record<string, [number, number, number]>;
  lights: VoxelLight[];
  private _part: VoxelPart;
  private _xf: Transform[];

  constructor({ unit = 0.125, seed = 1, jitter = 0.05 }: BuilderOptions = {}) {
    this.unit = unit;
    this.jitter = jitter;
    this.rand = makeRng(seed);
    this.seed = seed;
    this.parts = [{ name: 'root', parent: null, pivot: [0, 0, 0], boxes: [] }];
    this._part = this.parts[0]!;
    this.anchors = {};
    this.lights = [];
    this._xf = [{ tx: 0, ty: 0, tz: 0, sx: 1, sz: 1, rot: 0 }];
  }

  // ---------- random helpers (seeded, deterministic) ----------

  /** Uniform float in [a, b). */
  range(a: number, b: number): number { return a + this.rand() * (b - a); }
  /** Uniform int in [a, b]. */
  int(a: number, b: number): number { return Math.floor(a + this.rand() * (b - a + 1)); }
  /** `true` with probability p. */
  chance(p: number): boolean { return this.rand() < p; }
  /** Pick one element (returns undefined for an empty array). */
  pick<T>(arr: readonly T[]): T | undefined { return arr[Math.floor(this.rand() * arr.length)]; }
  /** Deterministic 3D value noise, seeded by this builder. */
  noise(x: number, y: number, z: number, scale: number = 1): number { return noise3(x * scale, y * scale, z * scale, this.seed); }
  /** Deterministic fractal noise, seeded by this builder. */
  fbm(x: number, y: number, z: number, scale: number = 1, oct: number = 3): number { return fbm3(x * scale, y * scale, z * scale, oct, this.seed); }

  // ---------- parts (for things that move: limbs, doors, dish, lids) ----------

  /** Start (or switch to) a named part. Subsequent boxes belong to it. */
  part(name: string, { pivot = [0, 0, 0] as [number, number, number], parent = 'root' }: { pivot?: [number, number, number]; parent?: string } = {}): this {
    let p = this.parts.find((q) => q.name === name);
    if (!p) { p = { name, parent, pivot: this._pt(pivot[0], pivot[1], pivot[2]), boxes: [] }; this.parts.push(p); }
    this._part = p;
    return this;
  }
  /** Switch back to the root part. */
  root(): this { this._part = this.parts[0]!; return this; }

  // ---------- transform stack ----------

  /** Run `fn` with everything translated by (dx, dy, dz) units. */
  at(dx: number, dy: number, dz: number, fn: () => void): this { return this._push({ tx: dx, ty: dy, tz: dz }, fn); }
  /** Run `fn` mirrored across the plane x = 0 of the current frame. */
  mirrorX(fn: () => void): this { return this._push({ sx: -1 }, fn); }
  /** Run `fn` mirrored across the plane z = 0 of the current frame. */
  mirrorZ(fn: () => void): this { return this._push({ sz: -1 }, fn); }
  /** Run `fn` twice: as is and mirrored across x = 0 (great for symmetric ships/robots). */
  bothX(fn: (side: 1 | -1) => void): this { fn(1); this.mirrorX(() => fn(-1)); return this; }
  /** Run `fn` twice: as is and mirrored across z = 0. */
  bothZ(fn: (side: 1 | -1) => void): this { fn(1); this.mirrorZ(() => fn(-1)); return this; }
  /** Run `fn` rotated about Y in quarter turns (1 = 90° CCW seen from above). */
  rotY(quarters: number, fn: () => void): this { return this._push({ rot: ((quarters % 4) + 4) % 4 }, fn); }

  private _push(t: Partial<Transform>, fn: () => void): this {
    this._xf.push({ tx: 0, ty: 0, tz: 0, sx: 1, sz: 1, rot: 0, ...t });
    try { fn(); } finally { this._xf.pop(); }
    return this;
  }

  /** Local box → model-space box, innermost-first through the transform stack. */
  private _box(x: number, y: number, z: number, w: number, h: number, d: number): [number, number, number, number, number, number] {
    for (let i = this._xf.length - 1; i >= 0; i--) {
      const t = this._xf[i]!;
      if (t.sx < 0) x = -(x + w);
      if (t.sz < 0) z = -(z + d);
      for (let r = 0; r < t.rot; r++) { const nx = z, nz = -(x + w); x = nx; z = nz; const tw = w; w = d; d = tw; }
      x += t.tx; y += t.ty; z += t.tz;
    }
    return [x, y, z, w, h, d];
  }

  private _pt(x: number, y: number, z: number): [number, number, number] {
    const b = this._box(x, y, z, 0, 0, 0);
    return [b[0], b[1], b[2]];
  }

  // ---------- primitives ----------

  /** Add a box (min corner + size in units, colour palette-key/hex, material preset or literal). */
  box(x: number, y: number, z: number, w: number, h: number, d: number, color: ColorRef, mat: MatRef = 'rock', o?: BoxOptions): this {
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    if (d < 0) { z += d; d = -d; }
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

  /** 1×1×1 voxel shortcut. */
  voxel(x: number, y: number, z: number, color: ColorRef, mat?: MatRef, o?: BoxOptions): this { return this.box(x, y, z, 1, 1, 1, color, mat, o); }

  /**
   * Fill a region voxel by voxel; runs along X are merged when colour+mat match.
   * `fn(x,y,z)` returns a colour, `[colour, mat]`, or `null` to skip.
   */
  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, fn: (x: number, y: number, z: number) => FillResult, step: number = 1): this {
    const nx = Math.round((x1 - x0) / step), ny = Math.round((y1 - y0) / step), nz = Math.round((z1 - z0) / step);
    for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
      const y = y0 + j * step, z = z0 + k * step;
      let run: { x: number; col: ColorRef; mat: MatRef | undefined } | null = null;
      for (let i = 0; i <= nx; i++) {
        const x = x0 + i * step;
        const v = i < nx ? fn(x, y, z) : null;
        const col: ColorRef | null = v == null ? null : Array.isArray(v) ? v[0] : v;
        const mat: MatRef | undefined = Array.isArray(v) ? v[1] : undefined;
        if (run && (col !== run.col || mat !== run.mat)) { this.box(run.x, y, z, x - run.x, step, step, run.col, run.mat); run = null; }
        if (!run && col != null) run = { x, col, mat };
      }
    }
    return this;
  }

  /** Hollow box with walls of thickness `t`; `open` lists faces to leave out. */
  shell(x: number, y: number, z: number, w: number, h: number, d: number, t: number, color: ColorRef, mat?: MatRef, open: ReadonlyArray<'top' | 'bottom' | 'n' | 's' | 'e' | 'w'> = []): this {
    const has = (f: 'top' | 'bottom' | 'n' | 's' | 'e' | 'w'): boolean => !open.includes(f);
    if (has('bottom')) this.box(x, y, z, w, t, d, color, mat);
    if (has('top')) this.box(x, y + h - t, z, w, t, d, color, mat);
    if (has('w')) this.box(x, y + t, z, t, h - 2 * t, d, color, mat);
    if (has('e')) this.box(x + w - t, y + t, z, t, h - 2 * t, d, color, mat);
    if (has('n')) this.box(x + t, y + t, z, w - 2 * t, h - 2 * t, t, color, mat);
    if (has('s')) this.box(x + t, y + t, z + d - t, w - 2 * t, h - 2 * t, t, color, mat);
    return this;
  }

  /** Stair-stepped line of s×s×s voxels from a to b (cables, struts, antennas, branches). */
  line(ax: number, ay: number, az: number, bx: number, by: number, bz: number, s: number, color: ColorRef, mat?: MatRef): this {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay), Math.abs(bz - az)) / s));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const q = (v: number): number => Math.round(v / s) * s;
      this.box(q(ax + (bx - ax) * t), q(ay + (by - ay) * t), q(az + (bz - az) * t), s, s, s, color, mat);
    }
    return this;
  }

  /**
   * Stepped ellipsoid-ish mound of s-sized voxels (rocks, bushes, smoke puffs).
   * `colorFn(x,y,z,t)` gets `t = 0` at the core, `1` at the surface.
   */
  blob(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, s: number, colorFn: (x: number, y: number, z: number, t: number) => FillResult, { rough = 0.35, hollow = true }: { rough?: number; hollow?: boolean } = {}): this {
    const inside = (x: number, y: number, z: number): number => {
      const nx = (x + s / 2 - cx) / rx, ny = (y + s / 2 - cy) / ry, nz = (z + s / 2 - cz) / rz;
      const r = Math.sqrt(nx * nx + ny * ny + nz * nz);
      return r + (this.noise(x, y, z, 0.35 / s) - 0.5) * rough * 2;
    };
    const q = (v: number): number => Math.floor(v / s) * s;
    this.fill(q(cx - rx) - s, q(cy - ry) - s, q(cz - rz) - s, q(cx + rx) + 2 * s, q(cy + ry) + 2 * s, q(cz + rz) + 2 * s, (x, y, z) => {
      const r = inside(x, y, z);
      if (r > 1) return null;
      if (hollow && r < 0.55 && inside(x, y + s, z) < 0.9) return null;
      return colorFn(x, y, z, r);
    }, s);
    return this;
  }

  // ---------- metadata ----------

  /** Named point in model space (units): the game attaches lights/particles/prompts/items here. */
  anchor(name: string, x: number, y: number, z: number): this { this.anchors[name] = this._pt(x, y, z); return this; }

  /** Request a real light. Keep them few (≤ 3 per model). Position units; distance metres. */
  light(l: { x: number; y: number; z: number; color?: ColorRef; intensity?: number; distance?: number; flicker?: number; name?: string; castShadow?: boolean }): this {
    const [x, y, z] = this._pt(l.x, l.y, l.z);
    this.lights.push({
      name: l.name || 'light' + this.lights.length,
      x, y, z,
      color: hexOf(l.color ?? 'lamp'),
      intensity: l.intensity ?? 8,
      distance: l.distance ?? 8,
      flicker: l.flicker ?? 0,
      castShadow: !!l.castShadow,
      part: this._part.name,
    });
    return this;
  }

  /** Stamp another model-building function at an offset/rotation; `fn` receives this builder. */
  stamp(fn: (b: VoxelBuilder) => void, x: number = 0, y: number = 0, z: number = 0, quarters: number = 0): this {
    return this.at(x, y, z, () => this.rotY(quarters, () => fn(this)));
  }

  /** Finish. Returns a plain-data `VoxelModel`. */
  build(name: string = 'model'): VoxelModel {
    const u = this.unit;
    let n = 0;
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const p of this.parts) for (const b of p.boxes) {
      n++;
      min[0] = Math.min(min[0], b.x); min[1] = Math.min(min[1], b.y); min[2] = Math.min(min[2], b.z);
      max[0] = Math.max(max[0], b.x + b.w); max[1] = Math.max(max[1], b.y + b.h); max[2] = Math.max(max[2], b.z + b.d);
    }
    if (!n) { min[0] = min[1] = min[2] = 0; max[0] = max[1] = max[2] = 0; }
    const anchors: VoxelAnchors = {};
    for (const k in this.anchors) {
      const a = this.anchors[k]!;
      anchors[k] = [a[0] * u, a[1] * u, a[2] * u];
    }
    return {
      name, unit: u, boxCount: n,
      parts: this.parts.filter((p) => p.boxes.length || p.name === 'root' || this.parts.some((q) => q.parent === p.name)),
      anchors,
      lights: this.lights.map((l) => ({ ...l, x: l.x * u, y: l.y * u, z: l.z * u })),
      bounds: { min: [min[0] * u, min[1] * u, min[2] * u], max: [max[0] * u, max[1] * u, max[2] * u] },
    };
  }
}
