import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chunkDiscordMessage,
  discordIntents,
  parseAllowedUserIds,
  parseAttachments,
  parseTriggerWords,
  resolveConversationKey,
  shouldRespondToMessage,
  stripBotMention,
  startDiscordBot,
  type IncomingMessage,
} from './discord.js';

const msg = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({
  channelId: 'c1',
  messageId: 'm1',
  authorId: 'u1',
  authorBot: false,
  content: 'hi',
  mentionedBot: false,
  replyToBot: false,
  attachments: [],
  ...over,
});

describe('Discord uploads', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('uploads binary images as multipart and keeps long text chunks separate', async () => {
    vi.stubGlobal('WebSocket', class { addEventListener() {} close() {} });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const bot = startDiscordBot({ token: 'test', handle: async () => undefined });
    try {
      await bot.send('dm-channel', { content: 'x'.repeat(2100),
        files: [{ filename: 'image.png', mime: 'image/png', data: new Uint8Array([1, 2, 3]) }] });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const first = fetchMock.mock.calls[0]![1];
      expect(first.headers['content-type']).toBeUndefined();
      expect(first.body).toBeInstanceOf(FormData);
      expect(JSON.parse(first.body.get('payload_json'))).toMatchObject({
        attachments: [{ id: 0, filename: 'image.png' }], allowed_mentions: { parse: [] },
      });
      expect(await first.body.get('files[0]').arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer);
      expect(fetchMock.mock.calls[1]![1].headers['content-type']).toBe('application/json');
    } finally { bot.stop(); }
  });
  it('supports image-only replies and reports upload failures', async () => {
    vi.stubGlobal('WebSocket', class { addEventListener() {} close() {} });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    const bot = startDiscordBot({ token: 'test', handle: async () => undefined });
    try {
      await expect(bot.send('guild-channel', { content: '',
        files: [{ filename: 'image.png', mime: 'image/png', data: new Uint8Array([1]) }] }))
        .rejects.toThrow('delivery failed');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { bot.stop(); }
  });
});

describe('discord helpers', () => {
  it('requests the voice, guild-message and message-content intents', () => {
    expect(discordIntents()).toBe((1 << 7) | (1 << 9) | (1 << 12) | (1 << 15));
    expect(discordIntents(false)).toBe((1 << 7) | (1 << 9) | (1 << 12));
  });

  it('parses a comma-separated allow-list', () => {
    expect([...parseAllowedUserIds(' a, b ,, c ')]).toEqual(['a', 'b', 'c']);
    expect(parseAllowedUserIds(undefined).size).toBe(0);
  });

  it('strips the bot mention', () => {
    expect(stripBotMention('<@123> hola <@!123>', '123')).toBe('hola');
    expect(stripBotMention('hola', undefined)).toBe('hola');
  });

  it('chunks long replies under the limit', () => {
    const chunks = chunkDiscordMessage('a '.repeat(2000), 2000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
    expect(chunkDiscordMessage('short')).toEqual(['short']);
  });

  it('parses the trigger words', () => {
    expect(parseTriggerWords(undefined)).toEqual(['doty', 'bot']);
    expect(parseTriggerWords(' hey , Hola ')).toEqual(['hey', 'Hola']);
  });

  it('responds to DMs, mentions, replies to Doty, and trigger words only', () => {
    const allowed = new Set(['u1']);
    expect(shouldRespondToMessage(msg(), { allowedUserIds: allowed })).toBe(true); // DM
    expect(shouldRespondToMessage(msg({ authorId: 'u2' }), { allowedUserIds: allowed })).toBe(false);
    expect(shouldRespondToMessage(msg({ authorBot: true }), { allowedUserIds: allowed })).toBe(false);
    // Guild: plain message is ignored...
    expect(shouldRespondToMessage(msg({ guildId: 'g1' }), { allowedUserIds: allowed })).toBe(false);
    // ...but a mention, a reply to Doty, or a trigger word gets a reply.
    expect(shouldRespondToMessage(msg({ guildId: 'g1', mentionedBot: true }), { allowedUserIds: allowed })).toBe(true);
    expect(shouldRespondToMessage(msg({ guildId: 'g1', replyToBot: true }), { allowedUserIds: allowed })).toBe(true);
    expect(shouldRespondToMessage(msg({ guildId: 'g1', content: 'hey doty' }), { allowedUserIds: allowed })).toBe(true);
    expect(shouldRespondToMessage(msg({ guildId: 'g1', content: 'the BOT is here' }), { allowedUserIds: allowed })).toBe(true);
    // Channel filter still applies.
    expect(shouldRespondToMessage(msg({ guildId: 'g1', mentionedBot: true, channelId: 'c2' }), { allowedUserIds: allowed, channelId: 'c1' })).toBe(false);
    // Custom trigger words.
    expect(shouldRespondToMessage(msg({ guildId: 'g1', content: 'ping' }), { allowedUserIds: allowed, triggerWords: ['ping'] })).toBe(true);
    expect(shouldRespondToMessage(msg({ guildId: 'g1', content: 'ping' }), { allowedUserIds: allowed, triggerWords: ['doty'] })).toBe(false);
  });
});

describe('attachments', () => {
  it('parses image attachments and keeps their metadata', () => {
    expect(parseAttachments([
      { url: 'https://cdn.discordapp.com/a.png', content_type: 'image/png', filename: 'a.png', size: 123 },
      { url: 'https://cdn.discordapp.com/b.txt', content_type: 'text/plain' },
      { content_type: 'image/png' },
      'nope',
    ])).toEqual([
      { url: 'https://cdn.discordapp.com/a.png', contentType: 'image/png', filename: 'a.png', size: 123 },
      { url: 'https://cdn.discordapp.com/b.txt', contentType: 'text/plain' },
    ]);
    expect(parseAttachments(undefined)).toEqual([]);
  });

  it('still answers a mention that carries only an image', () => {
    const allowed = new Set(['u1']);
    const imageOnly = msg({
      guildId: 'g1',
      content: '',
      mentionedBot: true,
      attachments: [{ url: 'https://cdn.discordapp.com/a.png', contentType: 'image/png' }],
    });
    expect(shouldRespondToMessage(imageOnly, { allowedUserIds: allowed })).toBe(true);
  });
});

describe('shared conversations', () => {
  const shared = new Set(['u1']);
  const dm = { isDm: true, userId: 'u1', conversationKey: 'discord:dm:u1' };

  it('routes a shared user DM to the desktop session', () => {
    expect(resolveConversationKey(dm, shared, 'desktop')).toBe('desktop');
  });

  it('keeps unlisted users and guilds on their own session', () => {
    expect(resolveConversationKey({ ...dm, userId: 'u2' }, shared, 'desktop')).toBe('discord:dm:u1');
    expect(resolveConversationKey({ isDm: false, userId: 'u1', conversationKey: 'discord:guild:g1' }, shared, 'desktop'))
      .toBe('discord:guild:g1');
    expect(resolveConversationKey(dm, new Set(), 'desktop')).toBe('discord:dm:u1');
  });
});
