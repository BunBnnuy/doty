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
import { AgentRuntime, type AgentRuntimeOptions } from './agent/runtime.js';

export interface BuildAppOptions {
  /** Inject a log (e.g. a future `PgEventLog`); defaults to in-memory. */
  log?: EventLog;
  /** Fastify/Pino logging. Off in tests, on in `index.ts`. */
  logger?: boolean;
  /** Opt-in, injectable model runtime. Omitted = event-only scaffold. */
  agent?: AgentRuntimeOptions;
}

export interface BuiltApp {
  app: FastifyInstance;
  log: EventLog;
}

export function buildApp(options: BuildAppOptions = {}): BuiltApp {
  const log = options.log ?? new InMemoryEventLog();
  const app = Fastify({ logger: options.logger ?? false });

  // The Tauri client and browser dev tools are separate origins.
  void app.register(cors, { origin: true });

  registerHealthRoutes(app);
  registerEventRoutes(app, log);
  const runtime = options.agent ? new AgentRuntime(options.agent, log) : undefined;
  registerMessageRoutes(app, log, runtime ? (text) => runtime.start(text) : undefined);
  if (runtime) app.addHook('onClose', async () => runtime.close());

  return { app, log };
}
