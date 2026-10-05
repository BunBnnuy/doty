import { randomUUID } from 'node:crypto';

export interface MemoryInput {
  dotId: string;
  kind: string;
  text: string;
  embedding: readonly number[];
  /** Identifies the vector space; change this when the provider/model changes. */
  embeddingModel: string;
}

export interface StoredMemory {
  id: string;
  dotId: string;
  kind: string;
  text: string;
  createdAt: Date;
}

export interface MemoryMatch extends StoredMemory { similarity: number }
export interface MemoryQuery {
  dotId: string;
  embedding: readonly number[];
  embeddingModel: string;
  topK?: number;
}

export interface MemoryStore {
  store(memory: MemoryInput): Promise<StoredMemory>;
  search(query: MemoryQuery): Promise<MemoryMatch[]>;
}

/** Normalize safely, even for very small or large finite components. */
export function normalizeEmbedding(value: unknown): number[] {
  if (!Array.isArray(value) || !value.length || value.length > 16000 ||
      Array.from(value).some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    throw new Error('Embedding must contain 1 to 16000 finite numbers');
  }
  const scale = Math.max(...value.map((item: number) => Math.abs(item)));
  if (scale === 0) throw new Error('Embedding must have nonzero magnitude');
  const scaled = value.map((item: number) => item / scale);
  const norm = Math.hypot(...scaled);
  return scaled.map((item) => item / norm);
}

export function memoryLimit(topK = 5): number {
  if (!Number.isInteger(topK) || topK < 1 || topK > 100) {
    throw new Error('topK must be an integer from 1 to 100');
  }
  return topK;
}

export function validateScope(dotId: string, embeddingModel: string): void {
  if (!dotId.trim() || !embeddingModel.trim()) throw new Error('dotId and embeddingModel are required');
}

export function validateMemory(memory: MemoryInput): void {
  validateScope(memory.dotId, memory.embeddingModel);
  if (!memory.kind.trim() || !memory.text.trim()) throw new Error('Memory kind and text are required');
}

/** Test/local store. Inputs and outputs are copied so callers cannot change stored data. */
export class InMemoryMemoryStore implements MemoryStore {
  readonly #rows: Array<StoredMemory & { embedding: number[]; embeddingModel: string }> = [];

  async store(input: MemoryInput): Promise<StoredMemory> {
    validateMemory(input);
    const embedding = normalizeEmbedding(input.embedding);
    const row = { id: randomUUID(), dotId: input.dotId, kind: input.kind, text: input.text,
      createdAt: new Date(), embedding, embeddingModel: input.embeddingModel };
    this.#rows.push(row);
    return this.copy(row);
  }

  async search(query: MemoryQuery): Promise<MemoryMatch[]> {
    validateScope(query.dotId, query.embeddingModel);
    const limit = memoryLimit(query.topK);
    const embedding = normalizeEmbedding(query.embedding);
    return this.#rows.filter((row) => row.dotId === query.dotId &&
      row.embeddingModel === query.embeddingModel && row.embedding.length === embedding.length)
      .map((row) => ({ ...this.copy(row), similarity: Math.max(-1, Math.min(1,
        row.embedding.reduce((sum, component, index) => sum + component * embedding[index]!, 0))) }))
      .sort((a, b) => b.similarity - a.similarity || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, limit);
  }

  private copy(row: StoredMemory): StoredMemory {
    return { id: row.id, dotId: row.dotId, kind: row.kind, text: row.text, createdAt: new Date(row.createdAt) };
  }
}
