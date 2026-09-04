/**
 * Dungeon scene builder for the WebGL viewport (T-0031, docs/web.md
 * "WebGL viewport"). Given a `LevelView`, produces one `InstancedMesh` per
 * material — walls (unit cubes for solid non-door cells), floors (unit quads
 * at y = 0 for passable cells including doorways and stairs), closed-door
 * boxes (a thin slab), open-door/doorway posts (two thin pillars per cell)
 * and stair markers (a lit quad on top of the floor). Sprite billboards are
 * placed with their feet at y = 0 and centred on the cell.
 *
 * Coordinates (architecture.md §7 / AsciiCity convention): map `x` grows
 * east, map `y` grows south, three.js `x` = east, `z` = south, `y` = up. A
 * cell (cx, cy) covers the box (cx…cx+1, 0…1, cy…cy+1); its centre is
 * (cx + 0.5, 0.5, cy + 0.5).
 *
 * `refresh(level)` is idempotent: it hashes each cell's `CellKind` and only
 * rebuilds when the set of known cells actually changes. `updateSprites` is
 * called every frame; instances are keyed by cell for cheap position updates.
 *
 * three.js has no DOM/WebGL dependency at import time; every class used here
 * (`Group`, `InstancedMesh`, `BoxGeometry`, `PlaneGeometry`, `Sprite`,
 * `SpriteMaterial`) constructs fine in node, so the whole builder is unit-
 * testable without a `WebGLRenderer`.
 */
import * as THREE from 'three';
import { isSolid, type CellKind, type LevelView, type Sprite } from '../../../src/model/types.js';

/** Aggregate instance counts after `refresh` — the tests inspect these. */
export interface SceneCounts {
  /** Solid non-unexplored non-door cells rendered as unit cubes. */
  walls: number;
  /** Passable non-unexplored cells rendered as unit floor quads. */
  floors: number;
  /** `door_closed` cells rendered as a thin box in the doorway. */
  doorBoxes: number;
  /** Two pillars per `door_open`/`doorway` cell. */
  doorPosts: number;
  /** Stair-marker quads for `stairs_up`/`stairs_down`. */
  stairs: number;
}

/** Materials for the structural meshes; supply overrides to swap in styled ones. */
export interface SceneMaterials {
  wall: THREE.Material;
  floor: THREE.Material;
  door: THREE.Material;
  post: THREE.Material;
  stair: THREE.Material;
}

/** Default plain Lambert materials — the GL viewport supplies textured ones. */
export function defaultMaterials(): SceneMaterials {
  return {
    wall: new THREE.MeshLambertMaterial({ color: 0x484848 }),
    floor: new THREE.MeshLambertMaterial({ color: 0x2a2a2a }),
    door: new THREE.MeshLambertMaterial({ color: 0x7a4a1a }),
    post: new THREE.MeshLambertMaterial({ color: 0x7a4a1a }),
    stair: new THREE.MeshLambertMaterial({ color: 0xa07a20, emissive: 0x503810 }),
  };
}

/** Per-cell counts used to size each `InstancedMesh` before placing instances. */
interface CellCounts {
  walls: number;
  floors: number;
  doorBoxes: number;
  doorPosts: number; // cells (× 2 posts)
  stairs: number;
}

/** Build a compact string that changes only when the set of drawable cells does. */
export function hashKinds(level: LevelView): string {
  const w = level.width;
  const h = level.height;
  const parts: string[] = [`${w}x${h}`];
  for (let y = 0; y < h; y++) {
    let row = '';
    for (let x = 0; x < w; x++) row += KIND_CODE[level.kindAt(x, y)] ?? '?';
    parts.push(row);
  }
  return parts.join('|');
}

