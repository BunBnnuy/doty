import { describe, expect, it } from 'vitest';
import {
  chunkDiscordMessage,
  discordIntents,
  parseAllowedUserIds,
  parseTriggerWords,
  resolveConversationKey,
  shouldRespondToMessage,
  stripBotMention,
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
  ...over,
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
