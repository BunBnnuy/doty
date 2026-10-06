/**
 * Email integration service: OAuth connect URLs, callbacks, token refresh and
 * read-only mailbox access, provider-agnostic.
 *
 * The desktop (or a curl on the server) asks for a connect URL; the browser
 * completes consent; the callback stores the sealed refresh token; every read
 * path refreshes short-lived access tokens in memory and persists rotations.
 * Tokens are never returned to callers or written outside the encrypted store.
 */

import { randomUUID } from 'node:crypto';
import { SecretBox, secretBoxFromEnv } from './crypto.js';
import {
  GmailClient,
  googleAccountEmail,
  googleAuthUrl,
  googleExchangeCode,
  googleRefreshToken,
  type GoogleConfig,
} from './google.js';
import {
  GraphClient,
  microsoftAccountEmail,
  microsoftAuthUrl,
  microsoftExchangeCode,
  microsoftRefreshToken,
  type MicrosoftConfig,
} from './microsoft.js';
import { PgIntegrationStore, type IntegrationStore, type StoredIntegration } from './store.js';
import {
  EMAIL_PROVIDERS,
  type EmailClient,
  type EmailListOptions,
  type EmailMessage,
  type EmailProvider,
  type EmailSummary,
  type IntegrationStatus,
  type OAuthTokens,
} from './types.js';

export class NotConfiguredError extends Error {
  readonly code = 'not_configured';
  constructor(readonly provider: string) {
    super(`Provider ${provider} is not configured on the server`);
  }
}

export class NotConnectedError extends Error {
  readonly code = 'not_connected';
  constructor(readonly provider: string) {
    super(`No ${provider} account is connected`);
  }
}

export class InvalidStateError extends Error {
  readonly code = 'invalid_state';
  constructor() {
    super('The OAuth state is missing, expired or forged');
  }
}

export class AmbiguousProviderError extends Error {
  readonly code = 'ambiguous_provider';
  constructor(readonly providers: EmailProvider[]) {
    super(`More than one account is connected (${providers.join(', ')}); specify a provider`);
  }
}

/** Refresh an access token a minute before it actually expires. */
const ACCESS_TOKEN_MARGIN_MS = 60_000;

interface ProviderHandle {
  authUrl(state: string): string;
  exchange(code: string): Promise<OAuthTokens>;
  refresh(refreshToken: string): Promise<OAuthTokens>;
  accountEmail(accessToken: string): Promise<string | undefined>;
  client(accessToken: string): EmailClient;
}

