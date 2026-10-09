/**
 * Agent backend that delegates to a local OpenCode CLI server.
 *
 * OpenCode owns the conversation history. Doty keeps only the session id per
 * conversation (`SessionStore`) and posts each turn to it, so continuity lives
 * in the CLI instead of Doty. Runs still emit the usual events so the desktop
 * chat and the avatar reflect what happened.
 */

import { randomUUID } from 'node:crypto';
import type { EventLog } from '../events/log.js';
import type { AgentImage } from '../provider/types.js';
import type { OpenCodeClient } from '../integrations/opencode.js';
import type { AgentRunResult } from './loop.js';
import type { AgentRunner } from './runner.js';
import type { SessionStore } from './sessions.js';

/** Conversation key the desktop client runs under. */
export const DESKTOP_SESSION_KEY = 'desktop';

export class OpenCodeAgent implements AgentRunner {
  readonly #creating = new Map<string, Promise<string>>();

  constructor(
    private readonly client: OpenCodeClient,
    private readonly log: EventLog,
    private readonly sessions: SessionStore,
  ) {}

  start(task: string): string {
    const runId = randomUUID();
    void this.execute(task, DESKTOP_SESSION_KEY, runId);
    return runId;
  }

  run(task: string, conversationKey = DESKTOP_SESSION_KEY, images: readonly AgentImage[] = []): Promise<AgentRunResult> {
    return this.execute(task, conversationKey, randomUUID(), images);
  }

  async close(): Promise<void> {
    // The OpenCode server is a separate process; nothing to close here.
  }

  /** Reuse the conversation's session, creating one on first use. */
  #session(key: string): Promise<string> {
    const existing = this.sessions.get(key);
    if (existing) return Promise.resolve(existing);
    const inFlight = this.#creating.get(key);
    if (inFlight) return inFlight;
    const created = this.client
      .createSession(`Doty · ${key}`)
      .then((sessionId) => {
        this.sessions.set(this.log, key, sessionId);
        this.#creating.delete(key);
        return sessionId;
      })
      .catch((error: unknown) => {
        this.#creating.delete(key);
        throw error;
      });
    this.#creating.set(key, created);
    return created;
  }

  private async execute(
    task: string,
    key: string,
    runId: string,
    images: readonly AgentImage[] = [],
  ): Promise<AgentRunResult> {
    const emit = (type: string, data: Record<string, unknown> = {}): void => {
      this.log.append({ type, data: { runId, ...data } });
    };
    const state = (activity: 'thinking' | 'done' | 'error', label: string): void => {
      this.log.append({ type: 'dot_state', data: { runId, state: { activity, emotion: 'focused', label } } });
    };
    emit('run_started', { task, backend: 'opencode', ...(images.length ? { images: images.length } : {}) });
    state('thinking', 'Thinking…');
    try {
      const sessionId = await this.#session(key);
      const answer = await this.client.prompt(sessionId, task, undefined, images);
      emit('assistant_message', { content: answer });
      emit('final', { text: answer });
      state('done', 'Done');
      emit('run_finished', { status: 'completed', steps: 1 });
      return { runId, status: 'completed', steps: 1, messages: [], answer };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'OpenCode failed';
      emit('run_error', { error: message });
      state('error', 'Run failed');
      emit('run_finished', { status: 'error', steps: 1 });
      return { runId, status: 'error', steps: 1, messages: [], error: message };
    }
  }
}