/** Compact one-letter code per `CellKind` used by `hashKinds`. */
const KIND_CODE: Record<CellKind, string> = {
  unexplored: '.',
  stone: 's',
  wall: 'W',
  doorway: 'd',
  door_open: 'o',
  door_closed: 'c',
  floor: 'F',
  corridor: 'C',
  stairs_up: '<',
  stairs_down: '>',
  ladder_up: '(',
  ladder_down: ')',
  altar: 'A',
  fountain: 'U',
  sink: 'K',
  grave: 'G',
  throne: 'T',
  tree: 't',
  bars: 'B',
  water: '~',
  lava: 'L',
  ice: 'I',
  air: ' ',
  cloud: 'l',
  drawbridge: 'b',
  trap: '^',
  other: 'x',
};

/** Base cube used for walls (unit, centred at origin). Reused across rebuilds. */
const CUBE_GEOM = new THREE.BoxGeometry(1, 1, 1);
/** Base floor quad, oriented in the XZ plane (normal up), centred at origin. */
const FLOOR_GEOM = (() => {
  const g = new THREE.PlaneGeometry(1, 1);
  g.rotateX(-Math.PI / 2);
  return g;
})();
/** Thin door slab: 1 wide, 1 tall, 0.2 deep — rotated into the doorway. */
const DOOR_GEOM = new THREE.BoxGeometry(1, 1, 0.2);
/** Vertical pillar 0.2×1×0.2 used for open-door and doorway posts. */
const POST_GEOM = new THREE.BoxGeometry(0.2, 1, 0.2);
/** Stair-marker quad, just above the floor to avoid z-fighting. */
const STAIR_GEOM = FLOOR_GEOM.clone();

/**
 * Owns the structural meshes (walls/floors/doors/posts/stairs) plus a group
 * of `THREE.Sprite`s for every cell-standing glyph. Attach `root` to the
 * scene; call `refresh(level)` when the level view might have changed and
 * `updateSprites(list)` every frame.
 */
export class SceneBuilder {
  readonly root: THREE.Group;
  readonly spriteGroup: THREE.Group;
  readonly materials: SceneMaterials;
  counts: SceneCounts = { walls: 0, floors: 0, doorBoxes: 0, doorPosts: 0, stairs: 0 };

  private structHash = '';
  private wallMesh: THREE.InstancedMesh | null = null;
  private floorMesh: THREE.InstancedMesh | null = null;
  private doorMesh: THREE.InstancedMesh | null = null;
  private postMesh: THREE.InstancedMesh | null = null;
  private stairMesh: THREE.InstancedMesh | null = null;
  private readonly spriteCache = new Map<string, THREE.Sprite>();

  constructor(materials?: Partial<SceneMaterials>) {
    this.materials = { ...defaultMaterials(), ...materials };
    this.root = new THREE.Group();
    this.spriteGroup = new THREE.Group();
    this.root.add(this.spriteGroup);
  }

  /**
   * Rebuild the structural meshes if the level's `CellKind` grid has changed
   * since the last call. Returns `true` when a rebuild happened.
   */
  refresh(level: LevelView): boolean {
    const hash = hashKinds(level);
    if (hash === this.structHash) return false;
    this.structHash = hash;
    this.rebuild(level);
    return true;
  }

  /**
   * Replace the sprite group's children with one billboard per `Sprite`.
   * Sprites are placed with their feet at `y = 0` and their centre at the
   * cell centre; the `materialFor` callback supplies the (cached) sprite
   * material — the default returns a plain-coloured material with no map,
   * which is enough for the node tests.
   */
  updateSprites(
    sprites: readonly Sprite[],
    materialFor: (s: Sprite) => THREE.SpriteMaterial = defaultSpriteMaterial,
  ): THREE.Sprite[] {
    const keep = new Set<string>();
    const out: THREE.Sprite[] = [];
    for (const s of sprites) {
      const key = spriteKey(s);
      keep.add(key);
      let mesh = this.spriteCache.get(key);
      if (mesh === undefined) {
        mesh = new THREE.Sprite(materialFor(s));
        this.spriteCache.set(key, mesh);
        this.spriteGroup.add(mesh);
      }
      const h = s.height ?? 0.7;
      mesh.scale.set(h, h, 1);
      mesh.position.set(s.x + 0.5, h / 2, s.y + 0.5);
      out.push(mesh);
    }
    // Drop sprites for cells that no longer host a glyph.
    for (const [key, mesh] of this.spriteCache) {
      if (keep.has(key)) continue;
      this.spriteGroup.remove(mesh);
      mesh.material.dispose();
      this.spriteCache.delete(key);
    }
    return out;
  }

