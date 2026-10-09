/** Explicit live check used by the deploy script; never exports page content. */
import { BrowserWorker, BrowserWorkspace } from './workspace.js';
import { OpenCodeClient, parseOpenCodeModel } from '../integrations/opencode.js';
import { BROWSER_REPLY_INSTRUCTION, parseBrowserRequest } from '../integrations/browser-discord.js';
import { IMAGE_REPLY_INSTRUCTION } from '../integrations/codex-images.js';
import type { BrowserImage } from './workspace.js';

const token = process.env.BROWSER_WORKER_TOKEN;
if (!token) throw new Error('Browser smoke requires runtime authentication');
const worker = new BrowserWorker('http://127.0.0.1:8890', token);
const model = parseOpenCodeModel(process.env.BROWSER_MODEL || 'opencode-go/deepseek-v4.1-flash');
if (model.providerID === 'openai' || /^(gpt-|codex|o\d)/i.test(model.modelID)) throw new Error('Use Codex CLI for OpenAI models');
const client = new OpenCodeClient({ baseUrl: 'http://127.0.0.1:4096', ...model, restricted: true, timeoutMs: 90_000 });
const browser = new BrowserWorkspace(worker, client);
try {
  browser.start('Open https://example.org and report its main heading and that exact source URL. Do not click or type.');
  let passed = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    const state = browser.status() as { status: string; answer?: string };
    if (state.status === 'completed') {
      const page = await worker.snapshot() as { url?: string };
      if (!page.url?.startsWith('https://example.org') || !state.answer?.includes('Example Domain') || !state.answer.includes('https://example.org'))
        throw new Error('Browser AI smoke result did not match the real page');
      passed = true; break;
    }
    if (state.status === 'error' || state.status === 'approval') throw new Error('Browser AI smoke did not complete a read-only task');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!passed) throw new Error('Browser AI smoke timed out');
  console.log('browser AI smoke: restricted vision planner navigated and read the real page');
  const routerSession = await client.createSession('Doty Discord browser routing smoke');
  const routed = parseBrowserRequest(await client.prompt(routerSession,
    `${IMAGE_REPLY_INSTRUCTION}\n${BROWSER_REPLY_INSTRUCTION}\nUser message:\nbusca el meme de goldship y sus papas`));
  if (!routed || !/gold\s*ship/i.test(routed)) throw new Error('Natural Discord meme request did not route to the browser');
  console.log('browser Discord smoke: the exact Gold Ship request routes to existing-image search');
  let delivered: BrowserImage | undefined;
  browser.start('Open https://www.python.org and send the existing official Python logo from the page. Use image_id, do not generate an image or click.',
    async update => { if (update.status === 'completed') delivered = update.image; });
  for (let attempt = 0; attempt < 120; attempt++) {
    const state = browser.status() as { status: string };
    if (state.status === 'completed') break;
    if (state.status === 'error' || state.status === 'approval') throw new Error('Existing-image browser smoke failed');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!delivered || delivered.mime !== 'image/png' || delivered.data.length < 500) throw new Error('Existing image did not reach the completion callback');
  console.log('browser image smoke: vision planner selected an existing image and delivered real PNG bytes');
  await worker.action({ action: 'search', query: 'goldship y sus papas meme', images: true });
  let imageResults = false;
  for (let attempt = 0; attempt < 15; attempt++) {
    const page = await worker.snapshot() as { images?: { title?: string }[] };
    if (page.images?.some(image => /gold\s*ship/i.test(image.title || ''))) { imageResults = true; break; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!imageResults) throw new Error('Live image search did not expose matching Gold Ship candidates');
  console.log('browser search smoke: live Gold Ship image candidates are available to the planner');
} finally { browser.close(); }
