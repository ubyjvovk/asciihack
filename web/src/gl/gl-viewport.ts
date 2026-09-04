/**
 * Browser WebGL viewport (T-0031, T-0032, docs/web.md "WebGL viewport").
 * Owns the canvas, the three.js renderer/scene/cameras and the vendored
 * `StyleRenderer`; from `LevelView` + `Pose` + `Sprite[]` it renders the
 * dungeon through the active AsciiCity style (`amber` by default, `F5`
 * cycles). Two cameras share the scene: a `PerspectiveCamera` for the
 * first-person view and an `OrthographicCamera` for the 3/4 overhead
 * "Diablo/Fallout" view. `setView('fps' | 'ortho')` switches between them.
 *
 * The canvas is absolutely positioned; `resize(cols, rows, cellW, cellH)`
 * moves it under the DOM terminal's viewport rectangle (message line at
 * row 0 + two status rows at the bottom are excluded — that leaves rows 1
 * … height − 3 for the 3D view). In fps the hero cell centre becomes the
 * camera origin at eye height 0.5; the `Pose.yaw` (0 = north, +π/2 = east)
 * is translated to a three.js yaw around the up axis by negating (three's
 * default forward is −z ≈ north). In ortho `placeOrthoCamera` positions
 * the camera NW-above the hero and any wall within 2 cells in front of the
 * hero is swapped for a translucent ghost cube so the hero stays visible.
 *
 * Browser-only: uses `document`/`window` and constructs a `WebGLRenderer`.
 * The pure geometry work lives in `scene-builder.ts` and the ortho maths
 * lives in `ortho-camera.ts` (both unit-tested in node).
 */
import * as THREE from 'three';
import { isSolid, type LevelView, type Pose, type Sprite, type Tile } from '../../../src/model/types.js';
import { makeCamera, makeRenderer, makeScene } from '../asciicity/render/scene.js';
import { StyleRenderer } from '../asciicity/render/post.js';
import { STYLES } from '../asciicity/render/styles/index.js';
import { STYLE_ORDER, type RenderStyle } from '../asciicity/render/style.js';
import {
  SceneBuilder,
  type SceneMaterials,
} from './scene-builder.js';
import { cutawayCellsFor, placeOrthoCamera } from './ortho-camera.js';

/** Distance in cells the hero's lantern reaches before falling to black. */
export const LANTERN_DISTANCE = 14;
/** Lantern intensity — the AsciiCity style shaders need bright surfaces to
 *  thin out; a dim scene is invisible after the black-point cut (T-0031 r2). */
export const LANTERN_INTENSITY = 12;
/** Camera eye height above the floor, in cells. */
export const EYE_HEIGHT = 0.5;
/** Horizon offset approximated by pitching the camera slightly down (T-0023). */
export const CAMERA_PITCH = -0.08;

/** Options accepted by `GlViewport`. */
export interface GlViewportOptions {
  /** Element the canvas is appended to (default `document.body`). */
  parent?: HTMLElement;
  /** Style id activated on start (default `amber`; unknown → `ascii`). */
  initialStyle?: string;
}

/**
 * The AsciiCity-shaded WebGL viewport for the browser fps/ortho modes.
 * Only `render` runs per frame; `resize` and `setStyle` are event-driven.
 */
export class GlViewport {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly orthoCamera: THREE.OrthographicCamera;
  readonly style: StyleRenderer;
  readonly builder: SceneBuilder;
  private readonly lantern: THREE.PointLight;
  private readonly materials: SceneMaterials;
  private readonly cutawayMaterial: THREE.MeshLambertMaterial;
  private readonly cutawayGeom: THREE.BoxGeometry;
  private readonly textureCache = new Map<string, THREE.Texture>();
  private readonly spriteMatCache = new Map<string, THREE.SpriteMaterial>();
  private atGlyphTexture: THREE.Texture | null = null;
  private wallCellOrder: Array<{ x: number; y: number }> = [];
  private cutawayMesh: THREE.InstancedMesh | null = null;
  private lastCutawayKey = '';
  private view: 'fps' | 'ortho' = 'fps';
  private cols = 80;
  private rows = 24;
  private cellW = 9;
  private cellH = 18;