export interface EmailServiceOptions {
  store: IntegrationStore;
  box: SecretBox;
  google?: GoogleConfig;
  microsoft?: MicrosoftConfig;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class EmailService {
  readonly #store: IntegrationStore;
  readonly #box: SecretBox;
  readonly #now: () => number;
  readonly #handles = new Map<EmailProvider, ProviderHandle>();
  readonly #tokens = new Map<EmailProvider, { accessToken: string; expiresAt: number }>();

  constructor(options: EmailServiceOptions) {
    this.#store = options.store;
    this.#box = options.box;
    this.#now = options.now ?? (() => Date.now());
    const fetchImpl = options.fetchImpl ?? fetch;

    if (options.google) {
      const config = options.google;
      this.#handles.set('google', {
        authUrl: (state) => googleAuthUrl(config, state),
        exchange: (code) => googleExchangeCode(config, code, fetchImpl),
        refresh: (refreshToken) => googleRefreshToken(config, refreshToken, fetchImpl),
        accountEmail: (accessToken) => googleAccountEmail(accessToken, fetchImpl),
        client: (accessToken) => new GmailClient(accessToken, fetchImpl),
      });
    }
    if (options.microsoft) {
      const config = options.microsoft;
      this.#handles.set('microsoft', {
        authUrl: (state) => microsoftAuthUrl(config, state),
        exchange: (code) => microsoftExchangeCode(config, code, fetchImpl),
        refresh: (refreshToken) => microsoftRefreshToken(config, refreshToken, fetchImpl),
        accountEmail: (accessToken) => microsoftAccountEmail(accessToken, fetchImpl),
        client: (accessToken) => new GraphClient(accessToken, fetchImpl),
      });
    }
  }

  configuredProviders(): EmailProvider[] {
    return [...this.#handles.keys()];
  }

  async statuses(): Promise<IntegrationStatus[]> {
    const rows = await this.#store.list();
    const byProvider = new Map(rows.map((row) => [row.provider, row]));
    return EMAIL_PROVIDERS.map((provider) => {
      const row = byProvider.get(provider);
      return {
        provider,
        configured: this.#handles.has(provider),
        connected: Boolean(row),
        ...(row?.account ? { account: row.account } : {}),
        ...(row?.scopes ? { scopes: row.scopes } : {}),
      };
    });
  }

  /** Signed authorize URL; the caller opens it in a browser (desktop/system). */
  connectUrl(provider: EmailProvider): string {
    const handle = this.#handle(provider);
    const state = this.#box.signState({ provider, nonce: randomUUID() }, this.#now());
    return handle.authUrl(state);
  }

  async handleCallback(
    provider: EmailProvider,
    code: string,
    state: string,
  ): Promise<{ account?: string }> {
    const handle = this.#handle(provider);
    const payload = this.#box.verifyState(state, this.#now());
    if (!payload || payload.provider !== provider) throw new InvalidStateError();
    const tokens = await handle.exchange(code);
    const account = await handle.accountEmail(tokens.accessToken).catch(() => undefined);
    await this.#persist(provider, tokens, account);
    return account ? { account } : {};
  }

  async disconnect(provider: EmailProvider): Promise<boolean> {
    this.#tokens.delete(provider);
    return this.#store.remove(provider);
  }

  async list(provider: EmailProvider | undefined, options: EmailListOptions): Promise<EmailSummary[]> {
    const resolved = await this.#resolveProvider(provider);
    const { handle, accessToken } = await this.#accessToken(resolved);
    return handle.client(accessToken).list(options);
  }

  async read(provider: EmailProvider | undefined, id: string): Promise<EmailMessage> {
    const resolved = await this.#resolveProvider(provider);
    const { handle, accessToken } = await this.#accessToken(resolved);
    return handle.client(accessToken).read(id);
  }

  async close(): Promise<void> {
    await this.#store.close();
  }

  #handle(provider: EmailProvider): ProviderHandle {
    const handle = this.#handles.get(provider);
    if (!handle) throw new NotConfiguredError(provider);
    return handle;
  }

  /** Without an explicit provider, pick the only connected account. */
  async #resolveProvider(provider: EmailProvider | undefined): Promise<EmailProvider> {
    if (provider) return provider;
    const rows = await this.#store.list();
    if (rows.length === 1 && rows[0]) return rows[0].provider;
    if (rows.length === 0) throw new NotConnectedError('email');
    throw new AmbiguousProviderError(rows.map((row) => row.provider));
  }

  async #accessToken(
    provider: EmailProvider,
  ): Promise<{ handle: ProviderHandle; accessToken: string }> {
    const handle = this.#handle(provider);
    const cached = this.#tokens.get(provider);
    if (cached && cached.expiresAt - ACCESS_TOKEN_MARGIN_MS > this.#now()) {
      return { handle, accessToken: cached.accessToken };
    }

    const row = await this.#store.get(provider);
    if (!row) throw new NotConnectedError(provider);
    const stored = this.#readSealed(row);
    if (!stored.refreshToken) throw new NotConnectedError(provider);

    const refreshed = await handle.refresh(stored.refreshToken);
    await this.#persist(provider, refreshed, row.account);
    return { handle, accessToken: refreshed.accessToken };
  }

  async #persist(
    provider: EmailProvider,
    tokens: OAuthTokens,
    account: string | undefined,
  ): Promise<void> {
    const existing = await this.#store.get(provider);
    const previous = existing ? this.#readSealed(existing) : undefined;
    const refreshToken = tokens.refreshToken ?? previous?.refreshToken;
    if (!refreshToken) throw new Error(`${provider} did not return a refresh token`);
    const scope = tokens.scope ?? previous?.scope;

    const sealedTokens = this.#box.encrypt(
      JSON.stringify({ v: 1, refreshToken, ...(scope ? { scope } : {}) }),
    );
    await this.#store.upsert({
      provider,
      account: account ?? existing?.account,
      scopes: scope ?? existing?.scopes,
      sealedTokens,
      tokenExpiresAt: tokens.expiresAt,
    });
    this.#tokens.set(provider, { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt });
  }

  #readSealed(row: StoredIntegration): { refreshToken?: string; scope?: string } {
    try {
      const parsed = JSON.parse(this.#box.decrypt(row.sealedTokens)) as {
        refreshToken?: unknown;
        scope?: unknown;
      };
      return {
        ...(typeof parsed.refreshToken === 'string' ? { refreshToken: parsed.refreshToken } : {}),
        ...(typeof parsed.scope === 'string' ? { scope: parsed.scope } : {}),
      };
    } catch {
      // A row that cannot be decrypted behaves like a disconnected account.
      return {};
    }
  }
}

/**
 * Build the service from the environment. Disabled (undefined) unless Postgres
 * and the encryption key exist; each provider is independently optional so the
 * server can boot before both OAuth apps are registered.
 */
export function createEmailServiceFromEnv(env: NodeJS.ProcessEnv = process.env): EmailService | undefined {
  const databaseUrl = env.DATABASE_URL?.trim();
  const box = secretBoxFromEnv(env);
  if (!databaseUrl || !box) return undefined;

  const publicUrl = (env.DOTY_PUBLIC_URL?.trim() || 'https://doty.killbunny.top').replace(/\/+$/, '');
  const googleClientId = env.GOOGLE_CLIENT_ID?.trim();
  const googleClientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  const microsoftClientId = env.MICROSOFT_CLIENT_ID?.trim();
  const microsoftClientSecret = env.MICROSOFT_CLIENT_SECRET?.trim();
  const microsoftTenantId = env.MICROSOFT_TENANT_ID?.trim() || 'common';

  return new EmailService({
    store: new PgIntegrationStore(databaseUrl),
    box,
    ...(googleClientId && googleClientSecret
      ? {
          google: {
            clientId: googleClientId,
            clientSecret: googleClientSecret,
            redirectUri: `${publicUrl}/integrations/google/callback`,
          },
        }
      : {}),
    ...(microsoftClientId && microsoftClientSecret
      ? {
          microsoft: {
            clientId: microsoftClientId,
            clientSecret: microsoftClientSecret,
            tenantId: microsoftTenantId,
            redirectUri: `${publicUrl}/integrations/microsoft/callback`,
          },
        }
      : {}),
  });
}
