/**
 * `BridgeTransport` — the contract shared by the Node bridge
 * (`spawnBridge` in `src/engine/bridge.ts`) and the browser transport
 * (`WsBridge` in `web/src/ws-bridge.ts`). Split into its own file so the
 * browser build can import the type without pulling in Node's
 * `child_process` / `stream` typings that live in `bridge.ts`.
 */
import type { BridgeMsg, RetMsg } from './protocol.js';

/** What the session/`runSession` require from a transport, in either environment. */
export interface BridgeTransport {
  /** Per-line JSON messages from the bridge's stdout / socket. */
  readonly messages: AsyncIterable<BridgeMsg>;
  /** Per-chunk batches of messages (used by session coalescing). */
  readonly batches: AsyncIterable<BridgeMsg[]>;
  /** Write one reply to the bridge (Node: stdin line; browser: WS text frame). */
  reply(msg: RetMsg): void;
  /** Ask the transport to end the bridge (Node signal name / browser socket close). */
  kill(signal?: string): void;
  /** Resolves with the bridge's exit code (0 on clean exit). */
  readonly exited: Promise<number>;
}
