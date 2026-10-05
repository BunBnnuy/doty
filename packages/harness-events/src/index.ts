/**
 * Harness observability contract.
 *
 * Every adapter (Codex, OpenCode, T3) normalizes to `HarnessEvent`; nothing
 * downstream knows harness specifics. Rust mirror lives in `crates/harness` —
 * keep field names in sync.
 *
 * PRIVACY: `HarnessEvent.text` is LOCAL ONLY and must never be transmitted.
 * Only `SessionDigest` crosses the wire, and `errorExcerpt` only when the user
 * explicitly opts in.
 */

export type Harness = 'codex' | 'opencode' | 't3';

export type HarnessEventKind =
  | 'session_start'
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'token_usage'
  | 'approval'
  | 'error'
  | 'turn_end'
  | 'session_end';

export type HarnessActivity =
  | 'running'
  | 'thinking'
  | 'tool_calling'
  | 'waiting_approval'
  | 'idle'
  | 'done'
  | 'error'
  | 'stale';

export interface HarnessEvent {
  harness: Harness;
  sessionId: string;
  project?: string;
  /** Epoch millis. */
  ts: number;
  kind: HarnessEventKind;
  status?: HarnessActivity;
  tool?: { name: string; args?: unknown };
  tokens?: { input?: number; output?: number };
  /** LOCAL ONLY — never transmitted to the server. */
  text?: string;
}

/** What the UI shows as a satellite dot. */
export interface HarnessStatus {
  harness: Harness;
  sessionId: string;
  project?: string;
  title?: string;
  status: HarnessActivity;
  /** Epoch millis of the last observed event. */
  lastActivityAt: number;
  tokens?: { input: number; output: number };
}

/**
 * Structurally derived on the client — no LLM, no raw content. This is the only
 * harness payload that reaches the online brain, so the dot can narrate what
 * your agents did without your code leaving the machine.
 */
export interface SessionDigest {
  harness: Harness;
  sessionId: string;
  project?: string;
  title?: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  turns: number;
  /** e.g. { "shell": 4, "apply_patch": 9 } */
  toolCalls: Record<string, number>;
  /** Repo-relative paths where possible. */
  filesTouched: string[];
  approvalDecisions: number;
  tokens?: { input?: number; output?: number };
  outcome: 'done' | 'error' | 'interrupted';
  /** OPT-IN only. Never populated by default. */
  errorExcerpt?: string;
}

/** The subset of a digest that is safe to transmit. */
export const TRANSMITTED_DIGEST_FIELDS = [
  'harness',
  'sessionId',
  'project',
  'title',
  'startedAt',
  'endedAt',
  'durationMs',
  'turns',
  'toolCalls',
  'filesTouched',
  'approvalDecisions',
  'tokens',
  'outcome',
] as const satisfies readonly (keyof SessionDigest)[];
