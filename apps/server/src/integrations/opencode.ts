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
 *   POST /session/{id}/abort           -> stop the session's in-flight run
 *   GET  /session                      -> list sessions
 *
 * Headless runs must never block on interactive input. Every prompt disables
 * the `question` tool (which waits for a human answer and would hang the turn
 * forever) and carries a timeout that aborts the session's run, so a stuck run
 * surfaces as an error instead of silence.
 */

import type { AgentImage } from '../provider/types.js';

export interface OpenCodeConfig {
  /** e.g. http://127.0.0.1:4096 */
  baseUrl: string;
  providerID: string;
  modelID: string;
  /** Optional OpenCode agent (e.g. "build"). */
  agent?: string;
  /** Abort a prompt that has not returned after this many ms (0 disables). */
  timeoutMs?: number;
  /** Browser planning sessions cannot use host tools or MCP connections. */
  restricted?: boolean;
}

/** Interactive tools that wait for a human; disabled on headless runs. */
const HEADLESS_TOOLS = { question: false } as const;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

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

/**
 * Build the OpenCode prompt `parts`. Text is always a part; each image becomes a
 * `file` part carrying an inline `data:` URL (OpenCode accepts data URLs).
 */
export function promptParts(text: string, images: readonly AgentImage[] = []): unknown[] {
  const parts: unknown[] = [];
  if (text) parts.push({ type: 'text', text });
  for (const image of images) {
    parts.push({
      type: 'file',
      url: image.dataUrl,
      mime: image.mime,
      ...(image.filename ? { filename: image.filename } : {}),
    });
  }
  if (!parts.length) parts.push({ type: 'text', text });
  return parts;
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
        permission: [{ permission: '*', pattern: '*', action: this.config.restricted ? 'deny' : 'allow' }],
      }),
    });
    if (!response.ok) throw new Error(`OpenCode session HTTP ${response.status}`);
    const body = (await response.json()) as { id?: unknown };
    if (typeof body.id !== 'string' || !body.id) throw new Error('OpenCode session response missing id');
    return body.id;
  }

  /** Stop a session's in-flight run (best effort). */
  async abort(sessionId: string): Promise<void> {
    try {
      await this.fetchImpl(this.url(`/session/${encodeURIComponent(sessionId)}/abort`), { method: 'POST' });
    } catch {
      // Best effort: callers are already handling a failure.
    }
  }

  /** Post one turn and return the assistant's text. */
  async prompt(
    sessionId: string,
    text: string,
    signal?: AbortSignal,
    images: readonly AgentImage[] = [],
  ): Promise<string> {
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    let timedOut = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort(new Error(`OpenCode prompt timed out after ${timeoutMs}ms`));
        }, timeoutMs)
      : undefined;
    try {
      const response = await this.fetchImpl(this.url(`/session/${encodeURIComponent(sessionId)}/message`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          parts: promptParts(text, images),
          ...(this.config.restricted ? { model: { providerID: this.config.providerID, modelID: this.config.modelID } } : {}),
          tools: this.config.restricted ? { '*': false, question: false, bash: false, read: false,
            write: false, edit: false, glob: false, grep: false, task: false, webfetch: false,
            websearch: false, todowrite: false } : HEADLESS_TOOLS,
          ...(this.config.agent ? { agent: this.config.agent } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`OpenCode prompt HTTP ${response.status}`);
      const body = (await response.json()) as { parts?: unknown };
      return extractOpenCodeText(body.parts);
    } catch (error) {
      // A run that never finishes keeps its session busy, so release it before
      // surfacing the failure.
      if (timedOut) await this.abort(sessionId);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
