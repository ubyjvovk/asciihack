/**
 * Third-person "diorama follow" camera (T-0052, docs/gpu-thirdperson.md).
 *
 * Afterburn's `ART_BIBLE.md` §6 pins the look: *"Perspective, FOV ≈ 28–32°,
 * pitch ≈ 38–46°, distance 22–34 m, follows the player with a soft spring.
 * Depth of field focused on the player, gentle (diorama, not mush)."* Their
 * rig's defaults (`vendor/afterburn/src/game/camera.js` is not vendored; the
 * numbers below are quoted from the PM's reading of it) are `fov 30`,
 * `pitch 42°`, `dist 26` (clamped 18–34), look-at height `0.95` above the
 * subject's feet, yaw snapped to 45° steps.
 *
 * **Scale conversion.** Afterburn is metres with a ~1.7 m character; here
 * one cell is one unit and `HERO_SPRITE_HEIGHT = 0.7` cells. So distances
 * scale by `0.7 / 1.7 ≈ 0.41` (`HERO_SPRITE_HEIGHT / AFTERBURN_HERO_M`).
 * Angles (FOV, pitch) are copied verbatim — they are dimensionless.
 *
 * Pure module — no `three`, no DOM. Both helpers below are unit-tested by
 * `tests/gpu-thirdperson.test.ts`.
 */
import { HERO_SPRITE_HEIGHT } from '../gl/ortho-camera.js';

/** Afterburn's subject height (m) — see `ART_BIBLE.md` §2 (character ≈ 0.08 m
 *  grid but ~1.7 m tall). Sole use is `THIRD_SCALE`. */
export const AFTERBURN_HERO_M = 1.7;

/** Metres → cells conversion factor `0.7 / 1.7`. Applied to *distances only*;
 *  angles (FOV, pitch) are dimensionless and copied verbatim. */
export const THIRD_SCALE = HERO_SPRITE_HEIGHT / AFTERBURN_HERO_M;

/** Vertical field of view, in degrees. ART_BIBLE §6: FOV 28–32°; afterburn
 *  rig default is 30. Not scaled — it is an angle. */
export const THIRD_FOV_DEG = 30;

/** Camera pitch above the horizon, in radians. ART_BIBLE §6: 38–46°;
 *  afterburn rig default is 42°. Not scaled — angle. */
export const THIRD_PITCH_RAD = (42 * Math.PI) / 180;

/** Look-at height above the subject's feet, in cells. Afterburn: 0.95 m
 *  above the ground; scaled: `0.95 · 0.7 / 1.7 ≈ 0.391`. */
export const THIRD_LOOK_HEIGHT_CELLS = 0.95 * THIRD_SCALE;

/** Default camera-to-target distance, in cells. Afterburn: 26 m; scaled: `26 · 0.7 / 1.7 ≈ 10.7`. */
export const THIRD_DIST_DEFAULT_CELLS = 34 * THIRD_SCALE;
/** Minimum camera-to-target distance (wheel-zoom clamp), in cells. Afterburn 18 m → ~7.41 cells. */
export const THIRD_DIST_MIN_CELLS = 18 * THIRD_SCALE;
/** Maximum camera-to-target distance (wheel-zoom clamp), in cells. Afterburn 34 m → ~14.0 cells. */
export const THIRD_DIST_MAX_CELLS = 52 * THIRD_SCALE;

/** Yaw snap step: 45° = π/4. ART_BIBLE §6 "follows the player with a soft
 *  spring", but the rig snaps yaw to 45° steps rather than tracking heading. */
export const THIRD_YAW_STEP_RAD = Math.PI / 4;

/** Numeric camera placement — plain numbers so tests can assert exactly. */
export interface ThirdPersonPose {
  /** Camera position in world (cell) coordinates. */
  position: { x: number; y: number; z: number };
  /** Look-at point in world coordinates: hero cell centre, lifted by
   *  `THIRD_LOOK_HEIGHT_CELLS`, so DOF and rotation pivot on the hero. */
  target: { x: number; y: number; z: number };
  /** Vertical FOV in degrees (dimensionless — never scaled). */
  fov: number;
  /** DOF focus distance in cells: identical to `‖position − target‖`, so the
   *  focal plane lands on the hero exactly as ART_BIBLE §6 asks. */
  focus: number;
}

/** Options for `thirdPersonPose`. All optional; defaults reproduce the rig. */
export interface ThirdPersonOpts {
  /** Pitch above horizon in radians (default `THIRD_PITCH_RAD`). */
  pitch?: number;
  /** Look-at lift above the hero cell's floor, in cells (default
   *  `THIRD_LOOK_HEIGHT_CELLS`). */
  lookHeight?: number;
  /** FOV in degrees (default `THIRD_FOV_DEG`). */
  fov?: number;
}

