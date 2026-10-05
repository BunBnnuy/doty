# @doty/desktop

Tauri v2 desktop client. Thin client: presence + local tools + harness watcher.
The brains live in `apps/server`.

Owned by **SA-4** in Wave 1.

## Wave 1 scope

- Tauri v2 app with a transparent, borderless, always-on-top window.
- Tray icon; autostart, global hotkey, and updater stubs.
- Drives the character from a **fake `DotState` driver** (`startFakeDriver`) so
  the floating dot is alive before the server exists.
- Uses a local placeholder dot for now; the real `@doty/avatar` package is wired
  in during Wave 2 integration.

## Notes

- `apps/desktop` is **standalone** — it is NOT a member of the root Cargo
  workspace. Its `src-tauri/Cargo.toml` must contain an empty `[workspace]`
  table so Cargo does not try to attach it to the root workspace.
- Do not modify root configs. Do not run `npm install`.
