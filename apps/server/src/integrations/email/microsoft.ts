/**
 * Microsoft identity platform OAuth (read-only) + Microsoft Graph mail client.
 *
 * Works with a single-tenant institutional app (`tenantId` = the directory ID)
 * or `common`/`organizations`. Delegated scopes are `offline_access`,
 * `User.Read` and `Mail.Read`: reading the signed-in user's mailbox and
 * nothing else. Microsoft rotates refresh tokens on every refresh, so callers
 * must always persist what comes back.
 */

import { clip, htmlToText } from './text.js';
import {
  EMAIL_BODY_LIMIT,
  type EmailAddress,
  type EmailClient,
  type EmailListOptions,
  type EmailMessage,
  type EmailSummary,
  type OAuthTokens,
} from './types.js';

export interface MicrosoftConfig {
  clientId: string;
  clientSecret: string;
  /** Directory (tenant) ID, `common` or `organizations`. */
  tenantId: string;
  redirectUri: string;
}

export const MICROSOFT_SCOPES = ['offline_access', 'User.Read', 'Mail.Read'] as const;

const GRAPH_API = 'https://graph.microsoft.com/v1.0';
const LIST_SELECT = 'id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead';
const READ_SELECT = 'id,subject,from,toRecipients,receivedDateTime,body,isRead';

function tokenEndpoint(tenantId: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
}

export function microsoftAuthUrl(config: MicrosoftConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: config.redirectUri,
    response_mode: 'query',
    scope: MICROSOFT_SCOPES.join(' '),
    // Show the account chooser so multiple mailboxes can be connected.
    prompt: 'select_account',
    state,
  });
  return `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/authorize?${params.toString()}`;
}

export async function microsoftExchangeCode(
  config: MicrosoftConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokens> {
  return microsoftToken(
    config,
    { grant_type: 'authorization_code', code, redirect_uri: config.redirectUri },
    fetchImpl,
  );
}

export async function microsoftRefreshToken(
  config: MicrosoftConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokens> {
  const tokens = await microsoftToken(
    config,
    { grant_type: 'refresh_token', refresh_token: refreshToken },
    fetchImpl,
  );
  // Rotated refresh tokens must be saved; keep the previous one only if absent.
  return tokens.refreshToken ? tokens : { ...tokens, refreshToken };
}

async function microsoftToken(
  config: MicrosoftConfig,
  fields: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<OAuthTokens> {
  const response = await fetchImpl(tokenEndpoint(config.tenantId), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: MICROSOFT_SCOPES.join(' '),
      ...fields,
    }).toString(),
  });
  if (!response.ok) throw new Error(`Microsoft token HTTP ${response.status}`);
  const body = (await response.json()) as Record<string, unknown>;
  const accessToken = typeof body.access_token === 'string' ? body.access_token : undefined;
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : Number(body.expires_in);
  if (!accessToken || !Number.isFinite(expiresIn)) {
    throw new Error('Microsoft token response is missing required fields');
  }
  return {
    accessToken,
    ...(typeof body.refresh_token === 'string' && body.refresh_token
      ? { refreshToken: body.refresh_token }
      : {}),
    expiresAt: Date.now() + expiresIn * 1000,
    ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
  };
}

export async function microsoftAccountEmail(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const response = await fetchImpl(`${GRAPH_API}/me?$select=mail,userPrincipalName`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return undefined;
  const body = (await response.json()) as { mail?: unknown; userPrincipalName?: unknown };
  if (typeof body.mail === 'string' && body.mail) return body.mail;
  if (typeof body.userPrincipalName === 'string' && body.userPrincipalName.includes('@')) {
    return body.userPrincipalName;
  }
  return undefined;
}

interface GraphEmailAddress {
  name?: string;
  address?: string;
}

interface GraphMessage {
  id?: string;
  subject?: string;
  from?: { emailAddress?: GraphEmailAddress };
  toRecipients?: Array<{ emailAddress?: GraphEmailAddress }>;
  receivedDateTime?: string;
  bodyPreview?: string;
  isRead?: boolean;
  body?: { contentType?: string; content?: string };
}

export class GraphClient implements EmailClient {
  constructor(
    private readonly accessToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async list(options: EmailListOptions): Promise<EmailSummary[]> {
    const params = new URLSearchParams({ $select: LIST_SELECT, $top: String(options.limit) });
    const filters: string[] = [];
    if (options.since !== undefined) {
      filters.push(`receivedDateTime ge ${new Date(options.since).toISOString()}`);
    }
    if (options.until !== undefined) {
      filters.push(`receivedDateTime lt ${new Date(options.until).toISOString()}`);
    }
    if (filters.length > 0) params.set('$filter', filters.join(' and '));
    const query = options.query?.trim();
    if (query) params.set('$search', `"${query.replace(/"/g, ' ')}"`);
    else params.set('$orderby', 'receivedDateTime desc');

    const response = await this.fetchImpl(`${GRAPH_API}/me/messages?${params.toString()}`, {
      headers: this.#headers(),
    });
    if (!response.ok) throw new Error(`Graph list HTTP ${response.status}`);
    const body = (await response.json()) as { value?: GraphMessage[] };
    return (body.value ?? []).filter((message) => typeof message?.id === 'string').map(toSummary);
  }

  async read(id: string): Promise<EmailMessage> {
    const params = new URLSearchParams({ $select: READ_SELECT });
    const response = await this.fetchImpl(
      `${GRAPH_API}/me/messages/${encodeURIComponent(id)}?${params.toString()}`,
      { headers: this.#headers() },
    );
    if (!response.ok) throw new Error(`Graph read HTTP ${response.status}`);
    const message = (await response.json()) as GraphMessage;
    const raw = message.body?.content ?? '';
    const text = message.body?.contentType === 'html' ? htmlToText(raw) : raw;
    return { ...toSummary(message), body: clip(text.trim(), EMAIL_BODY_LIMIT) };
  }

  #headers(): Record<string, string> {
    return { authorization: `Bearer ${this.accessToken}` };
  }
}

function toSummary(message: GraphMessage): EmailSummary {
  const from = toAddress(message.from?.emailAddress);
  return {
    id: message.id ?? '',
    provider: 'microsoft',
    subject: message.subject?.trim() || '(no subject)',
    ...(from ? { from } : {}),
    to: (message.toRecipients ?? [])
      .map((recipient) => toAddress(recipient?.emailAddress))
      .filter((address): address is EmailAddress => address !== undefined),
    date: message.receivedDateTime ?? '',
    snippet: message.bodyPreview ?? '',
    ...(message.isRead === false ? { unread: true } : {}),
  };
}

function toAddress(value: GraphEmailAddress | undefined): EmailAddress | undefined {
  if (!value?.address) return undefined;
  return { ...(value.name ? { name: value.name } : {}), address: value.address };
}
