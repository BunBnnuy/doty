# Harness Adapter Recon — SA-5

Read-only reconnaissance for the M8a harness adapters (OpenCode, T3 Code) plus the
Windows/Tauri toolchain. Grounds the two open questions in `docs/PLAN.md`
("T3: API vs. SQLite", "OpenCode: SSE vs. DB") with what actually exists on this
machine as of **2026-10-05**.

> Privacy: no secret file was read. `~/.local/share/opencode/auth.json`,
> `~/.t3/userdata/clerk-tokens.json`, and `~/.t3/userdata/secrets/` were never
> opened. Only metadata/JSON *keys* were inspected — no transcript `text` values
> are reproduced here.

---

## 1. OpenCode

**DB:** `C:\Users\beton\.local\share\opencode\opencode.db` (1,161,826,304 bytes, WAL mode)
Sidecars: `opencode.db-wal` (~36 MB), `opencode.db-shm`. WAL means concurrent
readers are safe; it is **not** a plain immutable file (a `mode=ro` read still
replays the WAL).

### Tables (25)

`account, account_state, control_account, credential, event, event_sequence,
instruction_blob, instruction_entry, instruction_state, kv, message, migration,
part, permission, project, project_directory, session, session_inbox,
session_message, session_pending, session_share, session_v2, todo, workspace,
worktree`

Row counts (this machine): `message` 4266 · `part` 17624 · `session` 103 ·
`session_v2` 115 · `session_message` 4794 · `todo` 120 · `event` 0 ·
`migration` 48.

There are **two coexisting generations** of the session model:

#### v1 (legacy, still populated) — `session` → `message` → `part`

```sql
CREATE TABLE "session" (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT,
  parent_id TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL, path TEXT,
  title TEXT NOT NULL, version TEXT NOT NULL, share_url TEXT,
  summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
  summary_diffs TEXT, metadata TEXT,
  cost REAL NOT NULL DEFAULT 0,
  tokens_input INTEGER NOT NULL DEFAULT 0, tokens_output INTEGER NOT NULL DEFAULT 0,
  tokens_reasoning INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read INTEGER NOT NULL DEFAULT 0, tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  revert TEXT, permission TEXT, agent TEXT, model TEXT,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
  time_compacting INTEGER, time_archived INTEGER,
  FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
);

CREATE TABLE "message" (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
  data TEXT NOT NULL,                          -- JSON
  FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
);
CREATE INDEX message_session_time_created_id_idx ON message(session_id, time_created, id);

CREATE TABLE "part" (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
  data TEXT NOT NULL,                          -- JSON
  FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE
);
CREATE INDEX part_message_id_id_idx ON part(message_id, id);
CREATE INDEX part_session_idx     ON part(session_id);
```

Relation: `session 1─* message 1─* part`. `message` carries role/usage and `part`
carries the streamed content blocks.

#### v2 (current) — `session_v2` → `session_message`

`session_v2` adds `fork_session_id, fork_boundary, time_suspended,
resume_attempts, time_idle, time_viewed, idle_outcome` over `session`.
`session_message` is a single flattened, event-sourced log (no separate parts):

```sql
CREATE TABLE session_message (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
  seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
  data TEXT NOT NULL,                          -- JSON
  FOREIGN KEY (session_id) REFERENCES session_v2(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX session_message_session_seq_idx       ON session_message(session_id, seq);
CREATE INDEX        session_message_session_type_seq_idx  ON session_message(session_id, type, seq);
CREATE INDEX        session_message_session_time_created_id_idx ON session_message(session_id, time_created, id);
```

Also tied to `session_v2`: `session_inbox` (0 rows), `session_pending` (0 rows),
`instruction_entry`, `session_message`, `session_share` (references v1 `session`).

**Coverage:** all 103 v1 sessions exist in v2 (`session ∩ session_v2 = 103`);
**12 sessions exist only in `session_v2`** (`message`/`part` have nothing for
them). Live OpenCode on this machine is writing **v2**, so the adapter should
read v2 first.

### JSON shapes (keys only)

