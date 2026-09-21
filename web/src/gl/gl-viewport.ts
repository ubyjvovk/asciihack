/**
 * Browser WebGL viewport (T-0031, T-0032, docs/web.md "WebGL viewport").
 * Owns the canvas, the three.js renderer/scene/cameras and the vendored
 * `StyleRenderer`; from `LevelView` + `Pose` + `Sprite[]` it renders the
 * dungeon through the active AsciiCity style (`amber` by default, `F5`
 * cycles). Two cameras share the scene: a `PerspectiveCamera` for the
 * first-person view and an `OrthographicCamera` for the 3/4 overhead
 * "Diablo/Fallout" view. `setView('fps' | 'ortho' | 'third')` switches
 * between them; `third` is afterburn's long-lens diorama follow (T-0052,
 * `docs/gpu-thirdperson.md`), reusing the perspective camera at a
 * behind-and-above pose.
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
import * as WG from 'three/webgpu';
import { isSolid, type LevelView, type Pose, type Sprite, type Tile } from '../../../src/model/types.js';
import {
  createPoseSmoother,
  POSE_SMOOTH_CELL_SECONDS,
  type PoseSmoother,
} from '../../../src/ui/view3d.js';
import { makeCamera, makeRenderer, makeScene } from '../asciicity/render/scene.js';
import { StyleRenderer } from '../asciicity/render/post.js';
import { STYLES } from '../asciicity/render/styles/index.js';
import { STYLE_ORDER, type RenderStyle } from '../asciicity/render/style.js';
import {
  SceneBuilder,
  type SceneMaterials,
} from './scene-builder.js';
import { cutawayCellsFor, HERO_SPRITE_HEIGHT, orthoPlacement, placeOrthoCamera, type OrthoPlacement } from './ortho-camera.js';
import { GpuCompositor } from '../gpu/compose.js';
import { DungeonScene } from '../gpu/dungeon.js';
import { CUTOUT, createVoxelMaterial, W } from '../gpu/materials.js';
import {
  CUTOUT_DEPTH_BIAS_CELLS,
  CUTOUT_SCREEN_FADE_MARGIN_PX,
  HERO_SILHOUETTE_WIDTH_CELLS,
  projectHeroForCutout,
  type CutoutFrame,
} from '../gpu/cutout.js';
import { Atmosphere, type MoodId } from '../gpu/moods.js';
import {
  applyOrthoPlacementTo,
  cutawayKey,
  FPS_FOG_DENSITY,
  moodFogDensityForView,
  orthoDofFocus,
  ORTHO_FOG_DENSITY,
  pipelineCameraForView,
} from '../gpu/ortho.js';
import { densityFogFactor, fog, uniform } from 'three/tsl';
import {
  clampQuality,
  createPipeline,
  type PipelineHandle,
  type QualityName,
  type RendererCaps,
} from '../gpu/pipeline.js';
import {
  backendFor,
  choosePath,
  gpuCanvasSize,
  moodFor,
  parseGpuQueryOptions,
  pipelineOptionsWithEnv,
  rawLook,
  styledLook,
  type BackendChoice,
  type GpuParam,
  type ViewportPath,
} from '../gpu/path.js';
import { SpriteLayer } from '../gpu/sprites.js';
import {
  clampThirdDist,
  dampPose,
  THIRD_DIST_DEFAULT_CELLS,
  THIRD_FOV_DEG,
  thirdPersonPose,
  wrapYawSteps,
  type DampState,
} from '../gpu/thirdperson.js';
import { createWeather, type WeatherHandle } from '../gpu/weather.js';
import { pickCellFromEvent, type Bounds, type Cell } from '../gpu/pick.js';

/** Distance in cells the hero's lantern reaches before falling to black. */
export const LANTERN_DISTANCE = 14;
/** Lantern intensity — the AsciiCity style shaders need bright surfaces to
 *  thin out; a dim scene is invisible after the black-point cut (T-0031 r2). */
export const LANTERN_INTENSITY = 12;
/** Camera eye height above the floor, in cells. */
export const EYE_HEIGHT = 0.5;
/** Horizon offset approximated by pitching the camera slightly down (T-0023). */
export const CAMERA_PITCH = -0.08;
// Fog densities now live in `web/src/gpu/ortho.ts` (T-0050 rework 3) so the
// ortho scaling helper can reference them without pulling this browser-only
// module (which uses DOM) into the pure test file. Re-exported here for
// docs/web.md and any external caller.
export { FPS_FOG_DENSITY, ORTHO_FOG_DENSITY };

/** Style-pass exposure the styled path compensates for (docs/gpu.md §6.1). */
export const STYLE_EXPOSURE = 1.7;
/** Seconds a mood change fades over (docs/gpu.md §5 — a doorway is a blend). */
export const MOOD_BLEND_SECONDS = 1.5;
/** Base emissive tint of the hero's lantern on the GPU path (docs/gpu.md §5). */
const GPU_LANTERN_COLOR = 0xffe0a8;
/** Assumed device pixel ratio when `window.devicePixelRatio` is not visible. */
const DEFAULT_DPR = 1;

/** Options accepted by `GlViewport`. */
export interface GlViewportOptions {
  /** Element the canvas is appended to (default `document.body`). */
  parent?: HTMLElement;
  /** Style id activated on start (default `amber`; unknown → `ascii`). */
  initialStyle?: string;
  /** `?gpu=auto|off|raw` — default parsed from `window.location.search`. */
  gpu?: GpuParam;
  /** `?q=low|medium|high|ultra` — default `caps.maxQuality`. */
  quality?: QualityName | 'auto';
  /** `?backend=webgpu|webgl2` — default `auto` (let three probe). */
  backend?: BackendChoice | 'auto';
  /** Pin a mood (`?mood=<id>`), bypassing `moodFor`; `null` = drive from level. */
  mood?: MoodId | null;
}

