import { getTableName } from 'drizzle-orm';
import { Pool } from 'pg';
import { memories } from '../db/schema.js';
import { memoryLimit, normalizeEmbedding, validateMemory, validateScope,
  type MemoryInput, type MemoryMatch, type MemoryQuery, type MemoryStore, type StoredMemory } from './store.js';

interface MemoryRow {
  id: string; dot_id: string; kind: string; content: string; created_at: Date | string;
  similarity?: number | string;
}
export interface PgMemoryQuery {
  query(sql: string, values?: unknown[]): Promise<{ rows: MemoryRow[] }>;
  end?(): Promise<void>;
}
const TABLE = `"${getTableName(memories)}"`;
const COLUMNS = 'id, dot_id, kind, content, created_at';
function fromRow(row: MemoryRow): StoredMemory {
  return { id: row.id, dotId: row.dot_id, kind: row.kind, text: row.content, createdAt: new Date(row.created_at) };
}

export class PgMemoryStore implements MemoryStore {
  readonly #pool: PgMemoryQuery;
  constructor(connection: string | PgMemoryQuery) {
    this.#pool = typeof connection === 'string' ? new Pool({ connectionString: connection }) : connection;
  }

  async store(input: MemoryInput): Promise<StoredMemory> {
    validateMemory(input);
    const embedding = normalizeEmbedding(input.embedding);
    const result = await this.#pool.query(
      `INSERT INTO ${TABLE} (dot_id, kind, content, embedding, embedding_model)
       VALUES ($1, $2, $3, $4::vector, $5) RETURNING ${COLUMNS}`,
      [input.dotId, input.kind, input.text, JSON.stringify(embedding), input.embeddingModel],
    );
    if (!result.rows[0]) throw new Error('Memory insert returned no row');
    return fromRow(result.rows[0]);
  }

  async search(query: MemoryQuery): Promise<MemoryMatch[]> {
    validateScope(query.dotId, query.embeddingModel);
    const limit = memoryLimit(query.topK);
    const embedding = normalizeEmbedding(query.embedding);
    const result = await this.#pool.query(
      `SELECT ${COLUMNS}, CASE WHEN vector_dims(embedding) = $4
         THEN 1 - (embedding <=> $2::vector) END AS similarity
       FROM ${TABLE} WHERE dot_id = $1 AND embedding_model = $3
         AND embedding IS NOT NULL AND vector_dims(embedding) = $4
       ORDER BY similarity DESC NULLS LAST, created_at ASC, id ASC LIMIT $5`,
      [query.dotId, JSON.stringify(embedding), query.embeddingModel, embedding.length, limit],
    );
    return result.rows.filter((row) => row.similarity != null && Number.isFinite(Number(row.similarity)))
      .map((row) => ({ ...fromRow(row), similarity: Math.max(-1, Math.min(1, Number(row.similarity))) }));
  }

  async close(): Promise<void> { await this.#pool.end?.(); }
}

/** No automatic fallback: local tests inject InMemoryMemoryStore explicitly. */
export function memoryStoreFromEnv(env: NodeJS.ProcessEnv = process.env): PgMemoryStore | undefined {
  const url = env.DATABASE_URL?.trim();
  return url ? new PgMemoryStore(url) : undefined;
}
