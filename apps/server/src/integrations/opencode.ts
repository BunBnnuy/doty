/**
 * OpenCode CLI server client.
 *
 * Doty delegates runs to a local `opencode serve` instance. OpenCode owns the
 * conversation history; Doty only stores the session id per conversation and
 * posts each new turn to that session.
 *
 * Endpoints (OpenCode 1.18):
 *   POST /session                      -> create a session
 *   POST /session/{id}/message         -> prompt; returns the assistant message
 *   GET  /session                      -> list sessions
 */

export interface OpenCodeConfig {
  /** e.g. http://127.0.0.1:4096 */
  baseUrl: string;
  providerID: string;
  modelID: string;
  /** Optional OpenCode agent (e.g. "build"). */
  agent?: string;
}

/** Parse `provider/model` into its parts; defaults the provider. */
export function parseOpenCodeModel(value: string): { providerID: string; modelID: string } {
  const trimmed = value.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return { providerID: 'opencode-go', modelID: trimmed || 'deepseek-v4.1-flash' };
  return { providerID: trimmed.slice(0, slash), modelID: trimmed.slice(slash + 1) };
}

/** Concatenate the text parts of an OpenCode message. */
export function extractOpenCodeText(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  const chunks: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const record = part as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string' && record.text.trim()) {
      chunks.push(record.text);
    }
  }
  return chunks.join('\n').trim();
}

export class OpenCodeClient {
  constructor(
    private readonly config: OpenCodeConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(path: string): string {
    return `${this.config.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  /** Create a session with an allow-all permission ruleset (headless runs). */
  async createSession(title?: string): Promise<string> {
    const response = await this.fetchImpl(this.url('/session'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(title ? { title } : {}),
        model: { id: this.config.modelID, providerID: this.config.providerID },
        permission: [{ permission: '*', pattern: '*', action: 'allow' }],
      }),
    });
    if (!response.ok) throw new Error(`OpenCode session HTTP ${response.status}`);
    const body = (await response.json()) as { id?: unknown };
    if (typeof body.id !== 'string' || !body.id) throw new Error('OpenCode session response missing id');
    return body.id;
  }

  /** Post one turn and return the assistant's text. */
  async prompt(sessionId: string, text: string, signal?: AbortSignal): Promise<string> {
    const response = await this.fetchImpl(this.url(`/session/${encodeURIComponent(sessionId)}/message`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parts: [{ type: 'text', text }],
        ...(this.config.agent ? { agent: this.config.agent } : {}),
      }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error(`OpenCode prompt HTTP ${response.status}`);
    const body = (await response.json()) as { parts?: unknown };
    return extractOpenCodeText(body.parts);
  }
}
