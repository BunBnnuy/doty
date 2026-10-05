# Doty — Design & Build Plan

A replica of the always-on AI assistant pattern popularized by **ChatGPT dots** and
**Grok Bot**: an agent that keeps working between conversations, fronted by a
characterful animated dot that reflects what it's doing.

> Status: **planning**. No code yet. This document is the source of truth until
> the first commit.

## References

- **Grok Bot** (`x.ai/bot`) — "a team of always-on AI teammates." Signature: a
  code-drawn orb that morphs smoothly between every state, shape, and expression.
- **ChatGPT dots** (OpenAI DevDay, Sept 2026) — always-on agents, each with a
  cute cartoon avatar, its own cloud computer, ~4,000 app connections, and
  continuous work between conversations.

The thing worth replicating is **not** the chatbot. It's (a) an animated avatar
that communicates state, and (b) an agent that runs without you watching.

## Decisions

| Decision        | Choice                                                          |
| --------------- | --------------------------------------------------------------- |
| Scope (v1)      | Full always-on agent                                            |
| Client          | **Desktop app** (thin client: presence + local tools + watcher) |
| Brains          | **Fully online** — API + always-on worker; nothing runs locally |
| Model backend   | OpenAI-compatible API (swap `baseURL`)                          |
| Cloud computer  | Managed sandbox (E2B / Daytona / Fly Machines)                  |
| Desktop shell   | **Tauri v2** (Rust + native webview; WebView2 on Windows)       |
| Local tools     | **Full local bridge, in scope** (M7) — OS control + file access |
| Harnesses       | **Watch Codex CLI, OpenCode, T3** (M8); Claude Code + DSH later |
| Harness privacy | **Metadata + client-built digest**; raw content never leaves    |
| Harness purpose | **Read-only watch + awareness** (no coordination for now)       |
| Users           | Single-user personal instance                                   |
| Voice           | Text first; state contract leaves room for voice later          |

### Why a desktop client, and what it must earn

A desktop client is only worth building over a web app if it adds one of two
things — otherwise it's a website in a window:

1. **Presence.** A floating dot on the desktop, tray icon, autostart, global
   hotkey, always-on-top, native notifications. The character *is* the product;
   the chat window is secondary.
2. **Local capability.** The ability to act on your machine (open apps, read
   files, screenshots, control input) — GrokBot's signature move — and to
   **observe** what other agents are doing on it.

Both are **in scope**. #2 turns the client from a viewer into a remote-controlled
actor and an observability hub, so each gets its own section and security
treatment.

### Why server-side "always-on"

If the brain lived in the desktop app, closing the laptop would stop the agent.
Keeping it online means: consistent behavior, no local compute, genuinely
always-on, easy updates, and the same dot reachable from other devices. The cost
is network dependency and privacy — everything you *choose* to send leaves the
machine.

## Architecture

```
   ┌───────────────────────────┐   HTTPS (REST)      ┌────────────────────────────┐
   │  Desktop client (Tauri)   │◀───────────────────▶│  Online service            │
   │                           │   SSE (downstream)  │  API + always-on worker    │
   │  • floating dot / tray    │◀───────────────────▶│                            │
   │  • autostart, hotkey      │   WebSocket         │  • agent loop              │
   │  • native notifications   │◀───────────────────▶│  • scheduler               │
   │  • chat + run view        │   control channel   │  • policy + memory         │
   │  • OS keychain (tokens)   │                     │  • harness awareness       │
   │  • local tool bridge      │   metadata+digest   │  • sandbox / MCP           │
   │  • harness watcher ───────┼────────────────────▶│                            │
   └───────────────────────────┘                     └────────────┬───────────────┘
        │ tails / subscribes                                       │
        ▼                                                          ▼
   Codex · OpenCode · T3                            Postgres (+pgvector)
```

## The spine: `DotState` contract

The runtime emits this; the avatar consumes it and nothing else. Keep the three
axes **independent** — an emotion change must not restart speech, and an activity
change must not clobber emotion.

