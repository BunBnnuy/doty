import type { FastifyInstance } from 'fastify';
import { PROTOCOL_VERSION } from '@doty/protocol';

/** Liveness probe. Cheap, dependency-free — safe for orchestrators. */
export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/health', async () => ({
    status: 'ok' as const,
    protocolVersion: PROTOCOL_VERSION,
    uptimeMs: Math.round(process.uptime() * 1000),
    now: Date.now(),
  }));
}
