import { describe, expect, it } from 'vitest';
import {
  chunkDiscordMessage,
  discordIntents,
  parseAllowedUserIds,
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
  ...over,
});

describe('discord helpers', () => {
  it('requests the message-content intents', () => {
    expect(discordIntents()).toBe((1 << 9) | (1 << 12) | (1 << 15));
    expect(discordIntents(false)).toBe((1 << 9) | (1 << 12));
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

  it('decides when to respond', () => {
    const allowed = new Set(['u1']);
    expect(shouldRespondToMessage(msg(), { allowedUserIds: allowed, mentionOnly: true })).toBe(true);
    expect(shouldRespondToMessage(msg({ authorId: 'u2' }), { allowedUserIds: allowed, mentionOnly: true })).toBe(false);
    expect(shouldRespondToMessage(msg({ authorBot: true }), { allowedUserIds: allowed, mentionOnly: true })).toBe(false);
    expect(shouldRespondToMessage(msg({ guildId: 'g1' }), { allowedUserIds: allowed, mentionOnly: true })).toBe(false);
    expect(shouldRespondToMessage(msg({ guildId: 'g1', mentionedBot: true }), { allowedUserIds: allowed, mentionOnly: true })).toBe(true);
    expect(shouldRespondToMessage(msg({ guildId: 'g1', channelId: 'c1' }), { allowedUserIds: allowed, channelId: 'c1', mentionOnly: true })).toBe(true);
    expect(shouldRespondToMessage(msg({ guildId: 'g1', channelId: 'c2' }), { allowedUserIds: allowed, channelId: 'c1', mentionOnly: true })).toBe(false);
  });
});