  constructor(opts: GlViewportOptions = {}) {
    const parent = opts.parent ?? document.body;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'gl-viewport';
    parent.appendChild(this.canvas);

    this.renderer = makeRenderer(this.canvas);
    this.renderer.setClearColor(0x000000, 1);

    this.scene = makeScene();
    // Override AsciiCity's outdoor scene with a dungeon look bright enough
    // for the style shaders to thin out (T-0031 r2 numbers).
    this.scene.background = new THREE.Color(0x000000);
    this.scene.fog = new THREE.FogExp2(0x000000, 0.10);
    // Drop the outdoor directional/hemisphere lights; keep a bright ambient
    // so nothing is pitch-black outside the lantern's cone.
    for (const child of [...this.scene.children]) {
      if (child instanceof THREE.DirectionalLight || child instanceof THREE.HemisphereLight) {
        this.scene.remove(child);
      } else if (child instanceof THREE.AmbientLight) {
        child.color = new THREE.Color(0xffffff);
        child.intensity = 0.35;
      }
    }
    this.materials = buildDungeonMaterials();
    // Cutaway ghost: same brick + tint as the opaque wall, but translucent.
    // `depthWrite: false` keeps the hero/monster overlay behind it from being
    // occluded when the ghost cube's own back faces render.
    this.cutawayMaterial = new THREE.MeshLambertMaterial({
      map: (this.materials.wall as THREE.MeshLambertMaterial).map,
      color: 0x9a9a9e,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    });
    this.cutawayGeom = new THREE.BoxGeometry(1, 1, 1);
    this.builder = new SceneBuilder(this.materials);
    this.scene.add(this.builder.root);

    this.camera = makeCamera(1);
    this.camera.near = 0.05;
    this.camera.far = 60;
    this.camera.updateProjectionMatrix();
    this.lantern = new THREE.PointLight(0xffe0a8, LANTERN_INTENSITY, LANTERN_DISTANCE, 1);
    this.camera.add(this.lantern);
    this.scene.add(this.camera);

    // Ortho camera lives alongside the perspective one; `placeOrthoCamera`
    // rewrites its frustum every ortho frame. The scene contains both.
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    this.scene.add(this.orthoCamera);

    this.style = new StyleRenderer(this.renderer, STYLES, {
      initial: opts.initialStyle ?? 'amber',
    });
  }

  /** Move the canvas under the DOM terminal's viewport rectangle, in CSS pixels. */
  place(leftPx: number, topPx: number, widthPx: number, heightPx: number): void {
    const style = this.canvas.style;
    style.position = 'absolute';
    style.left = `${leftPx}px`;
    style.top = `${topPx}px`;
    style.width = `${widthPx}px`;
    style.height = `${heightPx}px`;
    style.zIndex = '0';
    style.pointerEvents = 'none';
  }

