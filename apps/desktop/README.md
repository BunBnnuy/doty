# @doty/desktop

Tauri v2 desktop client. Thin client: presence + chat + local tools + harness watcher.
The brains live in `apps/server`.

## What it does

- Transparent, borderless, always-on-top floating window and a tray icon.
- Mounts `@doty/avatar` on the shared `DotState` store.
- Chat / run panel. Sending `POST`s `/message` (default `http://localhost:8787`).
- The transcript keeps only the newest 10 rows and shows a jump-to-bottom button
  while scrolled away from the newest message, so long sessions do not flood the
  panel.
- SSE client for `GET /events`. Frames are parsed as native SSE (`id` → seq,
  `event` → type, `data` → JSON payload). Reconnects send `Last-Event-ID`.
- Fake `DotState` driver while the server is unreachable. Queued messages flush
  when the stream returns.
- Autostart, global hotkey, and updater remain stubs on the Rust side.
- Codex, OpenCode and T3 watchers start with the shell and stop on exit. Their
  local sessions appear as orbiting satellite dots; click or keyboard-activate
  one for harness, session, project, status and last-activity metadata.
- New agent responses from any watched session appear in Doty's chat as Doty
  messages, labelled `harness · project`. This is local-only: the text is never
  POSTed and never reaches the server.
- Pending T3 questions appear as an interactive card at the end of the chat.
  Selecting an option answers them **from Doty**: it enqueues T3's own
  `runtime-request.respond` effect (see below) and T3 applies it, so you never
  type the answer into T3.

## Harness satellites

The Rust bridge uses `doty-harness` in finite background polling passes (every
two seconds), with fingerprints including SQLite WAL files. It retains the last
`HarnessStatus` per harness/session, emits `harness://status`, and exposes
`harness_statuses` for webview startup/reload hydration. It also carries each
session's recent activity lines, including assistant `text`, over **local IPC
only**; that text is rendered in the details panel and appended to the chat, and
is never handed to a network transport. Tool arguments and adapter error context
never enter this bridge's IPC. Running/thinking/tool-calling sessions go stale
after two minutes without activity; approvals remain waiting until updated.

Answering a T3 question is a deliberate, best-effort write, not a read: Doty
validates that the request is still pending, then inserts one
`runtime-request.respond` row into T3's own `orchestration_v2_effect_outbox`
(the same effect T3 writes when you answer in its UI). T3's effect worker polls
that table and applies it, so no T3 credential or API is needed. This is
unsupported by T3 and only safe because the row is indistinguishable from one
T3 would write; if the schema changes, writes fail closed and the card falls
back to copy-to-clipboard.

Active sessions remain visible. Done, idle, and error sessions remain visible
for two minutes after their last event. Stale sessions remain visible for up to
four minutes after their last event, which gives a stale marker about two minutes
on screen after the two-minute stale threshold. The UI drops expired activity
lines unless a user has that session open. Status metadata remains in the local
store; the native watcher keeps its snapshots until Doty exits.
Codex is mint, OpenCode violet, T3 blue; the border/badge shows activity:
thinking `…`, tools `↻`, approval `?`, done `✓`, error `!`, stale `–`.
Motion respects `prefers-reduced-motion`; pointing/focusing pauses an orbiting
dot. Browser-only Vite has no native watchers (and does not fake live sessions).

Limitations of the current adapter contract: changed sessions are replayed
because there is no reusable cursor or cancellation handle; shutdown waits for
the current finite session read. T3 currently does not populate project metadata
and deduplicates upstream Codex/OpenCode sessions itself. Titles are not derived
from transcripts. T3 also stamps replayed failed attempts with the current time
in the upstream adapter, so historical errors can appear recent; that needs an
adapter fix outside this directory. The launch request enables all three local watchers; there is
not yet a separate persistent per-harness consent/settings screen.

The additive avatar API is `mountSatellites(container, source, options)`, where
`source.subscribe` supplies a current array of shared `HarnessStatus` values.
It returns `{ element, setStatuses, destroy }`; optional `onSelect` receives only
the selected status. Position the container and center `mountAvatar` alongside
the layer. `size` is the first orbit's square area (default 136); each additional
twelve-session ring adds 48px to the layer's width/height. `mountAvatar` and the
character design are unchanged.

## Run

Webview only (no desktop session required):

```
npx vite
```

from `apps/desktop` — http://localhost:1420. Point it at a running server with
`?server=http://localhost:8787`, the `VITE_DOTY_SERVER` env var, or the Server
field in the panel.

Full shell (needs a desktop session):

```
npm -w @doty/desktop run dev
```

Server, separately: `npm -w @doty/server run dev`.

## Notes

- `apps/desktop` is **standalone** — it is NOT a member of the root Cargo
  workspace. Its `src-tauri/Cargo.toml` must contain an empty `[workspace]`
  table so Cargo does not try to attach it to the root workspace.
- Do not modify root configs. Do not run `npm install`.
- CSP `connect-src` allows the local brain (`http://localhost:8787` and
  `http://127.0.0.1:*`) plus Tauri IPC. `default-src` stays `'self'`.
