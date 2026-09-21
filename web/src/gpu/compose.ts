/**
 * Blit the GPU-owned canvas through AsciiCity's untouched style pass
 * (docs/gpu.md §6, docs/gpu-compose.md).
 *
 * The style shaders are raw GLSL on a `WebGLRenderer`, so a `WebGPURenderer`
 * cannot run them. Instead the GPU pipeline renders into its **own** canvas;
 * `GpuCompositor` wraps that canvas in a `THREE.CanvasTexture` on a
 * full-screen quad in a one-mesh scene, and hands that scene to the
 * untouched `StyleRenderer.render(scene, camera)`. The quad's vertex shader
 * writes clip space directly and ignores the camera, so the real perspective
 * camera is passed in and the style prelude's `cameraNear` / `cameraFar`
 * uniforms stay correct. Browser-only — needs `WebGLRenderer` under the
 * style renderer and a canvas 2D image source.
 */
import * as THREE from 'three';
import type { StyleRenderer } from '../asciicity/render/post.js';

/**
 * Owns the compose-side scene: a `THREE.CanvasTexture` wrapping the source
 * GPU canvas + a full-screen quad + a one-mesh `THREE.Scene`. Call
 * `render(styleRenderer, camera)` once per frame after the GPU pipeline has
 * finished drawing into the source canvas; `dispose()` frees the quad,
 * material and texture.
 */
export class GpuCompositor {
  readonly scene: THREE.Scene;
  readonly texture: THREE.CanvasTexture;
  private readonly geometry: THREE.PlaneGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly mesh: THREE.Mesh;

  constructor(source: HTMLCanvasElement) {
    // Nearest so a pixel-exact GPU frame does not soften; no mipmaps to keep
    // reallocation on canvas resize cheap.
    this.texture = new THREE.CanvasTexture(source);
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.flipY = true;

    this.geometry = new THREE.PlaneGeometry(2, 2);
    this.material = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: this.texture } },
      vertexShader: COMPOSE_VERTEX,
      fragmentShader: COMPOSE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
  }

  /**
   * Push the GPU canvas' contents through `styleRenderer`. `camera` must be
   * the real perspective camera the GPU frame was rendered with so the
   * style prelude's `cameraNear` / `cameraFar` land at the correct values;
   * the quad's own vertex shader ignores it.
   */
  render(styleRenderer: StyleRenderer, camera: THREE.PerspectiveCamera): void {
    this.texture.needsUpdate = true;
    styleRenderer.render(this.scene, camera);
  }

  /** Free the quad, material and canvas texture. */
  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

/** Trivial clip-space quad. */
const COMPOSE_VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Straight blit; the style pass downstream does its own quantisation. */
const COMPOSE_FRAGMENT = `
precision highp float;
uniform sampler2D tSrc;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(tSrc, vUv);
}
`;
