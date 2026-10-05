import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nowTool } from '../tools/now.js';
import { OpenAIChatProvider, openAIConfigFromEnv } from './openai.js';
import type { ProviderRequest } from './types.js';

const config = { baseUrl: 'https://provider.invalid/v1/', model: 'mock-model', apiKey: 'test-token-not-a-secret' };

function streamResponse(text: string, chunkSize = 7): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < bytes.length; index += chunkSize) controller.enqueue(bytes.subarray(index, index + chunkSize));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

function frame(delta: unknown, finish_reason: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\r\n\r\n`;
}

describe('OpenAI-compatible streaming provider (fake fetch)', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Real network forbidden'); })));
  afterEach(() => vi.unstubAllGlobals());

  it('streams UTF-8 text and assembles interleaved tool-call fragments', async () => {
    const wire = ': heartbeat\r\n\r\n' +
      frame({ content: 'Héllo 🌍' }) +
      frame({ tool_calls: [
        { index: 1, id: 'call_b', type: 'function', function: { name: 'http_', arguments: '{"url":' } },
        { index: 0, id: 'call_a', type: 'function', function: { name: 'no', arguments: '{' } },
      ] }) +
      frame({ tool_calls: [
        { index: 0, function: { name: 'w', arguments: '}' } },
        { index: 1, function: { name: 'fetch', arguments: '"https://example.com"}' } },
      ] }) + frame({}, 'tool_calls') + 'data: [DONE]\r\n\r\n';
    const fakeFetch = vi.fn<typeof fetch>(async () => streamResponse(wire, 1));
    const delta = vi.fn();
    const provider = new OpenAIChatProvider(config, fakeFetch);
    const result = await provider.complete({
      messages: [{ role: 'system', content: 'Persona' }, { role: 'user', content: 'Task' }],
      tools: [{ name: nowTool.name, description: nowTool.description, parameters: nowTool.parameters }],
      onDelta: delta,
    });
    expect(result).toEqual({ role: 'assistant', content: 'Héllo 🌍', toolCalls: [
      { id: 'call_a', name: 'now', arguments: '{}' },
      { id: 'call_b', name: 'http_fetch', arguments: '{"url":"https://example.com"}' },
    ] });
    expect(delta).toHaveBeenCalledWith('Héllo 🌍');
    expect(fakeFetch.mock.calls[0]?.[0]).toBe('https://provider.invalid/v1/chat/completions');
    const init = fakeFetch.mock.calls[0]![1]!;
    expect(init.redirect).toBe('error');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-token-not-a-secret' });
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'mock-model', stream: true, tool_choice: 'auto' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends tool observations in the OpenAI wire shape and accepts a final answer', async () => {
    const fakeFetch = vi.fn<typeof fetch>(async () => streamResponse(
      frame({ content: 'Done' }) + frame({}, 'stop') + 'data: [DONE]\n\n',
    ));
    const provider = new OpenAIChatProvider({ ...config, apiKey: undefined }, fakeFetch);
    const request: ProviderRequest = { messages: [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'now', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', content: '{"ok":true}' },
    ], tools: [] };
    expect(await provider.complete(request)).toEqual({ role: 'assistant', content: 'Done' });
    const init = fakeFetch.mock.calls[0]![1]!;
    const body = JSON.parse(init.body as string);
    expect(body.messages).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'now', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
    ]);
    expect(body).not.toHaveProperty('tools');
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it.each([
    [frame({ content: 'Partial' }), 'prematurely'],
    ['data: not JSON\n\n', 'invalid SSE JSON'],
    [frame({}, 'length') + 'data: [DONE]\n\n', 'length'],
    [frame({ tool_calls: [{ index: 0, function: { name: 'now', arguments: '{}' } }] }, 'tool_calls'), 'incomplete tool call'],
    [frame({ tool_calls: [{ index: -1 }] }, 'tool_calls'), 'invalid tool index'],
    ['data: {"error":{"message":"upstream error"}}\n\n', 'stream error'],
  ])('rejects malformed or incomplete upstream streams', async (wire, error) => {
    const provider = new OpenAIChatProvider(config, async () => streamResponse(wire));
    await expect(provider.complete({ messages: [], tools: [] })).rejects.toThrow(error);
  });

  it('reports only status for HTTP errors, never upstream bodies', async () => {
    const provider = new OpenAIChatProvider(config, async () => new Response('private upstream error', { status: 401 }));
    await expect(provider.complete({ messages: [], tools: [] })).rejects.toThrow('Chat provider HTTP 401');
  });

  it('loads env without requiring it at import time and rejects embedded credentials', () => {
    expect(openAIConfigFromEnv({ OPENAI_MODEL: ' test ', OPENAI_BASE_URL: 'https://provider.invalid/v1' })).toMatchObject({
      model: 'test', baseUrl: 'https://provider.invalid/v1',
    });
    expect(() => openAIConfigFromEnv({})).toThrow('OPENAI_MODEL');
    expect(() => new OpenAIChatProvider({ ...config, baseUrl: 'https://user:password@provider.invalid' })).toThrow('credentials');
  });
});
