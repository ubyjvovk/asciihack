/**
 * WebSocket bridge server (docs/web.md). One process listens on a TCP port and
 * spawns one `nh-bridge` per socket connection. Every stdout line from the
 * bridge is forwarded to the socket as a text frame; every text frame from
 * the socket is written to the bridge's stdin. Closing the socket kills the
 * bridge, and the bridge exiting closes the socket.
 *
 * Binds every interface (`0.0.0.0`) by default so a browser on another
 * machine can reach it; set `ASCIIHACK_WS_HOST=127.0.0.1` (or `--host=`) for
 * loopback only. There is **no authentication** — see docs/web.md "Security".
 *
 * Because that kill is a `SIGTERM`, NetHack never cleans up its level locks,
 * so the server sweeps them (`./locks.ts`) at start and after each player's
 * last session — otherwise ten dead sessions wedge a name for three days
 * with "Too many hacks running now." See docs/web.md "Stale level locks".
 *
 * Run: `npm run web:server [-- --port 8790] [--playgrounds DIR]`.
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { IncomingMessage, createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { spawnBridge } from '../src/engine/bridge.js';
import type { BridgeProcess } from '../src/engine/bridge.js';
import { sweepAllPlaygrounds, sweepPlaygroundLocks } from './locks.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
/** Default nh-bridge binary path (matches `src/cli.ts`). */
const DEFAULT_BRIDGE = join(REPO, 'build', 'nethack', 'bridge', 'nh-bridge');
/** Default source playground (cloned from the build on first per-player use). */
const DEFAULT_PLAYGROUND_SRC = join(REPO, 'build', 'nethack', 'bridge', 'playground');
/** Default per-player playgrounds root. */
const DEFAULT_PLAYGROUNDS = join(process.env.ASCIIHACK_HOME ?? join(homedir(), '.asciihack'), 'players');

/** The name rule reused from `bin/asciihack-lib.sh:asciihack_valid_name`. */
const NAME_RE = /^[A-Za-z0-9_-]{1,20}$/;

/** Parsed CLI flags. */
export interface ServerFlags {
  host: string;
  port: number;
  bridge: string;
  playgroundSrc: string;
  playgrounds: string;
  /** Sweep stale NetHack level locks at start and after each session
   *  (docs/web.md "Stale level locks"). `--no-lock-sweep` turns it off for
   *  the case this server does not own `--playgrounds` alone. */
  sweepLocks: boolean;
}

/** Parse `argv.slice(2)` into `ServerFlags` (env overrides for defaults). */
export function parseServerFlags(argv: readonly string[]): ServerFlags {
  const flags: ServerFlags = {
    host: process.env.ASCIIHACK_WS_HOST ?? '0.0.0.0',
    port: Number(process.env.ASCIIHACK_WS_PORT ?? '8790'),
    bridge: process.env.ASCIIHACK_BRIDGE ?? DEFAULT_BRIDGE,
    playgroundSrc: process.env.ASCIIHACK_PLAYGROUND_SRC ?? DEFAULT_PLAYGROUND_SRC,
    playgrounds: process.env.ASCIIHACK_PLAYGROUNDS ?? DEFAULT_PLAYGROUNDS,
    sweepLocks: (process.env.ASCIIHACK_LOCK_SWEEP ?? '1') !== '0',
  };
  for (const arg of argv) {
    if (arg.startsWith('--host=')) flags.host = arg.slice('--host='.length);
    else if (arg.startsWith('--port=')) flags.port = Number(arg.slice('--port='.length));
    else if (arg.startsWith('--bridge=')) flags.bridge = arg.slice('--bridge='.length);
    else if (arg.startsWith('--playgrounds=')) flags.playgrounds = arg.slice('--playgrounds='.length);
    else if (arg.startsWith('--playground-src=')) flags.playgroundSrc = arg.slice('--playground-src='.length);
    else if (arg === '--no-lock-sweep') flags.sweepLocks = false;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'usage: asciihack-ws [--host=HOST] [--port=PORT] [--bridge=PATH] [--playgrounds=DIR] [--playground-src=DIR] [--no-lock-sweep]\n',
      );
      process.exit(0);
    } else {
      process.stderr.write(`asciihack-ws: unknown argument "${arg}"\n`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(flags.port) || flags.port <= 0) {
    process.stderr.write(`asciihack-ws: invalid --port\n`);
    process.exit(2);
  }
  return flags;
}

/** Extract and validate `?name=` from a `/play` request URL. Returns `null` on
 *  rejection (the caller closes the socket with 4400/4404). */
export function playerNameFromUrl(rawUrl: string, host: string): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl, `http://${host}`);
  } catch {
    return null;
  }
  if (u.pathname !== '/play') return null;
  const name = u.searchParams.get('name') ?? '';
  return NAME_RE.test(name) ? name : null;
}

/** Ensure the per-player playground exists (copied from the source on first use). */
export function ensurePlayerPlayground(src: string, target: string): void {
  if (existsSync(target)) return;
  if (!existsSync(src)) {
    throw new Error(
      `playground source not found at ${src} — run "bash scripts/nethack-build.sh lib && bash scripts/nethack-build.sh bridge" first`,
    );
  }
  mkdirSync(dirname(target), { recursive: true });
  cpSync(src, target, { recursive: true });
}

