import type { Tool, ToolDefinition } from './types.js';
import { httpFetchTool } from './http-fetch.js';
import { createArtifactWriteTool } from './artifact-write.js';
import { nowTool } from './now.js';

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();

  constructor(tools: readonly Tool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: Tool): void {
    if (this.#tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    this.#tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  definitions(): ToolDefinition[] {
    return [...this.#tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters }));
  }
}

export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry([httpFetchTool, createArtifactWriteTool(), nowTool]);
}
