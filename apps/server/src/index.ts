/**
 * @doty/server — the online brain (API + worker).
 *
 * Fastify API with `/health`, replayable `/events` SSE, and a validated
 * `POST /message`. Set OPENAI_MODEL to enable the tool-calling agent runtime.
 * No Postgres is required to run this.
 *
 * Run: `npm -w @doty/server run dev`
 */

import { pathToFileURL } from 'node:url';
import 'dotenv/config';
import { buildApp } from './app.js';
import { OpenAIChatProvider, openAIConfigFromEnv } from './provider/openai.js';
import { PgEventLog } from './events/pg-log.js';

const PORT = Number.parseInt(process.env.PORT ?? '8787', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const pgLog = databaseUrl ? new PgEventLog(databaseUrl) : undefined;
  const agent = process.env.OPENAI_MODEL?.trim()
    ? { provider: new OpenAIChatProvider(openAIConfigFromEnv()) }
    : undefined;
  const { app } = buildApp({
    logger: true,
    ...(pgLog ? { log: pgLog } : {}),
    ...(agent ? { agent } : {}),
  });

  if (pgLog) await pgLog.ready;
  if (!process.env.DOTY_TOKEN?.trim()) {
    app.log.warn('DOTY_TOKEN is unset: API bearer authentication is DISABLED (development only)');
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    if (pgLog) await pgLog.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: PORT, host: HOST });
  app.log.info(`@doty/server listening on http://${HOST}:${PORT}`);
}

// Only boot when executed directly, so importing this module has no side
// effects (tests, tooling).
const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
