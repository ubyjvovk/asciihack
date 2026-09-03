/**
 * Browser entry point (docs/web.md). Reads `?name=…` (and optionally
 * `?theme=…` / `?mode=…`) from the URL, opens a WebSocket to `/play`
 * (proxied by Vite to the WS server), wires a `NethackSession` + `App` to
 * the DOM terminal, and starts the fps mode by default. The three.js
 * viewport (T-0031) will later replace the fps viewport with an
 * AsciiCity-style render.
 */
import { NethackSession, runSession } from '../../src/engine/session.js';
import { App } from '../../src/ui/app.js';
import type { Theme } from '../../src/render/themes.js';
import { DEFAULT_SETTINGS, type Settings } from '../../src/ui/settings.js';
import { DomTerm } from './dom-term.js';
import { WsBridge } from './ws-bridge.js';

/** Character-name rule from `bin/asciihack-lib.sh` — mirrored server-side. */
const NAME_RE = /^[A-Za-z0-9_-]{1,20}$/;

interface UrlOpts {
  name: string;
  theme: Theme | null;
  mode: string;
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
  return { name, theme, mode };
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

  socket.addEventListener('open', () => {
    app.enter();
  });
  socket.addEventListener('close', () => {
    // The bridge closed (game exit or server drop). Leave the app so any
    // final message the session collected shows up.
    app.leave();
  });

  void runSession(bridge, session).catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('runSession failed', err);
  });
}

// Attach on DOMContentLoaded so #term exists.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}
