// Weather & air: rain streaks, ground splashes, drifting motes (dust / spores / embers).
// Everything is GPU-animated from instance ids — zero per-frame CPU work — and tiles around the focus point.
import * as THREE from 'three/webgpu';
import {
  uniform, float, vec2, vec3, vec4, hash, instanceIndex, time, mod, mix, smoothstep, sin, cos, fract, floor, abs, max, min, normalize, cross,
  cameraPosition, positionGeometry, uv, color,
} from 'three/tsl';
import { W } from './materials.js';

/**
 * Weather lives in its OWN scene (`weather.scene`) which the pipeline renders as an additive overlay pass —
 * transparent quads must never write into the G-buffer that SSGI/SSR read.
 */
export function createWeather() {
  const scene = new THREE.Scene();
  const u = {
    focus: uniform(new THREE.Vector3()),
    rainTint: uniform(color(0xa8bccb)), rainAlpha: uniform(0.0),
    wind: uniform(new THREE.Vector2(2.2, 0.9)),
    moteTint: uniform(color(0xffe2b8)), moteAlpha: uniform(0.0), moteRise: uniform(0.15),
  };

  // ---------- rain ----------
  const RAIN_N = 7000, R = 26, H = 22;
  const rainGeo = new THREE.PlaneGeometry(1, 1);
  const rainMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
  {
    const id = float(instanceIndex);
    const r1 = hash(id.mul(1.31).add(0.17)), r2 = hash(id.mul(2.77).add(5.1)), r3 = hash(id.mul(0.73).add(9.4)), r4 = hash(id.mul(4.13).add(2.2));
    const speed = mix(15.0, 21.0, r4);
    const fall = mod(r2.mul(H).add(time.mul(speed)), H); // distance fallen
    const y = float(H).sub(fall);
    // tile in XZ around the focus so the volume follows the camera with no popping
    const base = vec2(r1, r3).mul(R * 2);
    const drift = u.wind.mul(fall.div(speed)); // wind pushes drops as they fall
    const rel = mod(base.add(drift).sub(u.focus.xz), R * 2).sub(R);
    const centre = vec3(u.focus.x.add(rel.x), u.focus.y.add(y).sub(3.0), u.focus.z.add(rel.y));
    const dirFall = normalize(vec3(u.wind.x, speed.negate(), u.wind.y));
    const toCam = normalize(cameraPosition.sub(centre));
    const side = normalize(cross(dirFall, toCam));
    const len = mix(0.55, 1.15, r4), wid = mix(0.012, 0.022, r1);
    const p = positionGeometry; // plane −0.5..0.5
    rainMat.positionNode = centre.add(dirFall.mul(p.y.mul(len))).add(side.mul(p.x.mul(wid)));
    const edge = smoothstep(0.0, 0.25, uv().y).mul(smoothstep(1.0, 0.6, uv().y));
    const near = smoothstep(2.0, 7.0, centre.sub(cameraPosition).length()); // don't smear across the lens
    const ceil = smoothstep(0.0, 2.5, fall).mul(smoothstep(0.0, 1.5, y));
    const rainA = edge.mul(near).mul(ceil).mul(u.rainAlpha).mul(mix(0.35, 1.0, r2));
    rainMat.colorNode = vec4(u.rainTint.mul(rainA), 1.0);
  }
  const rain = new THREE.InstancedMesh(rainGeo, rainMat, RAIN_N);
  rain.frustumCulled = false; rain.castShadow = false; rain.receiveShadow = false; rain.name = 'rain'; rain.renderOrder = 20;
  scene.add(rain);

  // ---------- motes (dust in sunbeams, spores at night, embers near fires) ----------
  const MOTE_N = 900, MR = 20, MH = 9;
  const moteMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending });
  {
    const id = float(instanceIndex);
    const r1 = hash(id.mul(1.91).add(3.3)), r2 = hash(id.mul(3.17).add(1.9)), r3 = hash(id.mul(0.57).add(7.7)), r4 = hash(id.mul(5.3).add(4.4));
    const t = time.mul(mix(0.05, 0.16, r4));
    const wob = vec3(sin(t.mul(6.0).add(r1.mul(40.0))), sin(t.mul(4.3).add(r2.mul(40.0))).mul(0.5), cos(t.mul(5.1).add(r3.mul(40.0)))).mul(0.6);
    const yy = mod(r2.mul(MH).add(time.mul(u.moteRise).mul(mix(0.5, 1.5, r4))), MH);
    const base = vec2(r1, r3).mul(MR * 2).add(u.wind.mul(time.mul(0.12)));
    const rel = mod(base.sub(u.focus.xz), MR * 2).sub(MR);
    const centre = vec3(u.focus.x.add(rel.x), u.focus.y.add(yy).sub(0.5), u.focus.z.add(rel.y)).add(wob);
    const toCam = normalize(cameraPosition.sub(centre));
    const right = normalize(cross(vec3(0, 1, 0), toCam)), up = cross(toCam, right);
    const size = mix(0.025, 0.06, r4);
    const p = positionGeometry;
    moteMat.positionNode = centre.add(right.mul(p.x.mul(size))).add(up.mul(p.y.mul(size)));
    const d = uv().sub(0.5).length();
    const tw = sin(time.mul(mix(0.6, 2.2, r1)).add(r3.mul(30.0))).mul(0.5).add(0.5);
    const fadeY = smoothstep(0.0, 1.0, yy).mul(smoothstep(MH, MH - 2.0, yy));
    moteMat.colorNode = vec4(u.moteTint.mul(2.0).mul(smoothstep(0.5, 0.1, d).mul(tw).mul(fadeY).mul(u.moteAlpha)), 1.0);
  }
  const motes = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), moteMat, MOTE_N);
  motes.frustumCulled = false; motes.name = 'motes'; motes.renderOrder = 21;
  scene.add(motes);

  // ---------- glints: tiny far-visible lights (Pip's one saved blink, the mast lamp, the lamp left on the sign) ----------
  const glints = new Map();
  const glintGeo = new THREE.PlaneGeometry(1, 1);
  function addGlint({ id, x, y, z, color: c = 0xffb45e, size = 0.6, blink = null, gain = 1 }) {
    removeGlint(id);
    const level = uniform(1.0);
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, fog: false, blending: THREE.AdditiveBlending });
    const centre = uniform(new THREE.Vector3(x, y, z));
    const toCam = normalize(cameraPosition.sub(centre));
    const right = normalize(cross(vec3(0, 1, 0), toCam)), up = cross(toCam, right);
    // grow a little with distance so it never drops below a couple of pixels
    const dist = cameraPosition.sub(centre).length();
    const sz = float(size).mul(max(float(1.0), dist.div(28.0)));
    mat.positionNode = centre.add(right.mul(positionGeometry.x.mul(sz))).add(up.mul(positionGeometry.y.mul(sz)));
    const d = uv().sub(0.5).length();
    const core = smoothstep(0.5, 0.0, d); // soft disc with a hot centre
    mat.colorNode = vec4(color(c).mul(core.mul(core).mul(2.2).add(smoothstep(0.12, 0.0, d).mul(3.0))).mul(level).mul(gain), 1.0);
    const mesh = new THREE.Mesh(glintGeo, mat); mesh.frustumCulled = false; mesh.renderOrder = 30;
    scene.add(mesh);
    const g = { mesh, level, centre, blink, on: true, t: 0 };
    glints.set(id, g);
    return g;
  }
  function removeGlint(id) { const g = glints.get(id); if (g) { scene.remove(g.mesh); g.mesh.material.dispose(); glints.delete(id); } }

  const MOTES = {
    storm_night: [0xff9a55, 0.0], grey_dawn: [0xcfd8dc, 0.12], after_rain_gold: [0xffe2b8, 0.55], clear_evening: [0xffc9a0, 0.5],
    starry_night: [0x9ff5e0, 0.8], first_light: [0xffd2c0, 0.6], studio: [0xffffff, 0.0],
  };
  const tint = new THREE.Color();
  let moteTarget = 0;

  return {
    scene, uniforms: u, addGlint, removeGlint, glints,
    /** @param {number} dt @param {THREE.Vector3} focus @param {string} moodName */
    update(dt, focus, moodName) {
      u.focus.value.copy(focus);
      // rain visibility follows the global rain amount; brighter by day, faint at night
      const rainAmt = W.rain.value;
      const night = moodName === 'storm_night' ? 0.55 : 1.0;
      u.rainAlpha.value += (rainAmt * 0.5 * night - u.rainAlpha.value) * Math.min(1, dt * 1.5);
      rain.visible = u.rainAlpha.value > 0.004;
      u.wind.value.set(2.2 * W.wind.value, 0.9 * W.wind.value);
      const m = MOTES[moodName] || MOTES.studio;
      tint.setHex(m[0]); u.moteTint.value.lerp(tint, Math.min(1, dt * 0.5));
      moteTarget = m[1];
      u.moteAlpha.value += (moteTarget - u.moteAlpha.value) * Math.min(1, dt * 0.4);
      u.moteRise.value = moodName === 'starry_night' ? 0.35 : 0.12;
      motes.visible = u.moteAlpha.value > 0.004;
      for (const g of glints.values()) {
        g.t += dt;
        let target = g.on ? 1 : 0;
        if (g.blink && g.on) target = (g.t % g.blink.period) < g.blink.on ? 1 : 0;
        g.level.value += (target - g.level.value) * Math.min(1, dt * (target ? 18 : 6));
      }
    },
  };
}
