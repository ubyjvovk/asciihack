/**
 * Integration test for the nh-bridge binary. Runs the same flow as
 * `scripts/bridge-smoke.ts` but under vitest, gated on the bridge being
 * built (otherwise skipped so the plain unit test run stays fast and
 * dependency-free).
 */
import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import { cpSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Writable, Readable } from 'node:stream';

const repo = resolve(new URL('..', import.meta.url).pathname);
const bin = join(repo, 'build', 'nethack', 'bridge', 'nh-bridge');
const srcPg = join(repo, 'build', 'nethack', 'bridge', 'playground');
const bridgeReady = existsSync(bin) && existsSync(srcPg);

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

describe.skipIf(!bridgeReady)('nh-bridge', () => {
  it('emits a valid hello and prints ≥ 30 print_glyph calls (one MG_HERO) before first input', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'nh-bridge-vitest-'));
    const pg = join(tmp, 'playground');
    cpSync(srcPg, pg, { recursive: true });

    const env = {
      ...process.env,
      NETHACKDIR: pg,
      NETHACKOPTIONS:
        'role:Valkyrie,race:human,gender:female,align:neutral,name:smoke,pettype:none',
    };
    const child: ChildProcessByStdio<Writable, Readable, Readable> =
      spawn(bin, ['-u', 'smoke'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

    let helloOk = false;
    let heroSeen = false;
    let heroXY: { x: number; y: number } | null = null;
    let glyphCount = 0;
    let nextWinId = 1;
    let msgWinId: number | null = null;
    let helloNhw: Record<string, number> = {};
    let sawWelcomePutstr = false;
    let done = false;

    const write = (o: Record<string, unknown>): void => {
      child.stdin.write(JSON.stringify(o) + '\n');
    };

    for await (const line of rl) {
      if (done) break;
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (!helloOk) {
        expect(msg.t).toBe('hello');
        const S = (msg.S as Record<string, number> | undefined) ?? {};
        expect(typeof S.S_vwall).toBe('number');
        expect(typeof S.S_room).toBe('number');
        expect(typeof S.S_ndoor).toBe('number');
        const cmap = msg.cmap as unknown;
        expect(Array.isArray(cmap)).toBe(true);
        const extra = msg.extra as { extcmds?: Array<{ name?: unknown }> } | undefined;
        expect(Array.isArray(extra?.extcmds)).toBe(true);
        expect(extra?.extcmds?.some((e) => isRecord(e) && e.name === 'quit')).toBe(true);
        expect(isRecord(msg.mg)).toBe(true);
        helloNhw = (msg.nhw as Record<string, number> | undefined) ?? {};
        helloOk = true;
        continue;
      }
      if (msg.t === 'tables') {
        const mons = msg.monsters as Array<Record<string, unknown>>;
        const jackal = mons.find((m) => m.name === 'jackal');
        expect(jackal).toBeDefined();
        expect(jackal?.letter).toBe('d');
        expect(jackal?.size).toBe(1);
        const objs = msg.objects as Array<Record<string, unknown>>;
        expect(objs.some((o) => o.name === 'dagger')).toBe(true);
        continue;
      }
      if (msg.t === 'log') continue;
      if (msg.t === 'exit') {
        throw new Error(`bridge exited early: code ${String(msg.code)} reason ${String(msg.reason)}`);
      }
      if (msg.t !== 'call') throw new Error(`unexpected: ${JSON.stringify(msg)}`);
      const call = msg as { name: string; id?: number; args: unknown[] };
      const id = call.id;
      const needsReply = typeof id === 'number';

      switch (call.name) {
        case 'print_glyph': {
          glyphCount++;
          const [, x, y, gi] = call.args as [number, number, number, { flags: number } | null];
          if (gi && (gi.flags & 0x1) !== 0) { heroSeen = true; heroXY = { x, y }; }
          break;
        }
        case 'curs': {
          const [, x, y] = call.args as [number, number, number];
          heroXY = { x, y };
          break;
        }
        case 'create_nhwindow': {
          const [type] = call.args as [number];
          const wid = nextWinId++;
          if (type === helloNhw.NHW_MESSAGE) msgWinId = wid;
          if (needsReply) write({ id, ret: wid });
          break;
        }
        case 'putstr': {
          const [, , s] = call.args as [number, number, string | null];
          if (typeof s === 'string' && s.includes('welcome to NetHack'))
            sawWelcomePutstr = true;
          break;
        }
        case 'player_selection_or_tty':  if (needsReply) write({ id, ret: false }); break;
        case 'askname':                  if (needsReply) write({ id, ret: 'smoke' }); break;
        case 'yn_function': {
          const [, , def] = call.args as [string | null, string | null, string];
          if (needsReply) write({ id, ret: def || 'n' });
          break;
        }
        case 'select_menu':              if (needsReply) write({ id, ret: -1 }); break;
        case 'display_nhwindow':         if (needsReply) write({ id, ret: 0 }); break;
        case 'display_file':             if (needsReply) write({ id, ret: 0 }); break;
        case 'message_menu':             if (needsReply) write({ id, ret: 32 }); break;
        case 'doprev_message':           if (needsReply) write({ id, ret: 0 }); break;
        case 'getlin':                   if (needsReply) write({ id, ret: '' }); break;
        case 'get_ext_cmd':              if (needsReply) write({ id, ret: -1 }); break;
        case 'nhgetch':
        case 'nh_poskey': {
          expect(glyphCount).toBeGreaterThanOrEqual(30);
          expect(heroSeen).toBe(true);
          expect(heroXY).not.toBeNull();
          expect(msgWinId).not.toBeNull();
          expect(sawWelcomePutstr).toBe(true);
          if (needsReply) write({ id, ret: 27 });
          done = true;
          break;
        }
        default:
          if (needsReply) write({ id, ret: null });
      }
    }

    child.kill('SIGTERM');
    await new Promise<void>((r) => { child.once('exit', () => r()); setTimeout(r, 500); });
    expect(helloOk).toBe(true);
  }, 30_000);

  it('exits code 2 within 1s when stdin closes while awaiting a reply', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'nh-bridge-eof-'));
    const pg = join(tmp, 'playground');
    cpSync(srcPg, pg, { recursive: true });

    const env = {
      ...process.env,
      NETHACKDIR: pg,
      NETHACKOPTIONS:
        'role:Valkyrie,race:human,gender:female,align:neutral,name:smoke,pettype:none',
    };
    const child = spawn(bin, ['-u', 'smoke'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => chunks.push(b));
    // Close stdin immediately; the bridge should hit EOF on its first
    // reply-waiting call (create_nhwindow) and exit.
    child.stdin.end();
    const t0 = Date.now();
    const code: number = await new Promise((r) => child.once('exit', (c) => r(c ?? -1)));
    const dt = Date.now() - t0;
    const out = Buffer.concat(chunks).toString('utf8');
    expect(code).toBe(2);
    expect(dt).toBeLessThan(1000);
    // Last non-empty line is an exit object with a reason.
    const lines = out.split('\n').filter((l) => l.length > 0);
    const last = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
    expect(last.t).toBe('exit');
    expect(last.code).toBe(2);
    expect(typeof last.reason).toBe('string');
  }, 10_000);

  it('emits every stdout line as valid JSON', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'nh-bridge-json-'));
    const pg = join(tmp, 'playground');
    cpSync(srcPg, pg, { recursive: true });

    const env = {
      ...process.env,
      NETHACKDIR: pg,
      NETHACKOPTIONS:
        'role:Valkyrie,race:human,gender:female,align:neutral,name:smoke,pettype:none',
    };
    const child = spawn(bin, ['-u', 'smoke'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => chunks.push(b));
    child.stdin.end();
    await new Promise<void>((r) => child.once('exit', () => r()));
    const lines = Buffer.concat(chunks).toString('utf8').split('\n').filter((l) => l.length > 0);
    for (const l of lines) {
      expect(() => JSON.parse(l)).not.toThrow();
    }
  }, 10_000);
});
