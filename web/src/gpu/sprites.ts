/**
 * Sprite billboards for the GPU render path (T-0042, docs/gpu-sprites.md).
 * The ported afterburn stack lights a voxel dungeon, but monsters, items and
 * the hero live in `Sprite[]` — hand-building a voxel model for each of
 * NetHack's ~400 monsters is a different project. Instead we hand each sprite
 * a camera-facing quad that carries its 16×16 tile art (or a plain fill when
 * no tile is available) through a `MeshStandardNodeMaterial`, so the same
 * lighting stack that draws the walls also draws the goblins.
 *
 * Contract (docs/gpu.md §5, ticket T-0042):
 * - **Billboard about Y only** — yaw toward the camera every frame, never
 *   pitch. A monster stays standing when the (future) ortho camera looks down
 *   at it.
 * - **Alpha-tested, not blended** — `alphaTest = 0.5`, `transparent = false`,
 *   `depthWrite = true`. Sprites write depth so SSR reflects them in the wet
 *   floor and SSGI's bounce off them contributes to nearby cells.
 * - **Stand on the floor at the cell centre** — height from `sprite.height ??
 *   0.7`, width from the tile's aspect (square 1:1 for the 16×16 art).
 * - **Cache textures and materials per tile key** — the T-0031 lesson: rebuild
 *   a `DataTexture` per frame and you lose ~20 ms to a driver upload storm.
 * - **Small emissive for classes that glow** — zap, explosion, warning,
 *   swallow read as luminous.
 *
 * Pure enough for node tests: `three/webgpu` classes construct without a
 * renderer, and `DataTexture` needs no `document`. `tests/gpu-sprites.test.ts`
 * exercises this without a browser.
 */

import {
  Color,
  DataTexture,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardNodeMaterial,
  NearestFilter,
  PlaneGeometry,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
} from 'three/webgpu';
import type { Camera, Material, Object3D } from 'three/webgpu';
import { float, texture as textureNode, uniform, vec3 } from 'three/tsl';
import type { GlyphClass, Pose, Sprite, Tile } from '../../../src/model/types.js';
import { POSE_SMOOTH_CELL_SECONDS, POSE_SNAP_CELLS, poseSmoothingFactor } from '../../../src/ui/view3d.js';
import { applyAvatarFacing, createHeroAvatar, createPetAvatar } from './avatar.js';

/** Fallback height for sprites without a `height` field (cells). */
const DEFAULT_HEIGHT = 0.7;
/** Alpha threshold applied to the tile texture; palette-index 0 is fully transparent so 0.5 cuts a hard silhouette. */
const SPRITE_ALPHA_TEST = 0.5;
/** Material roughness — the ticket's value; the tile art is not a shiny mirror. */
const SPRITE_ROUGHNESS = 0.85;
/** Emissive multiplier applied to glowing classes (zap, explosion, warning, swallow). */
const GLOW_EMISSIVE = 0.9;

/** Unit plane (normal +Z, centred). One shared geometry per layer instance. */
function makeSpriteGeometry(): PlaneGeometry {
  return new PlaneGeometry(1, 1);
}

/** Classes that read as luminous — the material earns a small emissive. */
const GLOW_CLASSES: ReadonlySet<GlyphClass> = new Set<GlyphClass>([
  'zap', 'explosion', 'warning', 'swallow',
]);

/** Options for `new SpriteLayer(...)`. */
export interface SpriteLayerOptions {
  /**
   * If given, the hero (`ch === '@'`) and pet (`cls === 'pet'`) sprites are
   * rendered as voxel avatars sharing this material (T-0056, docs/gpu-avatar.md)
   * instead of camera-facing quads. Omit it and every sprite is a billboard,
   * as on the legacy path.
   */
  voxelMaterial?: Material;
}

/** One previous-frame eased position, used to match sprites frame-to-frame. */
interface EasedEntry {
  readonly ch: string;
  readonly cls: GlyphClass;
  x: number;
  y: number;
}

/**
 * Owns a pool of camera-facing quads under `root`, plus caches of
 * `DataTexture`s (per tile key) and `MeshStandardNodeMaterial`s (per tile +
 * tint + glow key). Attach `root` to the GPU scene, call `update(sprites,
 * camera)` every frame, `dispose()` to free every GPU resource.
 *
 * Given a `voxelMaterial`, the hero and pet sprites are routed to voxel
 * models (`createHeroAvatar` / `createPetAvatar`) instead. Each avatar object
 * is built the first time it is needed and reused on every subsequent frame —
 * only position and rotation change.
 *
 * ### Motion (T-0062, docs/gpu-thirdperson.md "Motion")
 *
 * The hero (`ch === '@'`) uses `pose.x`/`pose.y` — the smoothed hero world
 * position the viewport already glides one cell in
 * `POSE_SMOOTH_CELL_SECONDS`. Every other sprite (pet, monsters, items) gets
 * its own per-sprite ease with the same exponential shape: `SpriteLayer`
 * matches this frame's sprites to the previous frame's eased entries by
 * `(ch, cls)` and, within a class, nearest position; unmatched sprites are
 * new and placed directly at their target cell (no ease from an unrelated
 * neighbour). A jump larger than `POSE_SNAP_CELLS` snaps — a monster
 * teleporting across the room must not skate.
 */
