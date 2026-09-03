import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  LineSplitter,
  parseBridgeLine,
  spawnBridge,
  type BridgeChild,
  type SpawnFn,
} from '../src/engine/bridge.js';
import type { BridgeMsg, RetMsg } from '../src/engine/protocol.js';

// ---------------------------------------------------------------------------
// Fake ChildProcess for the injected spawn.

class FakeChild implements BridgeChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  killed: NodeJS.Signals | number | null = null;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = signal ?? 'SIGTERM';
    // Simulate an immediate exit for the test.
    for (const l of this.exitListeners) l(0, null);
    return true;
  }

  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this {
    if (event === 'exit') this.exitListeners.push(listener);
    return this;
  }
}

interface Rig {
  child: FakeChild;
  spawn: SpawnFn;
  lastArgs: { binary: string; argv: readonly string[]; opts: { env: NodeJS.ProcessEnv } } | null;
}

function makeRig(): Rig {
  const rig: Rig = { child: new FakeChild(), spawn: undefined as unknown as SpawnFn, lastArgs: null };
  rig.spawn = (binary, argv, opts) => {
    rig.lastArgs = { binary, argv, opts };
    return rig.child;
  };
  return rig;
}

// ---------------------------------------------------------------------------
// LineSplitter unit tests.

describe('engine/bridge — LineSplitter', () => {
  it('yields complete lines and buffers the partial trailing chunk', () => {
    const s = new LineSplitter();
    expect(s.push('foo\nba')).toEqual(['foo']);
    expect(s.push('r\nbaz')).toEqual(['bar']);
    expect(s.push('\n')).toEqual(['baz']);
    expect(s.flush()).toEqual([]);
  });

  it('holds a partial trailing line across chunks with no newline', () => {
    const s = new LineSplitter();
    expect(s.push('abc')).toEqual([]);
    expect(s.push('def')).toEqual([]);
    expect(s.push('ghi\n')).toEqual(['abcdefghi']);
  });

  it('flushes a partial trailing line at end of stream', () => {
    const s = new LineSplitter();
    s.push('one\ntwo');
    expect(s.flush()).toEqual(['two']);
  });
});

// ---------------------------------------------------------------------------
// parseBridgeLine sanity check.

describe('engine/bridge — parseBridgeLine', () => {
  it('parses recognised message types', () => {
    expect(parseBridgeLine('{"t":"log","msg":"hi"}')).toEqual({ t: 'log', msg: 'hi' });
    expect(parseBridgeLine('{"t":"exit","code":0}')).toEqual({ t: 'exit', code: 0 });
  });

  it('drops unparseable JSON and unknown message types', () => {
    expect(parseBridgeLine('not json')).toBeNull();
    expect(parseBridgeLine('{"t":"mystery"}')).toBeNull();
    expect(parseBridgeLine('[]')).toBeNull();
    expect(parseBridgeLine('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// spawnBridge integration (through a fake child).

describe('engine/bridge — spawnBridge', () => {
  it('splits messages that arrive across chunk boundaries', async () => {
    const rig = makeRig();
    const bridge = spawnBridge({
      binary: '/fake/nh-bridge',
      playgroundDir: '/tmp/pg',
      name: 'me',
      spawn: rig.spawn,
    });

    const iter = bridge.messages[Symbol.asyncIterator]();

    // Two JSON messages, split across three chunks with a broken newline.
    rig.child.stdout.write('{"t":"log","msg":"one"}\n{"t":"lo');
    rig.child.stdout.write('g","msg":"tw');
    rig.child.stdout.write('o"}\n');

    const a = await iter.next();
    const b = await iter.next();
    expect(a.value).toEqual({ t: 'log', msg: 'one' });
    expect(b.value).toEqual({ t: 'log', msg: 'two' });
    rig.child.stdout.end();
    const c = await iter.next();
    expect(c.done).toBe(true);
  });

  it('flushes a partial trailing line when stdout ends', async () => {
    const rig = makeRig();
    const bridge = spawnBridge({
      binary: '/fake/nh-bridge', playgroundDir: '/tmp/pg', name: 'me', spawn: rig.spawn,
    });
    const iter = bridge.messages[Symbol.asyncIterator]();
    // No trailing LF; must still surface after end().
    rig.child.stdout.write('{"t":"exit","code":0}');
    rig.child.stdout.end();
    const r = await iter.next();
    expect(r.value).toEqual({ t: 'exit', code: 0 });
    const done = await iter.next();
    expect(done.done).toBe(true);
  });

  it('exposes per-chunk batches for coalescing', async () => {
    const rig = makeRig();
    const bridge = spawnBridge({
      binary: '/fake/nh-bridge', playgroundDir: '/tmp/pg', name: 'me', spawn: rig.spawn,
    });
    const iter = bridge.batches[Symbol.asyncIterator]();
    // One chunk carrying two complete messages must arrive as one batch.
    rig.child.stdout.write('{"t":"log","msg":"a"}\n{"t":"log","msg":"b"}\n');
    const batch = await iter.next();
    const value = batch.value as BridgeMsg[];
    expect(value.map((m) => (m as { t: string }).t)).toEqual(['log', 'log']);
    rig.child.stdout.end();
  });

  it('reply() writes exactly one LF-terminated JSON line', () => {
    const rig = makeRig();
    const bridge = spawnBridge({
      binary: '/fake/nh-bridge', playgroundDir: '/tmp/pg', name: 'me', spawn: rig.spawn,
    });
    const chunks: Buffer[] = [];
    rig.child.stdin.on('data', (b: Buffer) => chunks.push(b));
    const reply: RetMsg = { id: 42, ret: 'hi', selected: [{ i: 1, count: -1 }] };
    bridge.reply(reply);
    const written = Buffer.concat(chunks).toString('utf8');
    expect(written.endsWith('\n')).toBe(true);
    expect(written.split('\n').filter((l) => l.length).length).toBe(1);
    expect(JSON.parse(written.trimEnd())).toEqual(reply);
  });

  it('sets NETHACKDIR and NETHACKOPTIONS in the child env with sensible defaults', () => {
    const rig = makeRig();
    spawnBridge({
      binary: '/fake/nh-bridge',
      playgroundDir: '/tmp/pg',
      name: 'hero',
      spawn: rig.spawn,
      env: {}, // empty base env so we're sure the wrapper set both keys.
    });
    expect(rig.lastArgs?.opts.env.NETHACKDIR).toBe('/tmp/pg');
    // Defaults: !tutorial + name:<name>. Callers can override with `options`.
    expect(rig.lastArgs?.opts.env.NETHACKOPTIONS).toContain('!tutorial');
    expect(rig.lastArgs?.opts.env.NETHACKOPTIONS).toContain('name:hero');
    expect(rig.lastArgs?.argv).toEqual(['-u', 'hero']);
  });

  it('exited resolves with the child exit code', async () => {
    const rig = makeRig();
    const bridge = spawnBridge({
      binary: '/fake/nh-bridge', playgroundDir: '/tmp/pg', name: 'me', spawn: rig.spawn,
    });
    bridge.kill(); // FakeChild fires 'exit' 0 synchronously
    await expect(bridge.exited).resolves.toBe(0);
  });
});
