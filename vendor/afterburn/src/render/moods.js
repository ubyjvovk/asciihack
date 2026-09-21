// Moods = complete lighting/atmosphere states (ART_BIBLE §5) + the Atmosphere rig that blends between them.
import * as THREE from 'three/webgpu';
import {
  uniform, color, vec2, vec3, vec4, float, mix, smoothstep, max, pow, dot, normalize, cross, positionLocal, abs, floor, fract, sin, step, time, exp, mx_noise_float,
  rangeFogFactor, positionWorld, cameraPosition, fog, densityFogFactor, mx_fractal_noise_float,
} from 'three/tsl';
import { W } from './materials.js';

const deg = Math.PI / 180;

/**
 * az: compass direction the light comes FROM (0 = north/-Z, 90 = east/+X). el: elevation above horizon.
 * Colours are sRGB hex. Intensities are tuned against exposure 1.0 with AgX.
 */
export const MOODS = {
  storm_night: {
    sun: { az: 300, el: 38, color: 0x8fb2d8, intensity: 1.0 },
    hemi: { sky: 0x3a5468, ground: 0x0e1316, intensity: 0.85 },
    sky: { zenith: 0x05090d, horizon: 0x16222b, ground: 0x030506, sunGlow: 0.0, stars: 0.0, cloud: 1.0 },
    fog: { color: 0x0d161b, density: 0.018 },
    weather: { wetness: 1.0, puddles: 0.85, rain: 1.0, wind: 1.6 },
    look: { exposure: 1.0, rayDensity: 0.0, tintAmount: 0.22, saturation: 0.92, contrast: 1.08, bloomStrength: 0.3, vignette: 0.55, giIntensity: 10 },
    glow: 0.25, lampGain: 1.0, envIntensity: 0.5,
  },
  grey_dawn: {
    sun: { az: 95, el: 30, color: 0xcfd9e2, intensity: 1.5 },
    hemi: { sky: 0x8aa0ad, ground: 0x23282a, intensity: 1.0 },
    sky: { zenith: 0x53636e, horizon: 0x9aa7ad, ground: 0x1a1f22, sunGlow: 0.15, stars: 0.0, cloud: 0.95 },
    fog: { color: 0x7d8a90, density: 0.014 },
    weather: { wetness: 0.95, puddles: 0.8, rain: 0.35, wind: 1.0 },
    look: { exposure: 1.0, rayDensity: 0.001, tintAmount: 0.18, saturation: 0.9, contrast: 1.02, bloomStrength: 0.2, vignette: 0.45, giIntensity: 9 },
    glow: 0.2, lampGain: 1.4, envIntensity: 0.9,
  },
  after_rain_gold: {
    sun: { az: 292, el: 21, color: 0xffd0a0, intensity: 7.0 },
    hemi: { sky: 0x6fa7c4, ground: 0x23292a, intensity: 1.25 },
    sky: { zenith: 0x3e6e86, horizon: 0xe9b98a, ground: 0x1c1d1c, sunGlow: 1.0, stars: 0.0, cloud: 0.55 },
    fog: { color: 0xb7a58d, density: 0.0065 },
    weather: { wetness: 0.8, puddles: 0.7, rain: 0.0, wind: 0.7 },
    look: { exposure: 1.0, rayDensity: 0.0042, tintAmount: 0.2, saturation: 1.04, contrast: 1.08, bloomStrength: 0.22, vignette: 0.42, giIntensity: 5 },
    glow: 0.3, lampGain: 2.2, envIntensity: 1.0,
  },
  clear_evening: {
    sun: { az: 282, el: 12, color: 0xff9e6b, intensity: 5.5 },
    hemi: { sky: 0x6f7fb0, ground: 0x2b2326, intensity: 0.8 },
    sky: { zenith: 0x2b3f6b, horizon: 0xf0a27c, ground: 0x1b1a1c, sunGlow: 1.2, stars: 0.25, cloud: 0.2 },
    fog: { color: 0xc99a86, density: 0.005 },
    weather: { wetness: 0.35, puddles: 0.35, rain: 0.0, wind: 0.5 },
    look: { exposure: 1.0, rayDensity: 0.003, tintAmount: 0.14, saturation: 1.08, contrast: 1.05, bloomStrength: 0.24, vignette: 0.4, giIntensity: 10 },
    glow: 0.7, lampGain: 1.8, envIntensity: 1.0,
  },
  starry_night: {
    sun: { az: 140, el: 46, color: 0xa9c4ff, intensity: 1.15 },
    hemi: { sky: 0x3a4f86, ground: 0x0e1016, intensity: 0.75 },
    sky: { zenith: 0x060a1c, horizon: 0x1b2a4a, ground: 0x04050a, sunGlow: 0.0, stars: 1.0, cloud: 0.05 },
    fog: { color: 0x121c33, density: 0.006 },
    weather: { wetness: 0.25, puddles: 0.3, rain: 0.0, wind: 0.4 },
    look: { exposure: 1.0, rayDensity: 0.0, tintAmount: 0.2, saturation: 1.1, contrast: 1.06, bloomStrength: 0.34, vignette: 0.5, giIntensity: 12 },
    glow: 1.6, lampGain: 1.0, envIntensity: 0.8,
  },
  first_light: {
    sun: { az: 88, el: 8, color: 0xffb08a, intensity: 6.0 },
    hemi: { sky: 0x8d94c4, ground: 0x2a2226, intensity: 0.85 },
    sky: { zenith: 0x3d4f86, horizon: 0xffb59a, ground: 0x1c1a1e, sunGlow: 1.4, stars: 0.15, cloud: 0.3 },
    fog: { color: 0xe0a892, density: 0.008 },
    weather: { wetness: 0.4, puddles: 0.3, rain: 0.0, wind: 0.5 },
    look: { exposure: 1.0, rayDensity: 0.005, tintAmount: 0.12, saturation: 1.1, contrast: 1.04, bloomStrength: 0.26, vignette: 0.38, giIntensity: 9 },
    glow: 0.6, lampGain: 1.8, envIntensity: 1.0,
  },
  // neutral studio light for the model viewer
  studio: {
    sun: { az: 235, el: 35, color: 0xfff1e0, intensity: 4.0 },
    hemi: { sky: 0xb9c6cf, ground: 0x3a3632, intensity: 1.0 },
    sky: { zenith: 0x5b6b75, horizon: 0xaab4b8, ground: 0x2a2c2d, sunGlow: 0.3, stars: 0.0, cloud: 0.0 },
    fog: { color: 0x8f9a9e, density: 0.002 },
    weather: { wetness: 0.0, puddles: 0.0, rain: 0.0, wind: 0.6 },
    look: { exposure: 1.0, rayDensity: 0.0, tintAmount: 0.06, saturation: 1.0, contrast: 1.02, bloomStrength: 0.2, vignette: 0.3, giIntensity: 8 },
    glow: 1.0, lampGain: 1.5, envIntensity: 1.0,
  },
};

