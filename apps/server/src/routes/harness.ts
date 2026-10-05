/**
 * `POST /harness-message` and `POST /harness-notice` — client -> server.
 *
 * The desktop watcher observes other agents (Codex / OpenCode / T3) on the local
 * machine. It publishes their reasoning, final replies and finish notices here so
 * the server persists them and fans them out over `/events` to every connected
 * client. This is shared transcript content by explicit product decision.
 *
 * Metadata + `text` are stored verbatim; the payload is validated and bounded so
 * a malformed or hostile client cannot write unbounded rows.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { EventLog } from '../events/log.js';

const harness = z.enum(['codex', 'opencode', 't3']);

/** One reasoning block or final reply captured from a watched session. */
export const harnessMessageSchema = z.object({
  machine: z.string().min(1).max(120),
  harness,
  sessionId: z.string().min(1).max(200),
  project: z.string().max(500).optional(),
  title: z.string().max(500).optional(),
  kind: z.enum(['assistant', 'thinking']),
  text: z.string().min(1).max(20_000),
  ts: z.number().int().nonnegative(),
});

/** A watched session finished, errored, or is waiting for the user. */
export const harnessNoticeSchema = z.object({
  machine: z.string().min(1).max(120),
  harness,
  sessionId: z.string().min(1).max(200),
  project: z.string().max(500).optional(),
  title: z.string().max(500).optional(),
  kind: z.enum(['done', 'error', 'attention']),
  ts: z.number().int().nonnegative(),
});

export type HarnessMessageBody = z.infer<typeof harnessMessageSchema>;
export type HarnessNoticeBody = z.infer<typeof harnessNoticeSchema>;

export function registerHarnessRoutes(app: FastifyInstance, log: EventLog): void {
  app.post('/harness-message', async (request, reply) => {
    const parsed = harnessMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_harness_message' });
    }
    const event = log.append({ type: 'harness_message', data: parsed.data });
    return reply.code(202).send({ ok: true, event });
  });

  app.post('/harness-notice', async (request, reply) => {
    const parsed = harnessNoticeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_harness_notice' });
    }
    const event = log.append({ type: 'harness_notice', data: parsed.data });
    return reply.code(202).send({ ok: true, event });
  });
}
