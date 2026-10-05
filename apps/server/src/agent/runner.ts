/**
 * Common surface for agent backends. Two implementations exist:
 *  - `AgentRuntime` (in-process OpenAI-compatible loop), and
 *  - `OpenCodeAgent` (delegates to the OpenCode CLI server, which owns the
 *    conversation history; Doty only stores the session id per conversation).
 */

import type { AgentRunResult } from './loop.js';

export interface AgentRunner {
  /** Fire-and-forget; returns the run id immediately. */
  start(task: string): string;
  /** Run and resolve with the result. `conversationKey` selects the backend session. */
  run(task: string, conversationKey?: string): Promise<AgentRunResult>;
  close(): Promise<void>;
}
