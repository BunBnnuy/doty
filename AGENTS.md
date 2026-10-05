# AGENTS.md — rules for subagents working in this repo

Read `docs/PLAN.md` first. It is the source of truth for the product.

## Run of show

Wave 0 (orchestrator) has frozen the workspace and three contracts. Wave 1 runs
in parallel across disjoint directories.

## Hard rules

1. **Own your directory only.** Touch nothing outside it. Do not edit root
   configs (`package.json`, `Cargo.toml`, `tsconfig.base.json`) or files inside
   another agent's package/app/crate.
2. **Contracts are frozen.** Import from `@doty/dot-state`,
   `@doty/harness-events`, and `@doty/protocol`. Never edit those packages. If a
   contract is wrong, report it — do not change it unilaterally.
3. **Do not run `npm install`.** The orchestrator owns all dependencies so
   parallel agents cannot corrupt the shared lockfile. If you need a dependency,
   stop and report it in your final message.
4. **No secrets.** Never read or transmit `~/.t3/userdata/secrets/`,
   `~/.t3/userdata/clerk-tokens.json`, `~/.local/share/opencode/auth.json`, or
   any file under a `secrets`/credentials path.
5. **Raw transcripts stay local.** Anything typed in `@doty/harness-events` as
   "LOCAL ONLY" must never be sent anywhere.

## Contract ownership map

| Contract | Package | Consumers |
| --- | --- | --- |
| `DotState` | `packages/dot-state` | avatar, desktop |
| `HarnessEvent` etc. | `packages/harness-events` | watcher (Rust mirror), server |
| Wire protocol | `packages/protocol` | server, desktop |

## Definition of done (report all four)

1. The run command to see your work.
2. What you verified, and how.
3. Anything you could not do and why.
4. Any dependency you need added.

## Model routing (project rule)

- **OpenAI models are run through the Codex CLI, never as a subagent model.**
  - Correct: `codex exec --cd <dir> --sandbox workspace-write --approve-for-me -o <out> "<task>"`
  - Wrong: `subagent(model: "opencode/gpt-6.1-sol" | "opencode-go/gpt-6-luna" | ...)`
  - Rationale: the Codex CLI is the native, authenticated harness (uses the
    user's Codex plan and tools). OpenAI models surfaced through the OpenCode
    catalog are not the same path.
- Non-OpenAI work (recon, verification, cheap/parallel mechanical tasks) may
  still use the `subagent` tool with a non-OpenAI model.

Canonical invocation:

```text
codex exec --cd <repo> --sandbox workspace-write --approve-for-me -o <last-message.json> "<task>"
```

Useful flags: `-C/--cd`, `-s/--sandbox read-only|workspace-write|danger-full-access`,
`--worktree` (isolated managed git worktree), `-m/--model`, `--json` (JSONL
events), `-o/--output-last-message`, `-i/--image`, `--ephemeral`,
`--skip-git-repo-check`.
