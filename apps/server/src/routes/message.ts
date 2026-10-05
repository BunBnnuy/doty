/**
 * `POST /message` — client -> server command.
 *
 * Wave 1 is a stub: validate the body with zod, append a `message` event to the
 * log (so connected SSE clients see it), and acknowledge. The real agent loop
 * replaces the handler later; the wire contract (zod -> EventLog) stays.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ClientToServer } from '@doty/protocol';
import type { EventLog } from '../events/log.js';

/**
 * Mirrors the `message` member of `ClientToServer`. `text` is required; `type`
 * is accepted for clients that send the full discriminated frame.
 */
export const messageBodySchema = z.object({
  type: z.literal('message').optional(),
  text: z.string().min(1).max(10_000),
});

export type MessageBody = z.infer<typeof messageBodySchema>;

type MessageFrame = Extract<ClientToServer, { type: 'message' }>;

/**
 * Normalize a validated body into the exact `ClientToServer` frame. If the
 * schema ever drifts from the frozen wire contract, this assignment stops
 * typechecking.
 */
export function toMessageFrame(body: MessageBody): MessageFrame {
  return { type: 'message', text: body.text };
}

export function registerMessageRoutes(app: FastifyInstance, log: EventLog): void {
  app.post('/message', async (request, reply) => {
    const parsed = messageBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_message',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      });
    }

    const event = log.append({
      type: 'message',
      data: { text: parsed.data.text },
    });

    return reply.code(202).send({ ok: true, event });
  });
}
