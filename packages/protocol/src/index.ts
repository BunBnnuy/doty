/**
 * Client <-> Server wire protocol. Frozen in Wave 0 so the two halves of the
 * app never block each other.
 *
 *  - REST:  commands that are not streams.
 *  - SSE:   server -> client, one-way, replayable from the append-only `events`
 *           log via `Last-Event-ID`.
 *  - WS:    the local bridge control channel (server asks the client to run a
 *           local action). Separate socket from SSE.
 */

import type { DotState } from '@doty/dot-state';

/** One append-only record. `seq` is the SSE id and the replay cursor. */
export interface ServerEvent<T = unknown> {
  seq: number;
  type: string;
  ts: number;
  data: T;
}

export interface HelloEvent {
  serverTime: number;
  /** Highest `seq` the server has; the client can request a replay from any. */
  cursor: number;
}

export interface DotStateEvent {
  state: DotState;
}

export type ServerToClient =
  | { type: 'hello'; hello: HelloEvent }
  | { type: 'dot_state'; dot: DotStateEvent }
  | { type: 'event'; event: ServerEvent }
  | { type: 'pong'; ts: number };

export type ClientToServer = { type: 'message'; text: string } | { type: 'ping' };

/** Local bridge: server -> client -> server, request/response. */
export interface BridgeRequest {
  id: string;
  action: string;
  args?: unknown;
  deadlineMs?: number;
}

export interface BridgeResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export const PROTOCOL_VERSION = 0;
