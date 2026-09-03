#!/usr/bin/env -S npx tsx
/**
 * Record a real nh-bridge session to `tests/fixtures/bridge/<name>.jsonl`.
 *
 * Spawns build/nethack/bridge/nh-bridge in an isolated NETHACKDIR, drives it
 * with a scripted key sequence, and interleaves every stdout line and every
 * reply the client wrote back into a single JSON-lines file — one bridge
 * line per row, `{"reply": <RetMsg>}` lines whenever we replied to the
 * previous call — so tests can replay the exact stream deterministically
 * without needing the C build.
 *
 * Usage:
 *   npx tsx scripts/record-bridge.ts --out FILE
 *      [--keys 'hjkl'] [--stop-at first-key|save-confirmed|eof]
 *      [--name smoke] [--role Valkyrie] ...
 *
 * Defaults record the "start" fixture: stop at the first `nhgetch`.
 * `--keys 'hjkl'` sends those keys after startup and stops when the stream
 * ends (or after `--limit N` more messages once keys are exhausted).
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';

interface Args {
  out: string;
  keys: string;
  stopAt: 'first-key' | 'save-confirmed' | 'eof';
  name: string;
  role: string;
  race: string;
  gender: string;
  align: string;
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    out: 'tests/fixtures/bridge/start.jsonl',
    keys: '',
    stopAt: 'first-key',
    name: 'rec',
    role: 'Valkyrie',
    race: 'human',
    gender: 'female',
    align: 'neutral',
    limit: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const v = argv[i + 1];
    switch (k) {
      case '--out': a.out = v!; i++; break;
      case '--keys': a.keys = v!; i++; break;
      case '--stop-at': a.stopAt = v as Args['stopAt']; i++; break;
      case '--name': a.name = v!; i++; break;
      case '--role': a.role = v!; i++; break;
      case '--race': a.race = v!; i++; break;
      case '--gender': a.gender = v!; i++; break;
      case '--align': a.align = v!; i++; break;
      case '--limit': a.limit = Number(v); i++; break;
      default:
        if (k.startsWith('--')) {
          console.error(`unknown flag: ${k}`);
          process.exit(2);
        }
    }
  }
  return a;
}

interface HelloMsg { t: 'hello'; nhw: Record<string, number>; mg: Record<string, number> }
interface CallMsg { t: 'call'; id?: number; name: string; args: unknown[] }
interface ExitMsg { t: 'exit'; code: number; reason?: string }
interface LogMsg { t: 'log'; msg: string }
type BridgeMsg = HelloMsg | CallMsg | ExitMsg | LogMsg;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repo = resolve(new URL('..', import.meta.url).pathname);
  const bin = join(repo, 'build', 'nethack', 'bridge', 'nh-bridge');
  const srcPg = join(repo, 'build', 'nethack', 'bridge', 'playground');
  if (!existsSync(bin) || !existsSync(srcPg)) {
    console.error(`record-bridge: bridge not built (${bin} missing). Run: bash scripts/nethack-build.sh bridge`);
    process.exit(2);
  }

  const tmp = mkdtempSync(join(tmpdir(), 'nh-bridge-rec-'));
  const pg = join(tmp, 'playground');
  cpSync(srcPg, pg, { recursive: true });

  const outPath = resolve(repo, args.out);
  mkdirSync(dirname(outPath), { recursive: true });

  const env = {
    ...process.env,
    NETHACKDIR: pg,
    NETHACKOPTIONS: `!tutorial,role:${args.role},race:${args.race},gender:${args.gender},align:${args.align},name:${args.name},pettype:none`,
  };
  const child: ChildProcessByStdio<Writable, Readable, Readable> = spawn(
    bin,
    ['-u', args.name],
    { env, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  child.stderr.on('data', (b: Buffer) => process.stderr.write(`[bridge] ${b.toString()}`));

  const collected: string[] = [];
  const write = (obj: Record<string, unknown>): void => {
    const line = JSON.stringify(obj);
    child.stdin.write(line + '\n');
    collected.push(JSON.stringify({ reply: obj }));
  };

  let nextWinId = 1;
  let done = false;
  let stopReason: string | null = null;
  const keys = Array.from(args.keys);
  let keyIdx = 0;
  let saveState: 'none' | 'sent-S' | 'confirmed' = 'none';
  let saveConfirmedCountdown = 0;
  let extraAfterKeys = 0;

  // Buffered line reader
  let buffer = '';
  const finish = async (reason: string): Promise<void> => {
    if (done) return;
    done = true;
    stopReason = reason;
  };

  child.stdout.on('data', async (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.length === 0) continue;
      collected.push(line);
      let msg: BridgeMsg;
      try { msg = JSON.parse(line) as BridgeMsg; }
      catch { continue; }
      if (msg.t === 'exit') { await finish('exit'); child.stdin.end(); continue; }
      if (msg.t !== 'call') continue;
      const call = msg;
      const id = call.id;
      const needsReply = typeof id === 'number';

      switch (call.name) {
        case 'create_nhwindow':          if (needsReply) write({ id, ret: nextWinId++ }); break;
        case 'player_selection_or_tty':  if (needsReply) write({ id, ret: false }); break;
        case 'player_selection':         if (needsReply) write({ id, ret: 0 }); break;
        case 'askname':                  if (needsReply) write({ id, ret: args.name }); break;
        case 'yn_function': {
          const [q, , def] = call.args as [string | null, string | null, number];
          // Confirm save with 'y' when NetHack asks the "Really save?" question.
          const query = (q ?? '').toLowerCase();
          if (saveState === 'sent-S' && query.includes('save')) {
            saveState = 'confirmed';
            if (needsReply) write({ id, ret: 'y'.charCodeAt(0) });
            if (args.stopAt === 'save-confirmed') saveConfirmedCountdown = 20;
            break;
          }
          const ch = (typeof def === 'number' && def) ? def : 'n'.charCodeAt(0);
          if (needsReply) write({ id, ret: ch });
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
          if (args.stopAt === 'first-key') {
            if (needsReply) write({ id, ret: 27 });
            await finish('first-key');
            child.stdin.end();
            break;
          }
          if (keyIdx < keys.length) {
            const ch = keys[keyIdx++]!;
            if (needsReply) write({ id, ret: ch.charCodeAt(0) });
          } else if (saveState === 'none' && args.stopAt !== 'eof') {
            saveState = 'sent-S';
            if (needsReply) write({ id, ret: 'S'.charCodeAt(0) });
          } else if (saveState === 'confirmed' || args.stopAt === 'eof') {
            if (args.limit > 0 && extraAfterKeys >= args.limit) {
              if (needsReply) write({ id, ret: 27 });
              await finish('limit');
              child.stdin.end();
              break;
            }
            if (needsReply) write({ id, ret: 27 });
            extraAfterKeys++;
          } else {
            if (needsReply) write({ id, ret: 27 });
          }
          break;
        }
        default:
          if (needsReply) write({ id, ret: null });
      }
      if (saveConfirmedCountdown > 0) {
        saveConfirmedCountdown--;
        if (saveConfirmedCountdown === 0) {
          // We asked to stop once the save was confirmed; give the bridge a
          // moment to finish its exit line then close stdin.
          setTimeout(() => child.stdin.end(), 200);
        }
      }
    }
  });

  const code: number = await new Promise((r) => child.once('exit', (c) => r(c ?? -1)));
  // Flush anything the bridge printed after we told it to stop (the exit line).
  if (buffer.length > 0) {
    collected.push(buffer);
    buffer = '';
  }

  writeFileSync(outPath, collected.join('\n') + '\n');
  console.log(`record-bridge: wrote ${collected.length} lines to ${outPath} (bridge exit ${code}, stop=${stopReason ?? 'exit'})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