function flatten(m) {
  const c = (h) => new THREE.Color(h);
  return {
    sunAz: m.sun.az, sunEl: m.sun.el, sunColor: c(m.sun.color), sunI: m.sun.intensity,
    hemiSky: c(m.hemi.sky), hemiGround: c(m.hemi.ground), hemiI: m.hemi.intensity,
    zenith: c(m.sky.zenith), horizon: c(m.sky.horizon), groundCol: c(m.sky.ground), sunGlow: m.sky.sunGlow, stars: m.sky.stars, cloud: m.sky.cloud,
    fogColor: c(m.fog.color), fogDensity: m.fog.density,
    wetness: m.weather.wetness, puddles: m.weather.puddles, rain: m.weather.rain, wind: m.weather.wind,
    glow: m.glow, lampGain: m.lampGain, envIntensity: m.envIntensity,
    look: { ...m.look },
  };
}
function lerpState(a, b, t, out) {
  for (const k in a) {
    const va = a[k], vb = b[k];
    if (va && va.isColor) out[k] = (out[k] || new THREE.Color()).copy(va).lerp(vb, t);
    else if (k === 'look') { out.look = out.look || {}; for (const j in va) out.look[j] = va[j] + ((vb[j] ?? va[j]) - va[j]) * t; }
    else if (k === 'sunAz') { let d = ((vb - va + 540) % 360) - 180; out[k] = va + d * t; }
    else out[k] = va + (vb - va) * t;
  }
  return out;
}

