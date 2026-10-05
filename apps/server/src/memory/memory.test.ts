import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { runAgent } from '../agent/loop.js';
import { InMemoryEventLog } from '../events/log.js';
import type { ChatProvider, ProviderRequest } from '../provider/types.js';
import { ToolRegistry } from '../tools/registry.js';
import { AgentMemory, InMemoryMemoryStore, MockEmbedder, OpenAIEmbedder, PgMemoryStore,
  embeddingConfigFromEnv, memoryStoreFromEnv, normalizeEmbedding, type PgMemoryQuery } from './index.js';

describe('memory (no network or live Postgres)', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden'); })));
  afterEach(() => vi.unstubAllGlobals());

  it('retrieves top-k by cosine, with dot, model, and dimension isolation', async () => {
    const store = new InMemoryMemoryStore();
    const input = { dotId: 'dot-a', kind: 'preference', text: 'First', embeddingModel: 'model-a' };
    await store.store({ ...input, embedding: [3, 0] });
    await store.store({ ...input, text: 'Second', embedding: [1, 1] });
    await store.store({ ...input, text: 'Opposite', embedding: [-1, 0] });
    await store.store({ ...input, dotId: 'dot-b', embedding: [1, 0] });
    await store.store({ ...input, embeddingModel: 'model-b', embedding: [1, 0] });
    await store.store({ ...input, embedding: [1, 0, 0] });
    const query = { dotId: 'dot-a', embeddingModel: 'model-a', embedding: [7, 0], topK: 2 };
    const matches = await store.search(query);
    expect(matches.map((match) => match.text)).toEqual(['First', 'Second']);
    expect(matches[0]?.similarity).toBeCloseTo(1);
    expect(matches[1]?.similarity).toBeCloseTo(Math.SQRT1_2);
    expect((await store.search({ ...query, topK: 3 }))[2]?.similarity).toBeCloseTo(-1);
    expect(await store.search({ ...query, dotId: 'absent' })).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('copies stored vectors and returned dates, and validates bad inputs', async () => {
    const store = new InMemoryMemoryStore();
    const embedding = [1, 0];
    const input = { dotId: 'dot', kind: 'fact', text: 'Keep me', embeddingModel: 'model', embedding };
    const saved = await store.store(input);
    const createdAt = saved.createdAt.getTime();
    embedding[0] = -1;
    saved.createdAt.setTime(0);
    const [match] = await store.search({ ...input, embedding: [1, 0] });
    expect(match?.similarity).toBeCloseTo(1);
    expect(match?.createdAt.getTime()).toBe(createdAt);
    for (const vector of [[], [0, 0], [NaN], [Infinity], ['1'], Array(2)]) {
      expect(() => normalizeEmbedding(vector)).toThrow('Embedding');
    }
    for (const component of normalizeEmbedding([Number.MAX_VALUE, Number.MAX_VALUE])) {
      expect(component).toBeCloseTo(Math.SQRT1_2);
    }
    for (const topK of [0, -1, 1.5, 101]) await expect(store.search({ ...input, topK })).rejects.toThrow('topK');
    await expect(store.store({ ...input, text: ' ' })).rejects.toThrow('text');
    await expect(store.store({ ...input, dotId: '' })).rejects.toThrow('dotId');
  });

  it('stores kind and text through the deterministic embedder', async () => {
    const embedder = new MockEmbedder();
    expect(await embedder.embed('Tea green')).toEqual(await embedder.embed('green TEA'));
    const store = new InMemoryMemoryStore();
    const memory = new AgentMemory({ store, embedder, dotId: 'dot', topK: 1 });
    await memory.remember('preference', 'green tea');
    await memory.remember('fact', 'typescript compiler');
    expect(await memory.retrieve('green tea')).toEqual([
      expect.objectContaining({ dotId: 'dot', kind: 'preference', text: 'green tea', similarity: expect.closeTo(1) }),
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('injects memories before history through the app runtime without automatic writes', async () => {
    const store = new InMemoryMemoryStore();
    const memory = new AgentMemory({ store, embedder: new MockEmbedder(), dotId: 'dot', topK: 1 });
    await memory.remember('preference', 'green tea');
    const requests: ProviderRequest[] = [];
    const provider: ChatProvider = { complete: async (request) => {
      requests.push(request);
      return { role: 'assistant', content: 'Done' };
    } };
    const { app, log } = buildApp({ token: '', agent: { provider, memory, persona: 'Persona' } });
    const finished = new Promise<void>((resolve) => {
      const unsubscribe = log.subscribe((event) => {
        if (event.type === 'run_finished') { unsubscribe(); resolve(); }
      });
    });
    try {
      expect((await app.inject({ method: 'POST', url: '/message', payload: { text: 'green tea' } })).statusCode).toBe(202);
      await finished;
      expect(requests[0]?.messages[0]).toEqual({ role: 'system', content: 'Persona' });
      expect(requests[0]?.messages[1]?.content).toContain('untrusted reference data');
      expect(requests[0]?.messages[1]?.content).toContain('green tea');
      expect(requests[0]?.messages[2]).toEqual({ role: 'user', content: 'green tea' });
      expect(await store.search({ dotId: 'dot', embeddingModel: 'mock-token-hash-v1', embedding: [1, ...Array<number>(63).fill(0)] })).toHaveLength(1);
    } finally { await app.close(); }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves context for empty/disabled memory, tolerates failure, and respects cancellation', async () => {
    const provider: ChatProvider = { complete: vi.fn<ChatProvider['complete']>(async () => ({ role: 'assistant', content: 'Done' })) };
    const base = { provider, log: new InMemoryEventLog(), tools: new ToolRegistry(), task: 'Task', persona: 'Persona',
      history: [{ role: 'user' as const, content: 'History' }] };
    const disabled = await runAgent(base);
    const empty = new AgentMemory({ store: new InMemoryMemoryStore(), embedder: new MockEmbedder(), dotId: 'dot' });
    expect((await runAgent({ ...base, memory: empty })).messages).toEqual(disabled.messages);
    const failed = new AgentMemory({ store: new InMemoryMemoryStore(), dotId: 'dot', embedder: {
      model: 'fail', embed: async () => { throw new Error('private provider detail'); },
    } });
    expect((await runAgent({ ...base, memory: failed })).status).toBe('completed');
    expect(base.log.since(0).some((event) => event.type === 'memory_unavailable')).toBe(true);
    expect(JSON.stringify(base.log.since(0))).not.toContain('private provider detail');
    const controller = new AbortController();
    controller.abort();
    const complete = vi.fn<ChatProvider['complete']>(async () => ({ role: 'assistant', content: 'Done' }));
    expect((await runAgent({ ...base, provider: { complete }, memory: empty, signal: controller.signal })).status).toBe('error');
    expect(complete).not.toHaveBeenCalled();
  });

  it('uses parameterized pgvector SQL and closes an injected pool', async () => {
    const row = { id: 'id', dot_id: 'dot', kind: 'fact', content: 'Text', created_at: new Date(), similarity: '0.9' };
    const query = vi.fn<PgMemoryQuery['query']>(async () => ({ rows: [row] }));
    const end = vi.fn(async () => undefined);
    const store = new PgMemoryStore({ query, end });
    await store.store({ dotId: 'dot', kind: 'fact', text: 'Text', embedding: [1, 0], embeddingModel: 'model' });
    expect(query.mock.calls[0]?.[0]).toContain('$4::vector');
    expect(query.mock.calls[0]?.[1]).toEqual(['dot', 'fact', 'Text', '[1,0]', 'model']);
    expect(await store.search({ dotId: 'dot', embedding: [1, 0], embeddingModel: 'model', topK: 2 }))
      .toEqual([expect.objectContaining({ text: 'Text', similarity: 0.9 })]);
    expect(query.mock.calls[1]?.[0]).toContain('embedding <=> $2::vector');
    expect(query.mock.calls[1]?.[0]).toContain('CASE WHEN vector_dims(embedding) = $4');
    expect(query.mock.calls[1]?.[1]).toEqual(['dot', '[1,0]', 'model', 2, 2]);
    await store.close();
    expect(end).toHaveBeenCalledOnce();
    expect(memoryStoreFromEnv({})).toBeUndefined();
    expect(memoryStoreFromEnv({ DATABASE_URL: ' ' })).toBeUndefined();
    const configured = memoryStoreFromEnv({ DATABASE_URL: 'postgres://unused.invalid/doty' });
    expect(configured).toBeInstanceOf(PgMemoryStore);
    await configured?.close(); // Pool construction/close does not open a connection.
  });

  it('calls the embeddings endpoint with fake fetch and reads env configuration', async () => {
    const fake = vi.fn<typeof fetch>(async () => Response.json({ data: [{ index: 0, embedding: [3, 4] }] }));
    const config = embeddingConfigFromEnv({ OPENAI_EMBED_MODEL: ' embed ', OPENAI_BASE_URL: 'https://provider.invalid/v1/', OPENAI_API_KEY: 'test-token' });
    const embedder = new OpenAIEmbedder(config, fake);
    expect(await embedder.embed('Text')).toEqual([0.6, 0.8]);
    const [url, init] = fake.mock.calls[0]!;
    expect(url).toBe('https://provider.invalid/v1/embeddings');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer test-token' } });
    expect(JSON.parse(init!.body as string)).toEqual({ model: 'embed', input: 'Text', encoding_format: 'float' });
    expect(() => embeddingConfigFromEnv({})).toThrow('OPENAI_EMBED_MODEL');
    expect(() => new OpenAIEmbedder({ ...config, baseUrl: 'https://user:pass@provider.invalid' })).toThrow('credentials');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects bad provider responses without exposing upstream error bodies', async () => {
    const config = { baseUrl: 'https://provider.invalid/v1', model: 'embed' };
    for (const body of [{}, { data: [{ index: 0, embedding: [0] }] }, { data: [{ index: 0, embedding: ['1'] }] }]) {
      await expect(new OpenAIEmbedder(config, async () => Response.json(body)).embed('Text')).rejects.toThrow();
    }
    await expect(new OpenAIEmbedder(config, async () => new Response('private detail', { status: 401 })).embed('Text'))
      .rejects.toThrow('Embedding provider HTTP 401');
    await expect(new OpenAIEmbedder(config, async () => new Response('bad json')).embed('Text')).rejects.toThrow('invalid JSON');
    const fake = vi.fn<typeof fetch>();
    const controller = new AbortController();
    controller.abort();
    await expect(new OpenAIEmbedder(config, fake).embed('Text', controller.signal)).rejects.toThrow();
    expect(fake).not.toHaveBeenCalled();
  });
});
