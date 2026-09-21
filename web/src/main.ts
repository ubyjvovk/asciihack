/**
 * Browser entry point (docs/web.md). Reads `?name=…` (and optionally
 * `?theme=…` / `?mode=…` / `?render=…`) from the URL, opens a WebSocket to
 * `/play` (proxied by Vite to the WS server), wires a `NethackSession` +
 * `App` to the DOM terminal, and starts the fps mode by default.
 *
 * When `mode=fps` (or `ortho`), the three.js `GlViewport` (T-0031/T-0032)
 * is mounted under the DOM terminal's viewport rectangle and renders the
 * dungeon through AsciiCity's shader styles; `F5` cycles them, `F2`/`F3`
 * switch between the first-person and 3/4 overhead ortho camera, and `F9`
 * switches to the third-person long-lens follow (T-0052 —
 * `docs/gpu-thirdperson.md`; F4 was already taken by the minimap toggle in
 * `src/ui/app.ts`). `Q`/`E` rotate the third-person camera in 45° steps and
 * the mouse wheel zooms between the min/max distance. Both key bindings mark
 * the viewport dirty immediately so the next rAF paints the change without
 * waiting for a game event.
 */
import { NethackSession, runSession } from '../../src/engine/session.js';
import { App } from '../../src/ui/app.js';
import { FpsMode, type MovementScheme } from '../../src/ui/modes/fps.js';
import { poseFor, spritesFromMap, charKey, sendKey } from '../../src/ui/view3d.js';
import {
  createTraveler,
  findPath,
  type Traveler,
  type TravelerState,
} from '../../src/ui/travel.js';
import type { Cell } from './gpu/pick.js';
import type { Theme } from '../../src/render/themes.js';
import { DEFAULT_SETTINGS, type Settings } from '../../src/ui/settings.js';
import { DomTerm } from './dom-term.js';
import { WsBridge } from './ws-bridge.js';
import { GlViewport } from './gl/gl-viewport.js';
import { HERO_SPRITE_HEIGHT } from './gl/ortho-camera.js';

/** Character-name rule from `bin/asciihack-lib.sh` — mirrored server-side. */
const NAME_RE = /^[A-Za-z0-9_-]{1,20}$/;

/** The 3D camera the page starts in. */
export type ViewName = 'fps' | 'ortho' | 'third';

