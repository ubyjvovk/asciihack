/**
 * Standalone renderer bench (`/scene.html`) — the PM's eyeball instrument.
 *
 * Mounts a `GlViewport` over a synthetic level with no WebSocket, no server
 * and no NetHack, so a renderer change can be looked at (or screenshotted by
 * `scripts/web-shot.mjs`) in one command: `npm run web:dev` then
 * `http://127.0.0.1:5173/scene.html`.
 *
 * Query: `?pose=x,y,yawDeg` (default a doorway view), `?render=<style>`,
 * `?fov=<deg>`, `?view=fps|ortho`, plus whatever the viewport itself reads
 * (`?gpu=`, `?q=` once the GPU path lands). Arrow keys/WASD walk, `[`/`]`
 * cycle the style. `window.__bench` and `window.__ready` are the automation
 * handles.
 */
import { type CellKind, type LevelView, type MapCell, type Pose } from '../../src/model/types.js';
import { GlViewport } from './gl/gl-viewport.js';

/** The bench level: a lit room, a dark corridor east through a doorway, stairs. */
const MAP = [
  '###############',
  '#.............#',
  '#............>#',
  '#.............#',
  '#......<......D%%%%%#',
  '#.............#    #',
  '#.............#    #',
  '###############    #',
  '                   #',
] as const;

const GLYPH_KIND: Readonly<Record<string, CellKind>> = {
  '#': 'wall',
  '.': 'floor',
  '%': 'corridor',
  D: 'doorway',
  '+': 'door_closed',
  "'": 'door_open',
  '<': 'stairs_up',
  '>': 'stairs_down',
  '{': 'fountain',
  ' ': 'unexplored',
};

/** Build a read-only `LevelView` from the ASCII map above. */
function benchLevel(): LevelView {
  const height = MAP.length;
  const width = Math.max(...MAP.map((r) => r.length));
  const kindAt = (x: number, y: number): CellKind => {
    if (x < 0 || y < 0 || y >= height) return 'unexplored';
    const ch = MAP[y]?.[x] ?? ' ';
    return GLYPH_KIND[ch] ?? 'unexplored';
  };
  return {
    width,
    height,
    kindAt,
    cellAt(x: number, y: number): MapCell | null {
      const kind = kindAt(x, y);
      if (kind === 'unexplored') return null;
      // the room is lit, the corridor beyond the doorway is not
      const lit = kind !== 'corridor';
      return { x, y, kind, terrain: null, top: null, lit };
    },
  };
}

/** Parse `?pose=x,y,yawDeg`; falls back to the hero standing in the room facing east. */
function poseFromQuery(search: string): Pose {
  const raw = new URLSearchParams(search).get('pose');
  const fallback: Pose = { x: 7.5, y: 4.5, yaw: Math.PI / 2 };
  if (raw === null) return fallback;
  const [x, y, deg] = raw.split(',').map(Number);
  if (x === undefined || y === undefined || deg === undefined) return fallback;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(deg)) return fallback;
  return { x, y, yaw: (deg * Math.PI) / 180 };
}

/** Mount the bench and start the render loop. */
function boot(): void {
  const params = new URLSearchParams(window.location.search);
  const level = benchLevel();
  const pose = poseFromQuery(window.location.search);
  const fov = Number(params.get('fov') ?? '70');
  const viewport = new GlViewport({ initialStyle: params.get('render') ?? 'amber' });
  if (params.get('view') === 'ortho') viewport.setView('ortho');

  const cellW = 9;
  const cellH = 18;
  const fit = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    viewport.place(0, 0, w, h);
    viewport.resize(Math.max(1, Math.floor(w / cellW)), Math.max(1, Math.floor(h / cellH)), cellW, cellH);
  };
  fit();
  window.addEventListener('resize', fit);

  window.addEventListener('keydown', (ev: KeyboardEvent) => {
    const step = 0.25;
    const turn = Math.PI / 24;
    if (ev.key === 'ArrowLeft' || ev.key === 'a') pose.yaw -= turn;
    else if (ev.key === 'ArrowRight' || ev.key === 'd') pose.yaw += turn;
    else if (ev.key === 'ArrowUp' || ev.key === 'w') {
      pose.x += Math.sin(pose.yaw) * step;
      pose.y -= Math.cos(pose.yaw) * step;
    } else if (ev.key === 'ArrowDown' || ev.key === 's') {
      pose.x -= Math.sin(pose.yaw) * step;
      pose.y += Math.cos(pose.yaw) * step;
    } else if (ev.key === '[') viewport.cycleStyle(-1);
    else if (ev.key === ']') viewport.cycleStyle(1);
    else return;
    ev.preventDefault();
  });

  let frames = 0;
  const loop = (): void => {
    viewport.render(level, pose, [], fov);
    frames += 1;
    if (frames === 2) window.__ready = true;
    window.requestAnimationFrame(loop);
  };
  window.requestAnimationFrame(loop);

  window.__bench = {
    viewport,
    pose,
    setPose(x: number, y: number, yawDeg: number): void {
      pose.x = x;
      pose.y = y;
      pose.yaw = (yawDeg * Math.PI) / 180;
    },
    debugInfo: () => viewport.debugInfo(),
    get frames(): number {
      return frames;
    },
  };
}

declare global {
  interface Window {
    __ready?: boolean;
    __bench?: unknown;
  }
}

boot();
