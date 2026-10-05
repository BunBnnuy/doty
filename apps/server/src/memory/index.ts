import type { Embedder } from './embedder.js';
import { memoryLimit, validateScope, type MemoryStore, type MemoryMatch, type StoredMemory } from './store.js';

export interface AgentMemoryOptions {
  store: MemoryStore;
  embedder: Embedder;
  dotId: string;
  topK?: number;
}

/** Store only explicitly supplied memories. Never copy transcripts or tool output automatically. */
export class AgentMemory {
  constructor(private readonly options: AgentMemoryOptions) {
    validateScope(options.dotId, options.embedder.model);
    memoryLimit(options.topK);
  }

  async remember(kind: string, text: string, signal?: AbortSignal): Promise<StoredMemory> {
    if (!kind.trim() || !text.trim()) throw new Error('Memory kind and text are required');
    const embedding = await this.options.embedder.embed(text, signal);
    signal?.throwIfAborted();
    return this.options.store.store({ dotId: this.options.dotId, kind, text, embedding,
      embeddingModel: this.options.embedder.model });
  }

  async retrieve(text: string, signal?: AbortSignal): Promise<MemoryMatch[]> {
    const embedding = await this.options.embedder.embed(text, signal);
    signal?.throwIfAborted();
    return this.options.store.search({ dotId: this.options.dotId, embedding,
      embeddingModel: this.options.embedder.model, topK: this.options.topK });
  }
}

export * from './store.js';
export * from './embedder.js';
export * from './pg-store.js';
