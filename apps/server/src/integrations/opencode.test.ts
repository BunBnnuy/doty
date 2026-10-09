import { describe, expect, it } from 'vitest';
import { extractOpenCodeText, OpenCodeClient, parseOpenCodeModel, promptParts } from './opencode.js';

describe('opencode helpers', () => {
  it('parses provider/model', () => {
    expect(parseOpenCodeModel('opencode-go/deepseek-v4.1-flash'))
      .toEqual({ providerID: 'opencode-go', modelID: 'deepseek-v4.1-flash' });
    expect(parseOpenCodeModel('deepseek-v4.1-flash'))
      .toEqual({ providerID: 'opencode-go', modelID: 'deepseek-v4.1-flash' });
    expect(parseOpenCodeModel('a/b/c')).toEqual({ providerID: 'a', modelID: 'b/c' });
  });

  it('extracts text parts', () => {
    expect(extractOpenCodeText([
      { type: 'step-start' },
      { type: 'text', text: 'hola' },
      { type: 'text', text: 'mundo' },
    ])).toBe('hola\nmundo');
    expect(extractOpenCodeText('nope')).toBe('');
    expect(extractOpenCodeText([{ type: 'text', text: '   ' }])).toBe('');
  });

  it('builds text and file parts, always keeping a text part', () => {
    expect(promptParts('hola')).toEqual([{ type: 'text', text: 'hola' }]);
    expect(promptParts('mira', [
      { mime: 'image/png', dataUrl: 'data:image/png;base64,AAA', filename: 'a.png' },
    ])).toEqual([
      { type: 'text', text: 'mira' },
      { type: 'file', url: 'data:image/png;base64,AAA', mime: 'image/png', filename: 'a.png' },
    ]);
    expect(promptParts('', [])).toEqual([{ type: 'text', text: '' }]);
  });

  it('creates a session and posts a prompt without interactive tools', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fake: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/session')) {
        return new Response(JSON.stringify({ id: 'ses_1' }), { status: 200 });
      }
      return new Response(JSON.stringify({ info: {}, parts: [{ type: 'text', text: 'ok' }] }), { status: 200 });
    };
    const client = new OpenCodeClient({ baseUrl: 'http://x', providerID: 'p', modelID: 'm' }, fake);
    expect(await client.createSession('t')).toBe('ses_1');
    expect(await client.prompt('ses_1', 'hola')).toBe('ok');
    expect(calls[0]?.body).toMatchObject({ model: { id: 'm', providerID: 'p' } });
    expect(calls[1]?.body).toMatchObject({
      parts: [{ type: 'text', text: 'hola' }],
      tools: { question: false },
    });
  });

  it('posts image parts as file parts', async () => {
    let body: unknown;
    const fake: typeof fetch = async (_input, init) => {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return new Response(JSON.stringify({ info: {}, parts: [{ type: 'text', text: 'ok' }] }), { status: 200 });
    };
    const client = new OpenCodeClient({ baseUrl: 'http://x', providerID: 'p', modelID: 'm' }, fake);
    await client.prompt('ses_1', 'mira', undefined, [
      { mime: 'image/png', dataUrl: 'data:image/png;base64,AAA', filename: 'a.png' },
    ]);
    expect(body).toMatchObject({
      parts: [
        { type: 'text', text: 'mira' },
        { type: 'file', url: 'data:image/png;base64,AAA', mime: 'image/png', filename: 'a.png' },
      ],
    });
  });

  it('aborts the session run when a prompt times out', async () => {
    const paths: string[] = [];
    const fake: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : String(input);
      paths.push(new URL(url).pathname);
      if (url.endsWith('/abort')) return new Response('true', { status: 200 });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    };
    const client = new OpenCodeClient({ baseUrl: 'http://x', providerID: 'p', modelID: 'm', timeoutMs: 10 }, fake);
    await expect(client.prompt('ses_1', 'hola')).rejects.toThrow(/timed out/);
    expect(paths).toContain('/session/ses_1/abort');
  });
});