  /** Free every GPU-side resource held by the builder. */
  dispose(): void {
    for (const m of [this.wallMesh, this.floorMesh, this.doorMesh, this.postMesh, this.stairMesh]) {
      if (m !== null) this.disposeMesh(m);
    }
    for (const sp of this.spriteCache.values()) sp.material.dispose();
    this.spriteCache.clear();
    for (const mat of Object.values(this.materials)) mat.dispose();
  }

  private rebuild(level: LevelView): void {
    const counts = countKinds(level);
    this.counts = {
      walls: counts.walls,
      floors: counts.floors,
      doorBoxes: counts.doorBoxes,
      doorPosts: counts.doorPosts * 2,
      stairs: counts.stairs,
    };
    this.wallMesh = this.reallocMesh(this.wallMesh, CUBE_GEOM, this.materials.wall, counts.walls);
    this.floorMesh = this.reallocMesh(this.floorMesh, FLOOR_GEOM, this.materials.floor, counts.floors);
    this.doorMesh = this.reallocMesh(this.doorMesh, DOOR_GEOM, this.materials.door, counts.doorBoxes);
    this.postMesh = this.reallocMesh(this.postMesh, POST_GEOM, this.materials.post, counts.doorPosts * 2);
    this.stairMesh = this.reallocMesh(this.stairMesh, STAIR_GEOM, this.materials.stair, counts.stairs);

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    let iw = 0, ifl = 0, id = 0, ip = 0, is = 0;
    for (let y = 0; y < level.height; y++) {
      for (let x = 0; x < level.width; x++) {
        const k = level.kindAt(x, y);
        if (k === 'unexplored') continue;
        const cx = x + 0.5;
        const cz = y + 0.5;
        if (k === 'door_closed') {
          const axis = doorAxis(level, x, y);
          const rotY = axis === 'ns' ? Math.PI / 2 : 0;
          q.setFromAxisAngle(UP, rotY);
          m.compose(new THREE.Vector3(cx, 0.5, cz), q, ONE_SCALE);
          this.doorMesh!.setMatrixAt(id++, m);
          continue;
        }
        if (k === 'door_open' || k === 'doorway') {
          floorMatrix(m, cx, cz);
          this.floorMesh!.setMatrixAt(ifl++, m);
          const axis = doorAxis(level, x, y);
          const posts = postPositions(cx, cz, axis);
          for (const p of posts) {
            m.compose(p, IDENT_Q, ONE_SCALE);
            this.postMesh!.setMatrixAt(ip++, m);
          }
          continue;
        }
        if (isSolid(k)) {
          m.compose(new THREE.Vector3(cx, 0.5, cz), IDENT_Q, ONE_SCALE);
          this.wallMesh!.setMatrixAt(iw++, m);
          continue;
        }
        floorMatrix(m, cx, cz);
        this.floorMesh!.setMatrixAt(ifl++, m);
        if (k === 'stairs_up' || k === 'stairs_down') {
          floorMatrix(m, cx, cz, 0.02);
          this.stairMesh!.setMatrixAt(is++, m);
        }
      }
    }
    for (const mesh of [this.wallMesh, this.floorMesh, this.doorMesh, this.postMesh, this.stairMesh]) {
      if (mesh !== null && mesh.instanceMatrix) mesh.instanceMatrix.needsUpdate = true;
    }
  }

