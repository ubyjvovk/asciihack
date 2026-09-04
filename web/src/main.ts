/**
 * Browser entry point (docs/web.md). Reads `?name=…` (and optionally
 * `?theme=…` / `?mode=…` / `?render=…`) from the URL, opens a WebSocket to
 * `/play` (proxied by Vite to the WS server), wires a `NethackSession` +
 * `App` to the DOM terminal, and starts the fps mode by default.
 *
 * When `mode=fps` (or `ortho`), the three.js `GlViewport` (T-0031/T-0032)
 * is mounted under the DOM terminal's viewport rectangle and renders the
 * dungeon through AsciiCity's shader styles; `F5` cycles them, `F2`/`F3`
 * switch between the first-person and 3/4 overhead ortho camera. Both key
 * bindings mark the viewport dirty immediately so the next rAF paints the
 * change without waiting for a game event.
 */
import { NethackSession, runSession } from '../../src/engine/session.js';
import { App } from '../../src/ui/app.js';
import { FpsMode } from '../../src/ui/modes/fps.js';
import { poseFor, spritesFromMap } from '../../src/ui/view3d.js';
import type { Theme } from '../../src/render/themes.js';
import { DEFAULT_SETTINGS, type Settings } from '../../src/ui/settings.js';
import { DomTerm } from './dom-term.js';
import { WsBridge } from './ws-bridge.js';
import { GlViewport } from './gl/gl-viewport.js';
import { HERO_SPRITE_HEIGHT } from './gl/ortho-camera.js';

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

  // GL viewport — only for the 3D modes; if present the App skips its CPU
  // dungeon render so the WebGL canvas below shows through (T-0031 rework 2).
  const gl = opts.mode === 'fps' || opts.mode === 'ortho'
    ? new GlViewport({ parent: document.body, initialStyle: opts.render ?? undefined })
    : null;

  const session = new NethackSession((r) => bridge.reply(r), { playerName: opts.name });
  const app = new App({
    session,
    term,
    mode: opts.mode,
    theme: opts.theme ?? undefined,
    settings,
    externalViewport: gl !== null,
  });
  if (gl !== null) {
    gl.setView(opts.mode === 'ortho' ? 'ortho' : 'fps');
    // Debug handle so the PM can diagnose the viewport from the page console:
    // `window.__asciihack.gl.debugInfo()` (plain numbers, see gl-viewport.ts).
    (window as unknown as { __asciihack: { gl: GlViewport } }).__asciihack = { gl };
    const loop = createRenderLoop(gl, session, app);
    // Capture F5 (style cycle) and F2/F3 (view switch) at the document level
    // so the WebGL viewport reacts before the App consumes them, and mark the
    // loop dirty so the next rAF repaints without waiting for a session event
    // (T-0032 fix for the T-0031 nit).
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'F5') {
        const step = ev.shiftKey ? -1 : 1;
        gl.cycleStyle(step);
        loop.mark();
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      if (ev.key === 'F3') {
        gl.setView('ortho');
        loop.mark();
        return;
      }
      if (ev.key === 'F2') {
        gl.setView('fps');
        loop.mark();
        return;
      }
    }, { capture: true });
    placeGl(gl, term);
    const relayout = (): void => placeGl(gl, term);
    const glResizeObserver = new ResizeObserver(relayout);
    glResizeObserver.observe(host);
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

/** Handle returned by `createRenderLoop`; `mark()` forces the next rAF to
 *  render even without a session event (used by F5/F2/F3 in `boot`). */
interface RenderLoop {
  mark(): void;
}

/**
 * Frame loop: renders whenever the session announces a change, the fps mode
 * is animating a turn, or a caller `mark()`s the loop dirty (view/style
 * switch). `requestAnimationFrame` is throttled to the browser's refresh
 * rate; when nothing changes we skip the GL call entirely.
 */
function createRenderLoop(gl: GlViewport, session: NethackSession, app: App): RenderLoop {
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
  return { mark };
}

/** Read the active fps mode (if the App is in fps), or null. */
function getFps(app: App): FpsMode | null {
  const mode = app.activeMode as unknown as { name: string };
  if (mode.name !== 'fps') return null;
  return app.activeMode as unknown as FpsMode;
}

/** Snapshot the session/pose/sprites and hand them to the GL viewport. In
 *  ortho the hero is drawn as an `@` sprite (see `gl-viewport.ts`); in fps
 *  it stays invisible (the camera is at the hero cell). */
function renderFrame(gl: GlViewport, session: NethackSession, app: App): void {
  const hero = session.hero;
  if (hero === null) return;
  const fps = getFps(app);
  const yaw = fps ? fps.currentYaw : 0;
  const vFovDeg = fps ? fps.vFovDeg : 60;
  const pose = poseFor(hero, yaw);
  const includeHero = gl.currentView === 'ortho';
  const sprites = spritesFromMap(session, hero, includeHero);
  if (includeHero) {
    const heroIdx = sprites.findIndex((s) => s.x === hero.x && s.y === hero.y);
    if (heroIdx >= 0) {
      // Pin the hero sprite to the standard billboard height so the ortho
      // frustum sizing (7 × height) leaves the hero at ≈ 1/7 of the viewport.
      sprites[heroIdx] = { ...sprites[heroIdx]!, height: HERO_SPRITE_HEIGHT };
    }
  }
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