export class Atmosphere {
  /**
   * @param {{scene: THREE.Scene, renderer: THREE.WebGPURenderer, look: object, shadowSize?: number, shadowRange?: number}} o
   */
  constructor({ scene, renderer, look, shadowSize = 4096, shadowRange = 46 }) {
    this.scene = scene; this.renderer = renderer; this.look = look;
    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(shadowSize, shadowSize);
    const R = shadowRange; Object.assign(this.sun.shadow.camera, { left: -R, right: R, top: R, bottom: -R, near: 1, far: 260 });
    this.sun.shadow.bias = -0.0005; this.sun.shadow.normalBias = 0.035; this.sun.shadow.radius = 2.5;
    this.shadowRange = R;
    scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1);
    scene.add(this.hemi);

    // sky dome uniforms
    this.u = {
      zenith: uniform(color(0x000000)), horizon: uniform(color(0x000000)), ground: uniform(color(0x000000)),
      sunDir: uniform(new THREE.Vector3(0, 1, 0)), sunColor: uniform(color(0xffffff)), sunGlow: uniform(0), stars: uniform(0), cloud: uniform(0),
      fogColor: uniform(color(0x000000)), fogDensity: uniform(0.01),
    };
    this.sky = this._makeSky();
    scene.add(this.sky);
    scene.fogNode = fog(this.u.fogColor, densityFogFactor(this.u.fogDensity));

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this._envScene = new THREE.Scene();
    this._envScene.add(this._makeSky(true));
    this._envRT = null; this._envDirty = true; this._envClock = 0;