/**
 * Compute the third-person camera pose for a hero at map cell `hero` with
 * yaw snapped to `yawSteps · 45°` and a camera-to-target distance `dist`.
 * Pure — no `three`, no DOM.
 *
 * `hero` uses the same axes as the fps view: `hero.x` = column, `hero.y` =
 * row (south is +y). The camera sits on a sphere around the target at
 * `(hero.x + 0.5, THIRD_LOOK_HEIGHT_CELLS, hero.y + 0.5)`, azimuth =
 * `yawSteps · π/4`, pitch above horizon `THIRD_PITCH_RAD`. `focus` equals
 * `dist` by construction (`position − target` has magnitude `dist`), so a
 * DOF pass focused on `focus` lands exactly on the hero.
 */
export function thirdPersonPose(
  hero: { x: number; y: number },
  yawSteps: number,
  dist: number,
  opts: ThirdPersonOpts = {},
): ThirdPersonPose {
  const pitch = opts.pitch ?? THIRD_PITCH_RAD;
  const lookHeight = opts.lookHeight ?? THIRD_LOOK_HEIGHT_CELLS;
  const fov = opts.fov ?? THIRD_FOV_DEG;
  const yaw = yawSteps * THIRD_YAW_STEP_RAD;

  const target = { x: hero.x + 0.5, y: lookHeight, z: hero.y + 0.5 };
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  // Azimuth 0 puts the camera **south** of the target, looking north — the
  // same convention afterburn's rig uses ("0 = camera south of the subject
  // looking north"). South is +z here (docs/gpu.md §4), so screen-up reads as
  // map north and screen-right as map east; placing it north instead mirrors
  // the world and makes every movement key look reversed.
  const position = {
    x: target.x - dist * cosP * sinY,
    y: target.y + dist * sinP,
    z: target.z + dist * cosP * cosY,
  };
  return { position, target, fov, focus: dist };
}

/** State for `dampPose` — a subset of `ThirdPersonPose` the spring smooths. */
export interface DampState {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
}

/**
 * Exponential-decay spring toward `wanted`, applied to position and target
 * componentwise. `dt` is in seconds; the smoothing factor is fixed so a
 * `dt` step advances `(wanted − current) · (1 − e^(−k·dt))`. Pure — mutates
 * neither input; returns a fresh state.
 *
 * The critical-damped feel ART_BIBLE §6 asks for comes from a single
 * time-constant (`SPRING_TAU_SEC`): the camera reaches ~63 % of the remaining
 * distance every `tau` seconds. This makes the follow feel "soft" without
 * a full mass-spring integrator — the hero cell only moves once per NetHack
 * turn, so the input is a step function and a first-order response reads
 * as diorama-like there.
 */
export function dampPose(current: DampState, wanted: DampState, dt: number): DampState {
  const k = 1 - Math.exp(-Math.max(0, dt) / SPRING_TAU_SEC);
  return {
    position: {
      x: current.position.x + (wanted.position.x - current.position.x) * k,
      y: current.position.y + (wanted.position.y - current.position.y) * k,
      z: current.position.z + (wanted.position.z - current.position.z) * k,
    },
    target: {
      x: current.target.x + (wanted.target.x - current.target.x) * k,
      y: current.target.y + (wanted.target.y - current.target.y) * k,
      z: current.target.z + (wanted.target.z - current.target.z) * k,
    },
  };
}

/** Spring time constant in seconds — the "soft spring" of ART_BIBLE §6. */
export const SPRING_TAU_SEC = 0.18;

/**
 * Wrap `yawSteps` into `[0, 8)` — Q/E can walk indefinitely, but only the
 * modulo-8 remainder matters for the pose (a full turn = 8 · 45°).
 */
export function wrapYawSteps(yawSteps: number): number {
  const n = 8;
  return ((yawSteps % n) + n) % n;
}

/**
 * Clamp `dist` into `[THIRD_DIST_MIN_CELLS, THIRD_DIST_MAX_CELLS]`. Called
 * whenever the mouse wheel changes the requested distance; the ticket pins
 * these bounds to afterburn's 18 m / 34 m through the scale conversion.
 */
export function clampThirdDist(dist: number): number {
  if (dist < THIRD_DIST_MIN_CELLS) return THIRD_DIST_MIN_CELLS;
  if (dist > THIRD_DIST_MAX_CELLS) return THIRD_DIST_MAX_CELLS;
  return dist;
}
