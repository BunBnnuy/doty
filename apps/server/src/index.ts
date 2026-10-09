/**
 * @doty/server — the online brain (API + worker).
 *
 * Fastify API with `/health`, replayable `/events` SSE, and a validated
 * `POST /message`.
 *
 * Agent backend: when `OPENCODE_SERVER_URL` is set, runs are delegated to a
 * local OpenCode CLI server (which owns the conversation history); otherwise the
 * in-process OpenAI-compatible loop is used. No Postgres is required to run this.
 *
 * Run: `npm -w @doty/server run dev`
 */

import { pathToFileURL } from 'node:url';
import 'dotenv/config';
import { buildApp } from './app.js';
import { InMemoryEventLog } from './events/log.js';
import { OpenAIChatProvider, openAIConfigFromEnv } from './provider/openai.js';
import { PgEventLog } from './events/pg-log.js';
import { AgentMemory, OpenAIEmbedder, embeddingConfigFromEnv, memoryStoreFromEnv } from './memory/index.js';
import { parseAllowedUserIds, parseTriggerWords, resolveConversationKey, startDiscordBot, type DiscordAttachment, type DiscordBot } from './integrations/discord.js';
import { extractCommandArg, parseVoiceCommand, VoiceManager } from './integrations/voice.js';
import { handleReminderMessage, ReminderService, resolveTimeZone } from './integrations/reminders.js';
import { classifyVoiceIntent, classifyVoiceIntentJev, JEV_DEFAULT_MODEL, JEV_DEFAULT_URL, type ClassifierConfig, type JevConfig } from './integrations/command-classifier.js';
import { OpenCodeClient, parseOpenCodeModel } from './integrations/opencode.js';
import { OpenCodeAgent, DESKTOP_SESSION_KEY } from './agent/opencode-agent.js';
import { SessionStore } from './agent/sessions.js';
import { ScheduleService } from './automations/schedules.js';
import { createEmailServiceFromEnv } from './integrations/email/service.js';
import { registerScheduleRoutes } from './routes/schedules.js';
import type { AgentRunner } from './agent/runner.js';
import type { AgentImage } from './provider/types.js';