export class SpriteLayer {
  readonly root: Group;
  private readonly geometry: PlaneGeometry;
  private readonly textureCache = new Map<string, DataTexture>();
  private readonly materialCache = new Map<string, MeshStandardNodeMaterial>();
  private readonly meshes = new Map<string, Mesh>();
  private readonly voxelMaterial: Material | undefined;
  private heroAvatar: Object3D | null = null;
  private petAvatar: Object3D | null = null;
  private heroInScene = false;
  private petInScene = false;
  private previousEased: EasedEntry[] = [];

  constructor(opts: SpriteLayerOptions = {}) {
    this.root = new Group();
    this.root.name = 'gpu-sprites';
    this.geometry = makeSpriteGeometry();
    this.voxelMaterial = opts.voxelMaterial;
  }

  /**
   * Reconcile the scene with `sprites`: reuse cached meshes/materials/textures
   * across frames, position each entry with feet on the floor and yaw it
   * toward `camera`, and drop meshes whose sprite no longer appears. When
   * constructed with a `voxelMaterial`, the hero (`ch === '@'`) and pet
   * (`cls === 'pet'`) become voxel avatars rotated about Y using `pose.yaw`
   * (radians, 0 = north — architecture.md §7); the pet borrows the hero's
   * facing because sprites carry no direction.
   *
   * `pose` (when given) also carries the **smoothed hero world position** —
   * the hero avatar/quad is drawn at `(pose.x, ., pose.y)` instead of its
   * integer cell centre, so it glides with the smoother the viewport is
   * already running (T-0060). Every other sprite eases toward its own cell
   * with the same shape (`dt` seconds of `1 − e^(−dt/τ)` at
   * `POSE_SMOOTH_CELL_SECONDS`), snapping on jumps > `POSE_SNAP_CELLS`.
   *
   * Returns the objects present after the call, in `sprites` order. Avatars'
   * roots are `Mesh`es at runtime (all boxes live in the "root" part), so
   * the declared `Mesh[]` return type reads correctly through the cast.
   */
  update(sprites: readonly Sprite[], camera: Camera, pose?: Pose, dt = 0): Mesh[] {
    const keep = new Set<string>();
    const out: Mesh[] = [];
    let heroSeen = false;
    let petSeen = false;
    const facing = pose?.yaw ?? 0;
    const nextEased: EasedEntry[] = [];
    const usedPrev = new Set<number>();
    for (const s of sprites) {
      const isHeroWithPose = s.ch === '@' && pose !== undefined;
      // Hero position comes from the outer smoother when `pose` is supplied;
      // no per-sprite ease so we do not double-smooth. Fall back to the
      // per-sprite ease when the caller has no smoothed pose to offer.
      const draw = isHeroWithPose
        ? { x: pose.x, y: pose.y }
        : this.easedFor(s, dt, nextEased, usedPrev);
      const drawX = draw.x;
      const drawY = draw.y;
      if (this.voxelMaterial !== undefined && s.ch === '@') {
        const obj = this.ensureHeroAvatar();
        obj.position.set(drawX, 0, drawY);
        applyAvatarFacing(obj, facing);
        heroSeen = true;
        out.push(obj as unknown as Mesh);
        continue;
      }
      if (this.voxelMaterial !== undefined && s.cls === 'pet') {
        const obj = this.ensurePetAvatar();
        obj.position.set(drawX, 0, drawY);
        applyAvatarFacing(obj, facing);
        petSeen = true;
        out.push(obj as unknown as Mesh);
        continue;
      }
      const key = spriteInstanceKey(s);
      keep.add(key);
      let mesh = this.meshes.get(key);
      if (mesh === undefined) {
        const material = this.materialFor(s);
        mesh = new Mesh(this.geometry, material);
        mesh.frustumCulled = false;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.name = `sprite:${key}`;
        this.meshes.set(key, mesh);
        this.root.add(mesh);
      }
      const height = s.height ?? DEFAULT_HEIGHT;
      const width = height * tileAspect(s.tile);
      mesh.scale.set(width, height, 1);
      mesh.position.set(drawX, height / 2, drawY);
      applyYawTowardsCamera(mesh, camera);
      out.push(mesh);
    }
    for (const [key, mesh] of this.meshes) {
      if (keep.has(key)) continue;
      this.root.remove(mesh);
      this.meshes.delete(key);
    }
    if (!heroSeen && this.heroInScene && this.heroAvatar !== null) {
      this.root.remove(this.heroAvatar);
      this.heroInScene = false;
    }
    if (!petSeen && this.petInScene && this.petAvatar !== null) {
      this.root.remove(this.petAvatar);
      this.petInScene = false;
    }
    this.previousEased = nextEased;
    return out;
  }