`message.data` variants:
- `{agent, model, role, summary, time}` (user/summary)
- `{agent, cost, finish, mode, modelID, parentID, path, providerID, role, time, tokens[, variant]}`
  (assistant; `tokens` is the usage object)

`part.data.type` values seen: `text`, `reasoning`, `step-start`, `step-finish`,
`tool`, `patch` — the `tool` part carries `{callID, tool, state[, metadata]}`;
`step-finish` carries `{cost, reason, tokens}`.

`session_message` is ordered by `seq` per session; `type` ∈
`user | assistant | synthetic | system | idle | model-switched |
location-switched`. `data` shapes by type:
- `user`: `{text, time[, files][, agents]}`
- `assistant`: `{agent, model, content, time, tokens, … cost, finish, snapshot,
  rawFinish, error}` (`content` is the block array mirroring v1 parts)
- `idle`: `{outcome, time}` · `model-switched`: `{model, previous, time}` ·
  `system`: `{description, metadata, text, time}`

`session.model` is `TEXT` holding JSON (`{"id","providerID"[,"variant"]}`).

### OpenCode recommendation

- **Read the DB; it is always present.** `opencode serve` was not listening, and
  the DB is the durable source. Prefer SSE only if a daemon is detected.
- **Use the v2 path:** iterate `session_v2` ordered by `time_updated`, then
  `session_message` ordered by `seq`. Keep the v1 `message`/`part` path as a
  fallback for older sessions (or when `session_message` is empty).
- **Tailing WAL SQLite:** `notify` on the main DB is unreliable because writes
  land in `-wal`. Simplest robust approach is a short poll of
  `MAX(session_message.seq)` / `MAX(session.message.time_updated)` per session
  (e.g. 500 ms–1 s), optionally using `-wal` mtime as a cheap dirty check.
  Always open **read-only** (`?mode=ro&immutable=0`) so the watcher never blocks
  OpenCode writers.
- **Mapping to `HarnessEvent`:** `user`→`user`; `assistant`→`assistant` +
  `token_usage` (from `tokens`/`cost`) + `thinking` (reasoning blocks);
  `tool` parts →`tool_call`/`tool_result` using `tool`+`state`; `idle.outcome`
  → `turn_end`; session `time_archived`→`session_end`. `text` stays **LOCAL
  ONLY**.
- **Never** read `auth.json`/`auth.json.bak-t3-workaround`.

---

## 2. T3 Code

**Canonical DB:** `C:\Users\beton\.t3\userdata\statev2.sqlite` (504,553,472 bytes)
Legacy: `state.sqlite` (386,310,144 bytes). Both WAL mode (`.sqlite-wal`/`.sqlite-shm`).
Prefer **`statev2.sqlite`** — it has the whole v1 projection *plus*
`orchestration_v2_*` projections and a v2 event log.

### Tables (statev2: 44; state: 19)

`statev2.sqlite` groups:
- **Legacy projection** (`projection_*`): `projection_projects`,
  `projection_threads`, `projection_thread_sessions`,
  `projection_thread_messages`, `projection_turns`,
  `projection_thread_activities`, `projection_thread_proposed_plans`,
  `projection_thread_pull_requests`, `projection_pending_approvals`,
  `projection_state`.
- **v2 orchestration projection** (`orchestration_v2_projection_*`): `threads`,
  `messages`, `runs`, `run_attempts`, `nodes`, `turn_items`, `provider_sessions`,
  `provider_threads`, `provider_turns`, `provider_session_bindings`, `subagents`,
  `metadata`, `plans`, `runtime_requests`, `context_handoffs`,
  `context_transfers`, `projection_checkpoints`,
  `projection_checkpoint_scopes`.
- **Event logs / infra:** `orchestration_events` (**68,109 rows**, live),
  `orchestration_v2_events` (0 rows), `orchestration_v2_effect_outbox` (101),
  `orchestration_v2_legacy_imports` (42), `orchestration_command_receipts`
  (37,918), `orchestration_v2_command_receipts` (0),
  `orchestration_v2_thread_launch_workflows` (0),
  `orchestration_v2_turn_item_positions` (3,004), `checkpoint_diff_blobs`,
  `provider_session_runtime`, `pull_request_files_viewed`, `scheduled_tasks`,
  `auth_*`, `effect_sql_migrations`.

