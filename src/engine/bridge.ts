/**
 * `nh-bridge` process wrapper (docs/architecture.md §3): spawns the C bridge,
 * sets `NETHACKDIR`/`NETHACKOPTIONS` in its environment, splits its stdout
 * into JSON-lines (tolerant of a partial trailing line and of `\n`
 * boundaries falling inside a chunk), and writes replies as single
 * LF-terminated lines on its stdin. The spawn function is injectable so
 * tests can feed a fake child; both a per-message and a per-chunk
 * `AsyncIterable` are exposed (share a single underlying reader — iterate
 * one, not both).
 */
import { spawn as nodeSpawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { BridgeMsg, RetMsg } from './protocol.js';

/** Minimal subset of `child_process.ChildProcess` this module needs. */
export interface BridgeChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

/** Signature the caller can substitute for `child_process.spawn` (tests). */
export type SpawnFn = (
  binary: string,
  argv: readonly string[],
  opts: { env: NodeJS.ProcessEnv; stdio: readonly ['pipe', 'pipe', 'pipe'] },
) => BridgeChild;

/** Arguments to `spawnBridge`. */
export interface SpawnBridgeOptions {
  /** Path to the `nh-bridge` binary. */
  binary: string;
  /** Directory the bridge will use as `NETHACKDIR` (playground). */
  playgroundDir: string;
  /** Character name passed both via `-u <name>` and `NETHACKOPTIONS=name:<name>`. */
  name: string;
  /**
   * Explicit `NETHACKOPTIONS` values (comma-joined by us, without leading `!` gymnastics — you decide).
   * Defaults to `['!tutorial', 'name:<name>']` if omitted.
   */
  options?: readonly string[];
  /** Extra argv appended after `-u <name>`. */
  argv?: readonly string[];
  /** Base environment (defaults to `process.env`); the wrapper always overrides `NETHACKDIR` and `NETHACKOPTIONS`. */
  env?: NodeJS.ProcessEnv;
  /** Injected spawn (defaults to `child_process.spawn`). */
  spawn?: SpawnFn;
}

/** Handle returned by `spawnBridge`. */
export interface BridgeProcess {
  /** Per-line JSON messages from the bridge's stdout. */
  readonly messages: AsyncIterable<BridgeMsg>;
  /** Per-stdout-chunk batches of messages (used by session coalescing). */
  readonly batches: AsyncIterable<BridgeMsg[]>;
  /** Write one reply line to the bridge's stdin (LF-terminated JSON). */
  reply(msg: RetMsg): void;
  /** Send a signal to the child (defaults to SIGTERM). */
  kill(signal?: NodeJS.Signals): void;
  /** Resolves with the child's exit code (0 on clean exit). */
  readonly exited: Promise<number>;
}

/** Default NETHACKOPTIONS the client sets when the caller does not override. */
export function defaultOptions(name: string): string[] {
  return ['!tutorial', `name:${name}`];
}

/**
 * Buffer-and-split raw stdout data into complete lines. Emits everything
 * before every `\n`; the (possibly partial) trailing text stays buffered.
 * Zero-length lines are dropped by the caller.
 */
export class LineSplitter {
  private buffer = '';

  /** Feed a chunk; return the complete lines it produced (may be empty). */
  push(chunk: string): string[] {
    this.buffer += chunk;
    if (this.buffer.indexOf('\n') < 0) return [];
    const parts = this.buffer.split('\n');
    // The last element is either "" (chunk ended on \n) or the still-partial
    // trailing line — hold it for the next push.
    this.buffer = parts.pop() ?? '';
    return parts;
  }

  /** Flush anything left in the buffer as a single line (called on stream end). */
  flush(): string[] {
    if (this.buffer.length === 0) return [];
    const out = [this.buffer];
    this.buffer = '';
    return out;
  }
}

/** Parse one line as a `BridgeMsg`; returns `null` on parse error or bad shape. */
export function parseBridgeLine(line: string): BridgeMsg | null {
  if (line.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  const t = rec['t'];
  if (t !== 'hello' && t !== 'call' && t !== 'exit' && t !== 'log') return null;
  return rec as unknown as BridgeMsg;
}

/**
 * Yield one array per stdout chunk containing every complete JSON message
 * that chunk carried (may be empty for a chunk with only a partial line).
 */
async function* readBatches(stdout: Readable): AsyncGenerator<BridgeMsg[]> {
  const splitter = new LineSplitter();
  // Node's Readable is an AsyncIterable<Buffer|string> when created with pipe
  // stdio; tests pass a PassThrough which behaves the same.
  for await (const chunk of stdout as AsyncIterable<Buffer | string>) {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const lines = splitter.push(text);
    if (lines.length === 0) continue;
    const batch: BridgeMsg[] = [];
    for (const line of lines) {
      const msg = parseBridgeLine(line);
      if (msg) batch.push(msg);
    }
    if (batch.length > 0) yield batch;
  }
  for (const line of splitter.flush()) {
    const msg = parseBridgeLine(line);
    if (msg) yield [msg];
  }
}

/** Spawn `nh-bridge` and return a `BridgeProcess` wrapping stdin/stdout. */
export function spawnBridge(opts: SpawnBridgeOptions): BridgeProcess {
  const spawnFn: SpawnFn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const argv: string[] = ['-u', opts.name, ...(opts.argv ?? [])];
  const optionParts = opts.options ?? defaultOptions(opts.name);
  const env: NodeJS.ProcessEnv = {
    ...(opts.env ?? process.env),
    NETHACKDIR: opts.playgroundDir,
    NETHACKOPTIONS: optionParts.join(','),
  };
  const child = spawnFn(opts.binary, argv, { env, stdio: ['pipe', 'pipe', 'pipe'] });

  // One shared generator drives both async iterables; iterating both
  // concurrently races on the same underlying stream — pick one.
  const batchGen: AsyncGenerator<BridgeMsg[]> = readBatches(child.stdout);

  const batches: AsyncIterable<BridgeMsg[]> = {
    [Symbol.asyncIterator]: () => batchGen,
  };
  const messages: AsyncIterable<BridgeMsg> = {
    [Symbol.asyncIterator]: () => {
      let pending: BridgeMsg[] = [];
      return {
        async next(): Promise<IteratorResult<BridgeMsg>> {
          while (pending.length === 0) {
            const r = await batchGen.next();
            if (r.done) return { value: undefined, done: true };
            pending = r.value;
          }
          return { value: pending.shift()!, done: false };
        },
      };
    },
  };

  const exited = new Promise<number>((resolve) => {
    child.on('exit', (code) => resolve(code ?? 0));
  });

  return {
    messages,
    batches,
    reply(msg: RetMsg): void {
      child.stdin.write(JSON.stringify(msg) + '\n');
    },
    kill(signal?: NodeJS.Signals): void {
      child.kill(signal ?? 'SIGTERM');
    },
    exited,
  };
}