  /**
   * Set the viewport cell grid: `cols × rows` cells, each `cellW × cellH`
   * CSS pixels. Recomputes the camera aspect + FOV to match, and reallocates
   * the low-res style target only when the cell grid changed.
   */
  resize(cols: number, rows: number, cellW: number, cellH: number): void {
    if (cols <= 0 || rows <= 0) return;
    this.cols = cols;
    this.rows = rows;
    this.cellW = cellW;
    this.cellH = cellH;
    const w = cols * cellW;
    const h = rows * cellH;
    this.style.setSize(w, h);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  /** Activate a style by id (returns `false` when unknown). */
  setStyle(id: string): boolean {
    return this.style.setStyle(id);
  }

  /** Switch between first-person and 3/4 overhead ortho cameras. */
  setView(view: 'fps' | 'ortho'): void {
    if (this.view === view) return;
    this.view = view;
    // Force `applyCutaway` to re-evaluate on the next frame in either
    // direction (entering ortho enables ghosts; leaving restores the walls).
    this.lastCutawayKey = '';
  }

  /** Which camera the next `render` call will use. */
  get currentView(): 'fps' | 'ortho' {
    return this.view;
  }

  /** Cycle through `STYLE_ORDER` (positive = next, negative = previous). */
  cycleStyle(step = 1): RenderStyle {
    return this.style.next(step);
  }

  /** All available style ids, in cycle order. */
  get styleIds(): readonly string[] {
    return STYLE_ORDER;
  }

  /** The currently active style id. */
  get activeStyle(): string {
    return this.style.style.id;
  }

  /**
   * Render one frame: rebuild the level geometry if the level view changed,
   * refresh the sprite billboards, position the active camera (perspective
   * for `fps`, orthographic for `ortho`), apply the cutaway ghost walls when
   * in ortho, then let the `StyleRenderer` render through the fragment
   * shader. `pose` carries the hero cell centre in both modes (`vFovDeg` is
   * unused in ortho — the frustum is derived from the viewport rectangle).
   */
  render(level: LevelView, pose: Pose, sprites: readonly Sprite[], vFovDeg: number): void {
    if (this.builder.refresh(level)) {
      this.wallCellOrder = collectWallCells(level);
      // Wall mesh was reallocated: invalidate the cutaway memo so we re-hide
      // the right instances on this frame.
      this.lastCutawayKey = '';
    }
    this.builder.updateSprites(sprites, (s) => this.spriteMaterialFor(s));
    // Keep the perspective camera at the hero cell in both views so the
    // lantern light (child of `camera`) stays anchored to the hero even
    // when the ortho camera is doing the rendering.
    this.camera.position.set(pose.x, EYE_HEIGHT, pose.y);
    this.camera.rotation.set(CAMERA_PITCH, -pose.yaw, 0, 'YXZ');
    if (this.camera.fov !== vFovDeg) {
      this.camera.fov = vFovDeg;
      this.camera.updateProjectionMatrix();
    }
    const heroCell = { x: Math.floor(pose.x), y: Math.floor(pose.y) };
    if (this.view === 'ortho') {
      this.applyCutaway(heroCell);
      placeOrthoCamera(this.orthoCamera, heroCell, this.cols, this.rows, 2);
      this.style.render(this.scene, this.orthoCamera);
    } else {
      this.applyCutaway(null);
      this.style.render(this.scene, this.camera);
    }
  }

  /** Free every GPU resource the viewport owns. */
  dispose(): void {
    this.style.dispose();
    this.builder.dispose();
    if (this.cutawayMesh !== null) {
      this.scene.remove(this.cutawayMesh);
      this.cutawayMesh.dispose();
      this.cutawayMesh = null;
    }
    this.cutawayMaterial.dispose();
    this.cutawayGeom.dispose();
    if (this.atGlyphTexture !== null) this.atGlyphTexture.dispose();
    for (const tex of this.textureCache.values()) tex.dispose();
    for (const mat of this.spriteMatCache.values()) mat.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }

  /** Locate the SceneBuilder's wall `InstancedMesh` inside `builder.root`. */
  private findWallMesh(): THREE.InstancedMesh | null {
    for (const child of this.builder.root.children) {
      if (child instanceof THREE.InstancedMesh && child.material === this.materials.wall) {
        return child;
      }
    }
    return null;
  }

  /**
   * Hide wall instances inside the cutaway box in front of `hero` and mirror
   * them into `cutawayMesh` (a separate, translucent InstancedMesh). Passing
   * `hero = null` restores every wall to opaque and drops the ghost mesh. The
   * key memoises on hero cell + wall count so we only touch the meshes when
   * something actually changed (cheap: `render` calls this every frame).
   */
  private applyCutaway(hero: { x: number; y: number } | null): void {
    const key = hero === null
      ? `none#${this.wallCellOrder.length}`
      : `${hero.x},${hero.y}#${this.wallCellOrder.length}`;
    if (key === this.lastCutawayKey) return;
    this.lastCutawayKey = key;

    const cutaway = hero === null ? EMPTY_STRING_SET : cutawayCellsFor(hero);
    const wallMesh = this.findWallMesh();
    const m = new THREE.Matrix4();
    const zeroScale = new THREE.Vector3(0, 0, 0);
    const oneScale = new THREE.Vector3(1, 1, 1);
    const q = new THREE.Quaternion();
    const ghostCells: Array<{ x: number; y: number }> = [];

    if (wallMesh !== null) {
      for (let i = 0; i < this.wallCellOrder.length; i++) {
        const c = this.wallCellOrder[i]!;
        const centre = new THREE.Vector3(c.x + 0.5, 0.5, c.y + 0.5);
        if (cutaway.has(`${c.x},${c.y}`)) {
          m.compose(centre, q, zeroScale); // collapse the cube: invisible
          ghostCells.push(c);
        } else {
          m.compose(centre, q, oneScale);
        }
        wallMesh.setMatrixAt(i, m);
      }
      if (wallMesh.instanceMatrix) wallMesh.instanceMatrix.needsUpdate = true;
    }

    if (this.cutawayMesh !== null) {
      this.scene.remove(this.cutawayMesh);
      this.cutawayMesh.dispose();
      this.cutawayMesh = null;
    }
    if (ghostCells.length > 0) {
      const mesh = new THREE.InstancedMesh(this.cutawayGeom, this.cutawayMaterial, ghostCells.length);
      mesh.frustumCulled = false;
      for (let i = 0; i < ghostCells.length; i++) {
        const c = ghostCells[i]!;
        m.compose(new THREE.Vector3(c.x + 0.5, 0.5, c.y + 0.5), q, oneScale);
        mesh.setMatrixAt(i, m);
      }
      this.scene.add(mesh);
      this.cutawayMesh = mesh;
    }
  }

  private spriteMaterialFor(s: Sprite): THREE.SpriteMaterial {
    // Sprites with no tile art get a generated `@` canvas texture for the
    // hero fallback (T-0032): tiles.json does not carry the player-role
    // artwork on every build, and an untextured coloured square reads badly
    // in the ortho view. Other tile-less sprites keep the plain-colour look.
    const wantAt = s.tile === undefined && s.ch === '@';
    const tileHash = s.tile ? tileKey(s.tile) : wantAt ? '@' : '';
    const key = `${tileHash}#${s.rgb.join(',')}`;
    const cached = this.spriteMatCache.get(key);
    if (cached !== undefined) return cached;
    // Build the tile texture *before* the material so the map is set at
    // construction — assigning `.map` post-hoc can trip a re-upload path on
    // some drivers when the placeholder was already committed.
    let map: THREE.Texture | undefined;
    if (s.tile) {
      const cachedTex = this.textureCache.get(tileHash);
      if (cachedTex !== undefined) {
        map = cachedTex;
      } else {
        map = tileToTexture(s.tile);
        this.textureCache.set(tileHash, map);
      }
    } else if (wantAt) {
      map = this.ensureAtGlyphTexture();
    }
    const mat = new THREE.SpriteMaterial({
      color: new THREE.Color(s.rgb[0], s.rgb[1], s.rgb[2]),
      transparent: true,
      map,
    });
    this.spriteMatCache.set(key, mat);
    return mat;
  }

  /** Lazy-build the shared `@` glyph texture used as the hero sprite's map. */
  private ensureAtGlyphTexture(): THREE.Texture {
    if (this.atGlyphTexture !== null) return this.atGlyphTexture;
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('gl-viewport: 2d context unavailable');
    ctx.clearRect(0, 0, 32, 32);
    ctx.fillStyle = 'white';
    ctx.font = 'bold 28px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('@', 16, 18);
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    this.atGlyphTexture = tex;
    return tex;
  }
}

/** An empty string set, reused as the "no cutaway" sentinel in `applyCutaway`. */
const EMPTY_STRING_SET: ReadonlySet<string> = new Set();

/** Collect wall cells in the same row-major order `SceneBuilder` uses so we
 *  can address individual instances of its wall `InstancedMesh` (non-door
 *  solid cells, `unexplored` skipped). */
function collectWallCells(level: LevelView): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < level.height; y++) {
    for (let x = 0; x < level.width; x++) {
      const k = level.kindAt(x, y);
      if (k === 'unexplored') continue;
      if (k === 'door_closed') continue;
      if (k === 'door_open' || k === 'doorway') continue;
      if (isSolid(k)) out.push({ x, y });
    }
  }
  return out;
}

