/**
 * Persistence for connected email accounts. Multiple accounts per provider are
 * allowed; a row is identified by its id and matched by `(provider, account)`.
 *
 * `sealedTokens` is opaque ciphertext produced by `SecretBox` — plaintext
 * tokens never touch this layer. The minimal query surface keeps the Postgres
 * implementation easy to exercise with a fake pool.
 */

import { randomUUID } from 'node:crypto';
import { getTableName } from 'drizzle-orm';
import { Pool } from 'pg';
import { credentials, integrations } from '../../db/schema.js';
import { isEmailProvider, type EmailProvider } from './types.js';

export interface StoredIntegration {
  id: string;
  provider: EmailProvider;
  account: string | undefined;
  scopes: string | undefined;
  status: string;
  /** SecretBox ciphertext of `{ v: 1, refreshToken, scope? }`. */
  sealedTokens: string;
  /** Access-token expiry at last save, epoch ms. */
  tokenExpiresAt: number | undefined;
  updatedAt: Date;
}

export interface UpsertIntegrationInput {
  provider: EmailProvider;
  account: string | undefined;
  scopes: string | undefined;
  sealedTokens: string;
  tokenExpiresAt: number | undefined;
}

export interface IntegrationStore {
  list(): Promise<StoredIntegration[]>;
  get(id: string): Promise<StoredIntegration | undefined>;
  upsert(input: UpsertIntegrationInput): Promise<StoredIntegration>;
  remove(id: string): Promise<boolean>;
  close(): Promise<void>;
}

interface IntegrationJoinRow {
  id: string;
  provider: string;
  account: string | null;
  scopes: string | null;
  status: string;
  secret: string | null;
  expires_at: Date | string | null;
  updated_at: Date | string;
}

export interface PgIntegrationQuery {
  query(sql: string, values?: unknown[]): Promise<{ rows: IntegrationJoinRow[] }>;
  end?(): Promise<void>;
}

const INTEGRATIONS = `"${getTableName(integrations)}"`;
const CREDENTIALS = `"${getTableName(credentials)}"`;
const JOIN_COLUMNS =
  'i.id, i.provider, i.account, i.scopes, i.status, c.secret, c.expires_at, i.updated_at';

function fromRow(row: IntegrationJoinRow): StoredIntegration | undefined {
  if (!isEmailProvider(row.provider)) return undefined;
  const expires = row.expires_at == null ? undefined : new Date(row.expires_at).getTime();
  return {
    id: row.id,
    provider: row.provider,
    account: row.account ?? undefined,
    scopes: row.scopes ?? undefined,
    status: row.status,
    sealedTokens: row.secret ?? '',
    tokenExpiresAt: expires != null && Number.isFinite(expires) ? expires : undefined,
    updatedAt: new Date(row.updated_at),
  };
}

export class PgIntegrationStore implements IntegrationStore {
  readonly #pool: PgIntegrationQuery;

  constructor(connection: string | PgIntegrationQuery) {
    this.#pool = typeof connection === 'string' ? new Pool({ connectionString: connection }) : connection;
  }

  async list(): Promise<StoredIntegration[]> {
    const result = await this.#pool.query(
      `SELECT ${JOIN_COLUMNS} FROM ${INTEGRATIONS} i
       LEFT JOIN ${CREDENTIALS} c ON c.integration_id = i.id AND c.kind = 'oauth_token'
       ORDER BY i.provider ASC, i.account ASC`,
    );
    return result.rows.map(fromRow).filter((row): row is StoredIntegration => row !== undefined);
  }

  async get(id: string): Promise<StoredIntegration | undefined> {
    const result = await this.#pool.query(
      `SELECT ${JOIN_COLUMNS} FROM ${INTEGRATIONS} i
       LEFT JOIN ${CREDENTIALS} c ON c.integration_id = i.id AND c.kind = 'oauth_token'
       WHERE i.id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? fromRow(row) : undefined;
  }

  async upsert(input: UpsertIntegrationInput): Promise<StoredIntegration> {
    // One statement: the credential row only exists alongside its integration.
    const result = await this.#pool.query(
      `WITH upsert_integration AS (
         INSERT INTO ${INTEGRATIONS} (provider, account, scopes, status, updated_at)
         VALUES ($1, $2, $3, 'connected', now())
         ON CONFLICT (provider, account) DO UPDATE SET
           scopes = EXCLUDED.scopes,
           status = 'connected',
           updated_at = now()
         RETURNING id, provider, account, scopes, status, updated_at
       ), upsert_credential AS (
         INSERT INTO ${CREDENTIALS} (integration_id, kind, secret, expires_at, updated_at)
         SELECT id, 'oauth_token', $4, $5, now() FROM upsert_integration
         ON CONFLICT (integration_id) DO UPDATE SET
           secret = EXCLUDED.secret,
           expires_at = EXCLUDED.expires_at,
           updated_at = now()
         RETURNING integration_id, secret, expires_at
       )
       SELECT i.id, i.provider, i.account, i.scopes, i.status, c.secret, c.expires_at, i.updated_at
       FROM upsert_integration i JOIN upsert_credential c ON c.integration_id = i.id`,
      [
        input.provider,
        input.account ?? null,
        input.scopes ?? null,
        input.sealedTokens,
        input.tokenExpiresAt == null ? null : new Date(input.tokenExpiresAt),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Integration upsert returned no row');
    const mapped = fromRow(row);
    if (!mapped) throw new Error('Integration upsert returned an unknown provider');
    return mapped;
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.#pool.query(
      `DELETE FROM ${INTEGRATIONS} WHERE id = $1 RETURNING id`,
      [id],
    );
    return result.rows.length > 0;
  }

  async close(): Promise<void> {
    await this.#pool.end?.();
  }
}

/** Used by tests; the production entrypoint always selects the Postgres store. */
export class InMemoryIntegrationStore implements IntegrationStore {
  readonly #rows = new Map<string, StoredIntegration>();

  async list(): Promise<StoredIntegration[]> {
    return [...this.#rows.values()];
  }

  async get(id: string): Promise<StoredIntegration | undefined> {
    return this.#rows.get(id);
  }

  async upsert(input: UpsertIntegrationInput): Promise<StoredIntegration> {
    const existing = [...this.#rows.values()].find(
      (row) => row.provider === input.provider && row.account === input.account,
    );
    const row: StoredIntegration = {
      id: existing?.id ?? randomUUID(),
      provider: input.provider,
      account: input.account,
      scopes: input.scopes,
      status: 'connected',
      sealedTokens: input.sealedTokens,
      tokenExpiresAt: input.tokenExpiresAt,
      updatedAt: new Date(),
    };
    this.#rows.set(row.id, row);
    return row;
  }

  async remove(id: string): Promise<boolean> {
    return this.#rows.delete(id);
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}
