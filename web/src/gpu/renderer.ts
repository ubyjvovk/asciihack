/**
 * WebGPU renderer bootstrap (browser-only) ported from
 * `~/afterburn/src/render/renderer.js` and specified by `docs/gpu.md` §3.
 * Probes `navigator.gpu` for the adapter's `maxColorAttachmentBytesPerSample`,
 * constructs a `WebGPURenderer` requesting a 64-byte MRT budget, applies AgX
 * tone mapping at exposure 1.0 and PCF soft shadows, awaits
 * `renderer.init()`, and returns the renderer alongside the caps needed by
 * `createPipeline` and `clampQuality`.
 *
 * Never throws on a missing `navigator.gpu`: three.js falls back to a
 * WebGL2 backend, which is a supported (but capped at `'medium'`) outcome.
 */
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { clampQuality, type QualityName, type RendererCaps } from './pipeline.js';

const MRT_LIMIT_BYTES = 64;

/** Result of `createRenderer`: the live renderer + probed caps. */
export interface RendererBundle {
  renderer: WebGPURenderer;
  caps: RendererCaps;
}

interface AdapterProbe {
  webgpu: boolean;
  mrtBytes: number;
}

async function probeAdapter(): Promise<AdapterProbe> {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const gpu = nav !== undefined ? (nav as Navigator & { gpu?: GPU }).gpu : undefined;
  if (gpu === undefined) return { webgpu: false, mrtBytes: 0 };
  try {
    const adapter = await gpu.requestAdapter();
    if (adapter === null) return { webgpu: false, mrtBytes: 0 };
    const raw = (adapter.limits as unknown as Record<string, number>)['maxColorAttachmentBytesPerSample'];
    const mrtBytes = typeof raw === 'number' && Number.isFinite(raw) ? raw : 32;
    return { webgpu: true, mrtBytes };
  } catch {
    return { webgpu: false, mrtBytes: 0 };
  }
}

/** Options for `createRenderer`. `canvas` is optional so three can create one. */
export interface CreateRendererOptions {
  readonly canvas?: HTMLCanvasElement;
  readonly antialias?: boolean;
  readonly powerPreference?: 'default' | 'high-performance' | 'low-power';
}

/**
 * Build the WebGPU renderer + probe caps. Awaits `renderer.init()` before
 * returning. If the adapter probe fails, the renderer still initialises
 * (three.js falls back to WebGL2); `caps.webgpu` will be `false` and
 * `caps.maxQuality` will be `'medium'`.
 */
export async function createRenderer(opts: CreateRendererOptions = {}): Promise<RendererBundle> {
  const probe = await probeAdapter();

  const renderer = new WebGPURenderer({
    canvas: opts.canvas,
    antialias: opts.antialias ?? false,
    powerPreference: opts.powerPreference ?? 'high-performance',
    requiredLimits: { maxColorAttachmentBytesPerSample: MRT_LIMIT_BYTES },
  });
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  await renderer.init();

  const capsBase: RendererCaps = {
    webgpu: probe.webgpu,
    mrtBytes: probe.mrtBytes,
    maxQuality: 'ultra',
  };
  const maxQuality: QualityName = clampQuality('ultra', capsBase);

  return {
    renderer,
    caps: { ...capsBase, maxQuality },
  };
}