  /**
   * Ease `s` toward its cell centre using the shared exponential damper.
   * Matches into `previousEased` by `(ch, cls)` + nearest position so a
   * sprite that shifts one cell inherits its previous eased position;
   * unmatched (appearing) sprites and matches beyond `POSE_SNAP_CELLS` snap
   * to the target cell instead of skating. Records the resulting position in
   * `nextEased` so the following frame can match against it in turn.
   */
  private easedFor(
    s: Sprite,
    dt: number,
    nextEased: EasedEntry[],
    usedPrev: Set<number>,
  ): { x: number; y: number } {
    const targetX = s.x + 0.5;
    const targetY = s.y + 0.5;
    let bestIdx = -1;
    let bestDistSq = Infinity;
    for (let i = 0; i < this.previousEased.length; i++) {
      if (usedPrev.has(i)) continue;
      const p = this.previousEased[i]!;
      if (p.ch !== s.ch || p.cls !== s.cls) continue;
      const dx = p.x - targetX;
      const dy = p.y - targetY;
      const d = dx * dx + dy * dy;
      if (d < bestDistSq) {
        bestDistSq = d;
        bestIdx = i;
      }
    }
    let easedX = targetX;
    let easedY = targetY;
    if (bestIdx >= 0) {
      const p = this.previousEased[bestIdx]!;
      const snapSq = POSE_SNAP_CELLS * POSE_SNAP_CELLS;
      if (bestDistSq > snapSq) {
        // Big jump (teleport, level change, `<`/`>`) — snap instead of
        // skating across the map for a full time constant.
        easedX = targetX;
        easedY = targetY;
      } else {
        const k = poseSmoothingFactor(dt, POSE_SMOOTH_CELL_SECONDS);
        easedX = p.x + (targetX - p.x) * k;
        easedY = p.y + (targetY - p.y) * k;
      }
      usedPrev.add(bestIdx);
    }
    nextEased.push({ ch: s.ch, cls: s.cls, x: easedX, y: easedY });
    return { x: easedX, y: easedY };
  }

  /** Free every GPU-side resource: meshes, materials, textures, geometry. */
  dispose(): void {
    for (const mesh of this.meshes.values()) this.root.remove(mesh);
    this.meshes.clear();
    for (const mat of this.materialCache.values()) mat.dispose();
    this.materialCache.clear();
    for (const tex of this.textureCache.values()) tex.dispose();
    this.textureCache.clear();
    this.geometry.dispose();
    if (this.heroAvatar !== null) {
      this.root.remove(this.heroAvatar);
      this.heroAvatar = null;
      this.heroInScene = false;
    }
    if (this.petAvatar !== null) {
      this.root.remove(this.petAvatar);
      this.petAvatar = null;
      this.petInScene = false;
    }
  }

  private ensureHeroAvatar(): Object3D {
    if (this.heroAvatar === null) {
      this.heroAvatar = createHeroAvatar(this.voxelMaterial as Material);
    }
    if (!this.heroInScene) {
      this.root.add(this.heroAvatar);
      this.heroInScene = true;
    }
    return this.heroAvatar;
  }

  private ensurePetAvatar(): Object3D {
    if (this.petAvatar === null) {
      this.petAvatar = createPetAvatar(this.voxelMaterial as Material);
    }
    if (!this.petInScene) {
      this.root.add(this.petAvatar);
      this.petInScene = true;
    }
    return this.petAvatar;
  }

  private materialFor(s: Sprite): MeshStandardNodeMaterial {
    const tKey = tileTextureKey(s);
    const rKey = rgbKey(s.rgb);
    const gKey = GLOW_CLASSES.has(s.cls) ? 'g' : 'n';
    const key = `${tKey}#${rKey}#${gKey}`;
    const cached = this.materialCache.get(key);
    if (cached !== undefined) return cached;
    const tex = this.textureFor(s, tKey);
    const mat = buildSpriteMaterial(tex, s.rgb, GLOW_CLASSES.has(s.cls));
    this.materialCache.set(key, mat);
    return mat;
  }

