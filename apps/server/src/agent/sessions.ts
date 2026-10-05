/**
 * Maps a conversation key (Discord DM user / guild, or the desktop) to an
 * OpenCode session id. The conversation itself lives in OpenCode; Doty only
 * remembers which session to continue.
 *
 * Persisted as `conversation_session` events (ignored by the chat UI), so the
 * mapping survives restarts without a new table.
 */

import type { EventLog } from '../events/log.js';

export class SessionStore {
  readonly #byKey = new Map<string, string>();

  hydrate(log: EventLog): void {
    for (const event of log.since(0)) {
      if (event.type !== 'conversation_session') continue;
      const data = event.data as Record<string, unknown> | null;
      if (!data || typeof data.conversation !== 'string' || typeof data.sessionId !== 'string') continue;
      if (data.conversation && data.sessionId) this.#byKey.set(data.conversation, data.sessionId);
    }
  }

  get(key: string): string | undefined {
    return this.#byKey.get(key);
  }

  set(log: EventLog, key: string, sessionId: string): void {
    if (!key || !sessionId) return;
    this.#byKey.set(key, sessionId);
    log.append({ type: 'conversation_session', data: { conversation: key, sessionId } });
  }
}
