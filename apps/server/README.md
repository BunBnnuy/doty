# Agent runtime

Run the server with `npm -w @doty/server run dev`. Set these environment variables
in your shell (or your existing local dotenv configuration; never commit secrets):

- `OPENAI_MODEL`: required to enable model runs.
- `OPENAI_BASE_URL`: OpenAI-compatible API root, including `/v1` when needed;
  defaults to `https://api.openai.com/v1`.
- `OPENAI_API_KEY`: provider credential; optional for unauthenticated local APIs.
- `DOTY_TOKEN`: bearer token required by `POST /message` and `GET /events`.
- `DATABASE_URL`: optional Postgres connection string; when set, the server uses
  `PgEventLog` and the existing `events` table for replay and persistence.
- `DISCORD_BOT_TOKEN`: optional; enables the Discord integration (receive and
  reply with the agent).
- `DISCORD_ALLOWED_USER_IDS`: comma-separated Discord user ids allowed to talk to
  Doty (empty = anyone; the server logs a warning).
- `DISCORD_CHANNEL_ID`: optional; restrict guild replies to this one channel.
- `DISCORD_MENTION_ONLY`: set `false` to answer every guild message instead of
  only messages that mention the bot.

Without `DOTY_TOKEN`, bearer authentication is disabled for local development and
the server logs a prominent warning. **Do not expose that mode publicly.** When
configured, send `Authorization: Bearer <DOTY_TOKEN>` on both `/message` and the
SSE `/events` connection. The token is never logged. `/message` retains its
existing `202 Accepted` response.

Without `OPENAI_MODEL`, `/message` keeps its original event-only behavior.
`buildApp({ agent: { provider, tools?, persona?, maxSteps? } })` injects a provider
for tests or another worker. Constructing the app never calls the network.

Send `POST /message` with `{"text":"What time is it?"}`. The immediate `202`
response includes `runId`; watch `GET /events` for that run's `run_started`,
`model_step`, `assistant_delta`, `tool_call`, `policy_decision`, `observation`,
`final`, and `run_finished` events. `dot_state` events also drive the existing
avatar contract. Reconnect using `Last-Event-ID` to replay missed steps.

The default limit is **8 model turns**, including the final-answer turn. A run
ending at the limit has status `max_steps`, not a fabricated answer. Tool errors
become observations so the model can recover; provider errors end the run.

## Policy and tools

- `now`: auto-allowed read.
- `http_fetch`: auto-allowed HTTP(S) GET, with private-address and redirect checks,
  a 15-second fetch timeout, and a 1 MB output cap. No model-supplied headers,
  credentials, method, or body. Tool text is untrusted data.
- `artifact_write`: side effect; **pauses with `requires_approval` without writing**.
  The implementation creates immutable files below a lazily allocated temporary
  `doty-artifacts-*` directory, never an arbitrary model-supplied path.
- Dangerous, unknown, or unclassified tools are denied. Classification is owned
  by the server registry, never by model arguments.

Approval UI/resumption, artifact download/retention, persistence, scheduling,
and global concurrency/cost budgets are not implemented. Without `DATABASE_URL`,
the runner uses the process-local in-memory EventLog. With Postgres configured,
history is hydrated before listening, writes are persisted to `events`, and a
poller discovers newly inserted rows. The synchronous `EventLog` contract means
in-process appends are queued for database writes and flushed on orderly shutdown;
use a single server writer, and note that an abrupt process crash can lose writes
still in that queue. For deployment, enforce network egress restrictions: DNS
preflight checks alone do **not** prevent DNS rebinding between validation and
native fetch.

## Offline verification

```text
npm -w @doty/server run test
npm -w @doty/server run typecheck
```

Runtime tests use a mock provider; provider transport tests use in-memory SSE
responses; HTTP tool tests mock both DNS and fetch. No live API or database is used.

## Optional long-term memory

The entrypoint enables memory only when `DATABASE_URL`, `OPENAI_MODEL`,
`OPENAI_EMBED_MODEL`, and `DOTY_DOT_ID` are set. `DOTY_DOT_ID` must identify an
existing row in `dots`. Apply the migrations in `apps/server/drizzle` first.
Migration `0001_memory_vector.sql` requires the Postgres pgvector extension.
The database user must have permission to enable that extension, or an
administrator must enable it first.

`OPENAI_BASE_URL` and `OPENAI_API_KEY` also configure the fetch-based embeddings
client. Memory remains disabled when the memory settings are absent. App
construction does not call the network. Tests inject `InMemoryMemoryStore` and
`MockEmbedder`; the mock uses deterministic token hashes, not semantic embeddings.

Workers can import these APIs from `src/memory/index.ts`:

```ts
const memory = new AgentMemory({ store, embedder, dotId, topK: 5 });
await memory.remember('preference', 'Use short answers.');
const matches = await memory.retrieve('How should I answer?');
buildApp({ agent: { provider, memory } });
```

`MemoryStore.store` accepts dot ID, kind, text, vector, and embedding model.
`MemoryStore.search` returns top-k matches with cosine similarity. Searches
exclude other dots, other embedding models, and vectors with different dimensions.
The pgvector column permits different dimensions; retrieval uses an exact scan.
Legacy JSON vectors are converted by the migration. Their model remains unset,
so they must be embedded again before retrieval can use them.

The runtime adds retrieved memories after the persona and before recent history.
It marks them as untrusted reference data. Empty or disabled memory adds no
context. A failed retrieval emits `memory_unavailable` and lets the task continue;
cancellation still stops the run. Memory text is not added to that event.
There is no automatic memory extraction, HTTP memory route, or model memory tool.
Only explicit `remember` calls store text. Watched-agent reasoning, replies and
finish notices are shared with the server by explicit product decision (see
`routes/harness.ts`); secrets are never transmitted.

## Discord integration

With `DISCORD_BOT_TOKEN` set (and a model configured), the server connects to the
Discord gateway and answers messages:

1. Create a Discord application and bot, and copy its token.
2. Enable the **MESSAGE CONTENT** privileged intent in the developer portal.
3. Invite the bot to your server (or just DM it).
4. Set `DISCORD_BOT_TOKEN` (and optionally `DISCORD_ALLOWED_USER_IDS` /
   `DISCORD_CHANNEL_ID`) in the server environment, then restart.

The bot ignores other bots, strips its own mention, sends a typing indicator, and
splits replies over 2000 characters. It uses the built-in `WebSocket` and `fetch`
— no `discord.js` dependency. Incoming text is appended to the event log as a
`message` event, so it also appears in the desktop chat.

**Conversation memory.** Doty keeps a bounded window of recent turns per
conversation — one scope per DM user (`discord:dm:<userId>`) and one per guild
(`discord:guild:<guildId>`) — and prepends it to the model context, so it
remembers what was said. Turns are stored as `conversation_turn` events (ignored
by the desktop chat), so the memory survives restarts without a new table.
