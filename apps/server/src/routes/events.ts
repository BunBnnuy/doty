/**
 * `GET /events` — server -> client SSE stream.
 *
 * Protocol (see `@doty/protocol`):
 *   - `seq` is the SSE `id` and the replay cursor.
 *   - On connect, replay every event with `seq > Last-Event-ID`, then stream
 *     live events. A client that never saw an event (or first connect) sends
 *     no header and gets the full log.
 *
 * Frame shape:
 *   id: <seq>
 *   event: <ServerEvent.type>
 *   data: <JSON of ServerEvent.data>
 *
 * A single `hello` control frame (no `id`) opens the stream, carrying the
 * server clock and the current cursor.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerToClient } from '@doty/protocol';
import type { EventLog } from '../events/log.js';

const HEARTBEAT_MS = 15_000;

interface SseFrame {
  /** Present for log events; omitted for control frames like `hello`. */
  id?: number;
  name: string;
  data: unknown;
}

function frame({ id, name, data }: SseFrame): string {
  const lines: string[] = [];
  if (id !== undefined) lines.push(`id: ${id}`);
  lines.push(`event: ${name}`);
  // Single-line JSON keeps `data:` framing unambiguous.
  lines.push(`data: ${JSON.stringify(data ?? null)}`);
  return `${lines.join('\n')}\n\n`;
}

/**
 * Read the replay cursor from the `Last-Event-ID` header. Browsers set it
 * automatically on EventSource reconnect; non-browser clients (the Tauri side)
 * set it explicitly. Anything unparseable means "replay from the start".
 */
export function parseLastEventId(request: FastifyRequest): number {
  const header = request.headers['last-event-id'];
  const raw = Array.isArray(header) ? header[0] : header;
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function registerEventRoutes(app: FastifyInstance, log: EventLog): void {
  app.get('/events', (request: FastifyRequest, reply: FastifyReply) => {
    const lastEventId = parseLastEventId(request);

    // We own the raw socket from here on: a long-lived stream, not a response.
    reply.hijack();
    const res = reply.raw;

    // Preserve headers set by plugins (e.g. @fastify/cors) before hijack.
    const headers: Record<string, string | number | string[]> = {};
    for (const [key, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) headers[key] = value;
    }

    res.writeHead(200, {
      ...headers,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // don't let proxies buffer the stream
    });
    res.flushHeaders();

    // `hello` tells the client where the stream is and the current cursor.
    const hello: ServerToClient = {
      type: 'hello',
      hello: { serverTime: Date.now(), cursor: log.cursor },
    };
    res.write(frame({ name: hello.type, data: hello.hello }));

    // Replay first, then subscribe. Both are synchronous, so no event can slip
    // through the gap (and none is delivered twice).
    for (const event of log.since(lastEventId)) {
      res.write(frame({ id: event.seq, name: event.type, data: event.data }));
    }

    const unsubscribe = log.subscribe((event) => {
      res.write(frame({ id: event.seq, name: event.type, data: event.data }));
    });

    // Keep the connection warm through proxies that kill idle sockets.
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, HEARTBEAT_MS);
    heartbeat.unref();

    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };

    request.raw.on('close', close);
    request.raw.on('error', close);

    return reply;
  });
}