/**
 * Wire one WebSocket to one bridge process: bridge stdout lines → text frames,
 * text frames → bridge stdin, socket close → kill bridge, bridge exit →
 * close socket. Returns when the pairing is set up (both handlers registered).
 * Injectable `spawn` so tests can substitute a fake bridge.
 */
export function attachBridgeToSocket(
  socket: WebSocket,
  bridge: BridgeProcess,
  onClose?: () => void,
): void {
  let socketClosed = false;
  let bridgeExited = false;

  // Bridge → socket: forward each per-line message as its own text frame.
  void (async () => {
    try {
      for await (const msg of bridge.messages) {
        if (socketClosed) break;
        // Re-serialise: the session and browser both parse JSON per frame.
        socket.send(JSON.stringify(msg));
      }
    } catch {
      // The bridge stream ended (child exited / stdout closed) — the exited
      // promise below handles the socket close.
    }
  })();

  // Socket → bridge: each frame is expected to be one JSON reply line.
  socket.on('message', (data, isBinary) => {
    if (bridgeExited) return;
    const text = isBinary ? Buffer.from(data as ArrayBuffer).toString('utf8') : String(data);
    if (text.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return; // ignore garbage; the bridge would reject it anyway
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    bridge.reply(parsed as { id: number; ret: number | string | boolean | null });
  });

  socket.on('close', () => {
    if (socketClosed) return;
    socketClosed = true;
    if (!bridgeExited) bridge.kill('SIGTERM');
    onClose?.();
  });

  bridge.exited
    .then(() => {
      bridgeExited = true;
      if (!socketClosed) {
        socketClosed = true;
        try {
          socket.close(1000, 'bridge exit');
        } catch {
          /* already closed */
        }
        onClose?.();
      }
    })
    .catch(() => {
      /* the exited promise never rejects in `spawnBridge` */
    });
}

/** Start listening; returns a shutdown function. */
export function startServer(flags: ServerFlags): { close: () => Promise<void> } {
  const http = createServer((_req, res) => {
    // The Vite dev server proxies `/play` here; anything else is not us.
    res.statusCode = 426;
    res.end('This is a WebSocket endpoint (/play?name=<name>)\n');
  });
  const wss = new WebSocketServer({ noServer: true });

  // Boot sweep: this process owns no sessions yet, so every level lock under
  // the playgrounds root is litter from a run that died without quitting.
  // NetHack cannot reclaim these itself for three days (docs/web.md).
  if (flags.sweepLocks) {
    for (const [player, n] of sweepAllPlaygrounds(flags.playgrounds)) {
      // eslint-disable-next-line no-console
      console.log(`ws-server: swept ${n} stale lock file(s) name=${player}`);
    }
  }

  // Live sessions per player name. A name's playground is only safe to sweep
  // once its last bridge has exited — two tabs under one name get two lock
  // letters, and sweeping after the first would delete the second's levels.
  const live = new Map<string, number>();

  http.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = req.url ?? '';
    const host = req.headers.host ?? flags.host;
    const name = playerNameFromUrl(url, host);
    if (name === null) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const target = join(flags.playgrounds, name);
      try {
        ensurePlayerPlayground(flags.playgroundSrc, target);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`ws-server: playground setup failed for ${name}: ${String(err)}`);
        try {
          ws.close(1011, 'playground setup failed');
        } catch {
          /* closed */
        }
        return;
      }
      const bridge = spawnBridge({
        binary: flags.bridge,
        playgroundDir: target,
        name,
      });
      const startedAt = Date.now();
      live.set(name, (live.get(name) ?? 0) + 1);
      // eslint-disable-next-line no-console
      console.log(`ws-server: session start name=${name} target=${target}`);
      attachBridgeToSocket(ws, bridge, () => {
        // eslint-disable-next-line no-console
        console.log(`ws-server: session end   name=${name} durationMs=${Date.now() - startedAt}`);
      });
      // Sweep on bridge *exit*, not on socket close: the socket handler has
      // only just sent SIGTERM at that point, and NetHack is still holding
      // its level files open.
      void bridge.exited.then(() => {
        const remaining = (live.get(name) ?? 1) - 1;
        if (remaining > 0) {
          live.set(name, remaining);
          return;
        }
        live.delete(name);
        if (!flags.sweepLocks) return;
        const swept = sweepPlaygroundLocks(target);
        if (swept > 0) {
          // eslint-disable-next-line no-console
          console.log(`ws-server: swept ${swept} stale lock file(s) name=${name}`);
        }
      });
    });
  });

  http.listen(flags.port, flags.host, () => {
    // eslint-disable-next-line no-console
    console.log(`ws-server: listening on ws://${flags.host}:${flags.port}/play`);
  });

  return {
    close: async (): Promise<void> => {
      await new Promise<void>((r) => http.close(() => r()));
      wss.close();
    },
  };
}

// Only auto-run when invoked as a script (not when imported by tests).
const invokedDirect =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirect) {
  const flags = parseServerFlags(process.argv.slice(2));
  startServer(flags);
}
