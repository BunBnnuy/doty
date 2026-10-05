/**
 * @doty/server — the online brain (API + worker).
 *
 * Wave 0 stub. SA-2 owns this directory and replaces it with:
 *   - Fastify app with `/health`
 *   - `/events` SSE that replays from `Last-Event-ID`, then streams live
 *   - an append-only `EventLog` interface (in-memory now, Postgres later)
 *   - Drizzle schema + migrations
 *
 * Do not import from other islands here; the only shared surface is
 * `@doty/protocol` and `@doty/harness-events`.
 */

export const SERVER_READY = false;

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('@doty/server stub — SA-2 will implement the SSE API here.');
}
