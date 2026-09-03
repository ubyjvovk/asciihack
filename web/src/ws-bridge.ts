/**
 * Browser transport implementing `BridgeTransport` over a plain WebSocket
 * (docs/web.md). One frame = one JSON bridge message; replies from the
 * client are sent back as one frame per reply. The Node WS server (`server/
 * ws-server.ts`) hosts the paired `nh-bridge` process. Line framing is
 * per-frame, so we do not need a line splitter here.
 */
import type { BridgeMsg, RetMsg } from '../../src/engine/protocol.js';
import type { BridgeTransport } from '../../src/engine/transport.js';

/** Minimal `WebSocket`-shaped event with the `data` field the `message` handler reads. */
export interface WsLikeEvent {
  data?: unknown;
}

/** Minimal subset of the browser `WebSocket` this transport uses (fakeable).
 *  `addEventListener` uses a single broad signature so fakes can register a
 *  generic handler; the `data` field is only read for `message` events. */
export interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', cb: (ev: WsLikeEvent) => void): void;
  readyState: number;
}

/** Options for `WsBridge`. `socket` is a live `WebSocket`-like (opened or opening). */
export interface WsBridgeOptions {
  socket: WsLike;
}

/** `BridgeTransport` backed by a browser WebSocket. */
export class WsBridge implements BridgeTransport {
  private readonly socket: WsLike;
  private readonly queue: BridgeMsg[] = [];
  private resolveNext: ((v: IteratorResult<BridgeMsg[]>) => void) | null = null;
  private done = false;
  private exitResolve!: (code: number) => void;
  readonly exited: Promise<number>;

  constructor(opts: WsBridgeOptions) {
    this.socket = opts.socket;
    this.exited = new Promise<number>((resolve) => {
      this.exitResolve = resolve;
    });
    this.socket.addEventListener('message', (ev) => this.onMessage(ev.data));
    this.socket.addEventListener('close', () => this.onClose(0));
    this.socket.addEventListener('error', () => this.onClose(2));
    // Note: `open` is handled by the caller (main.ts) so it can start `app.enter()`.
  }

  /** Batches of messages (one array per WS frame → one array per bridge line;
   *  the session's `handleBatch` fires one `change` per batch). */
  readonly batches: AsyncIterable<BridgeMsg[]> = {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<BridgeMsg[]>> => this.nextBatch(),
    }),
  };

  /** Per-message iterator — shares the same underlying queue as `batches`. */
  readonly messages: AsyncIterable<BridgeMsg> = {
    [Symbol.asyncIterator]: () => {
      const outer = this;
      let pending: BridgeMsg[] = [];
      return {
        async next(): Promise<IteratorResult<BridgeMsg>> {
          while (pending.length === 0) {
            const r = await outer.nextBatch();
            if (r.done) return { value: undefined, done: true };
            pending = r.value;
          }
          return { value: pending.shift()!, done: false };
        },
      };
    },
  };

  /** Send one JSON reply as a text frame. Silently drops when the socket is
   *  already closed — the session may hand us a reply that raced the close. */
  reply(msg: RetMsg): void {
    if (this.socket.readyState !== 1 /* OPEN */) return;
    try {
      this.socket.send(JSON.stringify(msg));
    } catch {
      /* socket closed between the check and the send — bridge is gone */
    }
  }

  /** Close the socket (parameter kept for `BridgeTransport` compatibility). */
  kill(_signal?: string): void {
    void _signal;
    try {
      this.socket.close(1000, 'client kill');
    } catch {
      /* already closed */
    }
  }

  // -------------------------------------------------------------------------
  // internals

  private onMessage(data: unknown): void {
    const text = typeof data === 'string' ? data : '';
    if (text.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const rec = parsed as Record<string, unknown>;
    const t = rec['t'];
    if (t !== 'hello' && t !== 'call' && t !== 'exit' && t !== 'log' && t !== 'tables') return;
    const msg = parsed as BridgeMsg;
    if (t === 'exit') {
      const code = typeof rec['code'] === 'number' ? (rec['code'] as number) : 0;
      this.deliver([msg]);
      this.exitResolve(code);
      return;
    }
    this.deliver([msg]);
  }

  private deliver(batch: BridgeMsg[]): void {
    if (this.resolveNext) {
      const r = this.resolveNext;
      this.resolveNext = null;
      r({ value: batch, done: false });
      return;
    }
    this.queue.push(...batch);
  }

  private nextBatch(): Promise<IteratorResult<BridgeMsg[]>> {
    if (this.queue.length > 0) {
      const value = this.queue.splice(0, this.queue.length);
      return Promise.resolve({ value, done: false });
    }
    if (this.done) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => {
      this.resolveNext = resolve;
    });
  }

  private onClose(code: number): void {
    if (this.done) return;
    this.done = true;
    this.exitResolve(code);
    if (this.resolveNext) {
      const r = this.resolveNext;
      this.resolveNext = null;
      r({ value: undefined, done: true });
    }
  }
}