    this.focus = new THREE.Vector3();
    this.flash = 0; // lightning
    this.cur = flatten(MOODS.studio); this.from = null; this.to = null; this.t = 1; this.dur = 0; this.name = 'studio';
    this._apply();
  }

  _makeSky(forEnv = false) {
    const u = this.u;
    const geo = new THREE.SphereGeometry(forEnv ? 50 : 420, 32, 16);
    const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    const dir = normalize(positionLocal);
    const h = dir.y;
    let col = mix(u.horizon, u.zenith, pow(max(h, 0.0), 0.45));
    col = mix(col, u.ground, smoothstep(0.0, -0.25, h));
    // sun / moon glow
    const sd = max(dot(dir, u.sunDir), 0.0);
    let glow = pow(sd, 6.0).mul(0.18).add(pow(sd, 90.0).mul(0.9));
    if (!forEnv) glow = glow.add(pow(sd, 1400.0).mul(6.0)); // the disc itself only in the visible sky (the DirectionalLight already provides its highlight)
    col = col.add(u.sunColor.mul(glow).mul(u.sunGlow));
    // clouds: soft fbm sheets drifting slowly; lit by the sun colour near the sun, give puddle reflections some structure
    const cuv = dir.xz.div(max(h, 0.06).add(0.25)).mul(1.4).add(vec3(time.mul(0.004), 0, 0).xz);
    const cn = mx_fractal_noise_float(vec3(cuv, 0.0), 4, 2.0, 0.55).mul(0.5).add(0.5);
    const cmask = smoothstep(float(1.0).sub(u.cloud).mul(0.75), float(1.0).sub(u.cloud).mul(0.75).add(0.35), cn).mul(smoothstep(-0.02, 0.2, h));
    const cloudCol = mix(mix(u.horizon, u.zenith, 0.3).mul(0.8), u.sunColor.mul(0.9), pow(sd, 3.0).mul(u.sunGlow).mul(0.6));
    col = mix(col, cloudCol, cmask.mul(0.85));
    // stars: two hashed layers (many faint, few bright) + a soft milky band that also thickens the star field
    const band = normalize(vec3(0.35, 0.55, -0.76));
    const bd = abs(dot(dir, band));
    const milky = smoothstep(0.42, 0.0, bd).mul(mx_fractal_noise_float(dir.mul(3.2), 4, 2.0, 0.55).mul(0.5).add(0.55));
    const starLayer = (scale, thresh, size, gain) => {
      const g = dir.mul(scale); const cell = floor(g); const f = fract(g).sub(0.5);
      const hsh = fract(sin(dot(cell, vec3(127.1, 311.7, 74.7))).mul(43758.5453));
      const hs2 = fract(hsh.mul(917.3));
      const on = step(float(thresh).sub(milky.mul(0.012)), hsh);
      const tw = sin(time.mul(hs2.mul(2.0).add(0.8)).add(hsh.mul(400.0))).mul(0.25).add(0.75);
      const tint = mix(vec3(1.0, 0.86, 0.72), vec3(0.75, 0.86, 1.0), hs2);
      return tint.mul(on).mul(smoothstep(size, 0.0, f.length())).mul(tw).mul(gain).mul(hs2.mul(0.7).add(0.3));
    };
    const horizonFade = smoothstep(0.0, 0.22, h);
    const starsCol = starLayer(150.0, 0.982, 0.16, 1.6).add(starLayer(70.0, 0.9935, 0.2, 4.0));
    col = col.add(starsCol.add(vec3(0.16, 0.2, 0.32).mul(milky).mul(0.5)).mul(u.stars).mul(horizonFade).mul(float(1.0).sub(u.cloud.mul(0.9))));
    if (!forEnv) {
      // celestial bodies: a ringed giant low in the north, Big Sister and Little Sister (the two moons) — quests count on them
      const phaseSun = normalize(vec3(-0.75, -0.12, 0.35)); // where the real sun is while we look at the night side
      const body = (az, el, radius, albedoA, albedoB, bands, ring) => {
        const a = az * deg, e = el * deg;
        const c = vec3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
        const t1 = normalize(cross(vec3(0, 1, 0), c)), t2 = cross(c, t1);
        const rel = dir.sub(c);
        const p = vec2(dot(rel, t1), dot(rel, t2)).div(radius * deg);
        const r2 = dot(p, p);
        const disc = smoothstep(1.0, 0.96, r2.sqrt());
        const nz = max(float(1.0).sub(r2), 0.0).sqrt();
        const n = t1.mul(p.x).add(t2.mul(p.y)).sub(c.mul(nz));
        const lit = smoothstep(-0.08, 0.35, dot(n, phaseSun)).mul(0.96).add(0.04);
        const tex = bands
          ? sin(p.y.mul(bands).add(mx_noise_float(vec3(p.mul(3.0), 1.0)).mul(1.6))).mul(0.5).add(0.5)
          : mx_noise_float(vec3(p.mul(2.4), 4.0)).mul(0.5).add(0.5);
        let c3 = mix(color(albedoA), color(albedoB), tex).mul(lit);
        let mask = disc;
        if (ring) {
          const q = vec2(p.x.mul(Math.cos(0.35)).add(p.y.mul(Math.sin(0.35))), p.y.mul(Math.cos(0.35)).sub(p.x.mul(Math.sin(0.35))).div(0.28));
          const rr = q.length();
          const gaps = smoothstep(1.92, 1.98, rr).oneMinus().add(smoothstep(2.02, 2.08, rr)).clamp(0, 1);
          const ringMask = smoothstep(1.35, 1.42, rr).mul(smoothstep(2.45, 2.35, rr)).mul(gaps).mul(mix(0.55, 1.0, sin(rr.mul(38.0)).mul(0.5).add(0.5)));
          const behind = disc.mul(step(0.0, q.y)); // the far half of the ring passes behind the planet
          const ringVis = ringMask.mul(behind.oneMinus());
          c3 = mix(c3, color(ring).mul(0.85), ringVis.mul(disc.oneMinus().max(step(q.y, 0.0))));
          mask = max(disc, ringVis.mul(0.9));
        }
        return { c3, mask };
      };
      const vis = mix(float(0.16), float(1.0), u.stars).mul(float(1.0).sub(u.cloud.mul(0.92))).mul(smoothstep(-0.02, 0.06, h));
      for (const b of [
        body(352, 15, 9.0, 0x2f6f7a, 0xd9c9a8, 9.0, 0xcdbf9f),
        body(140, 46, 3.1, 0xd8d4c8, 0x9a978f, 0, null),
        body(96, 31, 1.35, 0xa9c4e6, 0x6f86a8, 0, null),
      ]) col = mix(col, b.c3, b.mask.mul(vis));
    }
    mat.colorNode = vec4(col, 1.0);
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false; m.renderOrder = -10; m.castShadow = false; m.receiveShadow = false; m.name = 'sky';
    return m;
  }

  /** Blend to a mood over `seconds` (0 = cut). */
  set(name, seconds = 0) {
    const target = MOODS[name]; if (!target) throw new Error('Unknown mood ' + name);
    this.name = name;
    if (seconds <= 0) { this.cur = flatten(target); this.to = null; this.t = 1; this._apply(); this._envDirty = true; return; }
    this.from = lerpState(this.cur, this.cur, 0, {}); this.to = flatten(target); this.t = 0; this.dur = seconds;
  }

  /** Call every frame. focus = point the shadow frustum should follow (player / camera target). */
  update(dt, focus) {
    if (focus) this.focus.copy(focus);
    if (this.to) {
      this.t = Math.min(1, this.t + dt / this.dur);
      const e = this.t * this.t * (3 - 2 * this.t);
      lerpState(this.from, this.to, e, this.cur);
      this._envClock += dt; if (this._envClock > 0.6) { this._envDirty = true; this._envClock = 0; }
      if (this.t >= 1) { this.to = null; this._envDirty = true; }
    }
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 3.2);
    this._apply();
    if (this._envDirty) this._updateEnv();
  }

  lightning(strength = 1) { this.flash = strength; }

  _apply() {
    const s = this.cur, u = this.u;
    const az = s.sunAz * deg, el = s.sunEl * deg;
    // direction the light comes from (az 0 = north = -Z, 90 = east = +X)
    const dx = Math.sin(az) * Math.cos(el), dy = Math.sin(el), dz = -Math.cos(az) * Math.cos(el);
    // follow the focus, snapped to shadow texels so shadows don't swim
    const texel = (this.shadowRange * 2) / this.sun.shadow.mapSize.x;
    const fx = Math.round(this.focus.x / texel) * texel, fz = Math.round(this.focus.z / texel) * texel;
    this.sun.target.position.set(fx, 0, fz);
    this.sun.position.set(fx + dx * 120, dy * 120, fz + dz * 120);
    this.sun.target.updateMatrixWorld();
    const f = this.flash;
    this.sun.color.copy(s.sunColor).lerp(_white, Math.min(1, f));
    this.sun.intensity = s.sunI + f * 9;
    this.hemi.color.copy(s.hemiSky); this.hemi.groundColor.copy(s.hemiGround); this.hemi.intensity = s.hemiI + f * 1.5;
    u.zenith.value.copy(s.zenith).lerp(_flashSky, Math.min(1, f * 0.5)); u.horizon.value.copy(s.horizon).lerp(_flashSky, Math.min(1, f * 0.6)); u.ground.value.copy(s.groundCol);
    u.sunDir.value.set(dx, dy, dz); u.sunColor.value.copy(s.sunColor); u.sunGlow.value = s.sunGlow; u.stars.value = s.stars; u.cloud.value = s.cloud;
    u.fogColor.value.copy(s.fogColor).lerp(_flashSky, Math.min(1, f * 0.35)); u.fogDensity.value = s.fogDensity;
    W.wetness.value = s.wetness; W.puddles.value = s.puddles; W.rain.value = s.rain; W.wind.value = s.wind; W.glow.value = s.glow; W.lampGain.value = s.lampGain;
    this.scene.environmentIntensity = s.envIntensity;
    const L = this.look; if (L) for (const k in s.look) if (L[k]) L[k].value = s.look[k];
    if (L?.rayColor) L.rayColor.value.copy(s.sunColor);
    this.sky.position.copy(this.focus);
  }

  _updateEnv() {
    this._envDirty = false;
    const old = this._envRT;
    this._envRT = this.pmrem.fromScene(this._envScene, 0.02);
    this.scene.environment = this._envRT.texture;
    if (old) old.dispose();
  }

  get state() { return this.cur; }
}
const _white = new THREE.Color(0xdfe9ff), _flashSky = new THREE.Color(0x9fb4d0);
