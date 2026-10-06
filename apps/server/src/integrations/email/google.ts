/**
 * Google OAuth (read-only) + Gmail API client.
 *
 * Scope is `gmail.readonly`: the app can list, search and read messages and
 * nothing else. The authorization request always asks for offline access with
 * `prompt=consent` so a refresh token is returned even on reconnects.
 */

import { clip, decodeBase64Url, htmlToText } from './text.js';
import {
  EMAIL_BODY_LIMIT,
  type EmailAddress,
  type EmailClient,
  type EmailListOptions,
  type EmailMessage,
  type EmailSummary,
  type OAuthTokens,
} from './types.js';

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
] as const;

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export function googleAuthUrl(config: GoogleConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export async function googleExchangeCode(
  config: GoogleConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokens> {
  return googleToken(
    config,
    { grant_type: 'authorization_code', code, redirect_uri: config.redirectUri },
    fetchImpl,
  );
}

export async function googleRefreshToken(
  config: GoogleConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokens> {
  const tokens = await googleToken(
    config,
    { grant_type: 'refresh_token', refresh_token: refreshToken },
    fetchImpl,
  );
  // Google only returns a refresh token on the consent exchange; keep the old one.
  return tokens.refreshToken ? tokens : { ...tokens, refreshToken };
}

async function googleToken(
  config: GoogleConfig,
  fields: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<OAuthTokens> {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      ...fields,
    }).toString(),
  });
  if (!response.ok) throw new Error(`Google token HTTP ${response.status}`);
  const body = (await response.json()) as Record<string, unknown>;
  const accessToken = typeof body.access_token === 'string' ? body.access_token : undefined;
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : Number(body.expires_in);
  if (!accessToken || !Number.isFinite(expiresIn)) {
    throw new Error('Google token response is missing required fields');
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

export async function googleAccountEmail(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const response = await fetchImpl(USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return undefined;
  const body = (await response.json()) as { email?: unknown };
  return typeof body.email === 'string' && body.email ? body.email : undefined;
}

interface GmailPart {
  mimeType?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { data?: string };
  parts?: GmailPart[];
}

interface GmailMessage {
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

export class GmailClient implements EmailClient {
  constructor(
    private readonly accessToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async list(options: EmailListOptions): Promise<EmailSummary[]> {
    const params = new URLSearchParams({ maxResults: String(options.limit) });
    const query = options.query?.trim();
    if (query) params.set('q', query);
    const response = await this.fetchImpl(`${GMAIL_API}/messages?${params.toString()}`, {
      headers: this.#headers(),
    });
    if (!response.ok) throw new Error(`Gmail list HTTP ${response.status}`);
    const body = (await response.json()) as { messages?: Array<{ id?: unknown }> };
    const ids = (body.messages ?? [])
      .map((message) => message?.id)
      .filter((id): id is string => typeof id === 'string');

    const summaries: EmailSummary[] = [];
    for (const id of ids) summaries.push(await this.#summary(id));
    return summaries;
  }

  async read(id: string): Promise<EmailMessage> {
    const params = new URLSearchParams({ format: 'full' });
    const response = await this.fetchImpl(
      `${GMAIL_API}/messages/${encodeURIComponent(id)}?${params.toString()}`,
      { headers: this.#headers() },
    );
    if (!response.ok) throw new Error(`Gmail read HTTP ${response.status}`);
    const message = (await response.json()) as GmailMessage;
    const body = extractBodyText(message);
    return {
      ...toSummary(message, id),
      body: clip(body.trim(), EMAIL_BODY_LIMIT),
    };
  }

  async #summary(id: string): Promise<EmailSummary> {
    const params = new URLSearchParams({ format: 'metadata' });
    for (const headerName of ['Subject', 'From', 'To', 'Date']) {
      params.append('metadataHeaders', headerName);
    }
    const response = await this.fetchImpl(
      `${GMAIL_API}/messages/${encodeURIComponent(id)}?${params.toString()}`,
      { headers: this.#headers() },
    );
    if (!response.ok) throw new Error(`Gmail message HTTP ${response.status}`);
    return toSummary((await response.json()) as GmailMessage, id);
  }

  #headers(): Record<string, string> {
    return { authorization: `Bearer ${this.accessToken}` };
  }
}

function toSummary(message: GmailMessage, id: string): EmailSummary {
  const from = parseAddress(header(message.payload, 'From'));
  return {
    id,
    provider: 'google',
    subject: header(message.payload, 'Subject') ?? '(no subject)',
    ...(from ? { from } : {}),
    to: parseAddressList(header(message.payload, 'To')),
    date: messageDate(message),
    snippet: message.snippet ?? '',
    ...(message.labelIds?.includes('UNREAD') ? { unread: true } : {}),
  };
}

function messageDate(message: GmailMessage): string {
  const internal = Number(message.internalDate);
  if (Number.isFinite(internal) && internal > 0) return new Date(internal).toISOString();
  const parsed = Date.parse(header(message.payload, 'Date') ?? '');
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

export function header(part: GmailPart | undefined, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const entry of part?.headers ?? []) {
    if (entry.name?.toLowerCase() === wanted && typeof entry.value === 'string') return entry.value;
  }
  return undefined;
}

/** `"Ana Pérez" <ana@example.com>` or a bare address. */
export function parseAddress(value: string | undefined): EmailAddress | undefined {
  if (!value?.trim()) return undefined;
  const match = /^(.*?)\s*<([^>]+)>\s*$/.exec(value.trim());
  if (match) {
    const name = match[1]?.trim().replace(/^["']|["']$/g, '');
    const address = match[2]?.trim();
    return address ? { ...(name ? { name } : {}), address } : undefined;
  }
  return { address: value.trim() };
}

export function parseAddressList(value: string | undefined): EmailAddress[] {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => parseAddress(part))
    .filter((address): address is EmailAddress => Boolean(address?.address));
}

function findPartText(part: GmailPart | undefined, mimeType: string): string | undefined {
  if (!part) return undefined;
  if (part.mimeType === mimeType && part.body?.data) return decodeBase64Url(part.body.data);
  for (const child of part.parts ?? []) {
    const text = findPartText(child, mimeType);
    if (text) return text;
  }
  return undefined;
}

function extractBodyText(message: GmailMessage): string {
  const payload = message.payload;
  const plain = findPartText(payload, 'text/plain');
  if (plain) return plain;
  const html = findPartText(payload, 'text/html');
  if (html) return htmlToText(html);
  // Single-part message whose part carries no mimeType, or metadata-only payloads.
  if (payload?.body?.data) return decodeBase64Url(payload.body.data);
  return message.snippet ?? '';
}
