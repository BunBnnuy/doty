/**
 * Minimal, dependency-free Discord bot.
 *
 * Connects to the Discord gateway over the built-in `WebSocket`, listens for
 * messages, hands the text to the Doty agent runtime, and posts the reply back
 * with the REST API over the built-in `fetch`. No `discord.js` dependency.
 *
 * Security: replies only to users in `DISCORD_ALLOWED_USER_IDS` (empty = anyone),
 * ignores other bots, and never logs message content or the token.
 *
 * Setup: create a Discord application + bot, enable the MESSAGE CONTENT intent
 * in the developer portal, invite the bot, and set `DISCORD_BOT_TOKEN`.
 */

export interface DiscordMessageContext {
  channelId: string;
  messageId: string;
  userId: string;
  isDm: boolean;
  /** Memory scope: per DM user, or per guild (server). */
  conversationKey: string;
}

export interface DiscordBotOptions {
  token: string;
  /** Empty set = any user. */
  allowedUserIds?: ReadonlySet<string>;
  /** Restrict guild replies to this channel. DMs always work. */
  channelId?: string;
  /** In guilds without a fixed channel, only answer when mentioned. Default true. */
  mentionOnly?: boolean;
  /** Request the privileged MESSAGE_CONTENT intent. Default true. */
  messageContent?: boolean;
  /** Produce the reply text for an incoming message (runs the agent). */
  handle: (text: string, context: DiscordMessageContext) => Promise<string | undefined>;
  /** Metadata-only logger; never pass message content. */
  log?: (message: string) => void;
}

export interface DiscordBot {
  stop(): void;
}

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const API_BASE = 'https://discord.com/api/v10';
// GUILD_MESSAGES | DIRECT_MESSAGES
const BASE_INTENTS = (1 << 9) | (1 << 12);
// MESSAGE_CONTENT is privileged and must be enabled in the developer portal.
const MESSAGE_CONTENT_INTENT = 1 << 15;
const USER_AGENT = 'Doty (https://github.com/BunBnnuy/doty, 0.1)';

export function discordIntents(includeMessageContent = true): number {
  return BASE_INTENTS | (includeMessageContent ? MESSAGE_CONTENT_INTENT : 0);
}

/** Parse `DISCORD_ALLOWED_USER_IDS` (comma-separated) into a set. */
export function parseAllowedUserIds(raw: string | undefined): Set<string> {
  return new Set((raw ?? '').split(',').map((part) => part.trim()).filter(Boolean));
}

/** Remove a leading/any `<@id>` mention of the bot from a message body. */
export function stripBotMention(content: string, botUserId: string | undefined): string {
  if (!botUserId) return content.trim();
  return content.replace(new RegExp(`<@!?${botUserId}>`, 'g'), '').trim();
}

