import { createHash } from 'node:crypto';
import { normalizeEmbedding } from './store.js';

export interface Embedder {
  readonly model: string;
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
}

export interface EmbeddingConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
}

export function embeddingConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig {
  const model = env.OPENAI_EMBED_MODEL?.trim();
  if (!model) throw new Error('OPENAI_EMBED_MODEL is required to enable embeddings');
  return { model, baseUrl: env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1', apiKey: env.OPENAI_API_KEY };
}

export class OpenAIEmbedder implements Embedder {
  readonly model: string;

  constructor(private readonly config: EmbeddingConfig, private readonly fetchImpl: typeof fetch = fetch) {
    const url = new URL(config.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Embedding base URL must be HTTP(S) without credentials, query, or fragment');
    }
    if (!config.model.trim()) throw new Error('Embedding model is required');
    // Include the endpoint because two providers can use the same model name.
    this.model = `${config.baseUrl.replace(/\/+$/, '')}#${config.model}`;
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    if (!text.trim()) throw new Error('Embedding text is required');
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(this.config.timeoutMs ?? 15000);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
    const response = await this.fetchImpl(`${this.config.baseUrl.replace(/\/+$/, '')}/embeddings`, {
      method: 'POST', headers, redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      body: JSON.stringify({ model: this.config.model, input: text, encoding_format: 'float' }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Embedding provider HTTP ${response.status}`);
    }
    let body: unknown;
    try { body = await response.json(); } catch { throw new Error('Embedding provider returned invalid JSON'); }
    const data = (body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data) || data.length !== 1 || data[0]?.index !== 0) {
      throw new Error('Embedding provider returned invalid data');
    }
    return normalizeEmbedding(data[0].embedding);
  }
}

/** Deterministic token hashing for offline tests; this is not a semantic model. */
export class MockEmbedder implements Embedder {
  readonly model = 'mock-token-hash-v1';

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    signal?.throwIfAborted();
    if (!text.trim()) throw new Error('Embedding text is required');
    const vector = Array<number>(64).fill(0);
    for (const token of text.toLowerCase().match(/\p{L}+|\p{N}+/gu) ?? [text]) {
      const hash = createHash('sha256').update(token).digest();
      const index = hash.readUInt32LE(0) % vector.length;
      vector[index] = vector[index]! + 1;
    }
    return normalizeEmbedding(vector);
  }
}
