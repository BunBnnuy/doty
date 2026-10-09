import { describe, expect, it, vi } from 'vitest';
import { BrowserWorkspace } from '../browser/workspace.js';
import { browserOwner, canUseDiscordBrowser, parseBrowserRequest, startDiscordBrowser } from './browser-discord.js';
import type { DiscordMessageContext } from './discord.js';

const context: DiscordMessageContext = { userId: 'owner', channelId: 'original-dm', messageId: 'request', isDm: true,
  conversationKey: 'dm:owner', attachments: [] };
describe('Discord browser requests', () => {
  it('parses natural-language routing markers without accepting extra fields or empty tasks', () => {
    expect(parseBrowserRequest('```json\n{"doty_browser_request":{"task":"Find the existing Gold Ship meme and send it"}}\n```'))
      .toBe('Find the existing Gold Ship meme and send it');
    for (const text of ['normal reply', '{"doty_browser_request":{"task":" "}}',
      '{"doty_browser_request":{"task":"search","userId":"other"}}']) expect(parseBrowserRequest(text)).toBeUndefined();
  });
  it('allows only the owner DM, with no fallback to arbitrary users', () => {
    expect(browserOwner({ DISCORD_ALLOWED_USER_IDS: 'a,b' })).toBeUndefined();
    expect(browserOwner({ DOTY_DISCORD_USER_ID: 'owner', DISCORD_ALLOWED_USER_IDS: 'a,b' })).toBe('owner');
    expect(canUseDiscordBrowser(context, 'owner')).toBe(true);
    expect(canUseDiscordBrowser({ ...context, userId: 'other' }, 'owner')).toBe(false);
    expect(canUseDiscordBrowser({ ...context, isDm: false, guildId: 'server' }, 'owner')).toBe(false);
  });
  it('sends the existing downloaded image to the original DM after the asynchronous task finishes', async () => {
    const image = { data: Buffer.from('89504e470d0a1a0a', 'hex'), mime: 'image/png' };
    const model = { createSession: vi.fn(async () => 's'), abort: vi.fn(async () => {}),
      prompt: vi.fn(async () => '{"action":"done","answer":"Found this meme: https://source.example/","image_id":2}') };
    const fetchImage = vi.fn(async () => image);
    const browser = new BrowserWorkspace({ health: vi.fn(), screenshot: vi.fn(async () => Buffer.from('screen')),
      snapshot: vi.fn(async () => ({ images: [{ id: 2 }] })), action: vi.fn(), image: fetchImage }, model);
    const send = vi.fn(async () => {});
    startDiscordBrowser('Find and send the existing meme', context, browser, send, vi.fn());
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(fetchImage).toHaveBeenCalledWith(2);
    expect(send).toHaveBeenCalledWith('original-dm', { content: 'Found this meme: https://source.example/',
      files: [{ filename: 'doty-found-image.png', mime: 'image/png', data: image.data }] });
  });
  it('sends approval notice and then the final result after approval', async () => {
    const model = { createSession: vi.fn(async () => 's'), abort: vi.fn(async () => {}),
      prompt: vi.fn().mockResolvedValueOnce('{"action":"click","x":10,"y":20}')
        .mockResolvedValueOnce('{"action":"done","answer":"The source says..."}') };
    const action = vi.fn(async () => ({}));
    const browser = new BrowserWorkspace({ health: vi.fn(), screenshot: vi.fn(async () => Buffer.from('screen')),
      snapshot: vi.fn(async () => ({})), action }, model);
    const send = vi.fn(async () => {});
    startDiscordBrowser('Check a website', context, browser, send, vi.fn());
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(action).not.toHaveBeenCalled();
    browser.approve();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send).toHaveBeenLastCalledWith('original-dm', 'The source says...');
  });
  it('reports a delivery failure without publishing image bytes or page contents in logs', async () => {
    const browser = new BrowserWorkspace({ health: vi.fn(), screenshot: vi.fn(async () => Buffer.from('screen')),
      snapshot: vi.fn(async () => ({})), action: vi.fn() }, { createSession: vi.fn(async () => 's'), abort: vi.fn(async () => {}),
      prompt: vi.fn(async () => '{"action":"done","answer":"Private page text"}') });
    const log = vi.fn();
    startDiscordBrowser('Read', context, browser, vi.fn(async () => { throw new Error('Secret response'); }), log);
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('discord: browser result delivery failed'));
  });
  it('tries another existing image after a CDN download fails instead of refusing the entire task', async () => {
    const model = { createSession: vi.fn(async () => 's'), abort: vi.fn(async () => {}), prompt: vi.fn()
      .mockResolvedValueOnce('{"action":"done","answer":"First image","image_id":0}')
      .mockResolvedValueOnce('{"action":"done","answer":"Second public source","image_id":1}') };
    const image = { data: Buffer.from('89504e470d0a1a0a', 'hex'), mime: 'image/png' };
    const retrieve = vi.fn().mockRejectedValueOnce(new Error('CDN blocked')).mockResolvedValueOnce(image);
    const browser = new BrowserWorkspace({ health: vi.fn(), screenshot: vi.fn(async () => Buffer.from('screen')),
      snapshot: vi.fn(async () => ({})), action: vi.fn(), image: retrieve }, model);
    const send = vi.fn(async () => {});
    startDiscordBrowser('Find a meme', context, browser, send, vi.fn());
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(retrieve.mock.calls).toEqual([[0], [1]]);
    expect(model.prompt.mock.calls[1]?.[1]).toContain('could not be downloaded');
    expect(send).toHaveBeenCalledWith('original-dm', expect.objectContaining({ content: 'Second public source' }));
  });
});
