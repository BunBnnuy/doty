/**
 * REST side of the desktop client.
 *
 * `POST /message` accepts `{ type?: 'message', text }` and answers 202 with
 * `{ ok: true, event }`. The event's `seq` is also delivered on the SSE stream;
 * `ts` may be present here (it is a stored record) but is never required.
 */

import type { Harness } from '@doty/harness-events';

export const DEFAULT_SERVER = 'https://doty.killbunny.top';

const STORAGE_KEY = 'doty.server';
const TOKEN_STORAGE_KEY = 'doty.token';

export class HttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** Query string, then a previously chosen URL, then `VITE_DOTY_SERVER`, then the default. */
export function resolveServerUrl(): string {
  const fromQuery = new URLSearchParams(window.location.search).get('server');
  const queryUrl = fromQuery ? normalizeServerUrl(fromQuery) : null;
  if (queryUrl) return queryUrl;

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const storedUrl = stored ? normalizeServerUrl(stored) : null;
    if (storedUrl) return storedUrl;
  } catch {
    // Private mode / sandboxed webview — fall through.
  }

  const fromEnv = readViteServer();
  if (fromEnv) return fromEnv;
  return DEFAULT_SERVER;
}

export function rememberServerUrl(url: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, url);
  } catch {
    // Persistence is best-effort; the in-memory URL still applies.
  }
}

/** Query token, persisted token, then the optional build-time token. */
export function resolveToken(): string | null {
  const fromQuery = new URLSearchParams(window.location.search).get('token');
  if (fromQuery?.trim()) {
    rememberToken(fromQuery.trim());
    return fromQuery.trim();
  }
  try {
    const stored = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (stored?.trim()) return stored.trim();
  } catch {
    // Private mode / sandboxed webview - fall through.
  }
  const env = (import.meta as ImportMeta & { env?: Record<string, unknown> }).env;
  const value = env?.VITE_DOTY_TOKEN;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function rememberToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Persistence is best-effort; the query token still applies.
  }
}

export function forgetToken(): void {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Best-effort.
  }
}

/** Accept only http(s) origins. Returns null when the value is not a URL. */
export function normalizeServerUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function isRetryableSend(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  // `fetch` rejects with TypeError when the server cannot be reached.
  return error instanceof TypeError;
}

/** Returns the appended event `seq` when the server includes it. */
export async function postMessage(
  serverUrl: string,
  text: string,
  token: string | null,
  signal?: AbortSignal,
): Promise<number | undefined> {
  const response = await fetch(commandUrl(serverUrl, '/message'), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ type: 'message', text }),
    cache: 'no-store',
    credentials: 'omit',
    signal,
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new HttpError('Authentication failed. Set a valid token with ?token=... and reload.', 401);
    }
    let detail = String(response.status);
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === 'string' && body.error) detail = `${response.status} ${body.error}`;
    } catch {
      // Non-JSON error bodies still surface as a status.
    }
    throw new HttpError(`POST /message failed: ${detail}`, response.status);
  }

  try {
    const body = (await response.json()) as { event?: { seq?: unknown } };
    const seq = body.event?.seq;
    return typeof seq === 'number' && Number.isFinite(seq) ? seq : undefined;
  } catch {
    return undefined;
  }
}

/** One reasoning block or final reply captured from a watched session. */
export interface HarnessMessagePayload {
  machine: string;
  harness: Harness;
  sessionId: string;
  project?: string;
  title?: string;
  kind: 'assistant' | 'thinking';
  text: string;
  ts: number;
}

/** A watched session finished, errored, or is waiting for the user. */
export interface HarnessNoticePayload {
  machine: string;
  harness: Harness;
  sessionId: string;
  project?: string;
  title?: string;
  kind: 'done' | 'error' | 'attention';
  ts: number;
}

/** Publish a watched agent's reasoning/reply so every client sees it. */
export async function postHarnessMessage(
  serverUrl: string,
  token: string | null,
  payload: HarnessMessagePayload,
  signal?: AbortSignal,
): Promise<void> {
  await postJson(serverUrl, '/harness-message', token, payload, signal);
}

/** Publish a watched agent's finish/error/attention notice to every client. */
export async function postHarnessNotice(
  serverUrl: string,
  token: string | null,
  payload: HarnessNoticePayload,
  signal?: AbortSignal,
): Promise<void> {
  await postJson(serverUrl, '/harness-notice', token, payload, signal);
}

async function postJson(
  serverUrl: string,
  path: string,
  token: string | null,
  body: unknown,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(commandUrl(serverUrl, path), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    cache: 'no-store',
    credentials: 'omit',
    signal,
  });
  if (!response.ok) throw new HttpError(`POST ${path} failed: ${response.status}`, response.status);
}

function commandUrl(base: string, path: string): string {
  const url = new URL(base);
  url.pathname = path;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function readViteServer(): string | null {
  const env = (import.meta as ImportMeta & { env?: Record<string, unknown> }).env;
  const value = env?.VITE_DOTY_SERVER;
  return typeof value === 'string' ? normalizeServerUrl(value) : null;
}
