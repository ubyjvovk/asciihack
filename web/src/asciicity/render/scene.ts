/**
 * Renderer, scene and camera factories with the locked constants from
 * docs/architecture.md §6.
 */
import * as THREE from 'three';

/** Create the WebGL renderer with the locked flags (antialias off, pixel ratio 1). */
export function makeRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  return renderer;
}

/** Create the scene with black background, exponential fog and the three lights. */
export function makeScene(): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  scene.fog = new THREE.FogExp2(0x000000, 0.0018);

  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambient);

  const directional = new THREE.DirectionalLight(0xffffff, 1.1);
  directional.position.set(1, 2, 0.5);
  scene.add(directional);

  const hemisphere = new THREE.HemisphereLight(0x223344, 0x080808, 0.4);
  scene.add(hemisphere);

  return scene;
}

/** Create the perspective camera: 70° FOV, near 0.3, far 2000. */
export function makeCamera(aspect: number): THREE.PerspectiveCamera {
  return new THREE.PerspectiveCamera(70, aspect, 0.3, 2000);
}
