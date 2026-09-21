// WebGPU renderer bootstrap with capability checks.
import * as THREE from 'three/webgpu';

/** Probe the adapter so we never request limits the device cannot give. */
async function probe() {
  const out = { webgpu: false, mrtBytes: 32 };
  try {
    if (navigator.gpu) {
      const ad = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (ad) { out.webgpu = true; out.mrtBytes = ad.limits.maxColorAttachmentBytesPerSample || 32; }
    }
  } catch { /* fall through to WebGL2 backend */ }
  return out;
}

/**
 * @param {{canvas?: HTMLCanvasElement, maxDpr?: number}} [o]
 * @returns {Promise<{renderer: THREE.WebGPURenderer, caps: {webgpu: boolean, mrtBytes: number, maxQuality: string}}>}
 */
export async function createRenderer({ canvas, maxDpr = 1.5 } = {}) {
  const caps = await probe();
  const params = { antialias: false, powerPreference: 'high-performance' };
  if (canvas) params.canvas = canvas;
  if (caps.webgpu && caps.mrtBytes >= 64) params.requiredLimits = { maxColorAttachmentBytesPerSample: 64 };
  const renderer = new THREE.WebGPURenderer(params);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxDpr));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.0;
  await renderer.init();
  const isWebGPU = renderer.backend?.isWebGPUBackend === true;
  caps.webgpu = isWebGPU;
  // Full MRT stack needs the raised attachment budget; otherwise cap quality.
  caps.maxQuality = isWebGPU && caps.mrtBytes >= 64 ? 'ultra' : 'medium';
  return { renderer, caps };
}
