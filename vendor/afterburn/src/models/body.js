// Kinematic walker shared by the pilot and Pip: smooth acceleration, circle-vs-grid collision that slides
// instead of sticking, soft step up/down, world bounds, path following with stuck recovery.
// No allocations in update(); all scratch state lives on the body.
import { clamp, damp, dampAngle, yawOf } from './util.js';

const MAX_SUBSTEP = 0.15; // metres per collision sub-step (< radius, so nothing tunnels)

/**
 * @param {object} o
 * @param {object} o.world §8 world
 * @param {ReturnType<import('./nav.js').createNav>} o.nav
 * @param {number} [o.radius]
 * @param {number} [o.accel] m/s² when speeding up / steering  @param {number} [o.decel] m/s² when stopping
 * @param {number} [o.turn] yaw smoothing rate (1/s)
 */
export function createBody({ world, nav, radius = nav.radius, accel = 15, decel = 19, turn = 11 }) {
  const cell = nav.cell, ox = nav.grid.originX, oz = nav.grid.originZ;
  const out = { x: 0, z: 0 }; // scratch for collision + nearestFree

  const body = {
    x: 0, z: 0, y: 0, yaw: 0,
    vx: 0, vz: 0,
    /** actual horizontal speed this frame (m/s, after collision) */ speed: 0,
    /** metres actually moved this frame */ moved: 0,
    /** raw ground height under the centre */ groundY: 0,
    /** true while pushing against something */ blocked: false,
    radius,
    // wish (set by whoever drives the body each frame; path following overrides it)
    wishX: 0, wishZ: 0, wishSpeed: 0,
    // path following
    path: null, pathIndex: 0, pathSpeed: 0, pathStop: 0.08, pathPartial: false,
    _req: null, _resolve: null, _goal: { x: 0, z: 0 }, _bestD: Infinity, _stall: 0, _replans: 0, _clock: 0, _limit: 0, _lookT: 0,
    _targetY: 0, _faceYaw: null, _escape: false,

    /** Drive directly for this frame. (dx, dz) need not be normalised; speed in m/s. (A followed path overrides it — cancelPath() first.) */
    setWish(dx, dz, speed) {
      const l = Math.hypot(dx, dz);
      if (l > 1e-5 && speed > 0) { body.wishX = dx / l; body.wishZ = dz / l; body.wishSpeed = speed; } else body.wishSpeed = 0;
    },

    /** Put the body somewhere at once (nearest legal spot if the point itself is not walkable). */
    teleport(x, z, yaw, { exact = false } = {}) {
      body.cancelPath(false);
      if (!exact && !(nav.isFree(x, z) && world.walkable(x, z)) && nav.nearestFree(x, z, out, 24)) { x = out.x; z = out.z; }
      const b = world.bounds;
      body.x = clamp(x, b.minX + radius, b.maxX - radius); body.z = clamp(z, b.minZ + radius, b.maxZ - radius);
      if (yaw !== undefined) body.yaw = yaw;
      body.vx = body.vz = body.speed = body.moved = 0; body.wishSpeed = 0;
      body.groundY = world.heightAt(body.x, body.z);
      body._targetY = body.y = body.groundY;
    },

    /**
     * Walk to a point along a nav path. Resolves true on arrival (at the nearest reachable spot if the point itself
     * cannot be reached — see `pathPartial`), false when cancelled or hopelessly stuck.
     * @returns {Promise<boolean>}
     */
    goTo(x, z, { speed = 2.6, stop = 0.08 } = {}) {
      body.cancelPath(false);
      body.pathSpeed = speed; body.pathStop = stop; body._goal.x = x; body._goal.z = z; body._replans = 0;
      return new Promise((resolve) => { body._resolve = resolve; plan(); });
    },
    /** Stop following. The pending goTo() promise resolves with `arrived`. */
    cancelPath(arrived = false) {
      if (body._req) { body._req.cancel(); body._req = null; }
      body.path = null;
      const r = body._resolve; body._resolve = null;
      if (r) r(arrived);
    },
    get following() { return body._resolve !== null; },

    /** Turn in place toward a yaw (used when standing still; movement always wins). */
    faceYaw(yaw) { body._faceYaw = yaw; },
    facePoint(x, z) { if (Math.hypot(x - body.x, z - body.z) > 1e-3) body._faceYaw = yawOf(x - body.x, z - body.z); },

    /** Displace through the collision solver (soft pushes between characters). */
    nudge(dx, dz) {
      collide(body.x + dx, body.z + dz, body.groundY);
      if (world.walkable(out.x, out.z)) { body.x = out.x; body.z = out.z; }
    },

    update(dt) {
      if (body.path || body._req) follow(dt);

      // standing somewhere illegal (a door closed on us, a bad spawn)? walk out the shortest way, ignoring collision
      body._escape = !(nav.isFree(body.x, body.z) && world.walkable(body.x, body.z));
      if (body._escape && nav.nearestFree(body.x, body.z, out, 24)) { body.setWishKeep(out.x - body.x, out.z - body.z, 2.6); }

      // ---- velocity ----
      const tvx = body.wishX * body.wishSpeed, tvz = body.wishZ * body.wishSpeed;
      const dvx = tvx - body.vx, dvz = tvz - body.vz, dv = Math.hypot(dvx, dvz);
      const maxDv = (body.wishSpeed > 0.01 ? accel : decel) * dt;
      if (dv <= maxDv) { body.vx = tvx; body.vz = tvz; } else { body.vx += (dvx / dv) * maxDv; body.vz += (dvz / dv) * maxDv; }

      // ---- move + collide ----
      const px = body.x, pz = body.z;
      const stepLen = Math.hypot(body.vx, body.vz) * dt;
      if (stepLen > 1e-6) {
        const n = Math.max(1, Math.ceil(stepLen / MAX_SUBSTEP));
        const sx = (body.vx * dt) / n, sz = (body.vz * dt) / n;
        for (let s = 0; s < n; s++) {
          if (body._escape) { body.x += sx; body.z += sz; continue; }
          collide(body.x + sx, body.z + sz, body.groundY);
          if (!world.walkable(out.x, out.z)) break; // last line of defence: never enter a non-walkable cell
          body.x = out.x; body.z = out.z;
        }
      }
      const mx = body.x - px, mz = body.z - pz;
      body.moved = Math.hypot(mx, mz);
      body.speed = dt > 0 ? body.moved / dt : 0;
      body.blocked = stepLen > 1e-4 && body.moved < stepLen * 0.55;
      // what we actually did becomes our velocity: no pent-up speed when a wall lets go, clean slides along it
      if (stepLen > 1e-6 && body.moved < stepLen - 1e-5) { body.vx = mx / dt; body.vz = mz / dt; }

      // ---- facing: mostly where we really go, a little where we want to go (so pushing a wall still turns us) ----
      if (body.wishSpeed > 0.05 || body.speed > 0.25) {
        const fx = body.vx * 0.7 + body.wishX * body.wishSpeed * 0.3, fz = body.vz * 0.7 + body.wishZ * body.wishSpeed * 0.3;
        if (fx * fx + fz * fz > 0.01) body.yaw = dampAngle(body.yaw, yawOf(fx, fz), turn, dt);
        body._faceYaw = null;
      } else if (body._faceYaw !== null) {
        body.yaw = dampAngle(body.yaw, body._faceYaw, turn * 0.8, dt);
      }

      // ---- height: blend the footprint so steps become short ramps, then ease ----
      if (body.moved > 1e-5) {
        body.groundY = world.heightAt(body.x, body.z);
        body._targetY = footprintY(body.x, body.z, body.groundY, mx / body.moved, mz / body.moved);
      }
      body.y = damp(body.y, body._targetY, 14, dt);

      body.wishSpeed = 0; // wishes are per-frame
    },

    /** internal: like setWish but does not touch the path (escape logic). */
    setWishKeep(dx, dz, speed) { const l = Math.hypot(dx, dz) || 1; body.wishX = dx / l; body.wishZ = dz / l; body.wishSpeed = speed; },
  };

  /**
   * Height the feet should be at. Steps become short ramps: going up, the ground AHEAD is averaged in (the body rises
   * before the edge and never sinks into the step); going down, the ground BEHIND is (a soft hop down). Anything beyond
   * a legal step is ignored, so standing next to a cliff changes nothing.
   */
  function footprintY(x, z, h0, dx, dz) {
    let ahead = h0, behind = h0;
    for (let q = 1; q <= 3; q++) {
      const o = q * 0.16;
      const a = world.heightAt(x + dx * o, z + dz * o), b = world.heightAt(x - dx * o, z - dz * o);
      ahead += Math.abs(a - h0) <= nav.stepMax ? a : h0;
      behind += Math.abs(b - h0) <= nav.stepMax ? b : h0;
    }
    return Math.max(ahead, behind) / 4;
  }

  /** Push the circle at (x, z) out of every solid cell it touches. Result in `out`. */
  function collide(x, z, refH) {
    const b = world.bounds;
    for (let iter = 0; iter < 3; iter++) {
      let hit = false;
      const ci = Math.floor((x - ox) / cell), cj = Math.floor((z - oz) / cell);
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const i = ci + di, j = cj + dj;
        if (!nav.solid(i, j, refH)) continue;
        const x0 = ox + i * cell, z0 = oz + j * cell, x1 = x0 + cell, z1 = z0 + cell;
        const qx = x < x0 ? x0 : x > x1 ? x1 : x, qz = z < z0 ? z0 : z > z1 ? z1 : z;
        const ex = x - qx, ez = z - qz, d2 = ex * ex + ez * ez;
        if (d2 >= radius * radius) continue;
        hit = true;
        if (d2 > 1e-10) { const d = Math.sqrt(d2), push = (radius - d) / d; x += ex * push; z += ez * push; }
        else { // centre inside the cell: leave through the nearest face
          const l = x - x0, r = x1 - x, t = z - z0, u = z1 - z, m = Math.min(l, r, t, u);
          if (m === l) x = x0 - radius; else if (m === r) x = x1 + radius; else if (m === t) z = z0 - radius; else z = z1 + radius;
        }
      }
      if (!hit) break;
    }
    out.x = clamp(x, b.minX + radius, b.maxX - radius); out.z = clamp(z, b.minZ + radius, b.maxZ - radius);
  }

  // ---------- path following ----------
  function plan() {
    body.path = null;
    body._req = nav.request(body.x, body.z, body._goal.x, body._goal.z);
  }

  function follow(dt) {
    const req = body._req;
    if (req && !body.path) {
      if (req.status === 'queued' || req.status === 'searching') return; // thinking (a frame or two)
      body._req = null;
      if (req.status !== 'done' || req.points.length === 0) { body.cancelPath(false); return; }
      body.path = req.points; body.pathIndex = 0; body.pathPartial = req.partial;
      body._bestD = Infinity; body._stall = 0; body._clock = 0; body._lookT = 0;
      let len = 0, ax = body.x, az = body.z;
      for (let q = 0; q < req.points.length; q += 2) { len += Math.hypot(req.points[q] - ax, req.points[q + 1] - az); ax = req.points[q]; az = req.points[q + 1]; }
      body._limit = (len / Math.max(0.5, body.pathSpeed)) * 2.5 + 4;
    }
    const p = body.path;
    if (!p) return;
    const last = p.length - 2;
    let q = body.pathIndex;

    // look ahead: skip a corner as soon as the next one is in plain sight
    body._lookT -= dt;
    if (q < last && body._lookT <= 0) {
      body._lookT = 0.12;
      if (nav.lineClear(body.x, body.z, p[q + 2], p[q + 3])) { q = body.pathIndex = q + 2; body._bestD = Infinity; }
    }

    const dx = p[q] - body.x, dz = p[q + 1] - body.z, d = Math.hypot(dx, dz);
    if (q < last) {
      if (d < 0.22) { body.pathIndex = q + 2; body._bestD = Infinity; return follow(0); }
      body.setWishKeep(dx, dz, body.pathSpeed);
    } else {
      // a partial path already ends as close as one can get: walk it to the very end
      const stop = body.pathPartial ? Math.min(body.pathStop, 0.1) : body.pathStop;
      if (d <= stop || (d < 0.3 && body.blocked)) { body.cancelPath(true); return; }
      // ease into the final point: v² = 2·a·d
      body.setWishKeep(dx, dz, Math.max(0.45, Math.min(body.pathSpeed, Math.sqrt(2 * 5 * d))));
    }

    // stuck / timeout recovery — a path must always end
    body._clock += dt;
    if (d < body._bestD - 0.02) { body._bestD = d; body._stall = 0; } else body._stall += dt;
    if (body._stall > 0.6 || body._clock > body._limit) {
      if (body._replans++ < 2 && body._clock <= body._limit) { body._stall = 0; plan(); }
      else body.cancelPath(d < Math.max(0.6, body.pathStop));
    }
  }

  return body;
}
