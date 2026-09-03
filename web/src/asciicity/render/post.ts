/**
 * Generic style post-process (docs/architecture.md §4.11): render the 3D
 * scene into a low-res target, then paint a full-screen quad with the active
 * `RenderStyle` fragment (compiled against `STYLE_PRELUDE`).
 *
 * Browser-only — needs a `WebGLRenderer`. Pure style data lives in
 * `src/render/styles/`.
 */
import * as THREE from 'three';
import {
  STYLE_PRELUDE,
  STYLE_VERTEX,
  type RenderStyle,
  type StyleContext,
} from './style';

/** Hard cap on the scene target (architecture.md §4.11) so every style stays ≥ 30 fps. */
export const MAX_TARGET_W = 640;
/** Hard cap on the scene-target height at 1080p. */
export const MAX_TARGET_H = 360;

/**
 * Cell grid for a style at a canvas size. `?cell=` overrides `cellW`/`cellH`;
 * the product `cols·subX × rows·subY` is clamped to {@link MAX_TARGET_W}×
 * {@link MAX_TARGET_H} so a 2×2-cell style at 1080p does not allocate a
 * 960×540 target.
 */
export function styleGrid(
  style: Pick<RenderStyle, 'cellW' | 'cellH' | 'subX' | 'subY'>,
  width: number,
  height: number,
  cellW = style.cellW,
  cellH = style.cellH,
): { cols: number; rows: number } {
  const cols = Math.max(1, Math.floor(width / cellW));
  const rows = Math.max(1, Math.floor(height / cellH));
  const maxCols = Math.max(1, Math.floor(MAX_TARGET_W / style.subX));
  const maxRows = Math.max(1, Math.floor(MAX_TARGET_H / style.subY));
  return {
    cols: Math.min(cols, maxCols),
    rows: Math.min(rows, maxRows),
  };
}

/** Constructor options for {@link StyleRenderer}. */
export interface StyleRendererOptions {
  /** Style id to activate (`?render=`); unknown falls back to `ascii`. */
  initial?: string;
  /** `?cell=` override applied to every style's `cellW`. */
  cellW?: number;
  /** `?cell=` override applied to every style's `cellH`. */
  cellH?: number;
  /** Scene brightness multiplier (default 1.7). */
  exposure?: number;
  /** Density curve exponent (default 0.45). */
  gamma?: number;
}

/**
 * Owns the scene target, the full-screen quad, and the common uniforms, and
 * swaps `RenderStyle`s at runtime (`setStyle` / `next`).
 */