Counts (this machine): threads 42 (v1) / 53 (v2) · messages 1,969 (v1) / 1,853 (v2)
· turns 290 (v1) / runs 49, run_attempts 49 (v2) · turn_items 3,004 ·
activities 26,818 · pending_approvals see table.

### Key schemas

**Legacy projection** (flattened read-model, no JSON for the core fields):

```sql
projection_threads(thread_id PK, project_id, title, branch, worktree_path,
  latest_turn_id, created_at, updated_at, deleted_at, runtime_mode,
  interaction_mode, model_selection_json, archived_at, latest_user_message_at,
  pending_approval_count, pending_user_input_count, has_actionable_proposed_plan,
  settled_override, settled_at, snoozed_until, snoozed_at, …, linked_pull_request_json,
  active_order_key, title_state_json, auto_settle_disabled_at)

projection_thread_sessions(thread_id PK, status, provider_name, provider_session_id,
  provider_thread_id, active_turn_id, last_error, updated_at, runtime_mode,
  provider_instance_id)

projection_thread_messages(message_id PK, thread_id, turn_id, role, text,
  is_streaming, created_at, updated_at, attachments_json, context_json)

projection_turns(row_id PK, thread_id, turn_id, pending_message_id,
  assistant_message_id, state, requested_at, started_at, completed_at,
  checkpoint_turn_count, checkpoint_ref, checkpoint_status, checkpoint_files_json,
  source_proposed_plan_thread_id, source_proposed_plan_id,
  UNIQUE(thread_id, turn_id), UNIQUE(thread_id, checkpoint_turn_count))

projection_thread_activities(activity_id PK, thread_id, turn_id, tone, kind,
  summary, payload_json, created_at, sequence)
```

**v2 orchestration projection** (normative ids + a `payload_json` per row; the
typed columns are queryable):

```sql
orchestration_v2_projection_threads(thread_id PK, project_id, title,
  default_provider, runtime_mode, interaction_mode, active_provider_thread_id,
  created_at, updated_at, archived_at, deleted_at, payload_json, provider_instance_id)

orchestration_v2_projection_messages(message_id PK, thread_id, run_id, node_id,
  role, streaming, created_at, updated_at, payload_json)

orchestration_v2_projection_runs(run_id PK, thread_id, ordinal, provider,
  provider_thread_id, status, requested_at, completed_at, payload_json,
  provider_instance_id)

orchestration_v2_projection_run_attempts(attempt_id PK, thread_id, run_id,
  attempt_ordinal, root_node_id, provider, provider_thread_id, provider_turn_id,
  status, payload_json, provider_instance_id)

orchestration_v2_projection_nodes(node_id PK, thread_id, run_id, parent_node_id,
  root_node_id, kind, status, provider_thread_id, provider_turn_id,
  runtime_request_id, checkpoint_scope_id, started_at, completed_at, payload_json)

orchestration_v2_projection_turn_items(turn_item_id PK, thread_id, run_id,
  node_id, provider_thread_id, provider_turn_id, parent_item_id, ordinal,
  type, status, updated_at, payload_json)
```

Relationship: `thread 1─* run 1─* run_attempt 1─* node 1─* turn_item`, with
messages hanging off `thread`/`run`/`node`. `provider_thread`/`provider_turn`
bind the normalized ids to the upstream provider's own ids.
`orchestration_v2_projection_metadata` = `('thread-projections', schema_version 2,
last_sequence 67125)`.

`payload_json` keys (dicts):
- message: `id, threadId, runId, nodeId, role, text, attachments, context?,
  streaming, createdAt, updatedAt, createdBy, creationSource`
- run: `id, threadId, ordinal, status, startedAt, completedAt, modelSelection,
  providerThreadId, providerInstanceId, activeAttemptId, rootNodeId,
  userMessageId, checkpointId, contextHandoffId, queuePosition[, workspacePreparation]`
