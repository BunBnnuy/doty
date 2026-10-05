# @doty/desktop

Tauri v2 desktop client. Thin client: presence + chat + local tools + harness watcher.
The brains live in `apps/server`.

## What it does

- Transparent, borderless, always-on-top floating window and a tray icon.
- Mounts `@doty/avatar` on the shared `DotState` store.
- Chat / run panel. Sending `POST`s `/message` (default `http://localhost:8787`).
- SSE client for `GET /events`. Frames are parsed as native SSE (`id` → seq,
  `event` → type, `data` → JSON payload). Reconnects send `Last-Event-ID`.
- Fake `DotState` driver while the server is unreachable. Queued messages flush
  when the stream returns.
- Autostart, global hotkey, and updater remain stubs on the Rust side.
- Codex, OpenCode and T3 watchers start with the shell and stop on exit. Their
  local sessions appear as orbiting satellite dots; click or keyboard-activate
  one for harness, session, project, status and last-activity metadata.

## Harness satellites

The Rust bridge uses `doty-harness` in finite background polling passes (every
two seconds), with fingerprints including SQLite WAL files. It retains the last
`HarnessStatus` per harness/session, emits `harness://status`, and exposes
`harness_statuses` for webview startup/reload hydration. Raw events, transcript
`text`, tool arguments and adapter error context never enter this bridge's IPC
or the online chat/server path. Running/thinking/tool-calling sessions go stale
after two minutes without activity; approvals remain waiting until updated.

Active sessions remain visible; idle/done/error/stale sessions remain visible
for ten minutes after their real last activity. Older statuses remain in memory.
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
