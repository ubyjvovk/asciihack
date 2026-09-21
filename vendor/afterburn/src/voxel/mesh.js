// VoxelModel (plain data from kit.js) → three.js geometry / objects.
// Compact vertex format (24 B/vertex): position f32×3 · normal i8n×4 · aColor u8n×4 (sRGB rgb + per-box random)
// · aMat u8n×4 (roughness, metalness, emissive/EMISSIVE_RANGE, fx code | stone/ground/dry flags).
import * as THREE from 'three/webgpu';

export const EMISSIVE_RANGE = 32;

const FACE_PX = 1, FACE_NX = 2, FACE_PY = 4, FACE_NY = 8, FACE_PZ = 16, FACE_NZ = 32;

/** Growable typed-array geometry writer. */
export class GeoWriter {
  constructor(capBoxes = 1024) {
    this.nv = 0; this.ni = 0;
    this._alloc(capBoxes * 24, capBoxes * 36);
  }
  _alloc(v, i) {
    const grow = (Old, n, per) => { const a = new Old.constructor(n * per); a.set(Old.subarray(0, Math.min(Old.length, a.length))); return a; };
    this.pos = this.pos ? grow(this.pos, v, 3) : new Float32Array(v * 3);
    this.nrm = this.nrm ? grow(this.nrm, v, 4) : new Int8Array(v * 4);
    this.col = this.col ? grow(this.col, v, 4) : new Uint8Array(v * 4);
    this.mat = this.mat ? grow(this.mat, v, 4) : new Uint8Array(v * 4);
    this.idx = this.idx ? grow(this.idx, i, 1) : new Uint32Array(i);
    this.capV = v; this.capI = i;
  }
  _ensure(v, i) {
    if (this.nv + v > this.capV || this.ni + i > this.capI) this._alloc(Math.max(this.capV * 2, this.nv + v), Math.max(this.capI * 2, this.ni + i));
  }
  /**
   * Write one box. b = kit box (units). `unit` metres per unit. `ox,oy,oz` = origin offset in units (pivot).
   * `m` optional THREE.Matrix4 applied after scaling to metres (for baking placed models into world chunks).
   * `hidden` = bitmask of faces to skip.
   */
  box(b, unit, ox = 0, oy = 0, oz = 0, m = null, hidden = 0) {
    this._ensure(24, 36);
    const x0 = (b.x - ox) * unit, y0 = (b.y - oy) * unit, z0 = (b.z - oz) * unit;
    const x1 = x0 + b.w * unit, y1 = y0 + b.h * unit, z1 = z0 + b.d * unit;
    const cr = b.r, cg = b.g, cb = b.b, ca = Math.round(b.rnd * 255);
    const mr = Math.round(b.rough * 255), mm = Math.round(b.metal * 255);
    const me = Math.round(Math.min(1, b.emissive / EMISSIVE_RANGE) * 255), mf = (b.fx & 31) | (b.stone ? 32 : 0) | (b.ground ? 64 : 0) | (b.dry ? 128 : 0);
    const F = _faces;
    for (let f = 0; f < 6; f++) {
      if (hidden & (1 << f)) continue;
      const q = F[f];
      let nx = q[12], ny = q[13], nz = q[14];
      if (m) { const e = m.elements; const tx = e[0] * nx + e[4] * ny + e[8] * nz, ty = e[1] * nx + e[5] * ny + e[9] * nz, tz = e[2] * nx + e[6] * ny + e[10] * nz; const l = Math.hypot(tx, ty, tz) || 1; nx = tx / l; ny = ty / l; nz = tz / l; }
      const v0 = this.nv;
      for (let k = 0; k < 4; k++) {
        let px = q[k * 3] ? x1 : x0, py = q[k * 3 + 1] ? y1 : y0, pz = q[k * 3 + 2] ? z1 : z0;
        if (m) { const e = m.elements; const tx = e[0] * px + e[4] * py + e[8] * pz + e[12], ty = e[1] * px + e[5] * py + e[9] * pz + e[13], tz = e[2] * px + e[6] * py + e[10] * pz + e[14]; px = tx; py = ty; pz = tz; }
        const v = this.nv++;
        this.pos[v * 3] = px; this.pos[v * 3 + 1] = py; this.pos[v * 3 + 2] = pz;
        this.nrm[v * 4] = Math.round(nx * 127); this.nrm[v * 4 + 1] = Math.round(ny * 127); this.nrm[v * 4 + 2] = Math.round(nz * 127); this.nrm[v * 4 + 3] = 0;
        this.col[v * 4] = cr; this.col[v * 4 + 1] = cg; this.col[v * 4 + 2] = cb; this.col[v * 4 + 3] = ca;
        this.mat[v * 4] = mr; this.mat[v * 4 + 1] = mm; this.mat[v * 4 + 2] = me; this.mat[v * 4 + 3] = mf;
      }
      const i = this.ni; this.ni += 6;
      this.idx[i] = v0; this.idx[i + 1] = v0 + 1; this.idx[i + 2] = v0 + 2; this.idx[i + 3] = v0; this.idx[i + 4] = v0 + 2; this.idx[i + 5] = v0 + 3;
    }
  }
  /** Raw quad (4 corners CCW seen from outside), for terrain meshing. Colours 0..255, mat bytes as in box(). */
  quad(p, n, col, mat) {
    this._ensure(4, 6);
    const v0 = this.nv;
    for (let k = 0; k < 4; k++) {
      const v = this.nv++;
      this.pos[v * 3] = p[k * 3]; this.pos[v * 3 + 1] = p[k * 3 + 1]; this.pos[v * 3 + 2] = p[k * 3 + 2];
      this.nrm[v * 4] = n[0] * 127; this.nrm[v * 4 + 1] = n[1] * 127; this.nrm[v * 4 + 2] = n[2] * 127; this.nrm[v * 4 + 3] = 0;
      this.col[v * 4] = col[0]; this.col[v * 4 + 1] = col[1]; this.col[v * 4 + 2] = col[2]; this.col[v * 4 + 3] = col[3];
      this.mat[v * 4] = mat[0]; this.mat[v * 4 + 1] = mat[1]; this.mat[v * 4 + 2] = mat[2]; this.mat[v * 4 + 3] = mat[3];
    }
    const i = this.ni; this.ni += 6;
    this.idx[i] = v0; this.idx[i + 1] = v0 + 1; this.idx[i + 2] = v0 + 2; this.idx[i + 3] = v0; this.idx[i + 4] = v0 + 2; this.idx[i + 5] = v0 + 3;
  }
  get empty() { return this.nv === 0; }
  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, this.nv * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm.slice(0, this.nv * 4), 4, true));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col.slice(0, this.nv * 4), 4, true));
    g.setAttribute('aMat', new THREE.BufferAttribute(this.mat.slice(0, this.nv * 4), 4, true));
    g.setIndex(new THREE.BufferAttribute(this.nv > 65535 ? this.idx.slice(0, this.ni) : new Uint16Array(this.idx.subarray(0, this.ni)), 1));
    g.computeBoundingBox(); g.computeBoundingSphere();
    return g;
  }
}

