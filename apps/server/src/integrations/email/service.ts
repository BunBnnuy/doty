/**
 * Email integration service: OAuth connect URLs, callbacks, token refresh and
 * read-only mailbox access, provider-agnostic.
 *
 * Multiple accounts per provider are supported. Each connected mailbox is an
 * `integration` row; callers select one by email address or integration id.
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
  isEmailProvider,
  type EmailClient,
  type EmailListOptions,
  type EmailMessage,
  type EmailProvider,
  type EmailSelector,
  type EmailSummary,
  type IntegrationOverview,
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
  constructor(readonly target: string) {
    super(target === 'email' ? 'No email account is connected' : `No connected account matches "${target}"`);
  }
}

export class InvalidStateError extends Error {
  readonly code = 'invalid_state';
  constructor() {
    super('The OAuth state is missing, expired or forged');
  }
}

export class AmbiguousAccountError extends Error {
  readonly code = 'ambiguous_account';
  constructor(readonly accounts: string[]) {
    super(`More than one account matches (${accounts.join(', ')}); specify an account`);
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
  readonly #tokens = new Map<string, { accessToken: string; expiresAt: number }>();

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

  async statuses(): Promise<IntegrationOverview> {
    const rows = await this.#store.list();
    return {
      providers: EMAIL_PROVIDERS.map((provider) => ({
        provider,
        configured: this.#handles.has(provider),
        accounts: rows.filter((row) => row.provider === provider && row.account).length,
      })),
      accounts: rows
        .filter((row) => Boolean(row.account))
        .map((row) => ({
          id: row.id,
          provider: row.provider,
          account: row.account ?? '',
          ...(row.scopes ? { scopes: row.scopes } : {}),
        })),
    };
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
  ): Promise<{ account: string; id: string }> {
    const handle = this.#handle(provider);
    const payload = this.#box.verifyState(state, this.#now());
    if (!payload || payload.provider !== provider) throw new InvalidStateError();
    const tokens = await handle.exchange(code);
    const account = await handle.accountEmail(tokens.accessToken);
    if (!account) throw new Error('Could not determine the account email from the provider');
    const row = await this.#persist(provider, account, tokens);
    return { account, id: row.id };
  }

  /**
   * Disconnect one mailbox: accepts an integration id, or a provider name when
   * exactly one account of that provider is connected.
   */
  async disconnect(target: string): Promise<boolean> {
    const rows = await this.#store.list();

    const byId = rows.find((row) => row.id === target);
    if (byId) return this.#removeOne(byId);

    if (!isEmailProvider(target)) return false;
    const matches = rows.filter((row) => row.provider === target);
    if (matches.length === 0) return false;
    if (matches.length > 1) {
      throw new AmbiguousAccountError(matches.map((row) => row.account ?? row.id));
    }
    const single = matches[0];
    return single ? this.#removeOne(single) : false;
  }

  async list(selector: EmailSelector, options: EmailListOptions): Promise<EmailSummary[]> {
    const row = await this.#resolve(selector);
    const { handle, accessToken } = await this.#accessToken(row);
    return handle.client(accessToken).list(options);
  }

  async read(selector: EmailSelector, id: string): Promise<EmailMessage> {
    const row = await this.#resolve(selector);
    const { handle, accessToken } = await this.#accessToken(row);
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

  async #removeOne(row: StoredIntegration): Promise<boolean> {
    this.#tokens.delete(row.id);
    return this.#store.remove(row.id);
  }

  /** Resolve a selector to one connected mailbox, or fail with a clear error. */
  async #resolve(selector: EmailSelector): Promise<StoredIntegration> {
    const rows = await this.#store.list();
    if (rows.length === 0) throw new NotConnectedError('email');

    if (selector.account) {
      const needle = selector.account.trim().toLowerCase();
      const matches = rows.filter(
        (row) => row.id === selector.account || row.account?.toLowerCase() === needle,
      );
      if (matches.length === 0) throw new NotConnectedError(selector.account);
      const account = matches[0];
      if (matches.length === 1 && account) return account;
      throw new AmbiguousAccountError(matches.map((row) => row.account ?? row.id));
    }

    if (selector.provider) {
      const matches = rows.filter((row) => row.provider === selector.provider);
      if (matches.length === 0) throw new NotConnectedError(selector.provider);
      const account = matches[0];
      if (matches.length === 1 && account) return account;
      throw new AmbiguousAccountError(matches.map((row) => row.account ?? row.id));
    }

    const only = rows[0];
    if (rows.length === 1 && only) return only;
    throw new AmbiguousAccountError(rows.map((row) => row.account ?? row.id));
  }

  async #accessToken(
    row: StoredIntegration,
  ): Promise<{ handle: ProviderHandle; accessToken: string }> {
    const handle = this.#handle(row.provider);
    const cached = this.#tokens.get(row.id);
    if (cached && cached.expiresAt - ACCESS_TOKEN_MARGIN_MS > this.#now()) {
      return { handle, accessToken: cached.accessToken };
    }

    if (!row.account) throw new Error('Stored integration has no account email');
    const stored = this.#readSealed(row);
    if (!stored.refreshToken) throw new NotConnectedError(row.account);

    const refreshed = await handle.refresh(stored.refreshToken);
    await this.#persist(row.provider, row.account, refreshed);
    return { handle, accessToken: refreshed.accessToken };
  }

  async #persist(
    provider: EmailProvider,
    account: string,
    tokens: OAuthTokens,
  ): Promise<StoredIntegration> {
    const rows = await this.#store.list();
    const existing = rows.find(
      (row) => row.provider === provider && row.account?.toLowerCase() === account.toLowerCase(),
    );
    const previous = existing ? this.#readSealed(existing) : undefined;
    const refreshToken = tokens.refreshToken ?? previous?.refreshToken;
    if (!refreshToken) throw new Error(`${provider} did not return a refresh token`);
    const scope = tokens.scope ?? previous?.scope;

    const sealedTokens = this.#box.encrypt(
      JSON.stringify({ v: 1, refreshToken, ...(scope ? { scope } : {}) }),
    );
    const row = await this.#store.upsert({
      provider,
      account,
      scopes: scope ?? existing?.scopes,
      sealedTokens,
      tokenExpiresAt: tokens.expiresAt,
    });
    this.#tokens.set(row.id, { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt });
    return row;
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