  private textureFor(s: Sprite, key: string): DataTexture {
    const cached = this.textureCache.get(key);
    if (cached !== undefined) return cached;
    const tex = s.tile !== undefined ? tileToDataTexture(s.tile) : blankSpriteTexture();
    this.textureCache.set(key, tex);
    return tex;
  }
}

/** Aspect ratio (width / height) of the sprite's quad, from its tile. */
function tileAspect(tile: Tile | undefined): number {
  if (tile === undefined) return 1;
  if (tile.h === 0) return 1;
  return tile.w / tile.h;
}

/** Fixed key per sprite instance — cell + glyph identifies the pooled mesh. */
function spriteInstanceKey(s: Sprite): string {
  return `${s.x},${s.y}:${s.ch}`;
}

/** Deterministic hash of a tile's pixels + palette; two identical tiles share a texture. */
function tileTextureKey(s: Sprite): string {
  if (s.tile === undefined) return '@blank';
  let h = 0x811c9dc5 >>> 0;
  const pixels = s.tile.pixels;
  for (let i = 0; i < pixels.length; i++) {
    h ^= pixels[i]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // Palette-only differences must move the key too — two tiles with the same
  // indices but different colours are different textures.
  for (const entry of s.tile.palette) {
    h ^= entry[0];
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= entry[1];
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= entry[2];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `t:${s.tile.w}x${s.tile.h}#${h.toString(16)}`;
}

/** Quantised colour key so near-identical tints share one material. */
function rgbKey(rgb: readonly [number, number, number]): string {
  return `${rgb[0].toFixed(3)},${rgb[1].toFixed(3)},${rgb[2].toFixed(3)}`;
}

/** Rasterise a NetHack tile into a `DataTexture` (RGBA, nearest, sRGB). */
export function tileToDataTexture(tile: Tile): DataTexture {
  const w = tile.w;
  const h = tile.h;
  const data = new Uint8Array(w * h * 4);
  const flipped = new Uint8Array(w * h * 4);
  for (let i = 0; i < tile.pixels.length; i++) {
    const p = tile.pixels[i]!;
    const rgb = tile.palette[p] ?? [0, 0, 0];
    const o = i * 4;
    data[o] = rgb[0];
    data[o + 1] = rgb[1];
    data[o + 2] = rgb[2];
    // Palette index 0 is transparent; anything else is fully opaque so the
    // alphaTest cut leaves a hard, un-fringed silhouette.
    data[o + 3] = p === 0 ? 0 : 255;
  }
  // NetHack tiles are laid out row-major top-to-bottom, but `DataTexture`
  // treats index 0 as the bottom-left corner. Flip vertically so a monster's
  // head lands on top of its feet.
  for (let y = 0; y < h; y++) {
    const src = y * w * 4;
    const dst = (h - 1 - y) * w * 4;
    for (let i = 0; i < w * 4; i++) flipped[dst + i] = data[src + i]!;
  }
  const tex = new DataTexture(flipped, w, h, RGBAFormat, UnsignedByteType);
  tex.colorSpace = SRGBColorSpace;
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** Tiny 1×1 opaque-white fallback texture — the tint carries the whole look. */
function blankSpriteTexture(): DataTexture {
  const data = new Uint8Array([255, 255, 255, 255]);
  const tex = new DataTexture(data, 1, 1, RGBAFormat, UnsignedByteType);
  tex.colorSpace = SRGBColorSpace;
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** Assemble the sprite's node material: tile texture × tint, alpha-tested. */
function buildSpriteMaterial(
  tex: DataTexture,
  rgb: readonly [number, number, number],
  glow: boolean,
): MeshStandardNodeMaterial {
  const mat = new MeshStandardNodeMaterial();
  mat.name = 'sprite';
  mat.transparent = false;
  mat.alphaTest = SPRITE_ALPHA_TEST;
  mat.depthWrite = true;
  mat.side = DoubleSide;
  mat.roughness = SPRITE_ROUGHNESS;
  mat.metalness = 0;
  const sampled = textureNode(tex);
  const tint = uniform(new Color(rgb[0], rgb[1], rgb[2]));
  mat.colorNode = sampled.rgb.mul(tint);
  mat.opacityNode = sampled.a;
  if (glow) {
    mat.emissiveNode = vec3(tint.r, tint.g, tint.b).mul(sampled.rgb).mul(float(GLOW_EMISSIVE));
  }
  return mat;
}

/** Rotate `mesh` so its +Z face points at the camera in the XZ plane only. */
export function applyYawTowardsCamera(mesh: Mesh, camera: Camera): void {
  const dx = camera.position.x - mesh.position.x;
  const dz = camera.position.z - mesh.position.z;
  const yaw = dx === 0 && dz === 0 ? 0 : Math.atan2(dx, dz);
  mesh.rotation.set(0, yaw, 0, 'YXZ');
}
