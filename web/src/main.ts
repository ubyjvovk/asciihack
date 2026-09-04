/**
 * Browser entry point (docs/web.md). Reads `?name=…` (and optionally
 * `?theme=…` / `?mode=…` / `?render=…`) from the URL, opens a WebSocket to
 * `/play` (proxied by Vite to the WS server), wires a `NethackSession` +
 * `App` to the DOM terminal, and starts the fps mode by default.
 *
 * When `mode=fps` (or `ortho`), the three.js `GlViewport` (T-0031) is
 * mounted under the DOM terminal's viewport rectangle and renders the
 * dungeon through AsciiCity's shader styles; `F5` cycles them. The `<pre>`
 * HUD (message line, status, minimap, compass) still paints on top; a
 * follow-up ticket will make the fps/ortho modes paint transparent cells
 * inside the viewport so the WebGL scene shows through.
 */
import { NethackSession, runSession } from '../../src/engine/session.js';
import { App } from '../../src/ui/app.js';
import { FpsMode } from '../../src/ui/modes/fps.js';
import { poseFor, spritesFromMap, type Facing } from '../../src/ui/view3d.js';
import type { Theme } from '../../src/render/themes.js';
import { DEFAULT_SETTINGS, type Settings } from '../../src/ui/settings.js';
import { DomTerm } from './dom-term.js';
import { WsBridge } from './ws-bridge.js';
import { GlViewport } from './gl/gl-viewport.js';

/** Character-name rule from `bin/asciihack-lib.sh` — mirrored server-side. */
const NAME_RE = /^[A-Za-z0-9_-]{1,20}$/;

interface UrlOpts {
  name: string;
  theme: Theme | null;
  mode: string;
  render: string | null;
}

/** Parse the query string; falls back to sensible defaults for missing bits. */
export function parseUrlOpts(search: string): UrlOpts {
  const p = new URLSearchParams(search);
  const rawName = p.get('name') ?? 'guest';
  const name = NAME_RE.test(rawName) ? rawName : 'guest';
  const rawTheme = p.get('theme');
  const theme = isTheme(rawTheme) ? rawTheme : null;
  const rawMode = p.get('mode') ?? 'fps';
  const mode = rawMode === 'classic' || rawMode === 'fps' || rawMode === 'ortho' ? rawMode : 'fps';
  const render = p.get('render');
  return { name, theme, mode, render };
}

function isTheme(v: string | null): v is Theme {
  return v === 'cyber' || v === 'gloom' || v === 'solarized' || v === 'amber';
}

/** Wire the DOM: terminal, socket, session, app. */
function boot(): void {
  const host = document.getElementById('term') as HTMLPreElement | null;
  if (host === null) {
    document.body.textContent = 'error: #term host missing';
    return;
  }
  // Text placeholder until the first paint arrives.
  host.textContent = 'connecting…';
  host.focus();

  const opts = parseUrlOpts(window.location.search);
  const term = new DomTerm({ host });

  const ro = new ResizeObserver(() => term.notifyResize());
  ro.observe(host);

  const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${wsProto}//${window.location.host}/play?name=${encodeURIComponent(opts.name)}`;
  const socket = new WebSocket(url);
  const bridge = new WsBridge({ socket });

  const settings: Settings = { ...DEFAULT_SETTINGS };
  if (opts.theme !== null) settings.theme = opts.theme;

  const session = new NethackSession((r) => bridge.reply(r), { playerName: opts.name });
  const app = new App({
    session,
    term,
    mode: opts.mode,
    theme: opts.theme ?? undefined,
    settings,
  });

  // GL viewport — only for the 3D modes.
  const gl = opts.mode === 'fps' || opts.mode === 'ortho'
    ? new GlViewport({ parent: document.body, initialStyle: opts.render ?? undefined })
    : null;
  if (gl !== null) {
    // Capture F5 before it reaches the App's theme cycle so the same key
    // controls the shader style in the browser.
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'F5') return;
      const step = ev.shiftKey ? -1 : 1;
      gl.cycleStyle(step);
      ev.preventDefault();
      ev.stopPropagation();
    }, { capture: true });
    placeGl(gl, term);
    const relayout = (): void => placeGl(gl, term);
    const glResizeObserver = new ResizeObserver(relayout);
    glResizeObserver.observe(host);
    // Drive a rAF loop that only asks three.js to render when there is
    // something to show (the session's map, hero or facing changed).
    startRenderLoop(gl, session, app);
  }

  socket.addEventListener('open', () => {
    app.enter();
  });
  socket.addEventListener('close', () => {
    // The bridge closed (game exit or server drop). Leave the app so any
    // final message the session collected shows up.
    app.leave();
    if (gl !== null) gl.dispose();
  });

  void runSession(bridge, session).catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('runSession failed', err);
  });
}

/**
 * Position the GL canvas over the DOM terminal's viewport rectangle: the
 * region between the message line (row 0) and the two status rows at the
 * bottom, in CSS pixels. Runs once at startup and on every resize.
 */
function placeGl(gl: GlViewport, term: DomTerm): void {
  const cw = term.cellWidth;
  const ch = term.cellHeight;
  const cols = term.columns;
  const rows = Math.max(1, term.rows - 3);
  gl.place(0, ch, cols * cw, rows * ch);
  gl.resize(cols, rows, cw, ch);
}

/**
 * Frame loop: renders whenever the session announces a change or the fps
 * mode is animating a turn. `requestAnimationFrame` is throttled to the
 * browser's refresh rate; when nothing changes we skip the GL call entirely.
 */
function startRenderLoop(gl: GlViewport, session: NethackSession, app: App): void {
  let dirty = true;
  const mark = (): void => { dirty = true; };
  session.on('change', mark);
  session.on('request', mark);
  const raf = (): void => {
    const fps = getFps(app);
    const animating = fps !== null && fps.isTurning;
    if (dirty || animating) {
      renderFrame(gl, session, app);
      dirty = false;
    }
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
}

/** Read the active fps mode (if the App is in fps), or null. */
function getFps(app: App): FpsMode | null {
  const mode = app.activeMode as unknown as { name: string };
  if (mode.name !== 'fps') return null;
  return app.activeMode as unknown as FpsMode;
}

/** Snapshot the session/pose/sprites and hand them to the GL viewport. */
function renderFrame(gl: GlViewport, session: NethackSession, app: App): void {
  const hero = session.hero;
  if (hero === null) return;
  const fps = getFps(app);
  const facing: Facing | null = fps ? fps.currentFacing : null;
  const yaw = fps ? fps.currentYaw : 0;
  const vFovDeg = fps ? fps.vFovDeg : 60;
  const pose = poseFor(hero, yaw);
  const sprites = spritesFromMap(session, hero, facing === null);
  gl.render(session.map, pose, sprites, vFovDeg);
}

// Attach on DOMContentLoaded so #term exists.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}
