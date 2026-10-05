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
import { AgentMemory, OpenAIEmbedder, embeddingConfigFromEnv, memoryStoreFromEnv } from './memory/index.js';
import { parseAllowedUserIds, startDiscordBot, type DiscordBot } from './integrations/discord.js';
import { ConversationStore } from './agent/conversation.js';

const PORT = Number.parseInt(process.env.PORT ?? '8787', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const pgLog = databaseUrl ? new PgEventLog(databaseUrl) : undefined;
  const dotId = process.env.DOTY_DOT_ID?.trim();
  const memoryStore = databaseUrl && dotId && process.env.OPENAI_EMBED_MODEL?.trim() && process.env.OPENAI_MODEL?.trim()
    ? memoryStoreFromEnv() : undefined;
  const memory = memoryStore && dotId ? new AgentMemory({
    store: memoryStore, dotId, embedder: new OpenAIEmbedder(embeddingConfigFromEnv()),
  }) : undefined;
  const agent = process.env.OPENAI_MODEL?.trim()
    ? { provider: new OpenAIChatProvider(openAIConfigFromEnv()), ...(memory ? { memory } : {}) }
    : undefined;
  const { app, log: eventLog, runtime } = buildApp({
    logger: true,
    ...(pgLog ? { log: pgLog } : {}),
    ...(agent ? { agent } : {}),
  });

  if (pgLog) await pgLog.ready;
  if (!process.env.DOTY_TOKEN?.trim()) {
    app.log.warn('DOTY_TOKEN is unset: API bearer authentication is DISABLED (development only)');
  }

  // Optional Discord integration: receive messages and reply with the agent.
  let discord: DiscordBot | undefined;
  const discordToken = process.env.DISCORD_BOT_TOKEN?.trim();
  if (discordToken && runtime) {
    const allowed = parseAllowedUserIds(process.env.DISCORD_ALLOWED_USER_IDS);
    if (allowed.size === 0) {
      app.log.warn('DISCORD_ALLOWED_USER_IDS is unset: Doty will answer any Discord user');
    }
    const conversations = new ConversationStore();
    conversations.hydrate(eventLog);
    discord = startDiscordBot({
      token: discordToken,
      allowedUserIds: allowed,
      ...(process.env.DISCORD_CHANNEL_ID?.trim() ? { channelId: process.env.DISCORD_CHANNEL_ID.trim() } : {}),
      mentionOnly: process.env.DISCORD_MENTION_ONLY !== 'false',
      handle: async (text, context) => {
        eventLog.append({ type: 'message', data: { text } });
        const history = conversations.history(context.conversationKey);
        const result = await runtime.run(text, { history });
        conversations.record(eventLog, context.conversationKey, { role: 'user', content: text });
        if (result.answer) {
          conversations.record(eventLog, context.conversationKey, { role: 'assistant', content: result.answer });
        }
        return result.answer ?? result.error ?? `No pude completar la tarea (${result.status}).`;
      },
      log: (message) => app.log.info(message),
    });
    app.log.info('Discord integration enabled');
  } else if (discordToken && !runtime) {
    app.log.warn('DISCORD_BOT_TOKEN is set but OPENAI_MODEL is missing; Discord is disabled');
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    discord?.stop();
    await app.close();
    if (pgLog) await pgLog.close();
    if (memoryStore) await memoryStore.close();
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
