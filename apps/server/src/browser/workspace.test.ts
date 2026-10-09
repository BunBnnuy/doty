import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { BrowserWorkspace, browserAction, type BrowserTransport } from './workspace.js';
import { OpenCodeClient } from '../integrations/opencode.js';

function worker(): BrowserTransport {
  return { health: vi.fn(async () => ({ ready: true })), screenshot: vi.fn(async () => Buffer.from('png')),
    snapshot: vi.fn(async () => ({ nodes: [{ name: 'Untrusted page' }] })), action: vi.fn(async () => ({ ok: true })) };
}
describe('private browser workspace', () => {
  it('requires auth even when the main API has no token, and never writes page content to shared events', async () => {
    for (const token of ['', 'owner']) {
      const browser = new BrowserWorkspace(worker());
      const { app, log } = buildApp({ token, browser });
      try {
        expect((await app.inject('/browser')).statusCode).toBe(200);
        expect((await app.inject('/browser/screenshot')).statusCode).toBe(401);
        const status = await app.inject({ url: '/browser/status', headers: { authorization: 'Bearer owner' } });
        expect(status.statusCode).toBe(token ? 200 : 401);
        expect(log.since(0)).toEqual([]);
      } finally { await app.close(); }
    }
  });
  it('does not execute AI input until the owner approves it', async () => {
    const transport = worker();
    const model = { createSession: vi.fn(async () => 'private'), abort: vi.fn(async () => {}),
      prompt: vi.fn().mockResolvedValueOnce('{"action":"click","x":10,"y":20}')
        .mockResolvedValueOnce('{"action":"done","answer":"Complete"}') };
    const browser = new BrowserWorkspace(transport, model);
    browser.start('Read this site');
    await vi.waitFor(() => expect(browser.status()).toMatchObject({ status: 'approval' }));
    expect(transport.action).not.toHaveBeenCalled();
    await expect(browser.manual({ action: 'wait' })).rejects.toThrow();
    browser.approve();
    await vi.waitFor(() => expect(browser.status()).toMatchObject({ status: 'completed', answer: 'Complete' }));
    expect(transport.action).toHaveBeenCalledExactlyOnceWith({ action: 'click', x: 10, y: 20 });
  });
  it('takeover prevents a late model answer from running an action', async () => {
    let complete!: (answer: string) => void;
    const transport = worker();
    const model = { createSession: vi.fn(async () => 'private'), abort: vi.fn(async () => {}),
      prompt: vi.fn(() => new Promise<string>(resolve => { complete = resolve; })) };
    const browser = new BrowserWorkspace(transport, model);
    browser.start('Read this site');
    await vi.waitFor(() => expect(model.prompt).toHaveBeenCalled());
    browser.takeControl(); complete('{"action":"navigate","url":"https://example.com"}');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(transport.action).not.toHaveBeenCalled();
    expect(browser.status()).toMatchObject({ mode: 'human', status: 'idle' });
  });
  it('blocks invalid schemes, shell-like keys, and coordinates outside the screen', () => {
    for (const input of [{ action: 'navigate', url: 'file:///etc/passwd' }, { action: 'navigate', url: 'https://name:pass@example.com' },
      { action: 'click', x: 1280, y: 0 }, { action: 'key', key: 'ctrl+alt+t' }, { action: 'type', text: 'x', shell: true }]) {
      expect(browserAction.safeParse(input).success).toBe(false);
    }
  });
  it('denies all host and MCP tools for browser planning', async () => {
    const calls: unknown[] = [];
    const fake: typeof fetch = async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: 's', parts: [{ type: 'text', text: '{}' }] }));
    };
    const client = new OpenCodeClient({ baseUrl: 'http://localhost', providerID: 'p', modelID: 'm', restricted: true }, fake);
    await client.createSession(); await client.prompt('s', 'task');
    expect(calls[0]).toMatchObject({ permission: [{ permission: '*', pattern: '*', action: 'deny' }] });
    expect(calls[1]).toMatchObject({ tools: { '*': false, bash: false, question: false } });
  });
});