export class StyleRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly _styles: readonly RenderStyle[];
  private readonly cellWOverride: number | undefined;
  private readonly cellHOverride: number | undefined;
  private readonly exposure: number;
  private readonly gamma: number;
  private readonly startedAt: number;
  private readonly dummyDepth: THREE.DepthTexture;
  private readonly quadGeom: THREE.PlaneGeometry;
  private readonly quadScene: THREE.Scene;
  private readonly orthoCamera: THREE.OrthographicCamera;
  private readonly common: Record<string, THREE.IUniform>;
  private quadMesh: THREE.Mesh | null = null;

  private _index = 0;
  private _cols = 1;
  private _rows = 1;
  private width = 1;
  private height = 1;
  private target!: THREE.WebGLRenderTarget;
  private material!: THREE.ShaderMaterial;
  private styleUniforms: Record<string, THREE.IUniform> = {};

  constructor(
    renderer: THREE.WebGLRenderer,
    styles: readonly RenderStyle[],
    opts?: StyleRendererOptions,
  ) {
    if (styles.length === 0) throw new Error('StyleRenderer: no styles');
    this.renderer = renderer;
    this._styles = styles;
    this.cellWOverride = opts?.cellW;
    this.cellHOverride = opts?.cellH;
    this.exposure = opts?.exposure ?? 1.7;
    this.gamma = opts?.gamma ?? 0.45;
    this.startedAt = performance.now();

    this.dummyDepth = new THREE.DepthTexture(1, 1);
    this.quadGeom = new THREE.PlaneGeometry(2, 2);
    this.quadScene = new THREE.Scene();
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.common = {
      tScene: { value: null },
      grid: { value: new THREE.Vector2(1, 1) },
      sub: { value: new THREE.Vector2(1, 1) },
      sceneSize: { value: new THREE.Vector2(1, 1) },
      exposure: { value: this.exposure },
      gamma: { value: this.gamma },
      time: { value: 0 },
      tDepth: { value: this.dummyDepth },
      cameraNear: { value: 0.3 },
      cameraFar: { value: 2000 },
    };

    const wanted = opts?.initial ?? 'ascii';
    const found = styles.findIndex((s) => s.id === wanted);
    const ascii = styles.findIndex((s) => s.id === 'ascii');
    this._index = found >= 0 ? found : ascii >= 0 ? ascii : 0;

    this.build();
    const mesh = new THREE.Mesh(this.quadGeom, this.material);
    this.quadMesh = mesh;
    this.quadScene.add(mesh);
  }

  /** Registry in cycle order. */
  get styles(): readonly RenderStyle[] {
    return this._styles;
  }

  /** The currently active style. */
  get style(): RenderStyle {
    return this._styles[this._index];
  }

  /** Canvas cell columns after the last `setSize`. */
  get cols(): number {
    return this._cols;
  }

  /** Canvas cell rows after the last `setSize`. */
  get rows(): number {
    return this._rows;
  }

  /**
   * Activate `id`. Returns `false` and no-ops for unknown ids; otherwise
   * disposes the previous style and rebuilds the target/material at the
   * current canvas size.
   */
  setStyle(id: string): boolean {
    const idx = this._styles.findIndex((s) => s.id === id);
    if (idx < 0) return false;
    if (idx === this._index) return true;
    this.dropStyle();
    this._index = idx;
    this.build();
    return true;
  }

  /** Cycle `step` entries (negative for Shift+R). Wraps. */
  next(step = 1): RenderStyle {
    const n = this._styles.length;
    const idx = (((this._index + step) % n) + n) % n;
    if (idx !== this._index) {
      this.dropStyle();
      this._index = idx;
      this.build();
    }
    return this.style;
  }

  /**
   * Resize the canvas renderer and recompute the cell grid. The scene target
   * is resized only when `cols/rows` actually change.
   */
  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
    const { cols, rows } = this.gridFor(this.style);
    if (cols === this._cols && rows === this._rows) {
      this.syncCommon();
      return;
    }
    this._cols = cols;
    this._rows = rows;
    const tw = Math.max(1, cols * this.style.subX);
    const th = Math.max(1, rows * this.style.subY);
    this.target.setSize(tw, th);
    this.syncCommon();
  }

  /**
   * Render the scene into the low-res target, update common uniforms, then
   * paint the style quad to the canvas.
   */
  render(scene: THREE.Scene, camera: THREE.Camera): void {
    const timeS = (performance.now() - this.startedAt) / 1000;
    this.common.time.value = timeS;
    if (camera instanceof THREE.PerspectiveCamera) {
      this.common.cameraNear.value = camera.near;
      this.common.cameraFar.value = camera.far;
    }
    this.style.update?.(this.material.uniforms, timeS, this.ctx());
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.quadScene, this.orthoCamera);
  }

  /** Release GPU resources owned by this renderer. */
  dispose(): void {
    this.dropStyle();
    this.quadGeom.dispose();
    this.dummyDepth.dispose();
  }

  /** Dispose the *current* style's uniforms, material and target. */
  private dropStyle(): void {
    this.style.dispose?.(this.styleUniforms);
    this.styleUniforms = {};
    this.material.dispose();
    this.target.dispose();
  }

  /** Build target + material for `this.style` at the current canvas size. */
  private build(): void {
    const style = this.style;
    const { cols, rows } = this.gridFor(style);
    this._cols = cols;
    this._rows = rows;
    const tw = Math.max(1, cols * style.subX);
    const th = Math.max(1, rows * style.subY);
    this.target = this.makeTarget(tw, th, style.needsDepth);
    this.styleUniforms = style.makeUniforms(this.ctx());
    this.material = this.makeMaterial(style, this.styleUniforms);
    if (this.quadMesh) this.quadMesh.material = this.material;
    this.syncCommon();
  }

  private makeTarget(
    width: number,
    height: number,
    needsDepth: boolean,
  ): THREE.WebGLRenderTarget {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const opts: THREE.RenderTargetOptions = {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
    };
    // Omit `depthTexture` when unused — passing `undefined` throws in three r185
    // (`textures[0]` is not yet assigned inside the RenderTarget setter).
    if (needsDepth) opts.depthTexture = new THREE.DepthTexture(w, h);
    return new THREE.WebGLRenderTarget(w, h, opts);
  }

  private makeMaterial(
    style: RenderStyle,
    styleUniforms: Record<string, THREE.IUniform>,
  ): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: { ...this.common, ...styleUniforms },
      vertexShader: STYLE_VERTEX,
      fragmentShader: STYLE_PRELUDE + style.fragment,
      depthTest: false,
      depthWrite: false,
    });
  }

  private gridFor(style: RenderStyle): { cols: number; rows: number } {
    return styleGrid(
      style,
      this.width,
      this.height,
      this.cellWOverride ?? style.cellW,
      this.cellHOverride ?? style.cellH,
    );
  }

  private ctx(): StyleContext {
    return {
      cols: this._cols,
      rows: this._rows,
      makeCanvas(width: number, height: number): HTMLCanvasElement {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        return canvas;
      },
    };
  }

  private syncCommon(): void {
    const style = this.style;
    const cols = this._cols;
    const rows = this._rows;
    (this.common.grid.value as THREE.Vector2).set(cols, rows);
    (this.common.sub.value as THREE.Vector2).set(style.subX, style.subY);
    (this.common.sceneSize.value as THREE.Vector2).set(
      cols * style.subX,
      rows * style.subY,
    );
    this.common.tScene.value = this.target.texture;
    this.common.tDepth.value = style.needsDepth
      ? (this.target.depthTexture ?? this.dummyDepth)
      : this.dummyDepth;
  }
}
