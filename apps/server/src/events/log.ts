/**
 * Append-only event log — the spine behind SSE replay.
 *
 * The wire shape is `ServerEvent` from `@doty/protocol`: `seq` is both the SSE
 * `id` and the replay cursor. A reconnecting client sends its last seen `seq`
 * (as `Last-Event-ID`); we replay everything after it, then stream live.
 *
 * The in-memory implementation keeps the API runnable with **no Postgres**.
 * `PgEventLog` uses the same interface when DATABASE_URL is configured.
 */

import type { ServerEvent } from '@doty/protocol';

/**
 * An event ready to be appended. The log owns `seq`; `ts` defaults to now so
 * callers only need `type` + `data`.
 */
export type EventInput = Omit<ServerEvent, 'seq' | 'ts'> & { ts?: number };

export type EventListener = (event: ServerEvent) => void;

export interface EventLog {
  /** Highest assigned `seq` (0 when empty). Backs the SSE `hello` cursor. */
  readonly cursor: number;
  /** Assign the next `seq`, persist, and fan out to subscribers. */
  append(event: EventInput): ServerEvent;
  /** Every recorded event with `seq` strictly greater than `seq`, in order. */
  since(seq: number): ServerEvent[];
  /** Receive events appended after this call. Returns an unsubscribe fn. */
  subscribe(listener: EventListener): () => void;
}

/**
 * Process-local append-only log. Correct for a single server process; a
 * multi-worker deployment needs the Postgres-backed implementation.
 */
export class InMemoryEventLog implements EventLog {
  readonly #events: ServerEvent[] = [];
  readonly #listeners = new Set<EventListener>();
  #seq = 0;

  get cursor(): number {
    return this.#seq;
  }

  append(input: EventInput): ServerEvent {
    const event: ServerEvent = {
      type: input.type,
      data: input.data,
      ts: input.ts ?? Date.now(),
      seq: ++this.#seq,
    };
    this.#events.push(event);

    // Copy the set: a listener may unsubscribe during fan-out.
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must never corrupt the log or starve others.
      }
    }

    return event;
  }

  since(seq: number): ServerEvent[] {
    if (seq <= 0) return [...this.#events];
    return this.#events.filter((event) => event.seq > seq);
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