const PORT = Number.parseInt(process.env.PORT ?? '8787', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const pgLog = databaseUrl ? new PgEventLog(databaseUrl) : undefined;
  const eventLog = pgLog ?? new InMemoryEventLog();
  if (pgLog) await pgLog.ready;

  // Agent backend: the OpenCode CLI server when configured, else the in-process
  // OpenAI-compatible loop.
  const opencodeUrl = process.env.OPENCODE_SERVER_URL?.trim();
  let runner: AgentRunner | undefined;
  if (opencodeUrl) {
    const { providerID, modelID } = parseOpenCodeModel(
      process.env.OPENCODE_MODEL?.trim() || 'opencode-go/deepseek-v4.1-flash',
    );
    const client = new OpenCodeClient({
      baseUrl: opencodeUrl,
      providerID,
      modelID,
      ...(process.env.OPENCODE_AGENT?.trim() ? { agent: process.env.OPENCODE_AGENT.trim() } : {}),
    });
    const sessions = new SessionStore();
    sessions.hydrate(eventLog);
    runner = new OpenCodeAgent(client, eventLog, sessions);
  }

  const dotId = process.env.DOTY_DOT_ID?.trim();
  const memoryStore = !runner && databaseUrl && dotId
    && process.env.OPENAI_EMBED_MODEL?.trim() && process.env.OPENAI_MODEL?.trim()
    ? memoryStoreFromEnv() : undefined;
  const memory = memoryStore && dotId ? new AgentMemory({
    store: memoryStore, dotId, embedder: new OpenAIEmbedder(embeddingConfigFromEnv()),
  }) : undefined;
  const agent = !runner && process.env.OPENAI_MODEL?.trim()
    ? { provider: new OpenAIChatProvider(openAIConfigFromEnv()), ...(memory ? { memory } : {}) }
    : undefined;

  // Optional email integrations (Gmail / Microsoft 365). Enabled when Postgres
  // and DOTY_CRED_KEY exist; each provider additionally needs its OAuth app env.
  const email = createEmailServiceFromEnv();

  const { app, runtime } = buildApp({
    logger: true,
    log: eventLog,
    ...(runner ? { runner } : {}),
    ...(agent ? { agent } : {}),
    ...(email ? { email } : {}),
  });

  if (!process.env.DOTY_TOKEN?.trim()) {
    app.log.warn('DOTY_TOKEN is unset: API bearer authentication is DISABLED (development only)');
  }
  app.log.info(runner ? 'agent backend: opencode' : agent ? 'agent backend: openai' : 'agent backend: none');
  app.log.info(
    email
      ? `email integrations: enabled (${email.configuredProviders().join(', ') || 'no providers configured'})`
      : 'email integrations: disabled (requires DATABASE_URL + DOTY_CRED_KEY)',
  );

  // Optional Discord integration: receive messages and reply with the agent.
  let discord: DiscordBot | undefined;
  let voice: VoiceManager | undefined;
  let reminders: ReminderService | undefined;
  const timeZone = resolveTimeZone(process.env.DOTY_TZ);
  const discordToken = process.env.DISCORD_BOT_TOKEN?.trim();
  if (discordToken && runtime) {
    const allowed = parseAllowedUserIds(process.env.DISCORD_ALLOWED_USER_IDS);
    if (allowed.size === 0) {
      app.log.warn('DISCORD_ALLOWED_USER_IDS is unset: Doty will answer any Discord user');
    }
    const triggerWords = parseTriggerWords(process.env.DISCORD_TRIGGER_WORDS);
    // DMs from these users continue the desktop session, so Discord and the
    // desktop client share one OpenCode history. Same comma-separated format as
    // DISCORD_ALLOWED_USER_IDS.
    const sharedSessionUserIds = parseAllowedUserIds(process.env.DOTY_SHARED_SESSION_USER_IDS);
    const commandModel = process.env.COMMAND_MODEL?.trim() || process.env.OPENAI_MODEL?.trim();
    const classifier: ClassifierConfig | undefined = commandModel && process.env.OPENAI_BASE_URL?.trim()
      ? {
          baseUrl: process.env.OPENAI_BASE_URL.trim(),
          ...(process.env.OPENAI_API_KEY?.trim() ? { apiKey: process.env.OPENAI_API_KEY.trim() } : {}),
          model: commandModel,
          ...(process.env.OPENAI_USER_AGENT?.trim() ? { userAgent: process.env.OPENAI_USER_AGENT.trim() } : {}),
          ...(process.env.OPENAI_SESSION_ID?.trim() ? { sessionId: process.env.OPENAI_SESSION_ID.trim() } : {}),
        }
      : undefined;
    app.log.info(classifier ? `command classifier: ${classifier.model}` : 'command classifier: disabled');
    const jevKey = process.env.JEV_API_KEY?.trim();
    const jev: JevConfig | undefined = jevKey
      ? {
          baseUrl: process.env.JEV_BASE_URL?.trim() || JEV_DEFAULT_URL,
          apiKey: jevKey,
          model: process.env.JEV_MODEL?.trim() || JEV_DEFAULT_MODEL,
          ...(process.env.OPENAI_USER_AGENT?.trim() ? { userAgent: process.env.OPENAI_USER_AGENT.trim() } : {}),
          ...(process.env.OPENAI_SESSION_ID?.trim() ? { sessionId: process.env.OPENAI_SESSION_ID.trim() } : {}),
        }
      : undefined;
    app.log.info(jev ? 'jev classifier: enabled' : 'jev classifier: disabled');
    voice = new VoiceManager({
      log: (message) => app.log.info(message),
      ...(process.env.PIPER_BIN?.trim() ? { piperBin: process.env.PIPER_BIN.trim() } : {}),
      ...(process.env.PIPER_VOICE?.trim() ? { piperVoice: process.env.PIPER_VOICE.trim() } : {}),
      track: {
        ...(process.env.YTDLP_COOKIES?.trim() ? { cookies: process.env.YTDLP_COOKIES.trim() } : {}),
        ...(process.env.YTDLP_SEARCH?.trim() ? { search: process.env.YTDLP_SEARCH.trim() } : {}),
        ...(process.env.YTDLP_EXTRA_ARGS?.trim() ? { extraArgs: process.env.YTDLP_EXTRA_ARGS.trim().split(/\s+/) } : {}),
      },
    });
    reminders = new ReminderService({
      log: eventLog,
      onDue: (reminder) => {
        const prefix = reminder.guildId ? `<@${reminder.userId}> ` : '';
        return discord?.send(reminder.channelId, `⏰ ${prefix}${reminder.text}`);
      },
      logger: (message) => app.log.info(message),
    });
    discord = startDiscordBot({
      token: discordToken,
      allowedUserIds: allowed,
      ...(process.env.DISCORD_CHANNEL_ID?.trim() ? { channelId: process.env.DISCORD_CHANNEL_ID.trim() } : {}),
      triggerWords,
      onGatewayOpen: (send) => voice?.setGatewaySender(send),
      onVoiceStateUpdate: (data) => voice?.onVoiceStateUpdate(data),
      onVoiceServerUpdate: (data) => voice?.onVoiceServerUpdate(data),
      onCommand: async (text, context) => {
        const reminderReply = reminders
          ? handleReminderMessage(text, {
              channelId: context.channelId,
              userId: context.userId,
              ...(context.guildId ? { guildId: context.guildId } : {}),
              conversationKey: context.conversationKey,
            }, reminders, { timeZone, triggerWords })
          : undefined;
        if (reminderReply !== undefined) return reminderReply;
        let command = parseVoiceCommand(text, triggerWords);
        if (!command && jev) command = await classifyVoiceIntentJev(text, jev);
        if (!command && classifier && text.split(/\s+/).length <= 12) {
          command = await classifyVoiceIntent(text, classifier);
        }
        if (!command) return undefined;
        if ((command.cmd === 'play' || command.cmd === 'say') && !command.arg) {
          const arg = extractCommandArg(text, triggerWords);
          if (arg) command = { cmd: command.cmd, arg };
        }
        if (!context.guildId) return 'La voz solo funciona en servidores (no en DM).';
        const guildId = context.guildId;
        const channelId = voice?.channelOf(guildId, context.userId) ?? null;
        if (command.cmd === 'play') {
          if (!channelId) return 'Entra a un canal de voz primero y luego pídeme la música.';
          return voice?.play(guildId, channelId, command.arg ?? '');
        }
        if (command.cmd === 'join') {
          if (!channelId) return 'Entra a un canal de voz primero.';
          return voice?.join(guildId, channelId);
        }
        if (command.cmd === 'say') {
          if (!voice?.connected(guildId)) return 'Primero hazme entrar a un canal de voz (`doty join`).';
          await voice.speak(guildId, command.arg ?? '');
          return '';
        }
        switch (command.cmd) {
          case 'skip': return voice?.skip(guildId);
          case 'stop': return voice?.stop(guildId);
          case 'pause': return voice?.pause(guildId);
          case 'resume': return voice?.resume(guildId);
          case 'queue': return voice?.queue(guildId);
          default: return undefined;
        }
      },
      handle: async (text, context) => {
        const key = resolveConversationKey(context, sharedSessionUserIds, DESKTOP_SESSION_KEY);
        eventLog.append({ type: 'message', data: { text } });
        const images = await loadDiscordImages(context.attachments, (message) => app.log.info(message));
        const result = await runtime.run(text, key, images);
        const reply = result.answer ?? result.error ?? `No pude completar la tarea (${result.status}).`;
        if (context.guildId && voice?.connected(context.guildId)) {
          void voice.speak(context.guildId, reply);
        }
        return reply;
      },
      log: (message) => app.log.info(message),
    });
    reminders.hydrate();
    app.log.info(`reminders: ${reminders.pending()} pending (tz ${timeZone})`);
    app.log.info('Discord integration enabled');
  } else if (discordToken && !runtime) {
    app.log.warn('DISCORD_BOT_TOKEN is set but no agent backend is configured; Discord is disabled');
  }

  // Conversational schedules ("envíame el resumen de correos todos los días a
  // las 6 am"). The agent creates them through its MCP tools; firing runs the
  // stored prompt through the same agent, so the result lands in the Doty chat
  // (run events) plus a Discord DM when configured.
  let schedules: ScheduleService | undefined;
  if (runtime) {
    const discordUserId = resolveDiscordUserId(process.env);
    const discordBot = discord;
    const deliverDiscord = discordBot && discordUserId
      ? async (text: string): Promise<void> => {
          const channelId = await discordBot.dmChannel(discordUserId);
          if (!channelId) throw new Error('could not open the Discord DM channel');
          await discordBot.send(channelId, text);
        }
      : undefined;
    if (!deliverDiscord) {
      app.log.warn('schedules: Discord delivery unavailable (set DOTY_DISCORD_USER_ID or a shared/allowed Discord user id)');
    }
    schedules = new ScheduleService({
      log: eventLog,
      run: (prompt, key) => runtime.run(prompt, key),
      ...(deliverDiscord ? { deliverDiscord } : {}),
      logger: (message) => app.log.info(message),
    });
    registerScheduleRoutes(app, schedules);
    schedules.hydrate();
    app.log.info(`schedules: ${schedules.list().length} active (tz ${timeZone})`);
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    reminders?.stop();
    schedules?.stop();
    voice?.destroy();
    discord?.stop();
    await app.close();
    if (pgLog) await pgLog.close();
    if (memoryStore) await memoryStore.close();
    if (email) await email.close();
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

/** Discord user that receives scheduled DMs: explicit env, else the first shared/allowed id. */
function resolveDiscordUserId(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env.DOTY_DISCORD_USER_ID?.trim();
  if (explicit) return explicit;
  for (const raw of [env.DOTY_SHARED_SESSION_USER_IDS, env.DISCORD_ALLOWED_USER_IDS]) {
    const first = raw?.split(',')[0]?.trim();
    if (first) return first;
  }
  return undefined;
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_ATTACHMENTS = 4;

/**
 * Download the image attachments of a Discord message and inline them as
 * `data:` URLs. Discord CDN URLs are signed and expire, so they are fetched
 * immediately and never handed to the model backend as-is. Non-image
 * attachments, oversized files and failed downloads are skipped.
 */
async function loadDiscordImages(
  attachments: readonly DiscordAttachment[] | undefined,
  log: (message: string) => void,
): Promise<AgentImage[]> {
  const images: AgentImage[] = [];
  for (const attachment of attachments ?? []) {
    if (images.length >= MAX_IMAGE_ATTACHMENTS) break;
    if (!attachment.contentType?.startsWith('image/')) continue;
    if (attachment.size !== undefined && attachment.size > MAX_IMAGE_BYTES) {
      log(`discord: skipped image over ${MAX_IMAGE_BYTES} bytes`);
      continue;
    }
    try {
      const response = await fetch(attachment.url, { headers: { 'User-Agent': 'Doty/0.1' } });
      if (!response.ok) {
        log(`discord: image download failed (${response.status})`);
        continue;
      }
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length > MAX_IMAGE_BYTES) {
        log(`discord: skipped downloaded image over ${MAX_IMAGE_BYTES} bytes`);
        continue;
      }
      const mime = attachment.contentType ?? response.headers.get('content-type') ?? 'image/png';
      images.push({
        mime,
        dataUrl: `data:${mime};base64,${data.toString('base64')}`,
        ...(attachment.filename ? { filename: attachment.filename } : {}),
      });
    } catch (error) {
      log(`discord: image download errored (${error instanceof Error ? error.name : 'unknown'})`);
    }
  }
  return images;
}