/** Split a reply into <=2000-char chunks on a word/newline boundary. */
export function chunkDiscordMessage(text: string, limit = 2000): string[] {
  const max = Math.max(1, limit - 10);
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** The subset of a Discord MESSAGE_CREATE the filter needs. */
export interface IncomingMessage {
  channelId: string;
  messageId: string;
  guildId?: string;
  authorId: string;
  authorBot: boolean;
  content: string;
  mentionedBot: boolean;
}

export interface RespondOptions {
  allowedUserIds: ReadonlySet<string>;
  channelId?: string;
  mentionOnly: boolean;
}

/** Whether Doty should answer this message. */
export function shouldRespondToMessage(msg: IncomingMessage, options: RespondOptions): boolean {
  if (msg.authorBot) return false;
  if (options.allowedUserIds.size > 0 && !options.allowedUserIds.has(msg.authorId)) return false;
  if (msg.guildId === undefined) return true; // DM
  if (options.channelId) return msg.channelId === options.channelId;
  return options.mentionOnly ? msg.mentionedBot : true;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readIncoming(data: unknown, botUserId: string | undefined): IncomingMessage | null {
  const record = asRecord(data);
  if (!record) return null;
  const author = asRecord(record.author);
  const channelId = typeof record.channel_id === 'string' ? record.channel_id : '';
  const authorId = typeof author?.id === 'string' ? author.id : '';
  if (!channelId || !authorId) return null;
  const mentions = Array.isArray(record.mentions) ? record.mentions : [];
  return {
    channelId,
    messageId: typeof record.id === 'string' ? record.id : '',
    ...(typeof record.guild_id === 'string' ? { guildId: record.guild_id } : {}),
    authorId,
    authorBot: author?.bot === true,
    content: typeof record.content === 'string' ? record.content : '',
    mentionedBot: botUserId !== undefined && mentions.some((m) => asRecord(m)?.id === botUserId),
  };
}

export function startDiscordBot(options: DiscordBotOptions): DiscordBot {
  const allowed = options.allowedUserIds ?? new Set<string>();
  const mentionOnly = options.mentionOnly ?? true;
  const log = options.log ?? (() => {});
  const respondOptions: RespondOptions = {
    allowedUserIds: allowed,
    mentionOnly,
    ...(options.channelId ? { channelId: options.channelId } : {}),
  };

  let stopped = false;
  let socket: WebSocket | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectDelay = 1000;
  let lastSeq: number | null = null;
  let botUserId: string | undefined;
  let includeMessageContent = options.messageContent ?? true;

  const authHeaders: Record<string, string> = {
    Authorization: `Bot ${options.token}`,
    'content-type': 'application/json',
    'User-Agent': USER_AGENT,
  };

  async function sendMessage(channelId: string, content: string): Promise<void> {
    for (const chunk of chunkDiscordMessage(content)) {
      try {
        const response = await fetch(`${API_BASE}/channels/${channelId}/messages`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ content: chunk }),
        });
        if (!response.ok) log(`discord: reply failed with ${response.status}`);
      } catch (error) {
        log(`discord: reply request errored (${error instanceof Error ? error.name : 'unknown'})`);
      }
    }
  }

  async function sendTyping(channelId: string): Promise<void> {
    try {
      await fetch(`${API_BASE}/channels/${channelId}/typing`, { method: 'POST', headers: authHeaders });
    } catch {
      // Typing is best-effort.
    }
  }

  async function respond(message: IncomingMessage, text: string): Promise<void> {
    log(`discord: message from ${message.authorId} (${message.guildId === undefined ? 'dm' : 'guild'})`);
    void sendTyping(message.channelId);
    const typing = setInterval(() => void sendTyping(message.channelId), 8_000);
    try {
      const reply = await options.handle(text, {
        channelId: message.channelId,
        messageId: message.messageId,
        userId: message.authorId,
        isDm: message.guildId === undefined,
        conversationKey: message.guildId === undefined
          ? `discord:dm:${message.authorId}`
          : `discord:guild:${message.guildId}`,
      });
      if (reply && reply.trim()) await sendMessage(message.channelId, reply.trim());
    } catch (error) {
      log(`discord: handler errored (${error instanceof Error ? error.name : 'unknown'})`);
      await sendMessage(message.channelId, 'Algo falló al procesar tu mensaje.');
    } finally {
      clearInterval(typing);
    }
  }

  function handleDispatch(event: string, data: unknown): void {
    if (event === 'READY') {
      const user = asRecord(asRecord(data)?.user);
      if (typeof user?.id === 'string') botUserId = user.id;
      reconnectDelay = 1_000;
      log(`discord: ready as ${typeof user?.username === 'string' ? user.username : 'bot'}`);
      return;
    }
    if (event !== 'MESSAGE_CREATE') return;
    const message = readIncoming(data, botUserId);
    if (!message) return;
    if (!shouldRespondToMessage(message, respondOptions)) {
      // Metadata only: helps diagnose why a guild message was ignored (usually a
      // missing MESSAGE_CONTENT intent, which empties `content`).
      if (message.guildId) {
        log(`discord: ignored guild message (channel=${message.channelId} mention=${message.mentionedBot} contentLen=${message.content.length})`);
      }
      return;
    }
    const text = stripBotMention(message.content, botUserId);
    if (!text) return;
    void respond(message, text);
  }

  function identify(ws: WebSocket): void {
    ws.send(JSON.stringify({
      op: 2,
      d: {
        token: options.token,
        intents: discordIntents(includeMessageContent),
        properties: { os: process.platform, browser: 'doty', device: 'doty' },
      },
    }));
  }

  function sendHeartbeat(ws: WebSocket): void {
    ws.send(JSON.stringify({ op: 1, d: lastSeq }));
  }

  function startHeartbeat(intervalMs: number): void {
    stopHeartbeat();
    heartbeat = setInterval(() => {
      if (socket && socket.readyState === 1) sendHeartbeat(socket);
    }, Math.max(1_000, intervalMs));
  }

  function stopHeartbeat(): void {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(30_000, reconnectDelay * 2);
    log(`discord: reconnecting in ${delay}ms`);
    reconnectTimer = setTimeout(connect, delay);
  }

  function onPayload(raw: string): void {
    let payload: { op?: number; s?: number | null; t?: string; d?: unknown };
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      return;
    }
    if (typeof payload.s === 'number') lastSeq = payload.s;
    switch (payload.op) {
      case 10: {
        const hello = asRecord(payload.d);
        const interval = typeof hello?.heartbeat_interval === 'number' ? hello.heartbeat_interval : 45_000;
        if (socket) {
          startHeartbeat(interval);
          identify(socket);
        }
        break;
      }
      case 1:
        if (socket) sendHeartbeat(socket);
        break;
      case 7:
        socket?.close();
        break;
      case 9:
        setTimeout(() => {
          if (!stopped && socket) identify(socket);
        }, 1_000 + Math.random() * 4_000);
        break;
      case 0:
        handleDispatch(payload.t ?? '', payload.d);
        break;
      default:
        break;
    }
  }

  function connect(): void {
    if (stopped) return;
    log('discord: connecting to gateway');
    const ws = new WebSocket(GATEWAY_URL);
    socket = ws;
    ws.addEventListener('open', () => {
      log('discord: gateway socket open');
    });
    ws.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data === 'string') onPayload(event.data);
    });
    ws.addEventListener('close', (event: CloseEvent) => {
      stopHeartbeat();
      log(`discord: gateway closed (code ${event.code})`);
      if (event.code === 4014 && includeMessageContent) {
        includeMessageContent = false;
        reconnectDelay = 1_000;
        log('discord: MESSAGE CONTENT intent not enabled; retrying without it (DMs and mentions still work; enable it in the portal for full guild content)');
      }
      scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      // The close event that follows schedules the reconnect.
    });
  }

  connect();

  return {
    stop() {
      stopped = true;
      stopHeartbeat();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
      socket = undefined;
    },
  };
}