- turn_item `type` (the normalized activity stream — 30 distinct shapes seen):
  `user_message, assistant_message, reasoning, command_execution, dynamic_tool,
  file_change, file_search, web_search, todo_list, checkpoint, subagent,
  user_input_request, run_interrupt_request, run_interrupt_result, error,
  notification, …`; each carries `id, threadId, runId, nodeId, ordinal,
  providerThreadId, providerTurnId, status, startedAt, completedAt, type, title,
  nativeItemRef, parentItemId`.
- activity `kind` top: `tool.updated`, `tool.completed`, `tool.started`,
  `context-window.updated`, `checkpoint.captured`, `turn.plan.updated`,
  `user-input.requested/resolved`, `task.*`, `runtime.warning`,
  `checkpoint.capture.failed`; `tone ∈ tool|info|error`.

### Config files (non-secret)

- `server-runtime.json`:
  `{"version":1,"pid":99404,"host":"0.0.0.0","port":3773,"origin":"http://127.0.0.1:3773","startedAt":"2026-10-05T14:16:23.262Z"}`
- `connection-catalog.json`: `{"version":1,"encryptedCatalog":"<opaque base64>"}` —
  **encrypted, contains no usable plaintext** (no tokens leaked).

### Local HTTP API probe (answers PLAN's "API vs SQLite")

`curl` against `http://127.0.0.1:3773` while the server is running:
`/`, `/health`, `/healthz`, `/api`, `/api/health`, `/api/v1/threads`,
`/api/threads`, `/threads`, `/trpc`, `/rpc`, `/openapi.json`,
`/api/openapi.json`, `/events`, `/api/events`, `/api/status` **all return
HTTP 200 with `content-type: text/html`** — i.e. the SPA catch-all serving
`index.html`. No documented/guessable JSON or OpenAPI surface was found. There is
no evidence of a stable, discoverable local REST API; `server-runtime.json` only
advertises host/port, not a schema.

### T3 recommendation

- **Parse `statev2.sqlite` read-only; do not depend on the HTTP API** (probe above
  shows no discoverable stable surface, and the private SPA API is undocumented).
- **Read the `orchestration_v2_projection_*` tables** — they are the normalized,
  already-flattened view, so the adapter does not have to replay raw events.
  Order changes by `orchestration_v2_projection_metadata.last_sequence`, or tail
  the raw `orchestration_events` log (`sequence` — the live one; note
  `orchestration_v2_events` is currently empty).
- **Add a schema guard:** probe `sqlite_master` for expected tables/columns before
  querying; the schema is private and versioned (`effect_sql_migrations`,
  `schema_version 2`). Fail safe to "unknown" rather than guessing if a column
  moves.
- **Map to `HarnessEvent`:** `turn_item.type` is nearly a 1:1 match
  (`command_execution`/`file_*`/`web_search`/`dynamic_tool` → `tool_call` +
  `tool_result`, `reasoning` → `thinking`, `user_message`/`assistant_message` →
  `user`/`assistant`, `checkpoint`/`todo_list` → `token_usage`/status,
  `run_interrupt_*`/`error` → `error`, `user_input_request` → `waiting_approval`).
  `tokens`/`cost` on v2 runs/messages feed `token_usage` and `SessionDigest`.
- Thread `status` (`projection_thread_sessions.status`, run `status`) → `idle`/
  `done`/`error`/`stale`; T3 writes continuously, so apply the PLAN staleness
  heuristic.
- Note T3 is an **aggregator** — it launches Codex/OpenCode. Its own threads
  duplicate those sessions; dedupe by `provider_thread_id`/`provider_session_id`
  where the upstream adapter also sees them.

---

## 3. Toolchain (Tauri v2 on Windows)

