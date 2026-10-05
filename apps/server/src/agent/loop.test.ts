import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '@doty/protocol';
import { buildApp } from '../app.js';
import { InMemoryEventLog } from '../events/log.js';
import type { ChatMessage, ChatProvider, ProviderRequest } from '../provider/types.js';
import { ToolRegistry } from '../tools/registry.js';
import { nowTool } from '../tools/now.js';
import type { Tool } from '../tools/types.js';
import { runAgent, MAX_OBSERVATION_CHARS } from './loop.js';

type Assistant = Extract<ChatMessage, { role: 'assistant' }>;
const call: Assistant = { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'now', arguments: '{}' }] };

class MockProvider implements ChatProvider {
  readonly requests: ProviderRequest[] = [];
  constructor(private readonly replies: readonly Assistant[]) {}
  async complete(request: ProviderRequest): Promise<Assistant> {
    this.requests.push(request);
    const reply = this.replies[this.requests.length - 1];
    if (!reply) throw new Error('Unexpected model turn');
    if (reply.content) request.onDelta?.(reply.content);
    return reply;
  }
}

describe('agent loop (mock provider, no network)', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network access forbidden in tests'); })));
  afterEach(() => vi.unstubAllGlobals());

  it('performs tool call → observation → final and fans out ordered ServerEvents', async () => {
    const log = new InMemoryEventLog();
    const live: ServerEvent[] = [];
    log.subscribe((event) => live.push(event));
    const provider = new MockProvider([call, { role: 'assistant', content: 'The time is available.' }]);
    const tools = new ToolRegistry([nowTool]);
    const result = await runAgent({ task: 'What time is it?', persona: 'Test persona', provider, tools, log, runId: 'test-run' });

    expect(result.status).toBe('completed');
    expect(result.steps).toBe(2);
    expect(result.answer).toBe('The time is available.');
    expect(provider.requests[0]?.messages).toEqual([
      { role: 'system', content: 'Test persona' }, { role: 'user', content: 'What time is it?' },
    ]);
    expect(provider.requests[1]?.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'call_1' });
    const observation = JSON.parse(provider.requests[1]!.messages.at(-1)!.content);
    expect(observation).toMatchObject({ ok: true, result: { ts: expect.any(Number), iso: expect.any(String) } });
    expect(live).toEqual(log.since(0));
    expect(live.map((event) => event.seq)).toEqual(live.map((_, index) => index + 1));
    expect(live.map((event) => event.type)).toEqual([
      'run_started', 'dot_state', 'model_step', 'assistant_message', 'tool_call',
      'policy_decision', 'dot_state', 'observation', 'dot_state', 'model_step',
      'assistant_delta', 'assistant_message', 'final', 'dot_state', 'run_finished',
    ]);
    expect(live.every((event) => (event.data as { runId: string }).runId === 'test-run')).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('truncates a large tool observation before it reaches the model', async () => {
    const huge: Tool = {
      name: 'huge',
      description: 'returns a large result',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      tier: 'read',
      async run() { return { blob: 'x'.repeat(50_000) }; },
    };
    const hugeCall: Assistant = { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'huge', arguments: '{}' }] };
    const provider = new MockProvider([hugeCall, { role: 'assistant', content: 'ok' }]);
    const log = new InMemoryEventLog();
    const result = await runAgent({ task: 'go', provider, tools: new ToolRegistry([huge]), log });
    expect(result.status).toBe('completed');
    const toolMessage = provider.requests[1]!.messages.at(-1)!;
    expect(toolMessage.content.length).toBeLessThanOrEqual(MAX_OBSERVATION_CHARS + 40);
    const event = log.since(0).find((item) => item.type === 'observation');
    expect((event?.data as { observation: { truncated?: boolean } }).observation.truncated).toBe(true);
  });

  it('stops at the step limit and ends with max_steps when the wrap-up has no answer', async () => {
    const provider = new MockProvider([call, call, call]);
    const log = new InMemoryEventLog();
    const result = await runAgent({ task: 'Keep going', provider, tools: new ToolRegistry([nowTool]), log, maxSteps: 2 });
    expect(result).toMatchObject({ status: 'max_steps', steps: 2 });
    expect(provider.requests).toHaveLength(3); // 2 steps + one tool-free wrap-up
    expect(provider.requests[2]?.tools).toEqual([]);
    expect(log.since(0).filter((event) => event.type === 'observation')).toHaveLength(2);
    expect(log.since(0).some((event) => event.type === 'final')).toBe(false);
    expect(log.since(0).at(-1)).toMatchObject({ type: 'run_finished', data: { status: 'max_steps' } });
  });

  it('answers from the wrap-up turn when the step limit is reached', async () => {
    const provider = new MockProvider([call, call, { role: 'assistant', content: 'Here is what I found.' }]);
    const log = new InMemoryEventLog();
    const result = await runAgent({ task: 'Keep going', provider, tools: new ToolRegistry([nowTool]), log, maxSteps: 2 });
    expect(result).toMatchObject({ status: 'completed', answer: 'Here is what I found.' });
    expect(log.since(0).at(-1)).toMatchObject({ type: 'run_finished', data: { status: 'completed' } });
  });

  it('pauses before a side effect and leaves later tool calls unexecuted', async () => {
    const run = vi.fn(async () => 'must not execute');
    const tool: Tool = { ...nowTool, name: 'artifact_write', tier: 'side-effecting', run };
    const provider = new MockProvider([{ role: 'assistant', content: '', toolCalls: [
      { id: 'write', name: 'artifact_write', arguments: '{"name":"test.txt","content":"hi"}' },
      { id: 'later', name: 'artifact_write', arguments: '{}' },
    ] }]);
    const log = new InMemoryEventLog();
    const result = await runAgent({ task: 'Write a file', provider, tools: new ToolRegistry([tool]), log });
    expect(result.status).toBe('requires_approval');
    expect(result.pendingToolCalls).toHaveLength(2);
    expect(run).not.toHaveBeenCalled();
    expect(provider.requests).toHaveLength(1);
    expect(log.since(0).find((event) => event.type === 'policy_decision')).toMatchObject({
      data: { tier: 'side-effecting', decision: 'requires_approval' },
    });
    expect(log.since(0).find((event) => event.type === 'dot_state' &&
      (event.data as { state: { activity: string } }).state.activity === 'waiting_approval')).toBeDefined();
  });

  it('denies dangerous/unclassified tools and returns malformed args as observations', async () => {
    const run = vi.fn(async () => 'must not execute');
    const { tier: _tier, ...unclassified } = nowTool;
    const provider = new MockProvider([{ role: 'assistant', content: '', toolCalls: [
      { id: 'bad', name: 'now', arguments: '[' },
      { id: 'danger', name: 'now', arguments: '{}' },
      { id: 'unknown', name: 'missing', arguments: '{}' },
    ] }, { role: 'assistant', content: 'Cannot execute those actions.' }]);
    const log = new InMemoryEventLog();
    const result = await runAgent({ task: 'Test failures', provider, tools: new ToolRegistry([{ ...unclassified, run }]), log });
    expect(result.status).toBe('completed');
    expect(run).not.toHaveBeenCalled();
    expect(result.messages.filter((message) => message.role === 'tool')).toHaveLength(3);
    expect(log.since(0).filter((event) => event.type === 'policy_decision')).toHaveLength(2);
  });

  it('appends history before the task, reports provider errors, and rejects invalid limits', async () => {
    const provider: ChatProvider = { complete: vi.fn(async () => { throw new Error('Mock provider failed'); }) };
    const log = new InMemoryEventLog();
    const options = { task: 'Task', provider, tools: new ToolRegistry(), log };
    const result = await runAgent({ ...options, history: [{ role: 'user', content: 'Earlier turn' }] });
    expect(result.messages[1]).toEqual({ role: 'user', content: 'Earlier turn' });
    expect(result).toMatchObject({ status: 'error', error: 'Mock provider failed' });
    expect(log.since(0).at(-1)).toMatchObject({ type: 'run_finished', data: { status: 'error' } });
    await expect(runAgent({ ...options, maxSteps: 0 })).rejects.toThrow('maxSteps');
  });

  it('starts a background run through /message using the same replayable SSE log', async () => {
    const provider = new MockProvider([call, { role: 'assistant', content: 'Finished' }]);
    const { app, log } = buildApp({ agent: { provider, tools: new ToolRegistry([nowTool]) } });
    const finished = new Promise<ServerEvent>((resolve) => {
      const unsubscribe = log.subscribe((event) => {
        if (event.type === 'run_finished') { unsubscribe(); resolve(event); }
      });
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/message', payload: { text: 'Get the time' } });
      expect(response.statusCode).toBe(202);
      const body = response.json<{ runId: string }>();
      expect(await finished).toMatchObject({ data: { runId: body.runId, status: 'completed' } });
      expect(log.since(0)[0]?.type).toBe('message');
      expect(log.since(0).find((event) => event.type === 'final')).toMatchObject({ data: { text: 'Finished' } });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
