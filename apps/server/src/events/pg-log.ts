/**
 * Postgres-backed event log. The existing EventLog API is synchronous, so the
 * durable implementation keeps a hydrated in-process read cache and queues
 * inserts. Cross-process appends are discovered by polling the same table.
 */

import { getTableName } from 'drizzle-orm';
import { Pool } from 'pg';
import type { ServerEvent } from '@doty/protocol';
import { events } from '../db/schema.js';
import type { EventInput, EventListener, EventLog } from './log.js';

const EVENTS_TABLE = `"${getTableName(events)}"`;
const POLL_INTERVAL_MS = 500;

interface DbEventRow {
  seq: number | string;
  type: string;
  ts: Date | string;
  data: unknown;
}

/** Minimal query surface also makes the implementation easy to exercise with a fake pg pool. */
export interface PgEventQuery {
  query(sql: string, values?: unknown[]): Promise<{ rows: DbEventRow[] }>;
  end?(): Promise<void>;
}

export class PgEventLog implements EventLog {
  readonly ready: Promise<void>;
  readonly #listeners = new Set<EventListener>();
  readonly #events: ServerEvent[] = [];
  readonly #pool: PgEventQuery;
  #seq = 0;
  #initialized = false;
  #closed = false;
  #pollTimer: ReturnType<typeof setInterval> | undefined;
  #writeQueue: Promise<void> = Promise.resolve();
  #persistenceFailed = false;
  #polling = false;

  constructor(connection: string | PgEventQuery) {
    this.#pool = typeof connection === 'string'
      ? new Pool({ connectionString: connection })
      : connection;
    this.ready = this.initialize();
  }

  get cursor(): number {
    return this.#seq;
  }

  append(input: EventInput): ServerEvent {
    if (!this.#initialized || this.#closed) {
      throw new Error('PgEventLog must be ready and open before appending');
    }

    const event: ServerEvent = {
      type: input.type,
      data: input.data,
      ts: input.ts ?? Date.now(),
      seq: ++this.#seq,
    };
    this.#events.push(event);
    this.fanOut(event);

    // The synchronous EventLog contract requires returning the event now. The
    // server awaits flush/close during shutdown; each INSERT retains its seq.
    this.#writeQueue = this.#writeQueue.then(async () => {
      await this.#pool.query(
        `INSERT INTO ${EVENTS_TABLE} (seq, type, ts, data) VALUES ($1, $2, $3, $4)`,
        [event.seq, event.type, new Date(event.ts), event.data],
      );
      await this.#pool.query(
        `SELECT setval(pg_get_serial_sequence($1, 'seq'), $2, true)`,
        [getTableName(events), event.seq],
      );
    }).catch(() => {
      this.#persistenceFailed = true;
      // Do not log event content (message events can contain user text).
      console.error('PgEventLog could not persist an event');
    });
    return event;
  }

  since(seq: number): ServerEvent[] {
    return this.#events.filter((event) => event.seq > seq);
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Wait for queued writes and fail if any append could not be persisted. */
  async flush(): Promise<void> {
    await this.#writeQueue;
    if (this.#persistenceFailed) throw new Error('PgEventLog persistence failed');
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    try {
      await this.flush();
    } finally {
      await this.#pool.end?.();
    }
  }

  /** Poll immediately; also useful for controlled shutdowns and verification. */
  async pollNow(): Promise<void> {
    await this.poll();
  }

  private async initialize(): Promise<void> {
    const result = await this.#pool.query(
      `SELECT seq, type, ts, data FROM ${EVENTS_TABLE} ORDER BY seq ASC`,
    );
    this.addRows(result.rows);
    await this.#pool.query(
      `SELECT setval(pg_get_serial_sequence($1, 'seq'), $2, $3)`,
      [getTableName(events), Math.max(this.#seq, 1), this.#seq > 0],
    );
    this.#initialized = true;
    this.#pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    this.#pollTimer.unref();
  }

  private async poll(): Promise<void> {
    if (this.#polling || this.#closed || !this.#initialized) return;
    this.#polling = true;
    try {
      const result = await this.#pool.query(
        `SELECT seq, type, ts, data FROM ${EVENTS_TABLE} WHERE seq > $1 ORDER BY seq ASC`,
        [this.#seq],
      );
      this.addRows(result.rows);
    } catch {
      // Keep polling after transient database errors; avoid logging payloads.
      console.error('PgEventLog could not poll for events');
    } finally {
      this.#polling = false;
    }
  }

  private addRows(rows: DbEventRow[]): void {
    for (const row of rows) {
      const seq = Number(row.seq);
      if (!Number.isSafeInteger(seq) || seq <= this.#seq) continue;
      const event: ServerEvent = {
        seq,
        type: row.type,
        ts: row.ts instanceof Date ? row.ts.getTime() : Date.parse(row.ts),
        data: row.data,
      };
      this.#seq = seq;
      this.#events.push(event);
      this.fanOut(event);
    }
  }

  private fanOut(event: ServerEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // A subscriber must never break persistence or other subscribers.
      }
    }
  }
}
