// The post stack that makes boxes look like a photographed diorama.
//   scene MRT → SSGI (AO + bounce) → SSR (wet/metal reflections) → god rays → TRAA → DOF → bloom
//   → tone map (AgX) → grade (split-tone, contrast, saturation) → vignette → grain
// Everything tunable lives in `look` (uniforms) so moods can animate it.
import * as THREE from 'three/webgpu';
import {
  pass, mrt, output, normalView, diffuseColor, velocity, metalness, roughness,
  vec2, vec3, vec4, float, int, uniform, color, add, mix, smoothstep, clamp, max, min, dot, pow,
  packNormalToRGB, unpackRGBToNormal, sample, convertToTexture, screenUV, screenCoordinate, time, renderOutput,
  interleavedGradientNoise, luminance,
} from 'three/tsl';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { ao as gtao } from 'three/addons/tsl/display/GTAONode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { godrays } from 'three/addons/tsl/display/GodraysNode.js';
import { bilateralBlur } from 'three/addons/tsl/display/BilateralBlurNode.js';
import { depthAwareBlend } from 'three/addons/tsl/display/depthAwareBlend.js';

export const QUALITY = {
  low: { gi: 'none', ssr: false, rays: false, aa: 'fxaa', dof: false, bloom: true, shadow: 2048, scale: 1 },
  medium: { gi: 'ao', ssr: true, ssrQ: 0.35, ssrScale: 0.5, rays: false, aa: 'traa', dof: true, bloom: true, shadow: 2048, scale: 1 },
  high: { gi: 'ssgi', slices: 1, steps: 12, ssr: true, ssrQ: 0.5, ssrScale: 0.5, rays: true, raySteps: 40, aa: 'traa', dof: true, bloom: true, shadow: 4096, scale: 1 },
  ultra: { gi: 'ssgi', slices: 2, steps: 10, ssr: true, ssrQ: 0.75, ssrScale: 1, rays: true, raySteps: 72, aa: 'traa', dof: true, bloom: true, shadow: 4096, scale: 1 },
};

/** Tunable look uniforms (moods animate these). */
export function createLook() {
  return {
    giIntensity: uniform(9.0), aoIntensity: uniform(1.35), giRadius: uniform(7.0),
    ssrIntensity: uniform(0.85),
    rayDensity: uniform(0.0035), rayMax: uniform(0.3), rayColor: uniform(color(0xffd9ac)),
    focus: uniform(30.0), focusRange: uniform(38.0), bokeh: uniform(1.0),
    bloomStrength: uniform(0.22), bloomRadius: uniform(0.55), bloomThreshold: uniform(1.0),
    // grade
    exposure: uniform(1.0), contrast: uniform(1.06), saturation: uniform(1.02),
    shadowTint: uniform(color(0x0e2a33)), highlightTint: uniform(color(0xfff1dc)), tintAmount: uniform(0.16),
    vignette: uniform(0.42), grain: uniform(0.028),
    maxRadiance: uniform(8.0),
    fade: uniform(1.0), // 0 = black (scene transitions)
  };
}

/**
 * @param {{renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, sun?: THREE.DirectionalLight, quality?: keyof QUALITY, look?: ReturnType<typeof createLook>, overlay?: THREE.Scene}} o
 *   overlay: a scene of additive, unlit effects (weather) composited after the lighting stack
 */