```ts
type Activity =
  | 'idle' | 'listening' | 'thinking' | 'working'
  | 'speaking' | 'waiting_approval' | 'done' | 'error';

type Emotion = 'neutral' | 'happy' | 'curious' | 'concerned' | 'focused';

interface DotState {
  activity: Activity;
  emotion: Emotion;
  speech?: { viseme: string; energy: number }; // drives mouth/ripple only
  progress?: number;                            // 0..1 while working
  label?: string;                               // "Reading 3 sources…"
  connection?: 'online' | 'reconnecting' | 'offline'; // client-side only
}
```

`connection` is the one client-owned field: the dot should visibly degrade when
the link to the online brain drops, rather than freezing as if thinking.

Renderer is swappable behind this contract: start **code-drawn SVG/canvas**
(closest to the Grok orb, no design tooling), keep **Rive** as an option if a
designed mascot is wanted later. Respect `prefers-reduced-motion`.

## Runtime loop (server, online)

1. **Trigger** — scheduler wakes a due task, or the client sends a message.
2. **Claim** — a worker atomically claims the task (`FOR UPDATE SKIP LOCKED`).
3. **Assemble** — persona + retrieved long-term memory + task + recent steps.
4. **Act** — stream a model call; parse tool calls.
5. **Gate** — policy engine decides auto-allow vs. require approval.
6. **Observe** — execute the tool, append the result, repeat from 4.
7. **Emit** — every step is persisted and fanned out over SSE to any connected
   client.
8. **Report** — on completion or gate, push a native notification.

## Desktop client concerns

- **Device auth** — browser-based login / device-code flow → refresh token stored
  in the OS keychain, never on disk in plaintext.
- **Reconnect + replay** — on reconnect, replay missed `events` so the client
  catches up instead of losing state.
- **Offline queue** — messages composed while offline queue locally and send on
  reconnect.
- **Native notifications** — the primary report-back path, since the client may
  be closed when a long task finishes.
- **Autostart + update channel** — launch at login, auto-update via the Tauri
  updater.
- **Floating window** — a transparent, borderless, always-on-top webview for the
  dot; a normal window for chat. Tray icon is the always-present anchor.
- **Always-on watcher** — the harness watcher runs on the Rust side, so it keeps
  watching even when the window is hidden.

## Local tool bridge (M7)

Because the brain is remote, letting the dot act on your machine means the server
must be able to ask the client to run local actions. That is a
remote-code-execution surface by definition, so it gets explicit design.

**Transport.** A persistent **WebSocket** from client to server, authenticated
with the device token, carrying request/response frames:

```jsonc
// server -> client
{ "id": "req_1", "action": "open_app", "args": { "name": "notepad" }, "deadlineMs": 5000 }
// client -> server
{ "id": "req_1", "ok": true, "result": { "pid": 4321 } }
```

**Capability model.** The client advertises a manifest of the actions it
supports. The server's policy engine can only request advertised actions, and the
user allow-lists them in settings. The model can never expand its own permission
set.

**Action tiers.**

| Tier           | Examples                                                            | Default                    |
| -------------- | ------------------------------------------------------------------- | -------------------------- |
| Read / safe    | screenshot, list windows, read clipboard, read file in allowed dir   | auto-allow (opt-in)        |
| Side-effecting | open app/URL, write file, type text, hotkey, click                   | confirm                    |
| Dangerous      | local shell exec, read credentials, act inside other apps            | explicit per-app opt-in    |

**Trust rules.**

- The **user confirmation dialog is rendered by the client**, never the server —
  otherwise a prompt-injected model could approve its own action.
- TLS to the server; the client verifies it is talking to *your* instance.
- File access is scoped to allow-listed directories; secrets are never returned
  to the server as tool output.
- Every request is audited: which run/step asked, action, args, outcome.

**Kill switch.** A global hotkey revokes all local permissions instantly and
disconnects the bridge. Rate limits and per-action timeouts apply.