// per face: 4 corners as (x?,y?,z?) selectors (1 = max), then the normal. Order matches FACE_* bits.
const _faces = [
  [1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 0],
  [0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0, -1, 0, 0],
  [0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 0, 0, 1, 0],
  [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, -1, 0],
  [0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, -1],
];

/**
 * Find faces fully covered by a single neighbouring box (cheap, catches most stacked/abutting cases).
 * Returns Uint8Array of FACE_* bitmasks, one per box.
 */
export function hiddenFaces(boxes) {
  const n = boxes.length, out = new Uint8Array(n);
  if (n < 2) return out;
  const Q = (v) => Math.round(v * 256);
  const CELL = 8;
  // axis tables: [min, size, u-min, u-size, v-min, v-size] accessors
  const ax = [
    { lo: 'x', sz: 'w', u: 'y', us: 'h', v: 'z', vs: 'd', P: FACE_PX, N: FACE_NX },
    { lo: 'y', sz: 'h', u: 'x', us: 'w', v: 'z', vs: 'd', P: FACE_PY, N: FACE_NY },
    { lo: 'z', sz: 'd', u: 'x', us: 'w', v: 'y', vs: 'h', P: FACE_PZ, N: FACE_NZ },
  ];
  for (const a of ax) {
    const mins = new Map(), maxs = new Map(); // plane → { cells: Map(cellKey → idx[]), large: idx[] }
    const put = (map, plane, i, b) => {
      let e = map.get(plane); if (!e) map.set(plane, (e = { cells: new Map(), large: [] }));
      const u0 = Math.floor(b[a.u] / CELL), u1 = Math.floor((b[a.u] + b[a.us]) / CELL), v0 = Math.floor(b[a.v] / CELL), v1 = Math.floor((b[a.v] + b[a.vs]) / CELL);
      if ((u1 - u0 + 1) * (v1 - v0 + 1) > 36) { e.large.push(i); return; }
      for (let u = u0; u <= u1; u++) for (let v = v0; v <= v1; v++) { const k = u * 73856093 ^ v * 19349663; let l = e.cells.get(k); if (!l) e.cells.set(k, (l = [])); l.push(i); }
    };
    for (let i = 0; i < n; i++) { const b = boxes[i]; put(mins, Q(b[a.lo]), i, b); put(maxs, Q(b[a.lo] + b[a.sz]), i, b); }
    const covered = (b, e, self) => {
      if (!e) return false;
      const E = 1e-4;
      const test = (j) => { if (j === self) return false; const c = boxes[j]; return c[a.u] <= b[a.u] + E && c[a.v] <= b[a.v] + E && c[a.u] + c[a.us] >= b[a.u] + b[a.us] - E && c[a.v] + c[a.vs] >= b[a.v] + b[a.vs] - E; };
      for (const j of e.large) if (test(j)) return true;
      const k = Math.floor((b[a.u] + b[a.us] / 2) / CELL) * 73856093 ^ Math.floor((b[a.v] + b[a.vs] / 2) / CELL) * 19349663;
      const l = e.cells.get(k); if (l) for (const j of l) if (test(j)) return true;
      return false;
    };
    for (let i = 0; i < n; i++) {
      const b = boxes[i];
      if (covered(b, mins.get(Q(b[a.lo] + b[a.sz])), i)) out[i] |= a.P; // my + face vs others' − faces
      if (covered(b, maxs.get(Q(b[a.lo])), i)) out[i] |= a.N;
    }
  }
  return out;
}