/**
 * The AsciiCity-shaded WebGL viewport for the browser fps/ortho modes.
 * Only `render` runs per frame; `resize` and `setStyle` are event-driven.
 * A second, GPU-backed path (T-0040) renders through the ported afterburn
 * stack when `?gpu=auto|raw` is set; it composes back through this same
 * `StyleRenderer` in styled mode. `GlViewport` owns both paths and
 * decides per frame via `choosePath` (docs/gpu.md §6, docs/gpu-compose.md).
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
  private lastHeroCell = { x: 0, y: 0 };
  private view: 'fps' | 'ortho' | 'third' = 'fps';
  private thirdYawSteps = 0;
  private thirdDist = THIRD_DIST_DEFAULT_CELLS;
  private thirdDamped: DampState | null = null;
  private lastFrameTime = 0;
  private readonly heroSmoother: PoseSmoother = createPoseSmoother({
    cellSeconds: POSE_SMOOTH_CELL_SECONDS,
  });
  private cols = 80;
  private rows = 24;
  private cellW = 9;
  private cellH = 18;
  private readonly opts: GlViewportOptions;
  private readonly gpuParam: GpuParam;
  private readonly requestedQuality: QualityName | 'auto';
  private readonly requestedBackend: BackendChoice | 'auto';
  private readonly pinnedMood: MoodId | null;
  private readonly parentEl: HTMLElement;
  private gpu: GpuPath | null = null;
  private gpuReady = false;
  private lastPath: ViewportPath = 'legacy';
  private forcedRaw = false;
  private readonly initialStyle: string;

  constructor(opts: GlViewportOptions = {}) {
    this.opts = opts;
    // Defaults come from `window.location.search` so the bench (`/scene.html`)
    // and any other consumer inherit the same knobs as `main.ts` without an
    // explicit override — the ticket rule for T-0040.
    const query = parseGpuQueryOptions(
      typeof window !== 'undefined' ? window.location.search : '',
    );
    this.gpuParam = opts.gpu ?? query.gpu;
    this.requestedQuality = opts.quality ?? query.quality;
    this.requestedBackend = opts.backend ?? query.backend;
    this.pinnedMood = opts.mood ?? query.mood;
    this.initialStyle = opts.initialStyle ?? 'amber';
    const parent = opts.parent ?? document.body;
    this.parentEl = parent;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'gl-viewport';
    parent.appendChild(this.canvas);

    this.renderer = makeRenderer(this.canvas);
    this.renderer.setClearColor(0x000000, 1);

    this.scene = makeScene();
    // Override AsciiCity's outdoor scene with a dungeon look bright enough
    // for the style shaders to thin out (T-0031 r2 numbers).
    this.scene.background = new THREE.Color(0x000000);
    this.scene.fog = new THREE.FogExp2(0x000000, FPS_FOG_DENSITY);
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
      initial: this.initialStyle,
      exposure: STYLE_EXPOSURE,
    });

    // Kick off the GPU path if not forced off. Fire-and-forget so the legacy
    // path serves frames while the GPU renderer boots; every `render()` after
    // that consults `choosePath` and picks the ready one.
    if (this.gpuParam !== 'off') void this.initGpu();
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
    this.gpu?.notifyResize();
  }

  /** Activate a style by id (returns `false` when unknown). */
  setStyle(id: string): boolean {
    return this.style.setStyle(id);
  }

  /** Switch between first-person, 3/4 overhead ortho and third-person cameras. */
  setView(view: 'fps' | 'ortho' | 'third'): void {
    if (this.view === view) return;
    this.view = view;
    // The ortho camera is far from the scene, so its fog density must be much
    // lower than the fps close-up or the whole view is fogged to black. The
    // third view sits at ~11 cells (docs/gpu-thirdperson.md §"Fog"), which is
    // atmospheric rather than black at the mood densities — no rescale.
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.density = view === 'ortho' ? ORTHO_FOG_DENSITY : FPS_FOG_DENSITY;
    }
    // Force `applyCutaway` to re-evaluate on the next frame in any direction
    // (entering ortho enables ghosts; leaving restores the walls).
    this.lastCutawayKey = '';
    // Drop the third-person damped state so entering `third` starts from the
    // wanted pose (no snap-in from a stale hero cell).
    if (view !== 'third') this.thirdDamped = null;
  }

  /** Which camera the next `render` call will use. */
  get currentView(): 'fps' | 'ortho' | 'third' {
    return this.view;
  }

  /**
   * Rotate the third-person yaw by `step` × 45°. Positive = clockwise (E),
   * negative = counter-clockwise (Q). Wrapped modulo 8 by `wrapYawSteps`, so
   * repeated presses never overflow. No-op when the viewport is not in the
   * third view — the state persists so re-entering keeps the last angle.
   */
  rotateThird(step: number): void {
    this.thirdYawSteps = wrapYawSteps(this.thirdYawSteps + step);
  }

  /**
   * Zoom the third-person camera by `delta` cells (positive = out, negative =
   * in). Clamped to `[THIRD_DIST_MIN_CELLS, THIRD_DIST_MAX_CELLS]` — the
   * afterburn `18–34 m` band converted through `THIRD_SCALE`.
   */
  zoomThird(delta: number): void {
    this.thirdDist = clampThirdDist(this.thirdDist + delta);
  }

  /**
   * Click-to-move (T-0061, docs/gpu-pick.md). Turn a `MouseEvent` on the
   * DOM terminal into the map cell under the cursor, using whichever camera
   * the active view renders through. Refreshes `orthoCamera`/`camera` for the
   * current view so the pick uses a live pose even if the last `render` used
   * the GPU path (which leaves the legacy cameras untouched for `ortho` and
   * `third`). Does not advance the third-view spring damper — read-only.
   *
   * **`updateMatrixWorld(true)` is load-bearing** (T-0061 rework 2):
   * `Raycaster.setFromCamera` reads the camera position from `matrixWorld`,
   * and `position.set` + `lookAt` only mutate `position`/`quaternion`. When
   * the GPU path is drawing the frame, GlViewport's `this.camera`/
   * `this.orthoCamera` are never handed to a `WebGLRenderer.render`, so their
   * `matrixWorld` stays stuck at construction identity and the picked ray
   * comes from the world origin looking straight ahead — hence the earlier
   * `y = -86` off-map picks. Forcing the update fixes both branches.
   *
   * `bounds` (optional) is passed through to `cellUnderRay` so a hit outside
   * the level rectangle returns `null` instead of a garbage off-map cell.
   */
  pickCell(ev: MouseEvent, bounds?: Bounds): Cell | null {
    if (this.view === 'ortho') {
      placeOrthoCamera(this.orthoCamera, this.lastHeroCell, this.cols, this.rows, 2);
      this.orthoCamera.updateMatrixWorld(true);
      return pickCellFromEvent(ev, this.canvas, this.orthoCamera, bounds);
    }
    if (this.view === 'third') {
      const wanted = thirdPersonPose(this.lastHeroCell, this.thirdYawSteps, this.thirdDist);
      const damped = this.thirdDamped ?? { position: wanted.position, target: wanted.target };
      this.camera.position.set(damped.position.x, damped.position.y, damped.position.z);
      this.camera.lookAt(damped.target.x, damped.target.y, damped.target.z);
      if (this.camera.fov !== wanted.fov) {
        this.camera.fov = wanted.fov;
        this.camera.updateProjectionMatrix();
      }
    }
    this.camera.updateMatrixWorld(true);
    return pickCellFromEvent(ev, this.canvas, this.camera, bounds);
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
   * Plain-number snapshot of the viewport for on-page debugging
   * (`window.__asciihack.gl.debugInfo()`). No three.js objects — the PM pastes
   * this into a console to diagnose camera/frustum issues without digging into
   * the scene graph.
   *
   * The report describes **the path that drew the last frame** (T-0050): on
   * the GPU path it reads the camera the pipeline is bound to (position,
   * near/far and — for ortho — the frustum sides `applyOrthoPlacementTo`
   * wrote), plus the GPU scene's own counts (chunk meshes, live torch
   * lights, sprite quads). On the legacy path it keeps the pre-T-0050
   * shape: the `THREE.*Camera` the `StyleRenderer` was handed and the
   * `SceneBuilder` instance counts. Before T-0050 the ortho GPU path always
   * returned the untouched legacy `orthoCamera` (a ±1 frustum at the
   * origin) and zero meshes, which hid the actual bound-camera state and
   * made the black-frame bug undiagnosable from the console.
   *
   * `left/right/top/bottom` are 0 for whichever perspective camera is
   * active (its frustum is FOV-derived, not a box).
   */
  debugInfo(): DebugInfo {
    const usingGpu = this.lastPath !== 'legacy' && this.gpu !== null;
    const h = this.lastHeroCell;
    const cutout = this.cutoutDebug();
    if (usingGpu) {
      const gpu = this.gpu!;
      // Third-person reuses the perspective `gpu.camera`, just repositioned.
      const cam = this.view === 'ortho' ? gpu.orthoCamera : gpu.camera;
      const isOrtho = this.view === 'ortho';
      return {
        view: this.view,
        camera: {
          type: this.view,
          position: { x: cam.position.x, y: cam.position.y, z: cam.position.z },
          target: { x: h.x + 0.5, y: 0.5, z: h.y + 0.5 },
          near: cam.near,
          far: cam.far,
          left: isOrtho ? gpu.orthoCamera.left : 0,
          right: isOrtho ? gpu.orthoCamera.right : 0,
          top: isOrtho ? gpu.orthoCamera.top : 0,
          bottom: isOrtho ? gpu.orthoCamera.bottom : 0,
        },
        meshes: {
          walls: gpu.dungeon.mainMeshes().filter((m) => m !== null).length,
          floors: gpu.dungeon.pointLights.length,
          sprites: gpu.sprites.root.children.length,
        },
        styleId: this.style.style.id,
        path: this.lastPath,
        gpuReady: this.gpuReady,
        backend: this.gpu?.backend ?? null,
        quality: this.gpu?.quality ?? null,
        mood: this.gpu?.mood ?? null,
        cutout,
      };
    }
    // Third-person reuses the legacy `this.camera` (perspective), repositioned.
    const cam = this.view === 'ortho' ? this.orthoCamera : this.camera;
    const isOrtho = cam instanceof THREE.OrthographicCamera;
    return {
      view: this.view,
      camera: {
        type: this.view,
        position: { x: cam.position.x, y: cam.position.y, z: cam.position.z },
        target: { x: h.x + 0.5, y: 0.5, z: h.y + 0.5 },
        near: cam.near,
        far: cam.far,
        left: isOrtho ? (cam as THREE.OrthographicCamera).left : 0,
        right: isOrtho ? (cam as THREE.OrthographicCamera).right : 0,
        top: isOrtho ? (cam as THREE.OrthographicCamera).top : 0,
        bottom: isOrtho ? (cam as THREE.OrthographicCamera).bottom : 0,
      },
      meshes: {
        walls: this.builder.counts.walls,
        floors: this.builder.counts.floors,
        sprites: this.builder.spriteGroup.children.length,
      },
      styleId: this.style.style.id,
      path: this.lastPath,
      gpuReady: this.gpuReady,
      backend: this.gpu?.backend ?? null,
      quality: this.gpu?.quality ?? null,
      mood: this.gpu?.mood ?? null,
      cutout,
    };
  }

  /** Snapshot of the CUTOUT uniforms `GpuPath.render` wrote last frame
   *  (T-0063 rework — the PM asked for the numbers so the resolved cut
   *  region can be read directly instead of inferred from a screenshot).
   *  `enabled` is `false` in `fps` (the camera IS the hero there) and while
   *  the GPU path is not running; the other fields report the most-recent
   *  frame the cutout was active on. */
  private cutoutDebug(): CutoutDebug {
    const frame = this.gpu?.lastCutoutFrame ?? null;
    const enabled = frame !== null;
    return {
      enabled,
      heroScreen: {
        min: { x: frame?.heroScreenMinX ?? 0, y: frame?.heroScreenMinY ?? 0 },
        max: { x: frame?.heroScreenMaxX ?? 0, y: frame?.heroScreenMaxY ?? 0 },
      },
      heroCamDist: frame?.heroCamDist ?? 0,
      fadeMarginPx: frame?.fadeMarginPx ?? 0,
    };
  }

  /** F8 flips between the raw GPU frame and the styled path. No-op when the
   *  GPU path never initialised — the toggle only makes sense while the
   *  ported pipeline can draw. */
  toggleRaw(): void {
    this.forcedRaw = !this.forcedRaw;
  }

  /** Effective `?gpu=` after any F8 toggle. */
  private effectiveGpuParam(): GpuParam {
    if (this.gpuParam === 'off') return 'off';
    return this.forcedRaw ? 'raw' : this.gpuParam;
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
    // One wall-clock delta drives both dampers this frame — the hero-cell
    // smoother (below) and the third-person spring (`stepThirdPose`). Sharing
    // the delta keeps their motion locked to the same rAF cadence.
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const dt = this.lastFrameTime === 0 ? 0.016 : Math.min(0.1, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;
    // Smooth the hero cell centre so a move eases across the cell instead of
    // teleporting — otherwise the third-person spring's input is a step
    // function and the follow reads as a lurch (T-0060). Yaw passes through
    // unchanged; the fps mode already animates it.
    const heroCell = { x: Math.floor(pose.x), y: Math.floor(pose.y) };
    const smoothedPose = this.heroSmoother.update(heroCell, pose.yaw, dt);
    this.lastHeroCell = heroCell;
    // Keep the legacy perspective camera at the smoothed hero position in
    // fps + ortho so the lantern light (child of `camera`) glides too. The
    // third view moves the camera further out below; the lantern rides with
    // it on the legacy path (a limitation of that path, called out in
    // `docs/gpu-thirdperson.md`).
    if (this.view !== 'third') {
      this.camera.position.set(smoothedPose.x, EYE_HEIGHT, smoothedPose.y);
      this.camera.rotation.set(CAMERA_PITCH, -smoothedPose.yaw, 0, 'YXZ');
      if (this.camera.fov !== vFovDeg) {
        this.camera.fov = vFovDeg;
        this.camera.updateProjectionMatrix();
      }
    }

    // Per-frame decision: both views can go through the GPU path now — the
    // ortho camera + cutaway are wired into `GpuPath` (T-0043, docs/gpu-ortho.md).
    // Depth-styles (`edges`) and `?gpu=off` still fall to legacy exactly as
    // before, so the legacy renderer stays a first-class citizen.
    const styleNeedsDepth = this.style.style.needsDepth === true;
    const path: ViewportPath = choosePath({
      gpuParam: this.effectiveGpuParam(),
      gpuReady: this.gpuReady && this.gpu !== null,
      styleNeedsDepth,
    });
    this.lastPath = path;

    if (path === 'legacy') {
      if (this.builder.refresh(level)) {
        this.wallCellOrder = collectWallCells(level);
        this.lastCutawayKey = '';
      }
      this.builder.updateSprites(sprites, (s) => this.spriteMaterialFor(s));
      if (this.view === 'ortho') {
        this.applyCutaway(heroCell);
        placeOrthoCamera(this.orthoCamera, heroCell, this.cols, this.rows, 2);
        this.style.render(this.scene, this.orthoCamera);
      } else if (this.view === 'third') {
        this.applyCutaway(null);
        const p = this.stepThirdPose(
          { x: smoothedPose.x - 0.5, y: smoothedPose.y - 0.5 },
          dt,
        );
        this.camera.position.set(p.position.x, p.position.y, p.position.z);
        this.camera.lookAt(p.target.x, p.target.y, p.target.z);
        if (this.camera.fov !== p.fov) {
          this.camera.fov = p.fov;
          this.camera.updateProjectionMatrix();
        }
        this.style.render(this.scene, this.camera);
      } else {
        this.applyCutaway(null);
        this.style.render(this.scene, this.camera);
      }
      return;
    }

    // GPU path (styled or raw). Render into the GPU-owned canvas via the
    // ported pipeline, then either blit through the style pass (styled) or
    // display the GPU canvas directly (raw).
    const gpu = this.gpu;
    if (gpu === null) return;
    const cols = this.style.cols;
    const rows = this.style.rows;
    const viewportPx: { cssW: number; cssH: number; dpr: number } = {
      cssW: this.cols * this.cellW,
      cssH: this.rows * this.cellH,
      dpr: typeof window !== 'undefined' ? window.devicePixelRatio || DEFAULT_DPR : DEFAULT_DPR,
    };
    const size = gpuCanvasSize(
      path,
      { subX: this.style.style.subX, subY: this.style.style.subY },
      cols,
      rows,
      viewportPx,
    );
    // Advance the third-person spring damper once per frame (fps + ortho pass
    // `null`; the branch inside `GpuPath.render` short-circuits to the ordinary
    // hero-cell pose). Doing it here keeps the damped state on the viewport
    // where the legacy path already reads it. Feed the smoothed hero position
    // in so the spring's input glides across the cell instead of stepping.
    const thirdFrame = this.view === 'third'
      ? this.stepThirdPose({ x: smoothedPose.x - 0.5, y: smoothedPose.y - 0.5 }, dt)
      : null;
    try {
      gpu.render(level, smoothedPose, sprites, vFovDeg, path, size, viewportPx, this.pinnedMood, this.view, this.cols, this.rows, thirdFrame, dt);
    } catch (err) {
      this.fallbackToLegacy(err);
      // Re-run this frame on the legacy path so the user gets something.
      this.render(level, pose, sprites, vFovDeg);
      return;
    }
    if (path === 'styled') {
      gpu.compositor.render(this.style, this.camera);
    } else {
      this.blitRawToCanvas(gpu.getCanvas(), viewportPx);
    }
  }

  /** Copy the GPU canvas into the visible legacy canvas via 2D drawImage. This
   *  keeps a single visible `<canvas>` in the DOM (the legacy one) and avoids
   *  a second element under the terminal grid. */
  private blitRawToCanvas(source: HTMLCanvasElement, viewportPx: { cssW: number; cssH: number; dpr: number }): void {
    const dpr = Math.min(Math.max(viewportPx.dpr, 1), 1.5);
    const w = Math.max(1, Math.round(viewportPx.cssW * dpr));
    const h = Math.max(1, Math.round(viewportPx.cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.renderer.setSize(w, h, false);
    }
    const gl = this.renderer.getContext();
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    // Simple full-screen quad through the style renderer would round-trip
    // through it again; use a tiny direct draw instead. Attaching a plain
    // texture-uploaded WebGLTexture and blitting is heavier than 2D drawImage
    // on a canvas — but we only get one context per canvas. Simplest robust
    // path: render the source through the compositor to `null` target (i.e.
    // the canvas). We reuse the compositor scene the styled path built.
    if (this.gpu === null) return;
    this.renderer.setRenderTarget(null);
    // The compositor.texture holds `source`; make sure it uploads this frame.
    this.gpu.compositor.texture.needsUpdate = true;
    this.renderer.render(this.gpu.compositor.scene, RAW_BLIT_CAMERA);
  }

  /** Latch onto the legacy path and log once. Called on the first GPU frame
   *  that throws, on `device.lost`, or on `uncapturederror`. */
  private fallbackToLegacy(reason: unknown): void {
    if (!this.gpuReady && this.gpu === null) return;
    this.gpuReady = false;
    const msg = reason instanceof Error ? reason.message : String(reason);
    // eslint-disable-next-line no-console
    console.warn(`[gl-viewport] GPU path failed, falling back to legacy: ${msg}`);
    try { this.gpu?.dispose(); } catch { /* ignore */ }
    this.gpu = null;
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
    try { this.gpu?.dispose(); } catch { /* ignore */ }
    this.gpu = null;
    this.renderer.dispose();
    this.canvas.remove();
  }

  /**
   * Boot the GPU path. Constructs a `WebGPURenderer` with the requested
   * backend, builds the ported scene + pipeline + compositor, then runs one
   * frame to detect the first-frame throw (docs/gpu.md §3). On a WebGPU-side
   * throw the whole path is rebuilt once on the WebGL2 fallback; any further
   * failure lands on `legacy` permanently.
   */
  private async initGpu(): Promise<void> {
    const forceWebGL = this.requestedBackend === 'webgl2';
    try {
      this.gpu = await GpuPath.create({
        parent: this.parentEl,
        cols: this.cols,
        rows: this.rows,
        cellW: this.cellW,
        cellH: this.cellH,
        requestedQuality: this.requestedQuality,
        forceWebGL,
        onLost: (r) => this.fallbackToLegacy(r),
      });
      this.gpuReady = true;
    } catch (err) {
      // Try the WebGL2 fallback if we started on WebGPU — measured pattern.
      if (!forceWebGL) {
        // eslint-disable-next-line no-console
        console.warn('[gl-viewport] WebGPU init failed, retrying on WebGL2:', err);
        try { this.gpu?.dispose(); } catch { /* ignore */ }
        this.gpu = null;
        try {
          this.gpu = await GpuPath.create({
            parent: this.parentEl,
            cols: this.cols,
            rows: this.rows,
            cellW: this.cellW,
            cellH: this.cellH,
            requestedQuality: this.requestedQuality,
            forceWebGL: true,
            onLost: (r) => this.fallbackToLegacy(r),
          });
          this.gpuReady = true;
          return;
        } catch (err2) {
          this.fallbackToLegacy(err2);
          return;
        }
      }
      this.fallbackToLegacy(err);
    }
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

  /**
   * Compute the third-person camera pose for `hero` this frame and run the
   * spring damper forward by the wall-clock delta since the last call. Used
   * by both the legacy render path and the GPU render path — legacy writes
   * the returned pose onto `this.camera`; GPU passes it into `GpuPath.render`
   * so the same damped state drives both cameras.
   */
  private stepThirdPose(hero: { x: number; y: number }, dt: number): ThirdPersonFrame {
    const wanted = thirdPersonPose(hero, this.thirdYawSteps, this.thirdDist);
    const wantedState: DampState = { position: wanted.position, target: wanted.target };
    const damped = this.thirdDamped === null ? wantedState : dampPose(this.thirdDamped, wantedState, dt);
    this.thirdDamped = damped;
    return { position: damped.position, target: damped.target, fov: wanted.fov, focus: wanted.focus };
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

/**
 * Plain-number snapshot returned by `GlViewport.debugInfo()` (T-0032 rework,
 * T-0050 made per-path).
 *
 * The `camera` and `meshes` fields describe **the path that drew the last
 * frame**, keyed by `path`:
 *
 * - `path === 'legacy'` (or before the GPU path is `gpuReady`):
 *   `camera` reports the `THREE.*Camera` the `StyleRenderer` was handed, and
 *   `meshes.{walls,floors,sprites}` are the `SceneBuilder`'s instance counts.
 * - `path === 'raw'` / `path === 'styled'` (GPU path live):
 *   `camera` reports the `WG.*Camera` the pipeline is bound to — the very
 *   reference `applyOrthoPlacementTo` writes to on an ortho frame — and
 *   `meshes.walls` is the chunk mesh count from `DungeonScene`, `meshes.floors`
 *   is the number of live `PointLight`s (torches), `meshes.sprites` is the
 *   `SpriteLayer` quad count.
 *
 * `left/right/top/bottom` are 0 for whichever perspective camera is active
 * (its frustum is FOV-derived, not a box).
 */
export interface DebugInfo {
  view: 'fps' | 'ortho' | 'third';
  camera: {
    type: 'fps' | 'ortho' | 'third';
    position: { x: number; y: number; z: number };
    target: { x: number; y: number; z: number };
    near: number;
    far: number;
    left: number;
    right: number;
    top: number;
    bottom: number;
  };
  meshes: { walls: number; floors: number; sprites: number };
  styleId: string;
  /** Which of the three paths the last frame went through (T-0040). */
  path: ViewportPath;
  /** Whether the GPU renderer initialised and has not fallen back. */
  gpuReady: boolean;
  /** Backend actually reached (`webgpu` or `webgl2`), or null on legacy-only. */
  backend: BackendChoice | null;
  /** Quality tier the GPU pipeline is running, or null on legacy-only. */
  quality: QualityName | null;
  /** Current mood id being applied by the GPU path, or null. */
  mood: MoodId | null;
  /** Hero cutout numbers the shader received last frame (T-0063 rework). */
  cutout: CutoutDebug;
}

/** Plain-number snapshot of the CUTOUT uniforms — surfaced by
 *  `GlViewport.debugInfo().cutout` so the PM can read the resolved cut
 *  rectangle and hero depth directly. All zero and `enabled: false` when
 *  the cutout is off (fps view, or before the first GPU frame). */
export interface CutoutDebug {
  /** True when the cutout uniform block is driving a discard this frame
   *  (`view === 'third' || view === 'ortho'`). */
  enabled: boolean;
  /** Hero's projected silhouette rectangle in pixels (top-left origin,
   *  matches TSL `screenCoordinate.xy`). Fragments inside this rectangle
   *  (plus `fadeMarginPx` on each side for the dither band) are candidates
   *  for the cut when the depth test also fires. */
  heroScreen: {
    min: { x: number; y: number };
    max: { x: number; y: number };
  };
  /** Hero's camera-space depth in world units (positive in front of the
   *  camera). Compare against `-positionView.z` fragment-side. */
  heroCamDist: number;
  /** Pixel margin the rectangle is expanded by for the screen-door dither
   *  fade. `CUTOUT_SCREEN_FADE_MARGIN_PX` by default. */
  fadeMarginPx: number;
}

/** Per-frame third-person pose after the spring damper (`dampPose`) has run.
 *  The wanted pose is computed by `thirdPersonPose`; the damper pulls
 *  position/target toward it and passes the result into both render paths. */
interface ThirdPersonFrame {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  fov: number;
  focus: number;
}

/** Camera used by `blitRawToCanvas` — the compose shader ignores it, but
 *  three needs a Camera reference to render. */
const RAW_BLIT_CAMERA = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

/** Reused hero-focus vector for the per-frame `weather.update` call so the
 *  render loop stays allocation-free (T-0044). */
const WEATHER_FOCUS_SCRATCH = new WG.Vector3();

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

interface GpuPathOptions {
  parent: HTMLElement;
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  requestedQuality: QualityName | 'auto';
  forceWebGL: boolean;
  onLost: (reason: unknown) => void;
}

/**
 * The ported afterburn stack owned by `GlViewport` on the GPU path.
 * Owns its own detached canvas (so a `CanvasTexture` can read it into the
 * legacy renderer for the styled and raw composites), a `WebGPURenderer`
 * (WebGPU or three's WebGL2 fallback), a `DungeonScene`, an `Atmosphere`
 * (blends the mood table, docs/gpu.md §5), a `RenderPipeline` and a
 * `GpuCompositor`. `render(...)` does everything a GPU frame needs; the
 * viewport composites its output afterwards.
 */
class GpuPath {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: WG.WebGPURenderer;
  readonly caps: RendererCaps;
  readonly scene: WG.Scene;
  readonly camera: WG.PerspectiveCamera;
  readonly orthoCamera: WG.OrthographicCamera;
  readonly lantern: WG.PointLight;
  readonly dungeon: DungeonScene;
  readonly atmosphere: Atmosphere;
  readonly handle: PipelineHandle;
  readonly compositor: GpuCompositor;
  readonly backend: BackendChoice;
  readonly sprites: SpriteLayer;
  readonly weather: WeatherHandle;
  readonly ghostGroup: WG.Group;
  readonly ghostGeom: WG.BoxGeometry;
  readonly ghostMaterial: WG.MeshBasicMaterial;
  /** Uniforms `scene.fogNode` reads. Own copies (not the atmosphere's) so
   *  `render` can scale density for the ortho view via `moodFogDensityForView`
   *  without touching `moods.ts` — the atmosphere still writes into its
   *  internal fog uniforms every `update()`, but nothing points at those
   *  after we replace `scene.fogNode` in `create()` (T-0050 rework 3). */
  readonly fogColor: WG.UniformNode<'color', WG.Color>;
  readonly fogDensity: WG.UniformNode<'float', number>;
  quality: QualityName;
  mood: MoodId;
  private lastTime = 0;
  private lastMoodDecision: MoodId | null = null;
  private lastView: 'fps' | 'ortho' | 'third' = 'fps';
  private lastGhostKey = '';
  /** Resolved cutout numbers from the most recent `render` — surfaced by
   *  `GlViewport.debugInfo()` so the PM can read the actual pixel radius
   *  and hero screen position instead of inferring them from a screenshot.
   *  `null` in `fps` (the cutout is disabled there). */
  lastCutoutFrame: CutoutFrame | null = null;

  private constructor(init: {
    canvas: HTMLCanvasElement;
    renderer: WG.WebGPURenderer;
    caps: RendererCaps;
    scene: WG.Scene;
    camera: WG.PerspectiveCamera;
    orthoCamera: WG.OrthographicCamera;
    lantern: WG.PointLight;
    dungeon: DungeonScene;
    atmosphere: Atmosphere;
    handle: PipelineHandle;
    compositor: GpuCompositor;
    backend: BackendChoice;
    sprites: SpriteLayer;
    weather: WeatherHandle;
    ghostGroup: WG.Group;
    ghostGeom: WG.BoxGeometry;
    ghostMaterial: WG.MeshBasicMaterial;
    fogColor: WG.UniformNode<'color', WG.Color>;
    fogDensity: WG.UniformNode<'float', number>;
    quality: QualityName;
    mood: MoodId;
  }) {
    this.canvas = init.canvas;
    this.renderer = init.renderer;
    this.caps = init.caps;
    this.scene = init.scene;
    this.camera = init.camera;
    this.orthoCamera = init.orthoCamera;
    this.lantern = init.lantern;
    this.dungeon = init.dungeon;
    this.atmosphere = init.atmosphere;
    this.handle = init.handle;
    this.compositor = init.compositor;
    this.backend = init.backend;
    this.sprites = init.sprites;
    this.weather = init.weather;
    this.ghostGroup = init.ghostGroup;
    this.ghostGeom = init.ghostGeom;
    this.ghostMaterial = init.ghostMaterial;
    this.fogColor = init.fogColor;
    this.fogDensity = init.fogDensity;
    this.quality = init.quality;
    this.mood = init.mood;
  }

  /**
   * Async factory: constructs the WebGPU renderer, awaits `init()`, builds
   * the scene + pipeline, and attaches loss listeners. Throws on any step
   * so the caller can decide whether to retry on WebGL2 or fall back.
   */
  static async create(opts: GpuPathOptions): Promise<GpuPath> {
    const canvas = document.createElement('canvas');
    canvas.className = 'gpu-source';
    // Detached (not appended): the styled path reads it as a `CanvasTexture`
    // and raw mode blits it through the legacy `WebGLRenderer`, so this
    // canvas never needs to be in the DOM.
    const params: Record<string, unknown> = {
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
    };
    if (opts.forceWebGL) params['forceWebGL'] = true;
    // Probe the adapter's MRT budget so we do not request 64 bytes when the
    // device only offers 32 (would fail requestAdapter under the new limit).
    let mrtBytes = 32;
    let hasNavGpu = false;
    try {
      const nav = typeof navigator !== 'undefined'
        ? (navigator as unknown as { gpu?: { requestAdapter(o: unknown): Promise<{ limits: Record<string, number> } | null> } })
        : undefined;
      if (nav?.gpu !== undefined) {
        hasNavGpu = true;
        const ad = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (ad !== null) {
          const raw = ad.limits['maxColorAttachmentBytesPerSample'];
          mrtBytes = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 32;
        }
      }
    } catch { /* fall through */ }
    if (!opts.forceWebGL && hasNavGpu && mrtBytes >= 64) {
      params['requiredLimits'] = { maxColorAttachmentBytesPerSample: 64 };
    }
    const renderer = new WG.WebGPURenderer(params as ConstructorParameters<typeof WG.WebGPURenderer>[0]);
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 1.5) : 1;
    renderer.setPixelRatio(dpr);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = WG.PCFSoftShadowMap;
    renderer.toneMapping = WG.AgXToneMapping;
    renderer.toneMappingExposure = 1.0;
    await renderer.init();
    const isWebGPU = (renderer.backend as unknown as { isWebGPUBackend?: boolean } | undefined)?.isWebGPUBackend === true;
    const backend: BackendChoice = isWebGPU ? 'webgpu' : 'webgl2';
    const caps: RendererCaps = {
      webgpu: isWebGPU,
      mrtBytes,
      maxQuality: isWebGPU && mrtBytes >= 64 ? 'ultra' : 'medium',
    };
    const requested: QualityName = opts.requestedQuality === 'auto'
      ? caps.maxQuality
      : opts.requestedQuality;
    const quality: QualityName = clampQuality(requested, caps);

    const scene = new WG.Scene();
    scene.background = new WG.Color(0x000000);

    const aspect = (opts.cols * opts.cellW) / Math.max(1, opts.rows * opts.cellH);
    const camera = new WG.PerspectiveCamera(70, aspect, 0.05, 60);
    camera.position.set(0, EYE_HEIGHT, 0);
    scene.add(camera);
    // Dedicated `OrthographicCamera` for the T-0043 3/4 overhead view. The
    // pipeline is built against the perspective camera on boot; F3 rebuilds
    // the graph against this ortho camera (T-0050 — the "projection copy"
    // trick T-0043 shipped produced a black frame because the TSL nodes
    // derived their uniforms from the still-perspective reference).
    const orthoCamera = new WG.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
    scene.add(orthoCamera);
    // The hero's lantern — reuses the same constants as the legacy path so
    // one number lives in one place (`docs/gpu.md` §5). Kept at scene level
    // (not a child of `camera`) so the ortho view can move the camera 40
    // cells NW-above the hero without dragging the light away too.
    const lantern = new WG.PointLight(GPU_LANTERN_COLOR, LANTERN_INTENSITY, LANTERN_DISTANCE, 1);
    lantern.position.set(0, EYE_HEIGHT, 0);
    scene.add(lantern);

    const voxelMat = createVoxelMaterial({ weather: true, sway: true });
    const dungeon = new DungeonScene({ material: voxelMat, ceilingMaterial: voxelMat });
    scene.add(dungeon.root);

    // Sprite billboards for monsters/items — camera-facing quads carrying
    // tile art, lit by the ported stack rather than pasted on top (T-0042).
    // The hero and pet are routed to voxel avatars sharing the voxel
    // material family (T-0056, docs/gpu-avatar.md), but with the cutout
    // discard disabled — the avatars project onto the same screen pixel as
    // the hero and can dip below the depth bias under smoothing, so the
    // rule that clears the wall in front of the hero would otherwise flicker
    // the avatar itself (`docs/gpu-cutout.md` §"What is exempt").
    const avatarMat = createVoxelMaterial({ weather: true, sway: true, cutout: false });
    const sprites = new SpriteLayer({ voxelMaterial: avatarMat });
    scene.add(sprites.root);

    // Ghost mesh scaffolding for the ortho cutaway (T-0043, docs/gpu-ortho.md).
    // One shared `BoxGeometry` + one translucent basic material; per-hero
    // meshes get parented to `ghostGroup` and swapped in/out when the hero
    // cell moves. Empty until the first ortho frame lands.
    const ghostGroup = new WG.Group();
    ghostGroup.name = 'ortho-ghost';
    scene.add(ghostGroup);
    const ghostGeom = new WG.BoxGeometry(1, 1, 1);
    const ghostMaterial = new WG.MeshBasicMaterial({
      color: 0x9a9a9e,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    });

    // Build `Atmosphere` *before* the pipeline so its per-mood env map is
    // available at SSR construction (T-0048/T-0049; stochastic SSR throws on
    // `sampleEnvironmentBRDF` when `environmentNode` is null). The rig needs
    // a `look` bag it can write mood-driven grade values into, but the
    // pipeline's real `LookUniforms` don't exist yet — so hand it a shared
    // proxy object and pour the pipeline's uniforms into it once the
    // pipeline is built. `Atmosphere` holds the reference (not a snapshot),
    // so `Object.assign` is enough; no private-field surgery on `moods.ts`.
    type AtmosphereLook = ConstructorParameters<typeof Atmosphere>[0]['look'];
    const lookProxy: AtmosphereLook = {};
    const atmosphere = new Atmosphere({ scene, look: lookProxy, weather: W });

    // Own the scene's fog uniforms so `render` can scale density for the
    // ortho view (T-0050 rework 3). The atmosphere set `scene.fogNode`
    // against its own internal uniforms in its constructor; we replace the
    // node with ours here so the ortho scale (via `moodFogDensityForView`)
    // reaches the shader. The atmosphere still writes its internal uniforms
    // every `_apply()`, but those uniforms are now orphaned — `render`
    // drives ours from `atmosphere.state` each frame instead. Reasoning
    // sits in `docs/gpu-ortho.md` §"Fog scales with the view".
    const fogColor = uniform(new WG.Color(0x0b0d10));
    const fogDensity = uniform(FPS_FOG_DENSITY);
    scene.fogNode = fog(fogColor, densityFogFactor(fogDensity));

    // Dungeon-air overlay (T-0044): drips / motes / embers composited
    // additively **after** the lighting stack, so their transparent quads
    // never touch the G-buffer SSGI/SSR read. Built before the pipeline so
    // its scene can be passed as `overlay` at construction.
    const weather = createWeather(W);

    // `sun` is null on purpose: dungeons have no shaft light and
    // `GodraysNode` throws on a light with no shadow map (docs/gpu.md §3).
    // `environment` closes the T-0048 hole — see `docs/gpu-compose.md`.
    const handle = createPipeline(pipelineOptionsWithEnv(
      { renderer, scene, camera, requested: quality, sun: null, overlay: weather.scene },
      atmosphere,
    ));
    const compositor = new GpuCompositor(canvas);

    // Give the pipeline canvas its initial size (styled mode will resize on
    // the first `render`; this just keeps early frames from being 1×1).
    renderer.setSize(Math.max(1, opts.cols * opts.cellW), Math.max(1, opts.rows * opts.cellH), false);

    // Now that the pipeline exists, wire its `LookUniforms` into the proxy
    // the atmosphere already writes to. Cast because `UniformNode<'float',
    // number>` isn't literally `{ value: number }` in TS, but the runtime
    // shape matches (`moods.ts::Look`).
    Object.assign(
      lookProxy as Record<string, unknown>,
      handle.look as unknown as Record<string, unknown>,
    );
    // Re-apply the initial mood so torchlit's grade values (exposure,
    // vignette, etc.) land in the pipeline's real uniforms; the atmosphere
    // constructor's own `_apply()` ran against the empty proxy and no-op'd.
    atmosphere.set('torchlit');
    atmosphere.update(0.016);

    const path = new GpuPath({
      canvas, renderer, caps, scene, camera, orthoCamera, lantern, dungeon, atmosphere,
      handle, compositor, backend, sprites, weather, ghostGroup, ghostGeom, ghostMaterial,
      fogColor, fogDensity, quality, mood: 'torchlit',
    });

    // Attach loss listeners for backends that surface them. Both are best-
    // effort; the try/catch handles the WebGL2 fallback where neither exists.
    try {
      const backendObj = renderer.backend as unknown as {
        device?: { lost?: Promise<unknown> };
        addEventListener?: (t: string, l: (e: unknown) => void) => void;
      };
      const device = backendObj.device;
      if (device !== undefined && device.lost !== undefined) {
        void device.lost.then((reason) => opts.onLost(reason));
      }
      if (typeof backendObj.addEventListener === 'function') {
        backendObj.addEventListener('uncapturederror', (e) => opts.onLost(e));
      }
    } catch { /* neither exists on WebGL2 — ignore */ }

    // First frame: detect the WebGPU createView swizzle throw so the caller
    // can retry once on WebGL2 (measured pattern from docs/gpu.md §3).
    handle.render();
    return path;
  }

  /** Access the GPU canvas so the compositor / raw blitter can sample it. */
  getCanvas(): HTMLCanvasElement { return this.canvas; }

  /** Resize the GPU canvas + pipeline to a target pixel size (styled or raw). */
  private resizeTo(w: number, h: number): void {
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.renderer.setSize(w, h, false);
    // The compositor's texture already tracks the canvas, but a dimension
    // change invalidates any cached upload — mark it dirty here so the next
    // `render` uploads the fresh contents.
    this.compositor.texture.needsUpdate = true;
  }

  /** Render one GPU frame. Throws to the viewport on backend failure. */
  render(
    level: LevelView,
    pose: Pose,
    sprites: readonly Sprite[],
    vFovDeg: number,
    mode: 'styled' | 'raw',
    size: { w: number; h: number },
    viewportPx: { cssW: number; cssH: number; dpr: number },
    pinnedMood: MoodId | null,
    view: 'fps' | 'ortho' | 'third',
    viewportCols: number,
    viewportRows: number,
    thirdFrame: ThirdPersonFrame | null,
    frameDt: number,
  ): void {
    // 1. Camera. The pipeline was built against `this.camera` (perspective)
    //    at boot; F3 rebuilds the graph against the real `OrthographicCamera`
    //    via `handle.setCamera` — only on a view change, never per frame
    //    (docs/gpu-ortho.md "The camera rebuild"). The previous "copy the
    //    ortho projection onto the perspective camera" trick rendered a
    //    black frame because the TSL nodes derived their uniforms from the
    //    still-`isPerspectiveCamera === true` reference (T-0050).
    const heroCell = { x: Math.floor(pose.x), y: Math.floor(pose.y) };
    let orthoPlace: OrthoPlacement | null = null;
    if (view === 'ortho') {
      orthoPlace = orthoPlacement(heroCell, viewportCols, viewportRows, 2);
      applyOrthoPlacementTo(this.orthoCamera, orthoPlace);
      this.orthoCamera.updateMatrixWorld(true);
    } else if (view === 'third' && thirdFrame !== null) {
      // Third-person: perspective camera lifted behind + above the hero at
      // the ART_BIBLE §6 pitch/distance. Uses the damped pose the viewport
      // stepped this frame — see `docs/gpu-thirdperson.md` "The spring".
      this.camera.position.set(thirdFrame.position.x, thirdFrame.position.y, thirdFrame.position.z);
      this.camera.lookAt(thirdFrame.target.x, thirdFrame.target.y, thirdFrame.target.z);
      const aspect = viewportPx.cssW / Math.max(1, viewportPx.cssH);
      if (this.camera.fov !== thirdFrame.fov || this.camera.aspect !== aspect) {
        this.camera.fov = thirdFrame.fov;
        this.camera.aspect = aspect;
        this.camera.updateProjectionMatrix();
      }
    } else {
      this.camera.position.set(pose.x, EYE_HEIGHT, pose.y);
      this.camera.rotation.set(CAMERA_PITCH, -pose.yaw, 0, 'YXZ');
      const aspect = viewportPx.cssW / Math.max(1, viewportPx.cssH);
      if (this.camera.fov !== vFovDeg || this.camera.aspect !== aspect) {
        this.camera.fov = vFovDeg;
        this.camera.aspect = aspect;
        this.camera.updateProjectionMatrix();
      }
    }
    // Lantern rides at the hero cell in both views — it is a scene child, not
    // a camera child, so the ortho camera moving 40 cells out does not drag
    // the light with it (T-0043).
    this.lantern.position.set(pose.x, EYE_HEIGHT, pose.y);

    // 1c. Hero cutout (T-0063, docs/gpu-cutout.md). Third and ortho enable
    //     the material-side discard so a wall actually blocking the hero
    //     clears; fps disables it — the camera IS the hero there, so
    //     nothing is ever between them. The rule is depth + screen-space
    //     **silhouette rectangle**: a fragment is cut when it is closer to
    //     the camera than the hero (view-space z) AND its projected pixel
    //     falls inside the hero's projected AABB. `projectHeroForCutout`
    //     projects the eight corners of the hero's world-space AABB and
    //     returns the pixel min/max — the actual on-screen silhouette,
    //     so the hole is the size of the figure it reveals. Rework 1's
    //     screen-space disc reached past the avatar and cut floor his
    //     shape never covered (`docs/gpu-cutout.md` §"Why a screen-space
    //     disc was tried and rejected"); rework 2 (this attempt) uses
    //     the rectangle instead.
    const cutoutOn = view === 'third' || view === 'ortho';
    CUTOUT.enabled.value = cutoutOn ? 1.0 : 0.0;
    if (cutoutOn) {
      const activeCam = view === 'ortho' ? this.orthoCamera : this.camera;
      const frame = projectHeroForCutout(
        activeCam,
        pose.x,
        0,
        pose.y,
        HERO_SILHOUETTE_WIDTH_CELLS,
        HERO_SPRITE_HEIGHT,
        this.canvas.width,
        this.canvas.height,
        CUTOUT_SCREEN_FADE_MARGIN_PX,
      );
      CUTOUT.heroCamDist.value = frame.heroCamDist;
      CUTOUT.heroScreenMin.value.set(frame.heroScreenMinX, frame.heroScreenMinY);
      CUTOUT.heroScreenMax.value.set(frame.heroScreenMaxX, frame.heroScreenMaxY);
      CUTOUT.fadeMarginPx.value = frame.fadeMarginPx;
      CUTOUT.depthBias.value = CUTOUT_DEPTH_BIAS_CELLS;
      this.lastCutoutFrame = frame;
    } else {
      this.lastCutoutFrame = null;
    }

    // 1b. View-change side effects: rebuild the pipeline graph against the
    //     view's real camera (T-0050), hide the ceiling for the overhead
    //     view (`docs/gpu.md` §4 kept it in its own group precisely for
    //     this), drop the ghost mesh on the way out, force a rebuild on the
    //     way in. `handle.setCamera` is a graph rebuild — cheap on paper,
    //     never called per frame, only when F3 flips `view`.
    if (view !== this.lastView) {
      // Third-person is a perspective camera too, so it uses `'fps'` for the
      // `pipelineCameraForView` and `moodFogDensityForView` picks — same
      // reference identity as fps, so `setCamera` no-ops after the initial
      // build. Only `'ortho'` rebuilds the graph.
      this.handle.setCamera(pipelineCameraForView(view === 'ortho' ? 'ortho' : 'fps', {
        perspective: this.camera,
        orthographic: this.orthoCamera,
      }));
      // Ceiling occludes the third-person camera (it sits ~7 units up above
      // the 1-unit ceiling), so hide it there too — only fps keeps it lit.
      this.dungeon.ceiling.visible = view === 'fps';
      if (view !== 'ortho') this.disposeGhostMesh();
      this.lastGhostKey = '';
      this.lastView = view;
    }
    if (view === 'ortho') this.refreshGhostMesh(level, heroCell);

    // 2. Refresh the dungeon geometry if the level changed.
    this.dungeon.refresh(level);
    this.dungeon.updateLights(Math.floor(pose.x), Math.floor(pose.y));

    // 2b. Update sprite billboards (monsters, items, hero) — camera-facing
    //     quads lit by the same stack as the terrain (T-0042). Face whichever
    //     camera the graph is currently rebuilt against so billboards yaw
    //     toward the ortho camera in ortho mode too. `pose` here is the
    //     smoothed hero world position (T-0062, docs/gpu-thirdperson.md
    //     "Motion") so the hero avatar/quad glides; `dt` drives the same
    //     per-sprite ease `SpriteLayer` applies to every other sprite.
    this.sprites.update(sprites, view === 'ortho' ? this.orthoCamera : this.camera, pose, frameDt);

    // 3. Mood: pinned via `?mood=` or derived from the hero's cell.
    const cellX = Math.floor(pose.x);
    const cellY = Math.floor(pose.y);
    const target: MoodId = pinnedMood ?? moodFor(level, cellX, cellY);
    if (target !== this.lastMoodDecision) {
      // A doorway is a fade, not a cut (`MOOD_BLEND_SECONDS`).
      if (this.lastMoodDecision === null) {
        this.atmosphere.set(target);
      } else {
        this.atmosphere.blendTo(target, MOOD_BLEND_SECONDS);
      }
      // `SSRNode` reads `environmentNode` at construction, so it keeps the
      // old texture (which the atmosphere just disposed inside `_rebuildEnv`)
      // until we swap it. Guarded because `nodes.ssr` is absent on the `low`
      // tier and `setEnvMap` is a newer three addition. Never throws — a
      // failure here must not take down the render loop.
      const ssr = this.handle.state.nodes['ssr'] as { setEnvMap?: (t: unknown) => void } | undefined;
      if (ssr !== undefined && typeof ssr.setEnvMap === 'function') {
        try { ssr.setEnvMap(this.atmosphere.environment); } catch { /* swallow */ }
      }
      this.lastMoodDecision = target;
      this.mood = target;
    }

    // 4. Advance the atmosphere blend. `dt` clamped so a paused tab does not
    //    fast-forward a mood on resume.
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const dt = this.lastTime === 0 ? 0.016 : Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.atmosphere.update(dt);

    // 4b. Drive our own fog uniforms from the atmosphere's current mood,
    //     scaling density per view (T-0050 rework 3, T-0054). The atmosphere's
    //     blend already ran; `moodFogDensityForView` is a multiplicative scale
    //     with three branches — pass-through for fps, `ORTHO_FOG_DENSITY /
    //     FPS_FOG_DENSITY` (= 0.1) for the ortho stand-off at 40 cells, and
    //     `THIRD_FOG_DENSITY / FPS_FOG_DENSITY` (= 0.4) for the diorama
    //     follow at ~10.7 cells — so deep_dark's heavier fog stays
    //     proportionally heavier than torchlit's in every view. The view name
    //     is passed straight through: mapping `'third'` back to `'fps'` here
    //     left the T-0054 helper as dead code and the diorama at 34 %
    //     survival (measured mean luminance 8.0 vs 54.0 fps / 28.8 ortho).
    const currentMood = this.atmosphere.state;
    this.fogColor.value.setHex(currentMood.fog.color);
    this.fogDensity.value = moodFogDensityForView(view, currentMood.fog.density);

    // 5. Apply the styled/raw grade overrides *after* the mood writes so the
    //    mood's vignette/grain don't leak into styled mode (docs/gpu.md §6.1).
    if (mode === 'styled') {
      const grade = styledLook(STYLE_EXPOSURE);
      this.handle.look.vignette.value = grade.vignette;
      this.handle.look.grain.value = grade.grain;
      this.handle.look.outputScale.value = grade.outputScale;
    } else {
      const grade = rawLook();
      if (grade.outputScale === undefined) this.handle.look.outputScale.value = 1;
      // vignette and grain are left alone: whatever the mood wrote applies.
    }

    // 5b. Push the far camera's distance into the DOF focus so the focal
    //     plane lands where the ticket says. Ortho: the whole board is inside
    //     `[focus ± focusRange]`. Third-person: the mood's focusRange (a few
    //     units) stays, so the hero is the only thing in the sharp slab and
    //     the near/far dungeon blurs — ART_BIBLE §6 "gentle, diorama, not mush".
    if (view === 'ortho' && orthoPlace !== null) {
      const dof = orthoDofFocus(orthoPlace);
      this.handle.look.focus.value = dof.focus;
      this.handle.look.focusRange.value = dof.focusRange;
    } else if (view === 'third' && thirdFrame !== null) {
      this.handle.look.focus.value = thirdFrame.focus;
    }

    // 5c. Advance the dungeon-air overlay (T-0044). The mood id + shared W
    //     uniforms pick which of drips/motes/embers are active and how
    //     strong; the focus point centres the wrap volume on the hero so
    //     particles follow the camera without popping.
    WEATHER_FOCUS_SCRATCH.set(pose.x, EYE_HEIGHT, pose.y);
    this.weather.update(dt, WEATHER_FOCUS_SCRATCH, target);

    // 6. Size and render.
    this.resizeTo(size.w, size.h);
    this.handle.render();
  }

  /**
   * Rebuild the ortho cutaway ghost mesh iff the hero cell moved
   * (`cutawayKey(hero)` is the memo). The ghost mesh sits at wall cells the
   * cutaway box crosses — see `docs/gpu-ortho.md` §"the ghost mesh" for why
   * this is option (a) and what it does not fix.
   */
  private refreshGhostMesh(level: LevelView, hero: { x: number; y: number }): void {
    const key = cutawayKey(hero);
    if (key === this.lastGhostKey) return;
    this.lastGhostKey = key;
    this.disposeGhostMesh();
    const cells = cutawayCellsFor(hero);
    for (const cellKey of cells) {
      const [xs, ys] = cellKey.split(',');
      if (xs === undefined || ys === undefined) continue;
      const cx = Number(xs);
      const cy = Number(ys);
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
      if (cx < 0 || cy < 0 || cx >= level.width || cy >= level.height) continue;
      // Only wall cells earn a ghost cube — nothing to hide over floors.
      if (!isSolid(level.kindAt(cx, cy))) continue;
      const mesh = new WG.Mesh(this.ghostGeom, this.ghostMaterial);
      mesh.position.set(cx + 0.5, 0.5, cy + 0.5);
      mesh.frustumCulled = false;
      // Late render order so the ghost draws after the opaque merged chunk
      // it sits on; without this the depth-sorted transparency queue can
      // put it behind the wall on some backends.
      mesh.renderOrder = 999;
      this.ghostGroup.add(mesh);
    }
  }

  /** Drop every mesh under the ghost group. Geometry + material are shared
   *  and outlive individual meshes, so only the wrapper `Mesh`es get freed. */
  private disposeGhostMesh(): void {
    while (this.ghostGroup.children.length > 0) {
      const child = this.ghostGroup.children[this.ghostGroup.children.length - 1]!;
      this.ghostGroup.remove(child);
    }
  }

  /** Called when viewport cells resize; the next `render` recomputes size. */
  notifyResize(): void {
    // The pipeline's `renderer.setSize` is called every frame from `render`
    // with the fresh target size, so we do not need to do anything here.
  }

  /** Free every GPU-side resource the path owns. */
  dispose(): void {
    try { this.disposeGhostMesh(); } catch { /* ignore */ }
    try { this.ghostGeom.dispose(); } catch { /* ignore */ }
    try { this.ghostMaterial.dispose(); } catch { /* ignore */ }
    try { this.compositor.dispose(); } catch { /* ignore */ }
    try { this.sprites.dispose(); } catch { /* ignore */ }
    try { this.weather.dispose(); } catch { /* ignore */ }
    try { this.dungeon.dispose(); } catch { /* ignore */ }
    try { this.renderer.dispose(); } catch { /* ignore */ }
  }
}
