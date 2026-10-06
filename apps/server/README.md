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
- `OPENCODE_SERVER_URL`: when set, all runs are delegated to a local
  `opencode serve` (which owns the conversation history); otherwise the
  in-process OpenAI-compatible loop is used.
- `OPENCODE_MODEL`: `provider/model` for OpenCode (default
  `opencode-go/deepseek-v4.1-flash`).
- `OPENCODE_AGENT`: optional OpenCode agent name (e.g. `build`).
- `DISCORD_BOT_TOKEN`: optional; enables the Discord integration (receive and
  reply with the agent).
- `DISCORD_ALLOWED_USER_IDS`: comma-separated Discord user ids allowed to talk to
  Doty (empty = anyone; the server logs a warning).
- `DISCORD_CHANNEL_ID`: optional; restrict guild replies to this one channel.
- `DISCORD_TRIGGER_WORDS`: comma-separated words that trigger a reply (default
  `doty,bot`).
- `DOTY_SHARED_SESSION_USER_IDS`: comma-separated Discord user ids whose DMs
  continue the desktop (`desktop`) session instead of a per-user one, so the
  same conversation history is shared across clients.
- `DOTY_CRED_KEY`: base64, 32 bytes. Encrypts OAuth tokens at rest; with
  `DATABASE_URL` it enables the email integrations.
