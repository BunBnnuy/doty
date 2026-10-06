/**
 * Normalized shapes shared by every email provider.
 *
 * Everything returned here is untrusted data: message bodies are written by
 * third parties. Callers (routes, MCP tools, the desktop) must never treat
 * their contents as instructions.
 */

export type EmailProvider = 'google' | 'microsoft';

export const EMAIL_PROVIDERS: readonly EmailProvider[] = ['google', 'microsoft'];

/** Hard cap for a message body returned by `read` (characters of plain text). */
export const EMAIL_BODY_LIMIT = 20_000;

export interface EmailAddress {
  name?: string;
  address: string;
}

export interface EmailSummary {
  id: string;
  provider: EmailProvider;
  subject: string;
  from?: EmailAddress;
  to: EmailAddress[];
  /** ISO 8601, UTC. */
  date: string;
  snippet: string;
  unread?: boolean;
}

export interface EmailMessage extends EmailSummary {
  /** Plain text (HTML is stripped); bounded by EMAIL_BODY_LIMIT. */
  body: string;
}

export interface EmailListOptions {
  query?: string;
  limit: number;
}

export interface EmailClient {
  list(options: EmailListOptions): Promise<EmailSummary[]>;
  read(id: string): Promise<EmailMessage>;
}

export interface ConnectedAccount {
  /** Stable integration id (also accepted as `account` by the email endpoints). */
  id: string;
  provider: EmailProvider;
  account: string;
  scopes?: string;
}

export interface ProviderStatus {
  provider: EmailProvider;
  /** Provider credentials (client id/secret) present in the server env. */
  configured: boolean;
  /** Number of connected mailboxes for this provider. */
  accounts: number;
}

export interface IntegrationOverview {
  providers: ProviderStatus[];
  accounts: ConnectedAccount[];
}

/** Selects one connected mailbox; `account` is an email address or integration id. */
export interface EmailSelector {
  provider?: EmailProvider;
  account?: string;
}

export interface OAuthTokens {
  accessToken: string;
  /** Absent on responses that do not rotate the refresh token. */
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scope?: string;
}

export function isEmailProvider(value: unknown): value is EmailProvider {
  return value === 'google' || value === 'microsoft';
}
