import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { BrowserWorker, BrowserWorkspace, browserAction, parseDecision, type BrowserTransport } from './workspace.js';
import { OpenCodeClient } from '../integrations/opencode.js';

function worker(): BrowserTransport {
  return { health: vi.fn(async () => ({ ready: true })), screenshot: vi.fn(async () => Buffer.from('png')),
    snapshot: vi.fn(async () => ({ nodes: [{ name: 'Untrusted page' }] })), action: vi.fn(async () => ({ ok: true })) };
}
describe('private browser workspace', () => {
  const dsml = (name: string, parameters: string) => `<||DSML|| calls>\n<||DSML|| invoke name="${name}">\n${parameters}\n</||DSML|| invoke>\n</||DSML|| calls>`.replaceAll('|', '｜');
  const parameter = (name: string, value: string, string = true) => `<||DSML|| parameter name="${name}" string="${string}">${value}</||DSML|| parameter>`;
  it('accepts the exact native DeepSeek search format through the strict action schema', () => {
    expect(parseDecision(dsml('search', parameter('query', 'Tibo reset Codex limits twitter') + parameter('images', 'false', false))))
      .toEqual({ action: 'search', query: 'Tibo reset Codex limits twitter', images: false });
    for (const raw of [dsml('bash', parameter('command', 'whoami')),
      dsml('search', parameter('query', 'one') + parameter('query', 'two')),
      dsml('search', parameter('query', 'one') + parameter('images', 'false')),
      dsml('search', parameter('query', 'one') + parameter('shell', 'true', false)),
      dsml('search', parameter('query', 'one')) + dsml('search', parameter('query', 'two'))]) expect(() => parseDecision(raw)).toThrow();
    expect(parseDecision('{"action":"done","answer":"DSML is a format"}')).toMatchObject({ answer: 'DSML is a format' });
  });
  it('asks for a corrected reply after malformed output without executing it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const transport = worker();
      const model = { createSession: vi.fn(async () => 'private'), abort: vi.fn(async () => {}),
        prompt: vi.fn().mockResolvedValueOnce('I will search now.')
          .mockResolvedValueOnce(dsml('search', parameter('query', 'Tibo reset Codex limits twitter') + parameter('images', 'false', false)))
          .mockResolvedValueOnce('{"action":"done","answer":"Read the search results"}') };
      const browser = new BrowserWorkspace(transport, model);
      browser.start('Find the Tibo post');
      await vi.waitFor(() => expect(browser.status()).toMatchObject({ status: 'completed' }));
      expect(transport.action).toHaveBeenCalledExactlyOnceWith({ action: 'search', query: 'Tibo reset Codex limits twitter', images: false });
      expect(model.prompt.mock.calls[1]?.[1]).toContain('was not executed');
      expect(errors).toHaveBeenCalledTimes(1);
    } finally { errors.mockRestore(); }
  });
  it('stops after three malformed replies without running any action', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const transport = worker();
      const model = { createSession: vi.fn(async () => 'private'), abort: vi.fn(async () => {}), prompt: vi.fn(async () => 'invalid') };
      const browser = new BrowserWorkspace(transport, model);
      browser.start('Read this page');
      await vi.waitFor(() => expect(browser.status()).toMatchObject({ status: 'error' }));
      expect(model.prompt).toHaveBeenCalledTimes(3);
      expect(transport.action).not.toHaveBeenCalled();
    } finally { errors.mockRestore(); }
  });
  it('recovers a temporary page-read failure without repeating input or authentication failures', async () => {
    const calls = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{"error":"CDP_CONTEXT_LOST"}', { status: 503 }))
      .mockResolvedValueOnce(new Response('{"nodes":[{"name":"ready"}]}'));
    const transport = new BrowserWorker('http://127.0.0.1:8890', 'private', calls);
    expect(await transport.snapshot()).toEqual({ nodes: [{ name: 'ready' }] });
    expect(calls).toHaveBeenCalledTimes(2);
    calls.mockReset().mockResolvedValue(new Response('{"error":"CDP_DISCONNECTED"}', { status: 503 }));
    await expect(transport.action({ action: 'click', x: 1, y: 1 })).rejects.toThrow('action failed (CDP_DISCONNECTED)');
    expect(calls).toHaveBeenCalledTimes(1);
    calls.mockReset().mockResolvedValue(new Response('', { status: 401 }));
    await expect(transport.snapshot()).rejects.toThrow('snapshot failed (HTTP_401)');
    expect(calls).toHaveBeenCalledTimes(1);
  });
  it('accepts the live provider reply with extra prose after its validated action', async () => {
    const model = { createSession: vi.fn(async () => 'private'), abort: vi.fn(async () => {}),
      prompt: vi.fn(async () => '{"action":"done","answer":"Heading: \\"Example Domain\\" {sample}"}\n\nThe heading is Example Domain.') };
    const browser = new BrowserWorkspace(worker(), model);
    browser.start('Read the main heading');
    await vi.waitFor(() => expect(browser.status()).toMatchObject({ status: 'completed', answer: 'Heading: "Example Domain" {sample}' }));
  });
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
