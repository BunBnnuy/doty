import type { ToolDefinition } from '../tools/types.js';

export interface ToolCall {
  id: string;
  name: string;
  /** Keep the wire JSON until the runtime validates it. */
  arguments: string;
}

/** One part of a multimodal user message (OpenAI-compatible `content` array). */
export type UserContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * An image supplied with a task, already inlined as a `data:` URL so expiring
 * source URLs (e.g. Discord CDN attachments) never reach the model backend.
 */
export interface AgentImage {
  mime: string;
  dataUrl: string;
  filename?: string;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | UserContentPart[] }
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
