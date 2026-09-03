/**
 * WsBridge tests: verify the browser transport reads one bridge message per
 * frame, forwards replies as text frames, and finishes its iterator on
 * close. A tiny hand-rolled fake WebSocket stands in for the real one.
 */
import { describe, it, expect } from 'vitest';
import { WsBridge, type WsLike, type WsLikeEvent } from '../web/src/ws-bridge.js';

/** Fake `WebSocket` capturing sends and exposing per-listener triggers. */
class FakeSocket implements WsLike {
  readyState = 1; // OPEN
  sent: string[] = [];
  private cbs: Record<string, Array<(v: WsLikeEvent) => void>> = {};
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    for (const cb of this.cbs['close'] ?? []) cb({});
  }
  addEventListener(type: 'open' | 'message' | 'close' | 'error', cb: (ev: WsLikeEvent) => void): void {
    (this.cbs[type] ??= []).push(cb);
  }
  /** Deliver a text frame to `message` listeners. */
  deliver(text: string): void {
    for (const cb of this.cbs['message'] ?? []) cb({ data: text });
  }
}

describe('WsBridge', () => {
  it('yields one message per delivered frame and closes the iterator on socket close', async () => {
    const sock = new FakeSocket();
    const bridge = new WsBridge({ socket: sock });
    // Two lines in → two messages out, framed one per frame.
    const hello = { t: 'hello', proto: 1, version: 'test', S: {}, cmap: [], nhw: {}, bl: {}, pick: {}, atr: {}, mg: {}, clr: {}, blmask: {} };
    sock.deliver(JSON.stringify(hello));
    sock.deliver(JSON.stringify({ t: 'call', name: 'nhgetch', args: [], id: 1 }));

    const it = bridge.messages[Symbol.asyncIterator]();
    const r1 = await it.next();
    const r2 = await it.next();
    expect(r1.done).toBe(false);
    expect((r1.value as { t: string }).t).toBe('hello');
    expect(r2.done).toBe(false);
    expect((r2.value as { name?: string }).name).toBe('nhgetch');

    // Close: the third .next() resolves with done:true and exited resolves.
    sock.close();
    const r3 = await it.next();
    expect(r3.done).toBe(true);
    await expect(bridge.exited).resolves.toBeTypeOf('number');
  });

  it('reply() sends the JSON-encoded RetMsg as one text frame', () => {
    const sock = new FakeSocket();
    const bridge = new WsBridge({ socket: sock });
    bridge.reply({ id: 42, ret: 108 });
    expect(sock.sent).toEqual([JSON.stringify({ id: 42, ret: 108 })]);
  });

  it('drops replies when the socket is not OPEN', () => {
    const sock = new FakeSocket();
    const bridge = new WsBridge({ socket: sock });
    sock.readyState = 3; // CLOSED before reply reaches us
    bridge.reply({ id: 7, ret: 0 });
    expect(sock.sent).toEqual([]);
  });

  it('batches yields one array per frame so handleBatch fires one change', async () => {
    const sock = new FakeSocket();
    const bridge = new WsBridge({ socket: sock });
    sock.deliver(JSON.stringify({ t: 'log', msg: 'a' }));
    const it = bridge.batches[Symbol.asyncIterator]();
    const r = await it.next();
    expect(r.done).toBe(false);
    expect(Array.isArray(r.value)).toBe(true);
    expect((r.value as unknown[]).length).toBe(1);
  });
});
