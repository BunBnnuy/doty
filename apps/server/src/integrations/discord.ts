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

/** The subset of a Discord attachment Doty forwards to the agent. */
export interface DiscordAttachment {
  url: string;
  contentType?: string;
  filename?: string;
  size?: number;
}

export interface DiscordMessageContext {
  channelId: string;
  messageId: string;
  userId: string;
  isDm: boolean;
  /** Guild id for server messages (absent for DMs). */
  guildId?: string;
  /** Memory scope: per DM user, or per guild (server). */
  conversationKey: string;
  /** Attachments on the message (images are passed to the agent). */
  attachments: readonly DiscordAttachment[];
}

export interface DiscordBotOptions {
  token: string;
  /** Empty set = any user. */
  allowedUserIds?: ReadonlySet<string>;
  /** Restrict guild replies to this channel. DMs always work. */
  channelId?: string;
  /** Case-insensitive words that trigger a reply. Default ['doty','bot']. */
  triggerWords?: readonly string[];
  /** Request the privileged MESSAGE_CONTENT intent. Default true. */
  messageContent?: boolean;
  /** Produce the reply text for an incoming message (runs the agent). */
  handle: (text: string, context: DiscordMessageContext) => Promise<string | DiscordReply | undefined>;
  /**
   * Optional command hook (music, etc.). Return a string to reply and skip the
   * agent, or `undefined` to let the agent handle the message.
   */
  onCommand?: (text: string, context: DiscordMessageContext) => Promise<string | undefined> | string | undefined;
  /** Receives the raw gateway sender once the socket is open (for voice). */
  onGatewayOpen?: (send: (payload: unknown) => boolean) => void;
  /** VOICE_STATE_UPDATE dispatch payload. */
  onVoiceStateUpdate?: (data: unknown) => void;
  /** VOICE_SERVER_UPDATE dispatch payload. */
  onVoiceServerUpdate?: (data: unknown) => void;
  /** Metadata-only logger; never pass message content. */
  log?: (message: string) => void;
}

export interface DiscordBot {
  /** Post a message to a channel unprompted (e.g. a scheduled reminder). */
  send(channelId: string, content: string | DiscordReply): Promise<void>;
  /** Open (or reuse) the DM channel with a user; `undefined` when it fails. */
  dmChannel(userId: string): Promise<string | undefined>;
  stop(): void;
}

export interface DiscordFile {
  filename: string;
  mime: string;
  data: Uint8Array;
}

export interface DiscordReply {
  content: string;
  files?: readonly DiscordFile[];
}

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const API_BASE = 'https://discord.com/api/v10';
// GUILD_VOICE_STATES | GUILD_MESSAGES | DIRECT_MESSAGES
const BASE_INTENTS = (1 << 7) | (1 << 9) | (1 << 12);
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
  /** The message is a reply to one of the bot's messages. */
  replyToBot: boolean;
  /** Attachments on the message (images are passed to the agent). */
  attachments: DiscordAttachment[];
}

/** Case-insensitive words that trigger a reply. */
export const DEFAULT_TRIGGER_WORDS: readonly string[] = ['doty', 'bot'];

/** Used as the prompt when a message carries attachments but no text. */
export const DEFAULT_ATTACHMENT_PROMPT = 'Mira la imagen que envié y responde.';

export interface RespondOptions {
  allowedUserIds: ReadonlySet<string>;
  channelId?: string;
  triggerWords?: readonly string[];
}

/**
 * Whether Doty should answer: DMs, messages that mention it, replies to it, or a
 * message containing a trigger word ("doty"/"bot"). Guild messages are further
 * limited to `channelId` when configured.
 */
