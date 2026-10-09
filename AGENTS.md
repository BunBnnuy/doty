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
5. **Harness content is shared.** By explicit product decision, the reasoning,
   replies and finish notices of watched agents are published to the online
   brain so every connected client sees them (see
   `apps/server/src/routes/harness.ts`). Secrets (rule 4) are still never
   transmitted.

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
  - Correct: `codex exec --cd <dir> --approve-for-me -o <out> "<task>"`
  - Wrong: `subagent(model: "opencode/gpt-6.1-sol" | "opencode-go/gpt-6-luna" | ...)`
  - Rationale: the Codex CLI is the native, authenticated harness (uses the
    user's Codex plan and tools). OpenAI models surfaced through the OpenCode
    catalog are not the same path.
  - `--approve-for-me` already implies the `workspace-write` sandbox and is
    MUTUALLY EXCLUSIVE with `--sandbox`; passing both is a CLI error.
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

## Deployment and change workflow

- The Doty server runs at `https://doty.killbunny.top` (systemd unit
  `doty-server` on `kb`).
- **Never edit project files on `kb` directly.** All changes are made in the
  local working copy.
- To ship a server change: commit locally, then push to `origin` `master`. That
  push triggers GitHub Actions (`.github/workflows/deploy.yml`), which verifies
  (typecheck + tests) and runs `.github/scripts/deploy-kb.sh` on `kb`: it
  `git fetch` + `git reset --hard origin/master`, reinstalls only when the
  lockfile changed, rebuilds contracts, and restarts `doty-server`.
- Do not start a local Doty desktop app or API unless the user asks for it.
- You may `ssh kb` to *inspect* for verification (logs, `systemctl status`,
  health) — never to modify files.