**Implementation.** The Rust side — not the webview — owns OS APIs (`enigo` for
input, native APIs for windows/screenshots) so the bridge doesn't run with
webview-level privileges.

## Harness observability (M8)

Doty watches the other AI coding agents running on your machine, shows their live
activity, and becomes **aware** of them — so it can tell you what your agents are
doing and nudge you when something finishes, fails, or gets stuck.

**There is no universal watcher.** Each harness persists work differently, so this
is a per-harness **adapter** problem feeding one normalized stream. Prior art to
borrow from rather than reinvent: `autonomous-harness` (one TS normalizer per
harness), `harness-cli` (spawns a harness, emits unified NDJSON), and
`claude-code-trace` (Tauri + React + live tailing — nearly our stack).

### Adapters (start here)

| Harness      | Capture                                                                 | Confirmed on this machine (2026-10-05) |
| ------------ | ----------------------------------------------------------------------- | -------------------------------------- |
| **Codex**    | Tail `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`                     | **Plain JSONL, zero `.zst` files** (cli 0.159.3) — no zstd decoding needed. First line is `session_meta` carrying `cwd`, `session_id`, `originator`, `cli_version`. |
| **OpenCode** | Prefer its server SSE (`/event`); fall back to reading `~/.local/share/opencode/opencode.db` (SQLite) | No `serve` daemon listening right now, but the local SQLite store exists — so watching works without requiring a running server. |
| **T3 Code**  | Read `~/.t3/userdata/statev2.sqlite`, or its local API via `server-runtime.json` | ~480 MB SQLite with a **private, undocumented schema → brittle**. Confirm whether `server-runtime.json` exposes a stable API before parsing SQLite. |

> **T3 Code is an aggregator, not a peer.** Codex sessions it launches are tagged
> `originator: "T3 Code"` (free attribution), and it leaves
> `opencode/auth.json.bak-t3-workaround` behind — it drives OpenCode too. So the
> T3 adapter overlaps the other two for T3-launched sessions; standalone Codex /
> OpenCode runs are still captured by their own adapters.

> **Recon (2026-10-05).** Toolchain: Node 26.7, npm 11.19, Rust 1.99 present;
> **no pnpm/bun** → npm workspaces. Codex, OpenCode and Claude Code binaries are
> installed; `dsh` is not.

Deferred: **Claude Code** (`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`,
live-tailable) and **DeepSeek Harness** (`dsh`, persistent session events).

### Normalized event model

Every adapter emits the same shape; nothing downstream knows harness specifics.

```ts
interface HarnessEvent {
  harness: 'codex' | 'opencode' | 't3';
  sessionId: string;
  project?: string;
  ts: number;
  kind: 'session_start' | 'user' | 'assistant' | 'thinking'
      | 'tool_call' | 'tool_result' | 'token_usage'
      | 'approval' | 'error' | 'turn_end' | 'session_end';
  status?: 'running' | 'thinking' | 'tool_calling' | 'waiting_approval'
         | 'idle' | 'done' | 'error' | 'stale';
  tool?: { name: string; args?: unknown };
  tokens?: { input?: number; output?: number };
  text?: string; // LOCAL ONLY — never transmitted
}
```