export function createPipeline({ renderer, scene, camera, sun = null, quality = 'high', look = createLook(), overlay = null, override = null }) {
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = false; // we tone-map ourselves, then grade in display space
  const state = { quality, nodes: {} };

  function build(qName) {
    const q = { ...(QUALITY[qName] || QUALITY.high), ...(override || {}) }; // override: dev-only per-pass switches (profiling)
    state.quality = qName;
    const scenePass = pass(scene, camera);
    const needNormal = q.gi !== 'none' || q.ssr;
    const targets = { output };
    if (q.gi === 'ssgi') targets.diffuseColor = diffuseColor;
    if (needNormal) targets.normal = packNormalToRGB(normalView);
    if (q.ssr) targets.metalrough = vec2(metalness, roughness);
    if (q.aa === 'traa') targets.velocity = velocity;
    scenePass.setMRT(mrt(targets));
    for (const k of ['diffuseColor', 'normal', 'metalrough']) if (targets[k]) scenePass.getTexture(k).type = THREE.UnsignedByteType;

    const pColor = scenePass.getTextureNode('output');
    const pDepth = scenePass.getTextureNode('depth');
    const pNormal = needNormal ? sample((uv) => unpackRGBToNormal(scenePass.getTextureNode('normal').sample(uv))) : null;

    let node = pColor;

    if (q.gi === 'ssgi') {
      const gi = ssgi(pColor, pDepth, pNormal, camera);
      gi.sliceCount.value = q.slices; gi.stepCount.value = q.steps;
      gi.radius = look.giRadius; gi.giIntensity = look.giIntensity; gi.aoIntensity = look.aoIntensity;
      gi.thickness.value = 0.6;
      // SSGI has no resolution knob of its own and is the most expensive pass: run it on a smaller target.
      // GI/AO are low-frequency; bilinear upsampling + TRAA hide the difference.
      const giScale = q.giScale ?? 1;
      if (giScale !== 1) { const setSize = gi.setSize.bind(gi); gi.setSize = (w, h) => setSize(Math.max(1, Math.round(w * giScale)), Math.max(1, Math.round(h * giScale))); }
      const pDiffuse = scenePass.getTextureNode('diffuseColor');
      node = vec4(add(pColor.rgb.mul(gi.getAONode().r), pDiffuse.rgb.mul(gi.getGINode().rgb)), pColor.a);
      state.nodes.gi = gi;
    } else if (q.gi === 'ao') {
      const aoPass = gtao(pDepth, pNormal, camera);
      aoPass.resolutionScale = 0.5;
      node = vec4(pColor.rgb.mul(aoPass.getTextureNode().r), pColor.a);
      state.nodes.ao = aoPass;
    }

    if (q.ssr) {
      const mr = scenePass.getTextureNode('metalrough');
      const r = ssr(pColor, pDepth, pNormal, { metalnessNode: mr.r, roughnessNode: mr.g, reflectNonMetals: true, camera });
      r.maxDistance.value = 40; r.thickness.value = 0.4; r.quality.value = q.ssrQ; r.intensity = look.ssrIntensity; r.resolutionScale = q.ssrScale ?? 1;
      node = vec4(node.rgb.add(r.rgb), node.a);
      state.nodes.ssr = r;
    }

    if (q.rays && sun) {
      const g = godrays(pDepth, camera, sun);
      g.density = look.rayDensity; g.maxDensity = look.rayMax; g.distanceAttenuation.value = 0.02; g.raymarchSteps.value = q.raySteps;
      const blur = bilateralBlur(g.getTextureNode());
      node = depthAwareBlend(convertToTexture(node), blur.getTextureNode(), pDepth, camera, { blendColor: look.rayColor, edgeRadius: uniform(int(2)), edgeStrength: uniform(float(2)) });
      state.nodes.rays = g;
    }

    // weather overlay (rain, motes): its own pass so transparent quads never touch the G-buffer that SSGI/SSR read
    if (overlay) { const op = pass(overlay, camera); node = vec4(node.rgb.add(op.getTextureNode('output').rgb), node.a); state.overlayPass = op; }

    // tame fireflies (sun/moon glints on mirror puddles) before they hit TRAA history, DOF bokeh and bloom
    node = vec4(min(node.rgb, vec3(look.maxRadiance)), node.a);

    if (q.aa === 'traa') node = traa(node, pDepth, scenePass.getTextureNode('velocity'), camera);

    if (q.dof) node = dof(node, scenePass.getViewZNode(), look.focus, look.focusRange, look.bokeh);

    if (q.bloom) {
      const b = bloom(node, 1, 0.5, 1);
      b.strength = look.bloomStrength; b.radius = look.bloomRadius; b.threshold = look.bloomThreshold;
      node = node.add(b);
      state.nodes.bloom = b;
    }

    // ---- display-space finishing ----
    let o = renderOutput(vec4(node.rgb.mul(look.exposure), 1.0)); // tone map + sRGB
    if (q.aa === 'fxaa') o = fxaa(convertToTexture(o));
    let c = o.rgb;
    // split-tone: shadows toward teal, highlights toward warm
    const l = luminance(c);
    const tint = mix(look.shadowTint, look.highlightTint, smoothstep(0.0, 0.75, l));
    c = mix(c, c.mul(tint).mul(1.9), look.tintAmount);
    // contrast around mid grey, saturation
    c = c.sub(0.5).mul(look.contrast).add(0.5);
    c = mix(vec3(luminance(c)), c, look.saturation);
    // vignette
    const d = screenUV.sub(0.5).mul(vec2(1.0, 0.85)).length();
    c = c.mul(mix(float(1.0), smoothstep(0.85, 0.2, d), look.vignette));
    // grain (animated, luminance-weighted so blacks stay clean-ish)
    const n = interleavedGradientNoise(screenCoordinate.xy.add(time.mul(61.0).floor().mul(vec2(37.0, 17.0)))).sub(0.5);
    c = c.add(n.mul(look.grain).mul(mix(1.0, 0.35, l)));
    c = clamp(c, 0.0, 1.0).mul(look.fade);
    pipeline.outputNode = vec4(c, 1.0);
    pipeline.needsUpdate = true;
    state.scenePass = scenePass;
  }

  build(quality);

  return {
    pipeline, look, state,
    setQuality(q) { if (q !== state.quality) build(q); },
    render() { pipeline.render(); },
  };
}
