//! Doty desktop shell — Tauri v2 (Wave 1).
//!
//! Presence layer only:
//!   * a transparent, borderless, always-on-top window showing the character,
//!   * a tray icon as the always-present anchor,
//!   * **stubs** for autostart, global hotkey and the updater.
//!
//! The dot itself is rendered by the webview (`index.html` / `src/main.ts`),
//! which mounts `@doty/avatar` on the shared `@doty/dot-state` store. The store
//! is driven by the server SSE stream, with the fake driver as a fallback when
//! the server is unreachable.
//!
//! The autostart/hotkey/updater stubs deliberately avoid pulling in the Tauri
//! plugins from `tauri-plugin-*` yet. Each stub below documents the exact plugin
//! call that replaces it, so wiring the real thing is a one-line change and no
//! API surface is invented.

// Hide the console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
mod harness;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime,
};

/// Label of the floating-dot window, matching `tauri.conf.json`.
const MAIN_WINDOW: &str = "main";

/// Default global hotkey the real implementation will register.
const HOTKEY_STUB: &str = "CommandOrControl+Shift+D";

/// Update channel the real updater will point at.
const UPDATER_CHANNEL_STUB: &str = "stable";

/// Snapshot of the Wave 1 OS-integration stubs, exposed to the webview and
/// used by tests/tooling to assert the shell booted with its hooks present.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StubReport {
    /// Whether launch-at-login is enabled. Stub: always `false`.
    autostart: bool,
    /// The hotkey the real implementation will bind.
    global_hotkey: String,
    /// The update channel the real implementation will use.
    updater_channel: String,
}

#[tauri::command]
fn stub_report() -> StubReport {
    StubReport {
        autostart: false,
        global_hotkey: HOTKEY_STUB.to_string(),
        updater_channel: UPDATER_CHANNEL_STUB.to_string(),
    }
}

/// Best-effort machine name, so shared harness events can say where a task ran.
#[tauri::command]
fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .or_else(|_| std::env::var("USERNAME"))
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "unknown".to_string())
}

// ---------------------------------------------------------------------------
// Tray icon
// ---------------------------------------------------------------------------

/// Draw Doty's accent dot into a small RGBA buffer for the tray. Generating the
/// icon in code avoids shipping a binary asset for Wave 1; the real branded
/// icons live under `src-tauri/icons/` for bundling.
fn dot_icon() -> Image<'static> {
    const SIZE: u32 = 32;
    let mut rgba = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    let center = (SIZE as f32 - 1.0) / 2.0;
    let radius = SIZE as f32 / 2.0;

    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 - center;
            let dy = y as f32 - center;
            let dist = (dx * dx + dy * dy).sqrt();
            // Antialias the last pixel of the edge.
            let coverage = (radius - dist).clamp(0.0, 1.0);
            let alpha = (coverage * 255.0) as u8;
            rgba.extend_from_slice(&[124, 108, 255, alpha]);
        }
    }

    Image::new_owned(rgba, SIZE, SIZE)
}

fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn hide_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.hide();
    }
}

fn install_tray<R: Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "Hide Doty", true, None::<&str>)?;
    let close = MenuItem::with_id(app, "close", "Close Doty", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&settings, &hide, &close])?;

    TrayIconBuilder::with_id("doty-tray")
        .icon(dot_icon())
        .tooltip("Doty")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "settings" => {
                show_main(app);
                let _ = app.emit("doty://settings", ());
            }
            "hide" => hide_main(app),
            "close" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

// ---------------------------------------------------------------------------
// OS-integration stubs (autostart / global hotkey / updater)
// ---------------------------------------------------------------------------

fn install_stubs<R: Runtime>(app: &AppHandle<R>) {
    install_autostart_stub(app);
    install_global_hotkey_stub(app);
    install_updater_stub(app);
}

/// Real implementation: `tauri_plugin_autostart::init(MacosLauncher::LaunchAgent,
/// Some(vec!["--autostart"]))` registered on the builder, then
/// `app.autolaunch().enable()`.
fn install_autostart_stub<R: Runtime>(_app: &AppHandle<R>) {
    report_stub("autostart", "launch-at-login not wired yet (Wave 2+)");
}

/// Real implementation: `tauri_plugin_global_shortcut::Builder::new()
/// .with_handler(...).build()` registered on the builder, then
/// `app.global_shortcut().register(HOTKEY_STUB.parse()?)`.
fn install_global_hotkey_stub<R: Runtime>(_app: &AppHandle<R>) {
    report_stub(
        "global-hotkey",
        &format!("would bind {HOTKEY_STUB} (Wave 2+)"),
    );
}

/// Real implementation: `tauri_plugin_updater::Builder::new().build()` with
/// `bundle.createUpdaterArtifacts = true` and an update endpoint in config.
fn install_updater_stub<R: Runtime>(_app: &AppHandle<R>) {
    report_stub(
        "updater",
        &format!("channel '{UPDATER_CHANNEL_STUB}' not wired yet (Wave 2+)"),
    );
}

fn report_stub(name: &str, detail: &str) {
    // In debug builds this reaches the console; in release the window is
    // console-less, which is expected for a presence app.
    println!("[doty:stub] {name}: {detail}");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            stub_report,
            device_name,
            harness::harness_statuses,
            harness::harness_activity,
            harness::harness_questions,
            harness::answer_question
        ])
        .setup(|app| {
            install_tray(app)?;
            install_stubs(app.handle());
            app.manage(harness::HarnessWatchers::start(app.handle().clone()));
            println!("[doty] desktop shell ready");
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Doty desktop")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<harness::HarnessWatchers>().stop();
            }
        });
}