`stale` is heuristic: a rollout that goes quiet while its process is gone (Codex
writes on every item, so ~2 minutes of silence means it's dead) — important for
accurate "is it still working?" states.

### Satellite dots

Each watched harness is a **small satellite dot orbiting Doty**, carrying its own
status (thinking / tool-calling / waiting-approval / done / error). Click one to
open its live transcript. This turns observability into the product's own visual
language — literally "a team of dots" — instead of a log panel bolted on.

```ts
interface HarnessStatus {
  harness: 'codex' | 'opencode' | 't3';
  sessionId: string;
  project?: string;
  title?: string;
  status: 'running' | 'thinking' | 'tool_calling' | 'waiting_approval'
         | 'idle' | 'done' | 'error' | 'stale';
  lastActivityAt: number;
  tokens?: { input: number; output: number };
}
```

### Privacy: metadata + client-built digest

The brain is online, but your transcripts are not. Raw `text` **never leaves the
machine**; the client renders transcripts locally. What crosses the wire is
metadata plus a **structurally-derived digest** — no LLM needed locally, no code
sent:

```ts
interface SessionDigest {
  harness: 'codex' | 'opencode' | 't3';
  sessionId: string; project?: string; title?: string;
  startedAt: number; endedAt?: number; durationMs?: number;
  turns: number;
  toolCalls: Record<string, number>;   // { "shell": 4, "apply_patch": 9 }
  filesTouched: string[];              // repo-relative
  approvalDecisions: number;
  tokens?: { input?: number; output?: number };
  outcome: 'done' | 'error' | 'interrupted';
  errorExcerpt?: string;               // OPT-IN only
}
```

The online brain narrates the digest in words ("Codex finished the refactor, 9
patches across 4 files, tests failed"). **True content summaries are impossible
without shipping content** — since we agreed no local model, any content-level
summary is an explicit per-harness opt-in excerpt, never a default.

**Two stores.** The client keeps a local read-model (full transcripts stay here;
re-read from the harness's own files). The server stores only metadata + digests.

### Awareness, not coordination

Read-only. On session end / failure / waiting-approval / stale, Doty raises a
native notification and can answer "what are my agents doing?" from its digests.
Doty does **not** launch or steer harnesses — that's M7b (control) territory and
explicitly out of scope here.

## Data model

`users · devices · dots(name, avatar, persona, autonomy, budget) · goals · tasks ·
runs · steps · artifacts · memories · integrations · credentials · approvals ·
schedules · notifications · local_actions · harness_sessions(metadata, digest) ·
harness_status · events`

Raw transcripts are **not** in this list — they never reach the server.

`events` is the append-only log that lets a reconnecting client replay anything
it missed — this is why SSE + DB beats a raw WebSocket.

## Tools

Start small and grow through **MCP**, which is how the originals claim thousands
of apps without thousands of bespoke integrations:

- web search + fetch (read)
- MCP client (apps, scoped by OAuth grants)
- artifacts (files/links produced)
- managed sandbox: code execution + headless browser (M6)
- local tools via the desktop bridge (M7)
- harness awareness: query your own digests (M8)

## Stack

- **Online service:** Next.js (App Router, TypeScript) for API, or a plain
  Fastify API — plus a **separate Node worker** for the always-on runtime.
- **Postgres + Drizzle ORM + pgvector** — everything durable, incl. memory.
- **pg-boss** — Postgres-backed job queue; no Redis until actually needed.
- **SSE** for live updates, replayable from `events`; **WebSocket** for the local
  bridge.
- **OpenAI SDK** pointed at any OpenAI-compatible `baseURL`.
- **E2B / Daytona / Fly Machines** for the sandbox; **`@modelcontextprotocol/sdk`**
  for integrations.
- **Desktop client:** **Tauri v2** — webview UI (avatar) + Rust side for OS-level
  actions and the harness watcher (`notify` for file tailing, `zstd` for Codex,
  an SSE client for OpenCode/T3).
- Single-user auth: one account; schema stays multi-user-shaped so it can grow.

## Milestones

| #   | Milestone              | Deliverable                                                          | Exit criteria                                        |
| --- | ---------------------- | -------------------------------------------------------------------- | ---------------------------------------------------- |
| M0  | Foundation             | Server scaffold, schema, auth, `DotState`, SSE; Tauri shell boots    | Desktop app opens and shows a static dot             |
| M1  | Character + presence   | Floating dot + tray, avatar morphs across states, native notifs, chat| It *feels* like the reference on your desktop        |
| M2  | Agent loop + tools     | ReAct loop, function calling, web/HTTP tools, live run view          | Dot completes a real multi-step task you can watch   |
| M3  | Always-on              | Worker, scheduler (interval + wall-clock), report-back, reconnect    | Close the app; work finishes and notifies you anyway |
| M4  | Memory + personality   | Long-term preference store, per-dot persona/avatar, feedback loop    | Dot improves on repeat work / remembers preferences  |
| M5  | Connections + approvals| MCP integrations, policy engine, approvals inbox                     | Dot can act in a real app, gated where it should be  |
| M6  | Cloud computer         | Managed sandbox: code exec + headless browser                        | Dot can build/run something unattended, safely       |
| M7a | Local bridge — reads   | WebSocket protocol, capability manifest, read-only actions, audit    | Dot can see the screen when asked, no side effects   |
| M7b | Local bridge — control | Input control (mouse/keyboard), app interaction, kill switch         | Dot can act on your machine; hotkey revokes instantly|
| M8a | Harness watch          | Watcher core + Codex/OpenCode/T3 adapters, live viewer, satellites   | See every harness's live session as orbiting dots    |
| M8b | Harness awareness      | Client-built digests → server, notifications, "what's running?"      | Ask the dot what your agents are doing, from words   |

**Ordering note:** M8a is read-only and has no approval surface, so it can be
built early — it does not depend on M7b.

## Guardrails (build in early, not later)

- **Cost** — per-dot token/task budget, per-run max steps and wall-clock,
  concurrency cap, global kill switch. Always-on agents spend money while you
  sleep; enforce this at M3, not after the first surprise bill.
- **Security** — credentials encrypted at rest and **never** placed in model
  context; the model gets capabilities, not secrets. Tool output is untrusted
  input, so the **policy decision happens in code, server-side** — never trust
  the model to police itself against prompt injection.
- **Local bridge** — allowed actions originate from the client's manifest and the
  user's allow-list, never from the model. Confirmation UI is client-rendered;
  the bridge is killable at any moment.
- **Harness privacy** — raw transcripts never leave the machine. Only metadata +
  client-built digests are transmitted; content excerpts are opt-in per harness.
  Watching requires explicit per-harness consent.
- **Harness secrets** — the watcher must never read or transmit
  `~/.t3/userdata/secrets/`, `~/.t3/userdata/clerk-tokens.json`, or
  `~/.local/share/opencode/auth.json`.
- **Sandbox egress** — deny by default; allow-list what a dot may reach.
- **Auditability** — every step persisted; every gated action records who
  approved it, including local actions.

## Repo layout (proposed)

```
apps/desktop/            Tauri v2 client — webview UI (avatar) + Rust side
  src-tauri/crates/harness/   watcher + per-harness adapters (Rust)
apps/server/             API + worker (online brain)
packages/dot-state/      shared DotState + AvatarStateMachine types
packages/harness-events/ shared HarnessEvent / HarnessStatus / SessionDigest
packages/db/             schema + migrations
packages/agent/          agent loop, tools, policy, memory
docs/                    this plan
```

## Open questions

- Which OpenAI-compatible provider is the default (OpenAI / xAI / OpenRouter / local)?
- Embeddings for memory: same provider, or a dedicated small local model?
- Approvals when the client is closed: rely on the queue + notify on next open,
  or add web push / a phone channel?
- Persona: one hardcoded character at M1, or user-named/avatar-picked from the start?

### Resolved (2026-10-05) — see `docs/recon-adapters.md`

- **T3 Code has no discoverable local API.** Every probed HTTP path returns the SPA
  catch-all. Parse `statev2.sqlite` **read-only**, reading the
  `orchestration_v2_projection_*` tables, behind a `sqlite_master` schema guard.
- **OpenCode: read the DB, not SSE.** `opencode.db` is always present; use the v2
  `session_v2 → session_message` path ordered by `seq`, poll WAL-safely, fall back
  to v1 `session → message → part`. Attach to `serve` SSE only if a daemon exists.
- **Tauri toolchain confirmed present** — MSVC Build Tools 18 (`link.exe`), Windows
  SDK 10.0.26100, WebView2 154.x. Builds run from a VS Developer prompt.
- Both stores are private/versioned: feature-detect the schema and emit nothing on
  mismatch rather than guessing.
```
