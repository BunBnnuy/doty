/** Explicit live check used by the deploy script; never exports page content. */
import { BrowserWorker, BrowserWorkspace } from './workspace.js';
import { OpenCodeClient, parseOpenCodeModel } from '../integrations/opencode.js';

const token = process.env.BROWSER_WORKER_TOKEN;
if (!token) throw new Error('Browser smoke requires runtime authentication');
const worker = new BrowserWorker('http://127.0.0.1:8890', token);
const model = parseOpenCodeModel(process.env.BROWSER_MODEL || 'opencode-go/deepseek-v4.1-flash');
if (model.providerID === 'openai' || /^(gpt-|codex|o\d)/i.test(model.modelID)) throw new Error('Use Codex CLI for OpenAI models');
const browser = new BrowserWorkspace(worker, new OpenCodeClient({ baseUrl: 'http://127.0.0.1:4096', ...model,
  restricted: true, timeoutMs: 90_000 }));
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
} finally { browser.close(); }
