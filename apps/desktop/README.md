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