/** Deterministic key so two identical tiles share one cached texture. */
function tileKey(t: Tile): string {
  // Hash by pixel content — palette-only differences also matter.
  let h = 0x811c9dc5;
  for (let i = 0; i < t.pixels.length; i++) {
    h ^= t.pixels[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return `${t.w}x${t.h}#${h >>> 0}`;
}

/** Rasterise a NetHack 16×16 tile into a nearest-filtered canvas texture. */
function tileToTexture(tile: Tile): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = tile.w;
  canvas.height = tile.h;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('gl-viewport: 2d context unavailable');
  const img = ctx.createImageData(tile.w, tile.h);
  for (let i = 0; i < tile.pixels.length; i++) {
    const p = tile.pixels[i]!;
    const rgb = tile.palette[p] ?? [0, 0, 0];
    const o = i * 4;
    img.data[o] = rgb[0];
    img.data[o + 1] = rgb[1];
    img.data[o + 2] = rgb[2];
    img.data[o + 3] = p === 0 ? 0 : 255; // palette index 0 = transparent
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

/** Build the textured Lambert materials used by the dungeon meshes. */
function buildDungeonMaterials(): SceneMaterials {
  return {
    wall: new THREE.MeshLambertMaterial({ map: brickTexture(), color: 0x9a9a9e }),
    floor: new THREE.MeshLambertMaterial({ map: flagstoneTexture(), color: 0x6a6a70 }),
    door: new THREE.MeshLambertMaterial({ map: doorTexture(), color: 0x8a6a3a }),
    post: new THREE.MeshLambertMaterial({ color: 0x8a6a3a }),
    stair: new THREE.MeshLambertMaterial({ color: 0xd0a040, emissive: 0x603818 }),
  };
}

/** 64×64 procedural brick pattern with mortar lines. */
function brickTexture(): THREE.Texture {
  return proceduralTexture(64, 64, (ctx) => {
    ctx.fillStyle = '#3a3a3a';
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = '#585552';
    const rowH = 8;
    for (let ry = 0, row = 0; ry < 64; ry += rowH, row++) {
      const offset = (row % 2 === 0) ? 0 : 8;
      for (let rx = -8; rx < 72; rx += 16) {
        ctx.fillRect(rx + offset + 1, ry + 1, 14, rowH - 2);
      }
    }
    ctx.fillStyle = '#1a1a1a';
    for (let n = 0; n < 40; n++) {
      const x = Math.floor(Math.random() * 64);
      const y = Math.floor(Math.random() * 64);
      ctx.fillRect(x, y, 1, 1);
    }
  });
}

/** 64×64 flagstone floor pattern: irregular stones separated by dark seams. */
function flagstoneTexture(): THREE.Texture {
  return proceduralTexture(64, 64, (ctx) => {
    ctx.fillStyle = '#232323';
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = '#333331';
    const cells: Array<[number, number, number, number]> = [
      [1, 1, 20, 24], [23, 1, 18, 18], [43, 1, 20, 26],
      [1, 27, 24, 20], [27, 21, 22, 24], [51, 29, 12, 20],
      [1, 49, 18, 14], [21, 47, 20, 16], [43, 51, 20, 12],
    ];
    for (const [x, y, w, h] of cells) ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#141414';
    for (let n = 0; n < 30; n++) {
      const x = Math.floor(Math.random() * 64);
      const y = Math.floor(Math.random() * 64);
      ctx.fillRect(x, y, 1, 1);
    }
  });
}

/** 64×64 door texture: vertical planks with faint hinges. */
function doorTexture(): THREE.Texture {
  return proceduralTexture(64, 64, (ctx) => {
    ctx.fillStyle = '#4a2c10';
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = '#7a4c1a';
    for (let x = 4; x < 64; x += 12) ctx.fillRect(x, 2, 8, 60);
    ctx.fillStyle = '#242424';
    ctx.fillRect(2, 12, 4, 6);
    ctx.fillRect(2, 46, 4, 6);
  });
}

/** Small helper that produces a repeat-clamped canvas texture. */
function proceduralTexture(w: number, h: number, paint: (ctx: CanvasRenderingContext2D) => void): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('gl-viewport: 2d context unavailable');
  paint(ctx);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}
