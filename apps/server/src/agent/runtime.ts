import { randomUUID } from 'node:crypto';
import type { EventLog } from '../events/log.js';
import type { ChatMessage, ChatProvider } from '../provider/types.js';
import { createDefaultToolRegistry, type ToolRegistry } from '../tools/registry.js';
import { runAgent, type AgentRunResult } from './loop.js';
import type { AgentMemory } from '../memory/index.js';

export interface AgentRuntimeOptions {
  provider: ChatProvider;
  tools?: ToolRegistry;
  persona?: string;
  maxSteps?: number;
  memory?: AgentMemory;
}

/** Process-local runner; durable scheduling/approval resumption are future seams. */
export class AgentRuntime {
  readonly #tools: ToolRegistry;
  readonly #running = new Map<AbortController, Promise<unknown>>();
  #closed = false;

  constructor(private readonly options: AgentRuntimeOptions, private readonly log: EventLog) {
    this.#tools = options.tools ?? createDefaultToolRegistry();
    if (options.maxSteps !== undefined &&
        (!Number.isInteger(options.maxSteps) || options.maxSteps < 1 || options.maxSteps > 100)) {
      throw new Error('maxSteps must be an integer from 1 to 100');
    }
  }

  start(task: string): string {
    if (this.#closed) throw new Error('Agent runtime is closed');
    const runId = randomUUID();
    const controller = new AbortController();
    const pending = runAgent({
      ...this.options,
      task,
      tools: this.#tools,
      log: this.log,
      runId,
      signal: controller.signal,
    }).finally(() => this.#running.delete(controller));
    this.#running.set(controller, pending);
    return runId;
  }

  /**
   * Run a task and resolve with its result. Integrations that must await a reply
   * (e.g. Discord) use this instead of the fire-and-forget `start`. `extra.history`
   * prepends prior conversation turns so the model remembers them.
   */
  async run(task: string, extra?: { history?: readonly ChatMessage[] }): Promise<AgentRunResult> {
    if (this.#closed) throw new Error('Agent runtime is closed');
    const runId = randomUUID();
    const controller = new AbortController();
    const pending = runAgent({
      ...this.options,
      task,
      ...(extra?.history?.length ? { history: extra.history } : {}),
      tools: this.#tools,
      log: this.log,
      runId,
      signal: controller.signal,
    }).finally(() => this.#running.delete(controller));
    this.#running.set(controller, pending);
    return pending;
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#running.keys()) controller.abort();
    await Promise.allSettled(this.#running.values());
  }
}