/** Geometry for one part (pivot moved to the local origin). */
export function partGeometry(part, unit, { cull = true } = {}) {
  const w = new GeoWriter(part.boxes.length);
  const hid = cull ? hiddenFaces(part.boxes) : null;
  const [ox, oy, oz] = part.pivot;
  part.boxes.forEach((b, i) => w.box(b, unit, ox, oy, oz, null, hid ? hid[i] : 0));
  return w.toGeometry();
}

/**
 * VoxelModel → Object3D hierarchy (one Mesh per part; parts pivot correctly).
 * root.userData.parts[name] → Object3D you can rotate/move to animate. root.userData.model = the data.
 */
export function buildModelObject(model, material, { castShadow = true, receiveShadow = true, cull = true } = {}) {
  const u = model.unit;
  const objs = {};
  for (const p of model.parts) {
    const o = p.boxes.length ? new THREE.Mesh(partGeometry(p, u, { cull }), material) : new THREE.Group();
    o.name = p.name; o.castShadow = castShadow; o.receiveShadow = receiveShadow;
    objs[p.name] = o;
  }
  const root = objs.root || new THREE.Group();
  for (const p of model.parts) {
    if (p.name === 'root') continue;
    const parent = model.parts.find((q) => q.name === p.parent) || model.parts[0];
    const o = objs[p.name];
    o.position.set((p.pivot[0] - parent.pivot[0]) * u, (p.pivot[1] - parent.pivot[1]) * u, (p.pivot[2] - parent.pivot[2]) * u);
    o.userData.rest = o.position.clone();
    (objs[parent.name] || root).add(o);
  }
  root.userData.parts = objs;
  root.userData.model = model;
  return root;
}

/** Bake a whole model (all parts, rest pose) into a GeoWriter with a world matrix. For static scenery. */
export function bakeModel(writer, model, matrix, { cull = true } = {}) {
  for (const p of model.parts) {
    const hid = cull ? hiddenFaces(p.boxes) : null;
    p.boxes.forEach((b, i) => writer.box(b, model.unit, 0, 0, 0, matrix, hid ? hid[i] : 0));
  }
}