- `DOTY_PUBLIC_URL`: public origin used to build OAuth redirect URIs (default
  `https://doty.killbunny.top`).
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`: Google OAuth web client with the
  Gmail API enabled (`gmail.readonly`).
- `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` / `MICROSOFT_TENANT_ID`:
  Entra app registration (`Mail.Read`, `User.Read`, `offline_access`); the
  tenant defaults to `common`.
- `DOTY_TZ`: IANA zone for schedules and reminders (default
  `America/Mexico_City`).
- `DOTY_DISCORD_USER_ID`: Discord user that receives scheduled DMs; falls back
  to the first id in `DOTY_SHARED_SESSION_USER_IDS` / `DISCORD_ALLOWED_USER_IDS`.

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

## Email integrations (Gmail + Microsoft 365)

Read-only mailbox access for the agent. Enabled when `DATABASE_URL` and
`DOTY_CRED_KEY` are set; each provider is independent, so a missing client
id/secret pair simply reports `configured: false` in status. **Multiple
mailboxes per provider are supported** — each connected account has an id and
an account email; `account` selects one (an email address or the id), and with
a single mailbox it can be omitted. Selecting an account when several match
returns `409 ambiguous_account` with the candidates.

```text
POST   /integrations/:provider/connect    → { url }  (bearer; open in a browser)
GET    /integrations/:provider/callback   → consent redirect target (public, state-signed)
GET    /integrations                      → providers + connected accounts (bearer)
DELETE /integrations/:target              → disconnect an account id or provider (bearer)
GET    /email/list?account=&provider=&query=&limit=10  → message summaries (bearer)
GET    /email/read?account=&provider=&id=              → one plain-text body (bearer)
```

- Tokens: refresh tokens are sealed with AES-256-GCM (`DOTY_CRED_KEY`) before
  touching Postgres; access tokens live only in server memory. Microsoft
  rotates refresh tokens on every refresh — the new value is always persisted.
- Scopes: Gmail `gmail.readonly`; Microsoft `Mail.Read` + `User.Read` +
  `offline_access`. Nothing here can send or modify mail.
- Email bodies are **untrusted input**: they are data, never instructions. The
  policy treatment lives in the tool descriptions (HTTP and MCP); no layer
  executes requests found inside a message.
- OAuth `state` is HMAC-signed under the same key and expires after 60 minutes;
  the callback is the only public route and only accepts a valid `state`.

OpenCode (the production agent backend) gets these tools through the stdio MCP
server in `src/mcp/email-mcp.ts` (email + schedule tools below). It proxies to
the guarded HTTP routes with `DOTY_TOKEN`, so the shim never sees mailbox
tokens. Example OpenCode config (`~/.config/opencode/opencode.jsonc`):

```jsonc
{
  "mcp": {
    "doty": {
      "type": "local",
      "command": [
        "/home/ubuntu/doty/node_modules/.bin/tsx",
        "/home/ubuntu/doty/apps/server/src/mcp/email-mcp.ts"
      ],
      "environment": { "DOTY_ENV_FILE": "/home/ubuntu/doty/.env" },
      "enabled": true
    }
  }
}
```

## Schedules (conversational automations)

Routines are created by talking to the agent, not in code: the user asks
"envíame el resumen de mis correos todos los días a las 6 am" and the agent
calls `schedule_daily` with a self-contained prompt (for example, "resume los
correos recibidos ayer de todas las cuentas y redáctalo en español"). Firing
runs that prompt through the same agent; the reply lands in the Doty chat (run
events) and goes out as a Discord DM unless `deliver: "doty"`.

```text
GET    /schedules        → active routines + next occurrence (bearer)
POST   /schedules        → { prompt, time: "HH:MM", deliver?, timeZone? } (bearer)
DELETE /schedules/:id    → cancel (bearer)
```

- MCP tools: `schedule_daily`, `schedule_list`, `schedule_cancel`.
- Event-sourced like reminders (`schedule_created` / `schedule_cancelled` /
  `schedule_fired`), so restarts rebuild the active set; a routine fires at
  most once per local day (`DOTY_TZ`).
- `email_list` accepts `since`/`until` (`yesterday`, `today`, `YYYY-MM-DD` or an
  ISO date-time) so date-bounded summaries are exact across providers.
- Discord delivery requires a target user: `DOTY_DISCORD_USER_ID`, falling back
  to the first id in `DOTY_SHARED_SESSION_USER_IDS` / `DISCORD_ALLOWED_USER_IDS`;
  without Discord the routine still lands in the Doty chat.

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

**When it replies.** DMs always get a reply. In a guild, Doty answers only when
the message mentions it, replies to one of its messages, or contains a trigger
word (`doty`/`bot` by default, configurable with `DISCORD_TRIGGER_WORDS`). Plain
guild messages are ignored — which also means the `MESSAGE_CONTENT` intent is only
needed for the trigger-word path; mentions and replies carry content regardless.

**Conversation memory.** When the OpenCode backend is enabled, each conversation
gets its own OpenCode session — one per DM user (`discord:dm:<userId>`), one per
guild (`discord:guild:<guildId>`), and one for the desktop (`desktop`) — and Doty
only stores the session id (as `conversation_session` events). The history lives
in OpenCode and is continued by posting to that session, so it survives restarts
without Doty re-sending past turns. DMs from users listed in
`DOTY_SHARED_SESSION_USER_IDS` reuse the desktop session instead, so Discord and
the desktop client keep one shared memory.

**Music (voice).** In a server, Doty can join your voice channel and play YouTube
audio: `doty play <url|search>`, `doty skip`, `doty stop` (leave), `doty pause`,
`doty resume`, `doty queue`. Requires `yt-dlp` and `ffmpeg` on the host plus the
`@discordjs/voice` + `libsodium-wrappers` + `opusscript` dependencies. It uses the
`GUILD_VOICE_STATES` intent to find your channel.

YouTube blocks many datacenter IPs ("Sign in to confirm you're not a bot"). Set
`YTDLP_COOKIES=/path/cookies.txt` (a Netscape cookies export from a logged-in
browser) to use YouTube, or point `YTDLP_SEARCH` at another source — e.g.
`scsearch1:` for SoundCloud, which works without cookies. `YTDLP_EXTRA_ARGS`
passes extra yt-dlp flags.

**Speech (TTS).** When Doty is in a voice channel it also *speaks* its replies
using local `piper`. `doty join` makes it join without music, and `doty say <text>`
makes it say something. Configure `PIPER_BIN` (the piper executable) and
`PIPER_VOICE` (an `.onnx` voice).
