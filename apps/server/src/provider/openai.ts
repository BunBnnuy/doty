import type { ChatMessage, ChatProvider, ProviderRequest, ToolCall } from './types.js';

export interface OpenAIConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
  /** Sent as User-Agent; OpenCode Go asks clients to identify themselves. */
  userAgent?: string;
  /** Sent as x-opencode-session so the gateway can route and cache. */
  sessionId?: string;
}

export function openAIConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OpenAIConfig {
  const model = env.OPENAI_MODEL?.trim();
  if (!model) throw new Error('OPENAI_MODEL is required to enable the agent');
  return {
    baseUrl: env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1',
    apiKey: env.OPENAI_API_KEY,
    model,
    userAgent: env.OPENAI_USER_AGENT?.trim() || 'doty/0.1',
    sessionId: env.OPENAI_SESSION_ID?.trim() || 'doty-default',
  };
}

function wireMessage(message: ChatMessage): unknown {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

/** Parse SSE across arbitrary byte boundaries, including CRLF and multiline data. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // A bounded frame prevents a malformed upstream from growing memory forever.
      if (buffer.length + data.join('\n').length > 2_000_000) {
        throw new Error('Provider SSE frame is too large');
      }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line === '') {
          if (data.length) yield data.join('\n');
          data = [];
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        }
      }
      if (done) {
        if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, '').replace(/\r$/, ''));
        if (data.length) yield data.join('\n');
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

interface Chunk {
  error?: unknown;
  choices?: Array<{
    index?: number;
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
}

export class OpenAIChatProvider implements ChatProvider {
  constructor(
    private readonly config: OpenAIConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const url = new URL(config.baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('OPENAI_BASE_URL must be an HTTP(S) URL without embedded credentials');
    }
    if (!config.model.trim()) throw new Error('OPENAI_MODEL is required');
  }

  async complete(request: ProviderRequest): Promise<Extract<ChatMessage, { role: 'assistant' }>> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs ?? 60_000);
    const signal = request.signal ? AbortSignal.any([timeout, request.signal]) : timeout;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
    headers['User-Agent'] = this.config.userAgent ?? 'doty/0.1';
    headers['x-opencode-session'] = this.config.sessionId ?? 'doty-default';
    const response = await this.fetchImpl(`${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      signal,
      // Never forward an Authorization header through an upstream redirect.
      redirect: 'error',
      body: JSON.stringify({
        model: this.config.model,
        stream: true,
        messages: request.messages.map(wireMessage),
        ...(request.tools.length ? {
          tools: request.tools.map((tool) => ({ type: 'function', function: tool })),
          tool_choice: 'auto',
        } : {}),
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      // Do not expose upstream response bodies: they can contain credentials.
      throw new Error(`Chat provider HTTP ${response.status}`);
    }
    if (!response.body) throw new Error('Chat provider returned no stream');

    let content = '';
    let finishReason: string | undefined;
    const calls = new Map<number, ToolCall>();
    for await (const data of sseData(response.body)) {
      if (data === '[DONE]') break;
      let chunk: Chunk;
      try {
        chunk = JSON.parse(data) as Chunk;
      } catch {
        throw new Error('Chat provider returned invalid SSE JSON');
      }
      if (!chunk || chunk.error) throw new Error('Chat provider reported a stream error');
      const choice = chunk.choices?.find((item) => item.index === 0 || item.index === undefined);
      if (!choice) continue; // Usage-only frames have no choice.
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (typeof delta?.content === 'string') {
        content += delta.content;
        request.onDelta?.(delta.content);
      }
      for (const fragment of delta?.tool_calls ?? []) {
        if (!Number.isInteger(fragment.index) || fragment.index < 0 || fragment.index > 127) {
          throw new Error('Chat provider returned an invalid tool index');
        }
        if (fragment.type && fragment.type !== 'function') throw new Error('Unsupported provider tool type');
        const call = calls.get(fragment.index) ?? { id: '', name: '', arguments: '' };
        if (fragment.id) call.id += fragment.id;
        if (fragment.function?.name) call.name += fragment.function.name;
        if (fragment.function?.arguments) call.arguments += fragment.function.arguments;
        calls.set(fragment.index, call);
      }
      if (content.length + [...calls.values()].reduce((sum, call) => sum + call.arguments.length, 0) > 2_000_000) {
        throw new Error('Chat provider output is too large');
      }
    }
    if (finishReason !== 'stop' && finishReason !== 'tool_calls') {
      throw new Error(finishReason ? `Chat provider stopped: ${finishReason}` : 'Chat provider stream ended prematurely');
    }
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    if (toolCalls.some((call) => !call.id || !call.name) || (finishReason === 'tool_calls' && !toolCalls.length)) {
      throw new Error('Chat provider returned an incomplete tool call');
    }
    return { role: 'assistant', content, ...(toolCalls.length ? { toolCalls } : {}) };
  }
}
