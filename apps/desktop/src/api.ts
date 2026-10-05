/**
 * REST side of the desktop client.
 *
 * `POST /message` accepts `{ type?: 'message', text }` and answers 202 with
 * `{ ok: true, event }`. The event's `seq` is also delivered on the SSE stream;
 * `ts` may be present here (it is a stored record) but is never required.
 */

export const DEFAULT_SERVER = 'http://localhost:8787';

const STORAGE_KEY = 'doty.server';

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
  signal?: AbortSignal,
): Promise<number | undefined> {
  const response = await fetch(commandUrl(serverUrl, '/message'), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ type: 'message', text }),
    cache: 'no-store',
    credentials: 'omit',
    signal,
  });

  if (!response.ok) {
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