  private reallocMesh(
    prev: THREE.InstancedMesh | null,
    geom: THREE.BufferGeometry,
    mat: THREE.Material,
    count: number,
  ): THREE.InstancedMesh | null {
    if (prev !== null) this.disposeMesh(prev);
    if (count === 0) return null;
    const mesh = new THREE.InstancedMesh(geom, mat, count);
    mesh.frustumCulled = false;
    this.root.add(mesh);
    return mesh;
  }

  private disposeMesh(mesh: THREE.InstancedMesh): void {
    this.root.remove(mesh);
    mesh.dispose();
  }
}

/** Unit-quaternion (no rotation) reused for the many instances that need one. */
const IDENT_Q = new THREE.Quaternion();
/** Unit scale (1, 1, 1) reused for the many instances that need one. */
const ONE_SCALE = new THREE.Vector3(1, 1, 1);
/** Up axis used to build the doorframe rotation. */
const UP = new THREE.Vector3(0, 1, 0);

/** Compose a floor-quad matrix at (cx, cz), optionally offset in y. */
function floorMatrix(m: THREE.Matrix4, cx: number, cz: number, yOffset = 0): void {
  m.compose(new THREE.Vector3(cx, yOffset, cz), IDENT_Q, ONE_SCALE);
}

/** Default sprite material — plain colour, no texture — enough for tests. */
function defaultSpriteMaterial(s: Sprite): THREE.SpriteMaterial {
  const [r, g, b] = s.rgb;
  return new THREE.SpriteMaterial({ color: new THREE.Color(r, g, b) });
}

/**
 * Key for the sprite cache: cell coordinates + glyph. Two glyphs on the same
 * cell (only during a transient stack) collide; the cache re-uses the mesh.
 */
function spriteKey(s: Sprite): string {
  return `${s.x},${s.y}:${s.ch}`;
}

/**
 * Choose the axis of a door cell: `ew` when its east/west neighbours are
 * walls (people walk east-west), `ns` when its north/south neighbours are.
 * Defaults to `ew` when neither pair is a wall (isolated door).
 */
function doorAxis(level: LevelView, x: number, y: number): 'ew' | 'ns' {
  const wallAt = (px: number, py: number): boolean => {
    const k = level.kindAt(px, py);
    return k === 'wall' || k === 'stone';
  };
  if (wallAt(x, y - 1) && wallAt(x, y + 1)) return 'ew';
  if (wallAt(x - 1, y) && wallAt(x + 1, y)) return 'ns';
  return 'ew';
}

/**
 * The two post positions for a door of the given axis, indented 0.1 inside
 * the cell so a wide-angle camera does not clip through the corner.
 */
function postPositions(cx: number, cz: number, axis: 'ew' | 'ns'): THREE.Vector3[] {
  if (axis === 'ew') {
    return [
      new THREE.Vector3(cx, 0.5, cz - 0.4),
      new THREE.Vector3(cx, 0.5, cz + 0.4),
    ];
  }
  return [
    new THREE.Vector3(cx - 0.4, 0.5, cz),
    new THREE.Vector3(cx + 0.4, 0.5, cz),
  ];
}

/** Count the drawable cells by structural kind (used to size each mesh). */
function countKinds(level: LevelView): CellCounts {
  const c: CellCounts = { walls: 0, floors: 0, doorBoxes: 0, doorPosts: 0, stairs: 0 };
  for (let y = 0; y < level.height; y++) {
    for (let x = 0; x < level.width; x++) {
      const k = level.kindAt(x, y);
      if (k === 'unexplored') continue;
      if (k === 'door_closed') {
        c.doorBoxes++;
        continue;
      }
      if (k === 'door_open' || k === 'doorway') {
        c.floors++;
        c.doorPosts++;
        continue;
      }
      if (isSolid(k)) {
        c.walls++;
        continue;
      }
      c.floors++;
      if (k === 'stairs_up' || k === 'stairs_down') c.stairs++;
    }
  }
  return c;
}
