import type { ActionTier, Tool, ToolArgs } from '../tools/types.js';

export interface PolicyDecision {
  tier: ActionTier;
  decision: 'allow' | 'requires_approval' | 'deny';
  reason: string;
}

/** Stub seam. Only server-registered metadata can grant read access. */
export function evaluatePolicy(tool: Tool | undefined, _args: ToolArgs): PolicyDecision {
  const tier = tool?.tier ?? 'dangerous';
  if (tier === 'read') return { tier, decision: 'allow', reason: 'Read-only action' };
  if (tier === 'side-effecting') {
    return { tier, decision: 'requires_approval', reason: 'Side effects require user approval' };
  }
  return { tier, decision: 'deny', reason: 'Dangerous or unclassified actions are disabled' };
}
