/**
 * Conversational schedule routes.
 *
 * The agent creates routines here (through the MCP tools) when the user asks
 * for something recurring in natural language; the same API is available with
 * the bearer token for scripting. Responses include the next occurrence so the
 * agent can confirm exactly when the routine will run.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Schedule } from '../automations/schedules.js';
import { parseTimeOfDay } from '../time.js';

/** Structural contract so routes stay testable without a real service. */
export interface ScheduleRoutesService {
  list(): Schedule[];
  create(input: {
    prompt: string;
    time: string;
    timeZone?: string;
    deliver?: 'both' | 'doty';
  }): Schedule;
  cancel(id: string): Schedule | undefined;
  nextRunAt(schedule: Schedule): number;
}

const createSchema = z.object({
  prompt: z.string().min(1).max(4_000),
  time: z.string().min(1).max(5),
  timeZone: z.string().min(1).max(64).optional(),
  deliver: z.enum(['both', 'doty']).optional(),
});

export function registerScheduleRoutes(app: FastifyInstance, service: ScheduleRoutesService): void {
  const present = (schedule: Schedule): Record<string, unknown> => ({
    id: schedule.id,
    prompt: schedule.prompt,
    time: schedule.time,
    timeZone: schedule.timeZone,
    deliver: schedule.deliver,
    createdAt: schedule.createdAt,
    nextRunAt: service.nextRunAt(schedule),
  });

  app.get('/schedules', async () => ({ schedules: service.list().map(present) }));

  app.post('/schedules', async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_schedule',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      });
    }
    if (!parseTimeOfDay(parsed.data.time)) {
      return reply.code(400).send({ error: 'invalid_time', message: 'time must be HH:MM (24h)' });
    }
    try {
      const schedule = service.create(parsed.data);
      return reply.code(201).send({ schedule: present(schedule) });
    } catch (error) {
      return reply.code(400).send({
        error: 'invalid_schedule',
        message: error instanceof Error ? error.message : 'Invalid schedule',
      });
    }
  });

  app.delete('/schedules/:id', async (request, reply) => {
    const id = (request.params as { id?: unknown }).id;
    if (typeof id !== 'string' || !id.trim()) {
      return reply.code(400).send({ error: 'invalid_id' });
    }
    const removed = service.cancel(id);
    if (!removed) return reply.code(404).send({ error: 'unknown_schedule' });
    return { ok: true, removed: removed.id };
  });
}
