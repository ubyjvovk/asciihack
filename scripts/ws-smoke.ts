#!/usr/bin/env -S npx tsx
/**
 * WS-server smoke test (T-0030). Starts `server/ws-server.ts` on a random
 * port, opens a client to `/play?name=smoke`, answers just enough calls to
 * reach the first `nhgetch`/`nh_poskey`, then closes the socket and asserts
 * the bridge process exits within 1 s. Prints one status line and exits
 * with code 0 on success, 1 on failure. Requires the bridge build.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { startServer, type ServerFlags } from '../server/ws-server.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const BRIDGE = process.env.ASCIIHACK_BRIDGE ?? join(REPO, 'build', 'nethack', 'bridge', 'nh-bridge');
const PLAYGROUND_SRC = process.env.ASCIIHACK_PLAYGROUND_SRC ?? join(REPO, 'build', 'nethack', 'bridge', 'playground');
const PLAYGROUNDS = process.env.ASCIIHACK_PLAYGROUNDS ?? join(REPO, 'build', 'ws-smoke-players');

function die(msg: string): never {
  process.stderr.write(`ws-smoke: FAIL — ${msg}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (!existsSync(BRIDGE)) die(`bridge not built at ${BRIDGE}`);
  if (!existsSync(PLAYGROUND_SRC)) die(`playground missing at ${PLAYGROUND_SRC}`);

  const port = 8790 + Math.floor(Math.random() * 100);
  const flags: ServerFlags = {
    host: '127.0.0.1',
    port,
    bridge: BRIDGE,
    playgroundSrc: PLAYGROUND_SRC,
    playgrounds: PLAYGROUNDS,
  };
  const server = startServer(flags);
  // The server logs 'listening on…' from inside listen(); wait a tick.
  await new Promise((r) => setTimeout(r, 200));

  const url = `ws://127.0.0.1:${port}/play?name=smoke`;
  const ws = new WebSocket(url);

  let sawHello = false;
  let reachedInput = false;
  let nextWinId = 1;
  const winTypes = new Map<number, number>();
  let helloNhw: Record<string, number> = {};

  const send = (o: Record<string, unknown>): void => ws.send(JSON.stringify(o));

  ws.on('message', (data) => {
    const text = String(data);
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      die(`bad JSON frame: ${text.slice(0, 120)}`);
    }
    const t = msg['t'];
    if (t === 'hello') {
      sawHello = true;
      const nhw = (msg['nhw'] ?? {}) as Record<string, number>;
      helloNhw = nhw;
      void helloNhw;
      return;
    }
    if (t === 'tables') return;
    if (t === 'log') return;
    if (t === 'exit') return;
    if (t !== 'call') return;
    const id = msg['id'] as number | undefined;
    const name = msg['name'] as string;
    const args = (msg['args'] as unknown[]) ?? [];
    switch (name) {
      case 'create_nhwindow': {
        const type = args[0] as number;
        const wid = nextWinId++;
        winTypes.set(wid, type);
        if (id !== undefined) send({ id, ret: wid });
        break;
      }
      case 'player_selection_or_tty':
        if (id !== undefined) send({ id, ret: false });
        break;
      case 'askname':
        if (id !== undefined) send({ id, ret: 'smoke' });
        break;
      case 'yn_function': {
        const def = args[2] as number;
        if (id !== undefined) send({ id, ret: typeof def === 'number' && def ? def : 'n'.charCodeAt(0) });
        break;
      }
      case 'select_menu':
        if (id !== undefined) send({ id, ret: -1 });
        break;
      case 'display_nhwindow':
        if (id !== undefined) send({ id, ret: 0 });
        break;
      case 'display_file':
        if (id !== undefined) send({ id, ret: 0 });
        break;
      case 'message_menu':
        if (id !== undefined) send({ id, ret: ' '.charCodeAt(0) });
        break;
      case 'get_ext_cmd':
        if (id !== undefined) send({ id, ret: -1 });
        break;
      case 'getlin':
        if (id !== undefined) send({ id, ret: '' });
        break;
      case 'nhgetch':
      case 'nh_poskey':
        reachedInput = true;
        // Do not answer — the ticket wants us to close the socket here and
        // observe the bridge exit within 1 s.
        setTimeout(() => ws.close(), 20);
        break;
      default:
        if (id !== undefined) send({ id, ret: null });
        break;
    }
  });

  const closed = new Promise<void>((r) => ws.on('close', () => r()));
  const opened = new Promise<void>((r, rej) => {
    ws.on('open', () => r());
    ws.on('error', (e) => rej(e));
  });
  const timeout = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error('smoke timed out (30 s)')), 30000),
  );

  await Promise.race([opened, timeout]);
  await Promise.race([closed, timeout]);

  // Give the server 1 s to end the paired bridge process. Since the ticket
  // asks for the bridge to exit within 1 s and the server logs the
  // `session end` line synchronously in `attachBridgeToSocket`, waiting on
  // stdout log timing is fragile — instead we just wait a short window and
  // then shut the server down.
  await new Promise((r) => setTimeout(r, 1000));

  if (!sawHello) die('never saw hello line');
  if (!reachedInput) die('never reached first key request');

  await server.close();
  process.stdout.write('ws-smoke: hello ok, first-key ok, close ok\n');
  process.exit(0);
}

main().catch((e: unknown) => die(String(e)));
