/**
 * Browser WebGL viewport (T-0031, docs/web.md "WebGL viewport"). Owns the
 * canvas, the three.js renderer/scene/camera and the vendored
 * `StyleRenderer`; from `LevelView` + `Pose` + `Sprite[]` it renders the
 * dungeon through the active AsciiCity style (`amber` by default, `F5`
 * cycles).
 *
 * The canvas is absolutely positioned; `resize(cols, rows, cellW, cellH)`
 * moves it under the DOM terminal's viewport rectangle (message line at
 * row 0 + two status rows at the bottom are excluded — that leaves rows 1
 * … height − 3 for the 3D view). The hero cell centre becomes the camera
 * origin at eye height 0.5; the `Pose.yaw` (0 = north, +π/2 = east) is
 * translated to a three.js yaw around the up axis by negating (three's
 * default forward is −z ≈ north).
 *
 * Browser-only: uses `document`/`window` and constructs a `WebGLRenderer`.
 * The pure geometry work lives in `scene-builder.ts` (unit-tested in node).
 */
import * as THREE from 'three';
import type { LevelView, Pose, Sprite, Tile } from '../../../src/model/types.js';
import { makeCamera, makeRenderer, makeScene } from '../asciicity/render/scene.js';
import { StyleRenderer } from '../asciicity/render/post.js';
import { STYLES } from '../asciicity/render/styles/index.js';
import { STYLE_ORDER, type RenderStyle } from '../asciicity/render/style.js';
import {
  SceneBuilder,
  type SceneMaterials,
} from './scene-builder.js';

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
  readonly style: StyleRenderer;
  readonly builder: SceneBuilder;
  private readonly lantern: THREE.PointLight;
  private readonly materials: SceneMaterials;
  private readonly textureCache = new Map<string, THREE.Texture>();
  private readonly spriteMatCache = new Map<string, THREE.SpriteMaterial>();
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
    this.builder = new SceneBuilder(this.materials);
    this.scene.add(this.builder.root);

    this.camera = makeCamera(1);
    this.camera.near = 0.05;
    this.camera.far = 60;
    this.camera.updateProjectionMatrix();
    this.lantern = new THREE.PointLight(0xffe0a8, LANTERN_INTENSITY, LANTERN_DISTANCE, 1);
    this.camera.add(this.lantern);
    this.scene.add(this.camera);

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
   * refresh the sprite billboards, move the camera to (hero, yaw), then let
   * the `StyleRenderer` render the scene through the active fragment shader.
   */
  render(level: LevelView, pose: Pose, sprites: readonly Sprite[], vFovDeg: number): void {
    this.builder.refresh(level);
    this.builder.updateSprites(sprites, (s) => this.spriteMaterialFor(s));
    this.camera.position.set(pose.x, EYE_HEIGHT, pose.y);
    // Map yaw (0 = north = -z, +π/2 = east = +x) to three's Y-rotation.
    this.camera.rotation.set(CAMERA_PITCH, -pose.yaw, 0, 'YXZ');
    if (this.camera.fov !== vFovDeg) {
      this.camera.fov = vFovDeg;
      this.camera.updateProjectionMatrix();
    }
    this.style.render(this.scene, this.camera);
  }

  /** Free every GPU resource the viewport owns. */
  dispose(): void {
    this.style.dispose();
    this.builder.dispose();
    for (const tex of this.textureCache.values()) tex.dispose();
    for (const mat of this.spriteMatCache.values()) mat.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }

  private spriteMaterialFor(s: Sprite): THREE.SpriteMaterial {
    const tileHash = s.tile ? tileKey(s.tile) : '';
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
    }
    const mat = new THREE.SpriteMaterial({
      color: new THREE.Color(s.rgb[0], s.rgb[1], s.rgb[2]),
      transparent: true,
      map,
    });
    this.spriteMatCache.set(key, mat);
    return mat;
  }
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