| Check | Result |
| --- | --- |
| `rustup show` | default host `x86_64-pc-windows-msvc`; active/only toolchain `stable-x86_64-pc-windows-msvc` |
| `cargo --version` | `cargo 1.99.0 (5f94df478 2026-08-27)` |
| `rustc --version` | `rustc 1.99.0 (b940084d7 2026-09-28)` |
| installed targets | `x86_64-pc-windows-msvc` |
| MSVC linker | **present** — VS 18 **Build Tools** `14.51.36231`; `link.exe` at `C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.51.36231\bin\Hostx64\x64\link.exe` (also x86/x64 variants) |
| Windows SDK | **present** — `C:\Program Files (x86)\Windows Kits\10\bin` with `10.0.26100.0` (plus legacy 14393/15063/16299/17134) |
| WebView2 runtime | **present** — `C:\Program Files (x86)\Microsoft\EdgeWebView\Application\154.0.4258.53`; HKLM pv `154.0.4258.53` |
| Node / npm | `node v26.7.0`, `npm 11.19.0` (matches PLAN recon; npm workspaces) |
| Tauri CLI | not installed globally (`tauri` not on PATH); use the npm `@tauri-apps/cli` dev dependency or `cargo tauri` once added |

**Caveat:** `cl.exe`/`link.exe` are **not on the global PATH** outside a Visual
Studio Developer prompt (expected). `rustc`/`cargo` on the MSVC host generally
locate MSVC via the registry/vswhere, but builds should be run from a **Developer
Command Prompt** (or with `vcvars64.bat`) to be safe. This was not smoke-tested
with an actual `cargo build` (SA-5 is read-only and must not create build
artifacts). Everything Tauri v2 needs (MSVC Build Tools + Windows SDK 10.0.26100
+ WebView2) is installed.

---

## 4. Recommended adapter approach (summary)

| Harness | Primary source | Change detection | Notes |
| --- | --- | --- | --- |
| **Codex** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (plain JSONL, no `.zst`) | file tail via `notify` | per PLAN recon; first line `session_meta` (`cwd`, `session_id`, `originator`, `cli_version`) |
| **OpenCode** | `opencode.db` → **`session_v2`→`session_message`** (fallback `session`→`message`→`part`) | poll `MAX(seq)` / `MAX(time_updated)` (WAL-safe read-only); SSE only if a `serve` daemon is detected | always-on works with no daemon; never read `auth.json` |
| **T3 Code** | `statev2.sqlite` → **`orchestration_v2_projection_*`** (threads/runs/run_attempts/nodes/turn_items) | tail `orchestration_events.sequence` and/or poll projection `updated_at`; track `orchestration_v2_projection_metadata.last_sequence` | no stable HTTP API (probe: SPA catch-all); add a `sqlite_master` schema guard; dedupe T3-launched Codex/OpenCode sessions |

Cross-cutting:
- Open every SQLite store **read-only** (`file:…?mode=ro`, URI flag) so the
  watcher can never block or corrupt a harness writer.
- One Rust adapter module per harness under `crates/harness/src/`, each emitting
  the shared `@doty/harness-events` `HarnessEvent` (Rust mirror in
  `crates/harness` — bump `CONTRACT_VERSION` on shape change).
- `text` is **LOCAL ONLY**; only `SessionDigest`/`TRANSMITTED_DIGEST_FIELDS` may
  leave the machine.
- Feature-detect schema; on mismatch emit nothing (or `error`) rather than
  guessing, since both stores' schemas are private and move between releases.

---

## Blockers / could-not-determine

- **No CLI `sqlite3`** on PATH; inspection used `python 3.14.5` `sqlite3` in
  read-only URI mode (worked, WAL replayed).
- **T3 HTTP API**: every path returns the SPA `index.html`; the real client/server
  RPC protocol (likely WebSocket or a non-obvious path) was not discovered and is
  undocumented — hence the SQLite recommendation.
- **No `cargo build` smoke test** of the MSVC linker (read-only mandate); presence
  of `link.exe`, SDK, and WebView2 was verified directly instead.
- `orchestration_v2_events` is empty while `orchestration_v2_projection_metadata`
  reports `last_sequence 67125`; the live event log is the legacy
  `orchestration_events`. Which one v2 will use long-term is unclear — the
  adapter should consume the projection tables, not raw events.
- OpenCode v1↔v2 back-fill semantics (why 12 sessions exist only in `session_v2`)
  were not determined; treat v2 as authoritative.
