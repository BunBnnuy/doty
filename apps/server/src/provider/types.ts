import type { ToolDefinition } from '../tools/types.js';

export interface ToolCall {
  id: string;
  name: string;
  /** Keep the wire JSON until the runtime validates it. */
  arguments: string;
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ProviderRequest {
  messages: readonly ChatMessage[];
  tools: readonly ToolDefinition[];
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}

/** Injectable seam: unit tests need neither credentials nor a network. */
export interface ChatProvider {
  complete(request: ProviderRequest): Promise<Extract<ChatMessage, { role: 'assistant' }>>;
}