interface UrlOpts {
  name: string;
  theme: Theme | null;
  mode: string;
  render: string | null;
  /** `?view=third` selects the third-person view once the viewport is mounted.
   *  Matches the `?view=fps|ortho` pattern already accepted by `scene-bench`. */
  view: ViewName;
  /** The `?view=` the URL actually carried, or null when it was absent. */
  viewExplicit: ViewName | null;
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
  // Afterburn's long-lens follow camera is the default 3D view (user,
  // 2026-09-21); `?view=fps` or `?view=ortho` opts out, and F2/F3/F9 still
  // switch at runtime.
  const rawView = p.get('view');
  const viewExplicit: ViewName | null =
    rawView === 'fps' || rawView === 'ortho' || rawView === 'third' ? rawView : null;
  const view: ViewName = viewExplicit ?? 'third';
  return { name, theme, mode, render, view, viewExplicit };
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
  // GPU-path knobs (`?gpu`/`?q`/`?backend`/`?mood`) default from the query
  // inside `GlViewport`, so /scene.html and this entry share defaults
  // (T-0040, docs/gpu-compose.md).
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
    // The 3D view defaults to afterburn's third-person follow camera. An
    // explicit `?view=` wins; failing that `?mode=ortho` still implies the
    // overhead camera, since that mode is asking for it.
    gl.setView(opts.viewExplicit ?? (opts.mode === 'ortho' ? 'ortho' : opts.view));
    // Movement scheme follows the 3D view: fps is a first-person camera, so
    // arrows turn/walk relative to the facing; ortho and third-person are
    // top-down/behind, so arrows are compass moves and the avatar swings to
    // face the direction (T-0057). Applied once at boot and again below on
    // every F2/F3/F9 view switch.
    syncMovement(app, gl.currentView);
    const traveler = createTraveler({
      session,
      sendStep: (viKey) => sendKey(session, () => {}, charKey(viKey)),
    });
    const loop = createRenderLoop(gl, session, app, traveler);
    // Debug handle so the PM can diagnose the viewport from the page console:
    // `window.__asciihack.gl.debugInfo()` (plain numbers, see gl-viewport.ts)
    // and `window.__asciihack.travel` (last pick, last path length, traveler
    // state) — the click-to-move instrument the T-0061 rework asked for.
    const travelDebug: TravelDebug = { lastPick: null, lastPathLength: null };
    (window as unknown as {
      __asciihack: {
        gl: GlViewport;
        travel: {
          debug: TravelDebug;
          state(): TravelerState;
        };
      };
    }).__asciihack = {
      gl,
      travel: { debug: travelDebug, state: () => traveler.state() },
    };
    // Click-to-move (T-0061). The GL canvas is `pointer-events: none` so the
    // DOM terminal keeps focus (docs/web.md); the terminal <pre> is where
    // clicks land, and `gl.pickCell` unprojects the event onto the floor plane
    // through the live camera.
    host.addEventListener('click', (ev) => {
      const bounds = { width: session.map.width, height: session.map.height };
      const cell = gl.pickCell(ev, bounds);
      travelDebug.lastPick = cell;
      travelDebug.lastPathLength = null;
      if (cell === null) return;
      const hero = session.hero;
      if (hero === null) return;
      const path = findPath(session.map, hero, cell);
      travelDebug.lastPathLength = path === null ? null : path.length;
      if (path === null || path.length === 0) return;
      traveler.start(path);
      loop.mark();
    });
    // Capture F5 (style cycle) and F2/F3 (view switch) at the document level
    // so the WebGL viewport reacts before the App consumes them, and mark the
    // loop dirty so the next rAF repaints without waiting for a session event
    // (T-0032 fix for the T-0031 nit).
    document.addEventListener('keydown', (ev) => {
      // Any key press stops an in-flight travel — a queued burst that ignored
      // the interrupt would walk the hero into whatever the player just
      // reacted to (T-0061). Modifier-only presses (Shift, Ctrl, …) do not
      // count as an override.
      if (!isModifierOnly(ev)) traveler.abort('user-key');
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
        // App also handles F3 (switches to ortho mode); defer so the
        // FpsMode we're targeting reflects the post-switch active mode.
        queueMicrotask(() => syncMovement(app, gl.currentView));
        return;
      }
      if (ev.key === 'F2') {
        gl.setView('fps');
        loop.mark();
        queueMicrotask(() => syncMovement(app, gl.currentView));
        return;
      }
      if (ev.key === 'F9') {
        // T-0052: F4 was taken (minimap toggle in `src/ui/app.ts`), so the
        // third-person view lands on F9 per the ticket's fallback rule.
        gl.setView('third');
        loop.mark();
        syncMovement(app, gl.currentView);
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      if (gl.currentView === 'third') {
        // Q/E rotate the third-person yaw in 45° steps (afterburn's snap);
        // ignored in the other views so game keys (like `q` for quaff) reach
        // the app in fps/ortho.
        if (ev.key === 'q' || ev.key === 'Q') {
          gl.rotateThird(-1);
          loop.mark();
          ev.preventDefault();
          ev.stopPropagation();
          return;
        }
        if (ev.key === 'e' || ev.key === 'E') {
          gl.rotateThird(+1);
          loop.mark();
          ev.preventDefault();
          ev.stopPropagation();
          return;
        }
      }
      if (ev.key === 'F8') {
        // T-0040: flip between raw GPU output and the styled composite.
        // Verified F1..F7 are the only F-key bindings in `src/ui/app.ts`, so
        // F8 is unbound and safe to grab here.
        gl.toggleRaw();
        loop.mark();
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
    }, { capture: true });
    // Third-person mouse-wheel zoom. Only active while the third view is up
    // so a normal scroll keeps working in fps/ortho. `deltaY / 100` maps a
    // notch to ~1 cell of camera movement — `clampThirdDist` inside
    // `GlViewport` enforces the ART_BIBLE §6 min/max distance band.
    document.addEventListener('wheel', (ev: WheelEvent) => {
      if (gl.currentView !== 'third') return;
      gl.zoomThird(ev.deltaY / 100);
      loop.mark();
      ev.preventDefault();
    }, { passive: false });
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
 *
 * The click-to-move traveler (T-0061) also ticks here: at most one vi-key
 * per rAF, so a queued walk cannot outrun the game or the browser.
 */
function createRenderLoop(gl: GlViewport, session: NethackSession, app: App, traveler: Traveler): RenderLoop {
  let dirty = true;
  const mark = (): void => { dirty = true; };
  session.on('change', mark);
  session.on('request', mark);
  const raf = (): void => {
    traveler.tick();
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

/** Modifier-only keydown events don't count as a travel-abort trigger. */
function isModifierOnly(ev: KeyboardEvent): boolean {
  return ev.key === 'Shift' || ev.key === 'Control' || ev.key === 'Alt' || ev.key === 'Meta';
}

/** Debug snapshot for the click-to-move path — mutated on every click and read
 *  through `window.__asciihack.travel.debug` (T-0061 rework 2). */
interface TravelDebug {
  lastPick: Cell | null;
  lastPathLength: number | null;
}

/** Read the active fps mode (if the App is in fps), or null. */
function getFps(app: App): FpsMode | null {
  const mode = app.activeMode as unknown as { name: string };
  if (mode.name !== 'fps') return null;
  return app.activeMode as unknown as FpsMode;
}

/** Movement scheme that goes with each 3D view. */
function movementFor(view: 'fps' | 'ortho' | 'third'): MovementScheme {
  return view === 'fps' ? 'facing' : 'absolute';
}

/**
 * Push the movement scheme onto the active FpsMode (if any). When the App is
 * currently in classic/ortho mode this is a no-op — the FpsMode instance is
 * still inside App's registry, but it will pick up its scheme on the next
 * `syncMovement` after F2 activates it (T-0057).
 */
function syncMovement(app: App, view: 'fps' | 'ortho' | 'third'): void {
  const fps = getFps(app);
  if (fps === null) return;
  fps.setMovement(movementFor(view));
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
  // Third-person needs the hero visible too — the camera looks *at* the hero
  // from behind and above, so an invisible hero would leave the frame empty.
  const includeHero = gl.currentView !== 'fps';
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
