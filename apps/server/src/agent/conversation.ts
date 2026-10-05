/**
 * Per-conversation chat memory.
 *
 * Each conversation (a Discord DM user, or a guild) keeps a bounded window of
 * recent turns that is prepended to the model context, so Doty remembers what
 * was said. Turns are also appended to the event log as `conversation_turn`
 * events — a type the desktop ignores — so the history is durable (hydrated on
 * startup) without a new table.
 */

import type { EventLog } from '../events/log.js';
import type { ChatMessage } from '../provider/types.js';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_CHARS = 6_000;

export class ConversationStore {
  readonly #byKey = new Map<string, ConversationTurn[]>();

  constructor(
    private readonly maxTurns = DEFAULT_MAX_TURNS,
    private readonly maxChars = DEFAULT_MAX_CHARS,
  ) {}

  /** Rebuild the in-memory window from the durable event log. */
  hydrate(log: EventLog): void {
    for (const event of log.since(0)) {
      if (event.type !== 'conversation_turn') continue;
      const data = event.data as Record<string, unknown> | null;
      if (!data || typeof data.conversation !== 'string') continue;
      if (data.role !== 'user' && data.role !== 'assistant') continue;
      if (typeof data.content !== 'string' || !data.content) continue;
      this.#push(data.conversation, { role: data.role, content: data.content });
    }
  }

  /** Recent turns for a conversation, oldest first. */
  history(key: string): ChatMessage[] {
    return this.#byKey.get(key) ?? [];
  }

  /** Persist a turn and add it to the in-memory window. */
  record(log: EventLog, key: string, turn: ConversationTurn): void {
    if (!key || !turn.content.trim()) return;
    log.append({ type: 'conversation_turn', data: { conversation: key, role: turn.role, content: turn.content } });
    this.#push(key, turn);
  }

  #push(key: string, turn: ConversationTurn): void {
    const turns = this.#byKey.get(key) ?? [];
    turns.push(turn);
    while (turns.length > this.maxTurns) turns.shift();
    let chars = turns.reduce((sum, item) => sum + item.content.length, 0);
    while (chars > this.maxChars && turns.length > 1) {
      chars -= turns.shift()!.content.length;
    }
    this.#byKey.set(key, turns);
  }
}
