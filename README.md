<img src="assets/icon.svg" width="64" height="64" alt="">

# Doty

An always-on AI assistant with a characterful animated dot — the pattern
popularized by **ChatGPT dots** and **Grok Bot**: an agent that keeps working
between conversations, fronted by a dot that reflects what it is doing.

The thing worth building is not the chatbot. It is an animated avatar that
communicates state, and an agent that runs without you watching.

- **Brains are online** — a Fastify API and worker (`apps/server`) that owns the
  agent loop, scheduler, memory and integrations.
- **The desktop client is a thin presence layer** — a Tauri v2 app
  (`apps/desktop`) with a transparent, always-on-top floating dot, a tray anchor,
  chat, native notifications and local harness observability.
- **Three frozen contracts** are the seam between the two halves:
  `@doty/dot-state`, `@doty/harness-events` and `@doty/protocol`.

`docs/PLAN.md` is the source of truth for the product and its milestones.

## Status

Early build. In place today: the agent loop (OpenCode or an in-process
OpenAI-compatible loop), long-term memory, the Discord bot (chat, voice music,
speech, scheduled reminders), the Rust harness watchers, and the desktop dot.
Planned: managed sandbox, the local tool bridge and approvals. See
`docs/PLAN.md` for the milestone table.

## Architecture

```
   Desktop client (Tauri v2)                 Online service (Node)
   ─────────────────────────                 ─────────────────────
   floating dot · tray · chat  ◀──REST/SSE──▶  Fastify API + worker
   native notifications                        agent loop · scheduler
   harness watcher (Rust) ──metadata+digest──▶  policy · memory
                                               Discord · voice · tools
        │                                              │
   local harnesses                             Postgres (+ pgvector)
   (Codex · OpenCode · T3)                    events · memories · ...
```

- The dot is rendered by `@doty/avatar` on the shared `@doty/dot-state` store;
  the server pushes state over SSE, and the local fake driver keeps it alive
  while the stream is down.
- Watched harnesses (Codex, OpenCode, T3) are normalized to
  `@doty/harness-events`; the Rust watcher in `crates/harness` mirrors that
  contract. Watched-agent reasoning and replies are shared to the server by
  explicit product decision; secrets are never transmitted.

## Repository layout

```
apps/server       Fastify API + agent runtime (the online brain)
apps/desktop      Tauri v2 client — floating dot, tray, chat, harness watcher
packages/avatar           @doty/avatar — the character renderer
packages/dot-state        @doty/dot-state — activity/emotion/speech contract
packages/harness-events   @doty/harness-events — normalized harness events
packages/protocol         @doty/protocol — client <-> server wire types
crates/harness            doty-harness / doty-watch — Rust harness watchers
crates/local-bridge       doty-local-bridge — local tool bridge (placeholder, M7)
docs/                     PLAN.md (source of truth) and recon notes
assets/                   icon
```

## Prerequisites

- **Node.js >= 22** and npm (this is an npm-workspaces monorepo).
- **Rust + Tauri v2 prerequisites** — only for the desktop client. On Windows:
  MSVC Build Tools and the WebView2 runtime.
- Optional: **Postgres with pgvector** (durable event log and memory),
  **`ffmpeg` + `yt-dlp` + `piper`** (Discord music and text-to-speech).

## Getting started

```bash
npm install

# The apps import the shared packages from their built `dist/`, so build them
# first. These are type-only contracts compiled with tsc.
npm run build:contracts        # @doty/dot-state, @doty/harness-events, @doty/protocol
npm -w @doty/avatar run build  # @doty/avatar (needed by the desktop webview)
```

Run the server (see `apps/server/README.md` for the full environment list):

```bash
npm -w @doty/server run dev    # http://localhost:8787
```

Run the desktop client (needs a desktop session):

```bash
npm -w @doty/desktop run dev
```

Webview only, without the Tauri shell — from `apps/desktop`:

```bash
npx vite                       # http://localhost:1420
```

## Verify

```bash
npm run typecheck              # every workspace
npm test                       # every workspace's vitest suite
```

Per workspace: `npm -w @doty/server run typecheck`, `npm -w @doty/desktop run test`, etc.

## Contracts (frozen)

| Contract | Package | Consumers |
| --- | --- | --- |
| `DotState` | `@doty/dot-state` | avatar, desktop |
| `HarnessEvent`, `HarnessStatus`, `SessionDigest` | `@doty/harness-events` | watcher (Rust mirror), server |
| Wire protocol (`ServerEvent`, `ClientToServer`, bridge frames) | `@doty/protocol` | server, desktop |

Treat them as frozen. The Rust mirror in `crates/harness` must stay
field-compatible with `@doty/harness-events`.

## Features at a glance

- **Chat + agent loop** over REST/SSE; every step is persisted and the avatar is
  driven by `dot_state` events.
- **Discord** — answers DMs, mentions and replies, keeps one conversation per
  scope, supports scheduled reminders, and joins voice for music and TTS.
- **Harness observability** — Codex, OpenCode and T3 sessions appear as orbiting
  satellite dots with live status, and as messages in the chat.
- **Long-term memory** — optional, pgvector-backed, retrieved per run.

Details live in `apps/server/README.md` and `apps/desktop/README.md`.

## Security notes

- Never commit secrets. Local `.env` files and yt-dlp `cookies.txt` are
  git-ignored; keep it that way.
- Without `DOTY_TOKEN` the API runs **unauthenticated** (development only) — do
  not expose it publicly.
- The local tool bridge (M7) and approvals are not implemented yet, so the
  desktop client cannot act on your machine.

## Documentation

- `docs/PLAN.md` — design and build plan (source of truth).
- `apps/server/README.md` — runtime, tools, memory, Discord.
- `apps/desktop/README.md` — the shell, harness watchers and T3 questions.

---

Created in [T3 Code](https://t3.codes).
