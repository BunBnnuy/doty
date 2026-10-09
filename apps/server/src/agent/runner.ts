/**
 * Common surface for agent backends. Two implementations exist:
 *  - `AgentRuntime` (in-process OpenAI-compatible loop), and
 *  - `OpenCodeAgent` (delegates to the OpenCode CLI server, which owns the
 *    conversation history; Doty only stores the session id per conversation).
 */

import type { AgentRunResult } from './loop.js';
import type { AgentImage } from '../provider/types.js';

export type { AgentImage } from '../provider/types.js';

export interface AgentRunner {
  /** Fire-and-forget; returns the run id immediately. */
  start(task: string): string;
  /**
   * Run and resolve with the result. `conversationKey` selects the backend
   * session; `images` are passed to the model alongside the task text.
   */
  run(task: string, conversationKey?: string, images?: readonly AgentImage[]): Promise<AgentRunResult>;
  close(): Promise<void>;
}
