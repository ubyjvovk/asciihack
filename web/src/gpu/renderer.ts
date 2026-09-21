/**
 * WebGPU renderer bootstrap (browser-only) — strict-TypeScript port of
 * `vendor/afterburn/src/render/renderer.js` (afterburn commit 8492a00).
 * Probes `navigator.gpu` for `maxColorAttachmentBytesPerSample`, then
 * constructs a `WebGPURenderer` — requesting the 64-byte MRT budget only
 * when the probe reports it is available — applies AgX tone mapping at
 * exposure 1.0, PCF soft shadows, awaits `renderer.init()`, and returns
 * `{ renderer, caps }` per `docs/gpu.md` §3. Never throws for a missing
 * `navigator.gpu`: three's WebGL2 fallback backend is a supported outcome
 * and gets `caps.webgpu = false`, `caps.maxQuality = 'medium'`.
 */
import * as THREE from 'three/webgpu';
import type { QualityName, RendererCaps } from './pipeline.js';

/** Probe the adapter so we never request limits the device cannot give. */
interface AdapterProbe {
  webgpu: boolean;
  mrtBytes: number;
}

// Minimal WebGPU adapter shape — the `@webgpu/types` package isn't installed
// and the standard DOM lib doesn't declare `navigator.gpu`.
interface MinimalAdapter {
  limits: Record<string, number>;
}
interface MinimalGpu {
  requestAdapter(options?: { powerPreference?: 'high-performance' | 'low-power' }): Promise<MinimalAdapter | null>;
}

async function probe(): Promise<AdapterProbe> {
  const out: AdapterProbe = { webgpu: false, mrtBytes: 32 };
  try {
    const nav = typeof navigator !== 'undefined' ? (navigator as unknown as { gpu?: MinimalGpu }) : undefined;
    const gpu = nav?.gpu;
    if (gpu !== undefined) {
      const ad = await gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (ad !== null) {
        out.webgpu = true;
        const raw = ad.limits['maxColorAttachmentBytesPerSample'];
        out.mrtBytes = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 32;
      }
    }
  } catch {
    // fall through to WebGL2 backend
  }
  return out;
}

/** Options for `createRenderer`; matches afterburn's `{ canvas, maxDpr }` shape. */
export interface CreateRendererOptions {
  canvas?: HTMLCanvasElement;
  maxDpr?: number;
}

/** Result of `createRenderer`: the initialised renderer plus the probed caps. */
export interface RendererBundle {
  renderer: THREE.WebGPURenderer;
  caps: RendererCaps;
}

/**
 * Build the WebGPU renderer + probe caps. Awaits `renderer.init()` before
 * returning; if the adapter probe fails, the renderer still initialises
 * (three falls back to WebGL2) and `caps.webgpu` will be `false` /
 * `caps.maxQuality` will be `'medium'`.
 */
export async function createRenderer(o: CreateRendererOptions = {}): Promise<RendererBundle> {
  const { canvas, maxDpr = 1.5 } = o;
  const caps: { webgpu: boolean; mrtBytes: number } = await probe();
  const params: THREE.WebGPURendererParameters = {
    antialias: false,
    powerPreference: 'high-performance',
  };
  if (canvas !== undefined) params.canvas = canvas;
  if (caps.webgpu && caps.mrtBytes >= 64) {
    params.requiredLimits = { maxColorAttachmentBytesPerSample: 64 };
  }
  const renderer = new THREE.WebGPURenderer(params);
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  renderer.setPixelRatio(Math.min(dpr, maxDpr));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.0;
  await renderer.init();
  const backend = renderer.backend as unknown as { isWebGPUBackend?: boolean } | undefined;
  const isWebGPU = backend?.isWebGPUBackend === true;
  // Full MRT stack needs the raised attachment budget; otherwise cap quality.
  const maxQuality: QualityName = isWebGPU && caps.mrtBytes >= 64 ? 'ultra' : 'medium';
  return {
    renderer,
    caps: { webgpu: isWebGPU, mrtBytes: caps.mrtBytes, maxQuality },
  };
}
