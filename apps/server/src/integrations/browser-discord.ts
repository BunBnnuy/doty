import { z } from 'zod';
import type { BrowserWorkspace, BrowserUpdate } from '../browser/workspace.js';
import type { DiscordBot, DiscordMessageContext } from './discord.js';

export const BROWSER_REPLY_INSTRUCTION = `Discord browser capability: Doty has a real Chromium browser with live internet.
For requests to search online, check current information, open websites, or find and send an EXISTING image or meme,
reply ONLY with {"doty_browser_request":{"task":"self-contained task including the user request and relevant context"}}.
The browser will do the work and send the result, including existing image files, back to this owner DM.
Do not claim that internet search or fetching existing images is unavailable. Do not generate a replacement when
the user asks to find an existing meme. Requests to CREATE or EDIT images still use doty_image_request.
Preserve the user's original search words when an expression is ambiguous. Do not turn an earlier unsupported
guess into a fact or replace the requested meme with a family description.
For other messages reply normally. Never put passwords or API tokens into a browser task.`;

export function parseBrowserRequest(answer: string): string | undefined {
  try {
    const text = answer.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, '$1');
    const value = z.object({ doty_browser_request: z.object({ task: z.string().trim().min(1).max(4000) }).strict() }).strict().parse(JSON.parse(text));
    return value.doty_browser_request.task;
  } catch { return undefined; }
}
export function browserOwner(env: NodeJS.ProcessEnv): string | undefined {
  if (env.DOTY_DISCORD_USER_ID?.trim()) return env.DOTY_DISCORD_USER_ID.trim();
  for (const raw of [env.DOTY_SHARED_SESSION_USER_IDS, env.DISCORD_ALLOWED_USER_IDS]) {
    const ids = [...new Set((raw || '').split(',').map(id => id.trim()).filter(Boolean))];
    if (ids.length === 1) return ids[0];
  }
  return undefined;
}
export function canUseDiscordBrowser(context: Pick<DiscordMessageContext, 'isDm' | 'guildId' | 'userId'>, owner: string | undefined): boolean {
  return !!owner && context.isDm && !context.guildId && context.userId === owner;
}
export function browserBusyReply(browser: Pick<BrowserWorkspace, 'status'>): string {
  const state = browser.status() as { status: string; steps: number; mode: string; ai: boolean };
  if (!state.ai) return 'The browser AI is unavailable. Check the browser configuration and try again.';
  if (state.status === 'approval') return 'Your browser task is waiting for input approval at https://doty.killbunny.top/browser. I will send the result here after approval.';
  if (state.mode === 'agent') return `Your browser task is still running (${state.steps} actions). I will send its result here when it finishes.`;
  return 'The browser is finishing another operation. Try again shortly.';
}
export function startDiscordBrowser(task: string, context: DiscordMessageContext, browser: BrowserWorkspace,
  send: DiscordBot['send'], log: (message: string) => void): string {
  browser.start(task, async (update: BrowserUpdate) => {
    try {
      if (update.status === 'completed') {
        if (update.image) {
          const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
          const ext = extensions[update.image.mime];
          if (!ext || !update.image.data.length || update.image.data.length > 10 * 1024 * 1024) throw new Error('Invalid image');
          await send(context.channelId, { content: update.answer || 'Here is the image I found.',
            files: [{ filename: `doty-found-image.${ext}`, mime: update.image.mime, data: update.image.data }] });
        } else await send(context.channelId, update.answer || 'Browser task completed.');
      } else if (update.status === 'approval') {
        await send(context.channelId, 'This browser task needs input approval. Review the next action at https://doty.killbunny.top/browser. I will send the result here after it finishes.');
      } else if (update.status === 'cancelled') await send(context.channelId, 'Browser task stopped because you took control.');
      else await send(context.channelId, update.answer || 'The browser task could not finish. Please try again.');
    } catch { log('discord: browser result delivery failed'); }
  });
  return 'I am checking the web. I will send the result here. You can watch at https://doty.killbunny.top/browser.';
}