export function shouldRespondToMessage(msg: IncomingMessage, options: RespondOptions): boolean {
  if (msg.authorBot) return false;
  if (options.allowedUserIds.size > 0 && !options.allowedUserIds.has(msg.authorId)) return false;
  if (msg.guildId === undefined) return true; // DM
  if (options.channelId && msg.channelId !== options.channelId) return false;
  if (msg.mentionedBot || msg.replyToBot) return true;
  const content = msg.content.toLowerCase();
  return (options.triggerWords ?? DEFAULT_TRIGGER_WORDS)
    .some((word) => word.length > 0 && content.includes(word.toLowerCase()));
}

/** Parse `DISCORD_TRIGGER_WORDS` (comma-separated); falls back to the defaults. */
export function parseTriggerWords(raw: string | undefined): string[] {
  const words = (raw ?? '').split(',').map((word) => word.trim()).filter(Boolean);
  return words.length > 0 ? words : [...DEFAULT_TRIGGER_WORDS];
}

/**
 * Conversation key an incoming message runs under. A DM from a user in
 * `sharedUserIds` continues the desktop session (`desktopKey`) instead of its
 * own, so Discord and the desktop client share one history.
 */
export function resolveConversationKey(
  context: Pick<DiscordMessageContext, 'isDm' | 'userId' | 'conversationKey'>,
  sharedUserIds: ReadonlySet<string>,
  desktopKey: string,
): string {
  return context.isDm && sharedUserIds.has(context.userId) ? desktopKey : context.conversationKey;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Parse the `attachments` array of a MESSAGE_CREATE payload. */
export function parseAttachments(raw: unknown): DiscordAttachment[] {
  if (!Array.isArray(raw)) return [];
  const attachments: DiscordAttachment[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (!record || typeof record.url !== 'string' || !record.url) continue;
    attachments.push({
      url: record.url,
      ...(typeof record.content_type === 'string' ? { contentType: record.content_type } : {}),
      ...(typeof record.filename === 'string' ? { filename: record.filename } : {}),
      ...(typeof record.size === 'number' ? { size: record.size } : {}),
    });
  }
  return attachments;
}

function readIncoming(data: unknown, botUserId: string | undefined): IncomingMessage | null {
  const record = asRecord(data);
  if (!record) return null;
  const author = asRecord(record.author);
  const channelId = typeof record.channel_id === 'string' ? record.channel_id : '';
  const authorId = typeof author?.id === 'string' ? author.id : '';
  if (!channelId || !authorId) return null;
  const mentions = Array.isArray(record.mentions) ? record.mentions : [];
  const referencedAuthor = asRecord(asRecord(record.referenced_message)?.author);
  return {
    channelId,
    messageId: typeof record.id === 'string' ? record.id : '',
    ...(typeof record.guild_id === 'string' ? { guildId: record.guild_id } : {}),
    authorId,
    authorBot: author?.bot === true,
    content: typeof record.content === 'string' ? record.content : '',
    mentionedBot: botUserId !== undefined && mentions.some((m) => asRecord(m)?.id === botUserId),
    replyToBot: botUserId !== undefined && referencedAuthor?.id === botUserId,
    attachments: parseAttachments(record.attachments),
  };
}

export function startDiscordBot(options: DiscordBotOptions): DiscordBot {
  const allowed = options.allowedUserIds ?? new Set<string>();
  const log = options.log ?? (() => {});
  const respondOptions: RespondOptions = {
    allowedUserIds: allowed,
    triggerWords: options.triggerWords ?? DEFAULT_TRIGGER_WORDS,
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

  async function sendMessage(channelId: string, reply: string | DiscordReply): Promise<void> {
    const content = typeof reply === 'string' ? reply : reply.content;
    const files = typeof reply === 'string' ? [] : reply.files ?? [];
    const chunks = chunkDiscordMessage(content);
    if (!chunks.length && files.length) chunks.push('');
    for (const [index, chunk] of chunks.entries()) {
      const payload = { content: chunk, allowed_mentions: { parse: [] } };
      let body: string | FormData = JSON.stringify(payload);
      const headers = { ...authHeaders };
      if (index === 0 && files.length) {
        const form = new FormData();
        form.set('payload_json', JSON.stringify({ ...payload,
          attachments: files.map((file, id) => ({ id, filename: file.filename })),
        }));
        files.forEach((file, id) => form.set(`files[${id}]`,
          new Blob([new Uint8Array(file.data)], { type: file.mime }), file.filename));
        delete headers['content-type'];
        body = form;
      }
      try {
        const response = await fetch(`${API_BASE}/channels/${channelId}/messages`, {
          method: 'POST',
          headers,
          body,
        });
        if (!response.ok) throw new Error(`Discord upload HTTP ${response.status}`);
      } catch (error) {
        log(`discord: reply request errored (${error instanceof Error ? error.name : 'unknown'})`);
        throw new Error('Discord message delivery failed');
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

  async function openDm(userId: string): Promise<string | undefined> {
    try {
      const response = await fetch(`${API_BASE}/users/@me/channels`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ recipient_id: userId }),
      });
      if (!response.ok) {
        log(`discord: could not open DM (${response.status})`);
        return undefined;
      }
      const body = (await response.json()) as { id?: unknown };
      return typeof body.id === 'string' ? body.id : undefined;
    } catch (error) {
      log(`discord: DM request errored (${error instanceof Error ? error.name : 'unknown'})`);
      return undefined;
    }
  }

  async function respond(message: IncomingMessage, text: string): Promise<void> {
    log(`discord: message from ${message.authorId} (${message.guildId === undefined ? 'dm' : 'guild'})`);
    const context: DiscordMessageContext = {
      channelId: message.channelId,
      messageId: message.messageId,
      userId: message.authorId,
      isDm: message.guildId === undefined,
      conversationKey: message.guildId === undefined
        ? `discord:dm:${message.authorId}`
        : `discord:guild:${message.guildId}`,
      ...(message.guildId !== undefined ? { guildId: message.guildId } : {}),
      attachments: message.attachments,
    };
    void sendTyping(message.channelId);
    const typing = setInterval(() => void sendTyping(message.channelId), 8_000);
    try {
      if (options.onCommand) {
        const handled = await options.onCommand(text, context);
        if (handled !== undefined) {
          if (handled.trim()) await sendMessage(message.channelId, handled.trim());
          return;
        }
      }
      const reply = await options.handle(text, context);
      if (typeof reply === 'string') {
        if (reply.trim()) await sendMessage(message.channelId, reply.trim());
      } else if (reply && (reply.content.trim() || reply.files?.length)) {
        await sendMessage(message.channelId, reply);
      }
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
    if (event === 'VOICE_STATE_UPDATE') {
      options.onVoiceStateUpdate?.(data);
      return;
    }
    if (event === 'VOICE_SERVER_UPDATE') {
      options.onVoiceServerUpdate?.(data);
      return;
    }
    if (event !== 'MESSAGE_CREATE') return;
    const message = readIncoming(data, botUserId);
    if (!message) return;
    if (!shouldRespondToMessage(message, respondOptions)) {
      // Metadata only: helps diagnose why a guild message was ignored (usually a
      // missing MESSAGE_CONTENT intent, which empties `content`).
      if (message.guildId) {
        log(`discord: ignored guild message (channel=${message.channelId} mention=${message.mentionedBot} reply=${message.replyToBot} contentLen=${message.content.length})`);
      }
      return;
    }
    const text = stripBotMention(message.content, botUserId);
    if (!text && message.attachments.length === 0) return;
    void respond(message, text || DEFAULT_ATTACHMENT_PROMPT).catch(() => log('discord: error reply delivery failed'));
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
      options.onGatewayOpen?.((payload) => {
        const current = socket;
        if (!current || current.readyState !== 1) return false;
        current.send(JSON.stringify(payload));
        return true;
      });
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
    send: sendMessage,
    dmChannel: openDm,
    stop() {
      stopped = true;
      stopHeartbeat();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
      socket = undefined;
    },
  };
}
