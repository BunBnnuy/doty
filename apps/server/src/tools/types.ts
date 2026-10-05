export type ActionTier = 'read' | 'side-effecting' | 'dangerous';
export type ToolArgs = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface Tool extends ToolDefinition {
  /** Server-owned metadata; never accepted from the model. Unclassified = dangerous. */
  tier?: ActionTier;
  run(args: ToolArgs): Promise<unknown>;
}
