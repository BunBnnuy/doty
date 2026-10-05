/**
 * Fastify app assembly.
 *
 * `buildApp` is deliberately side-effect-free: it does not listen, connect to
 * Postgres, or read required env, so tests can construct it directly. The
 * entrypoint (`src/index.ts`) is the only place that binds a port.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { InMemoryEventLog, type EventLog } from './events/log.js';
import { registerEventRoutes } from './routes/events.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMessageRoutes } from './routes/message.js';
import { registerHarnessRoutes } from './routes/harness.js';
import { AgentRuntime, type AgentRuntimeOptions } from './agent/runtime.js';
import { createHash, timingSafeEqual } from 'node:crypto';

export interface BuildAppOptions {
  /** Inject a log; defaults to in-memory. The entrypoint selects Postgres from DATABASE_URL. */
  log?: EventLog;
  /** Fastify/Pino logging. Off in tests, on in `index.ts`. */
  logger?: boolean;
  /** Opt-in, injectable model runtime. Omitted = event-only scaffold. */
  agent?: AgentRuntimeOptions;
  /** Shared bearer token. Defaults to DOTY_TOKEN; unset retains dev-only open mode. */
  token?: string;
}

export interface BuiltApp {
  app: FastifyInstance;
  log: EventLog;
}

/** Routes that require the shared bearer token when DOTY_TOKEN is set. */
const GUARDED_ROUTES = new Set(['/message', '/events', '/harness-message', '/harness-notice']);

export function buildApp(options: BuildAppOptions = {}): BuiltApp {
  const log = options.log ?? new InMemoryEventLog();
  const app = Fastify({ logger: options.logger ?? false });
  const token = (options.token ?? process.env.DOTY_TOKEN)?.trim() || undefined;

  if (token) {
    app.addHook('onRequest', async (request, reply) => {
      const route = request.routeOptions.url;
      if (!route || !GUARDED_ROUTES.has(route)) return;

      const authorization = request.headers.authorization;
      const match = authorization?.match(/^Bearer ([^\s]+)$/i);
      if (!match || !constantTimeTokenMatch(match[1] ?? '', token)) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
    });
  }

  // The Tauri client and browser dev tools are separate origins.
  void app.register(cors, { origin: true });

  registerHealthRoutes(app);
  registerEventRoutes(app, log);
  registerHarnessRoutes(app, log);
  const runtime = options.agent ? new AgentRuntime(options.agent, log) : undefined;
  registerMessageRoutes(app, log, runtime ? (text) => runtime.start(text) : undefined);
  if (runtime) app.addHook('onClose', async () => runtime.close());

  return { app, log };
}

/** Hash both values first so timingSafeEqual always receives equal-length buffers. */
export function constantTimeTokenMatch(candidate: string, expected: string): boolean {
  const candidateHash = createHash('sha256').update(candidate).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}
