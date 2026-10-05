//! Codex adapter.
//!
//! Codex persists sessions as plain JSONL at
//! `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. The first line is
//! `session_meta` (carrying `cwd`, `session_id`, `originator`, `cli_version`);
//! later lines have a top-level `type` plus a `payload.type`.
//!
//! This adapter tails those files live with `notify` and normalizes them to
//! [`HarnessEvent`]. The rich per-item records live in
//! `event_msg/item_completed.item`; the `response_item` stream carries the raw
//! tool protocol (and the approval-style `request_user_input*` calls). We use
//! items as the primary source for user/assistant/reasoning/tool events, and
//! `response_item` for the tool protocol + approvals, so nothing is counted
//! twice. `text` is carried for the local viewer and never leaves the machine.

use crate::adapter::{Adapter, SessionRef, StreamOptions};
use crate::model::{
    Harness, HarnessActivity, HarnessEvent, HarnessEventKind, TokenUsage, ToolInfo,
};
use crate::time::{now_millis, parse_rfc3339_millis};
use anyhow::{Context, Result};
use notify::{RecursiveMode, Watcher};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::mpsc::RecvTimeoutError;
use std::time::Instant;

/// Codex tool names that are generic wrappers around the typed `item_completed`
/// records (`CommandExecution`, `FileChange`, `Extension`). Emitting them too
/// would double-count.
const WRAPPER_TOOLS: [&str; 5] = ["exec", "shell", "apply_patch", "web_search", "search"];

#[derive(Debug, Clone)]
pub struct CodexAdapter {
    root: PathBuf,
}

impl Default for CodexAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl CodexAdapter {
    /// `$CODEX_HOME/sessions`, or `%USERPROFILE%/.codex/sessions` (Unix:
    /// `$HOME/.codex/sessions`).
    pub fn new() -> Self {
        Self::with_root(default_sessions_root())
    }

    pub fn with_root(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Build a [`SessionRef`] for an explicit rollout path.
    pub fn session_ref_for_path(&self, path: impl Into<PathBuf>) -> SessionRef {
        let path = path.into();
        let meta = std::fs::metadata(&path).ok();
        SessionRef {
            harness: Harness::Codex,
            session_id: session_id_from_path(&path).unwrap_or_default(),
            project: read_project(&path),
            modified: meta.as_ref().and_then(|m| m.modified().ok()),
            bytes: meta.as_ref().map(|m| m.len()).unwrap_or(0),
            path,
        }
    }
}

impl Adapter for CodexAdapter {
    fn harness(&self) -> Harness {
        Harness::Codex
    }

    fn discover(&self) -> Result<Vec<SessionRef>> {
        let mut paths = Vec::new();
        walk_rollouts(&self.root, 0, &mut paths);
        let mut sessions: Vec<SessionRef> = paths
            .into_iter()
            .map(|path| {
                let meta = std::fs::metadata(&path).ok();
                SessionRef {
                    harness: Harness::Codex,
                    session_id: session_id_from_path(&path).unwrap_or_default(),
                    project: read_project(&path),
                    modified: meta.as_ref().and_then(|m| m.modified().ok()),
                    bytes: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                    path,
                }
            })
            .collect();
        sessions.sort_by(|a, b| b.modified.cmp(&a.modified));
        Ok(sessions)
    }

    fn stream(
        &self,
        session: &SessionRef,
        opts: &StreamOptions,
        on_event: &mut dyn FnMut(HarnessEvent),
    ) -> Result<()> {
        let path = session.path.clone();
        let parent = path
            .parent()
            .map(Path::to_path_buf)
            .context("session path has no parent directory")?;

        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        })
        .context("create filesystem watcher")?;
        watcher
            .watch(&parent, RecursiveMode::NonRecursive)
            .with_context(|| format!("watch {}", parent.display()))?;

        let mut mapper = CodexMapper::new(session.session_id.clone(), session.project.clone());
        let mut offset = if opts.replay {
            0
        } else {
            std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0)
        };
        let mut leftover: Vec<u8> = Vec::new();
        let mut last_data = Instant::now();

        loop {
            let drained = read_complete_lines(&path, offset, &leftover)?;
            offset = drained.offset;
            leftover = drained.leftover;
            if drained.bytes_read > 0 {
                last_data = Instant::now();
            }
            for line in &drained.lines {
                if line.trim().is_empty() {
                    continue;
                }
                mapper.map_line(line, on_event);
            }

            if !opts.follow {
                return Ok(());
            }

            let elapsed = last_data.elapsed();
            if elapsed >= opts.stale_after {
                if let Some(event) = mapper.stale_event() {
                    on_event(event);
                }
                return Ok(());
            }

            let wait = opts.poll.min(opts.stale_after - elapsed);
            match rx.recv_timeout(wait) {
                // Any change in the directory wakes us; the next loop re-reads
                // our file from the last offset. Unrelated notifications are
                // harmless (0 new bytes) and the stale timer keeps ticking.
                Ok(Ok(_event)) => {}
                Ok(Err(_)) => {}
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return Ok(()),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Discovery helpers
// ---------------------------------------------------------------------------

fn default_sessions_root() -> PathBuf {
    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        if !codex_home.trim().is_empty() {
            return PathBuf::from(codex_home).join("sessions");
        }
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".codex").join("sessions")
}

fn walk_rollouts(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    if depth > 4 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            walk_rollouts(&path, depth + 1, out);
        } else if is_rollout(&path) {
            out.push(path);
        }
    }
}

fn is_rollout(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    name.starts_with("rollout-") && name.ends_with(".jsonl")
}

/// `rollout-2026-10-02T19-19-24-01a0fe0e-9627-75f3-8aed-b13bcab20d69.jsonl`
/// -> `01a0fe0e-9627-75f3-8aed-b13bcab20d69` (the trailing UUID).
fn session_id_from_path(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let stem = name.strip_suffix(".jsonl")?;
    if stem.len() < 36 {
        return None;
    }
    let candidate = &stem[stem.len() - 36..];
    let bytes = candidate.as_bytes();
    if candidate.len() == 36
        && bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[18] == b'-'
        && bytes[23] == b'-'
        && candidate
            .chars()
            .filter(|c| *c != '-')
            .all(|c| c.is_ascii_hexdigit())
    {
        Some(candidate.to_string())
    } else {
        None
    }
}

/// Read `payload.cwd` from the first `session_meta` line, cheaply.
fn read_project(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let value: Value = serde_json::from_str(&line).ok()?;
    value
        .get("payload")
        .and_then(|p| p.get("cwd"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

// ---------------------------------------------------------------------------
// Tailing
// ---------------------------------------------------------------------------

struct Drained {
    lines: Vec<String>,
    offset: u64,
    leftover: Vec<u8>,
    bytes_read: usize,
}

/// Read everything from `offset` to EOF and return the complete (newline
/// terminated) lines, leaving any trailing partial line in `leftover`.
fn read_complete_lines(path: &Path, offset: u64, leftover: &[u8]) -> Result<Drained> {
    let mut file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    file.seek(SeekFrom::Start(offset))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    let bytes_read = buf.len();

    let mut combined = Vec::with_capacity(leftover.len() + buf.len());
    combined.extend_from_slice(leftover);
    combined.extend_from_slice(&buf);

    let (complete, new_leftover) = match combined.iter().rposition(|&b| b == b'\n') {
        Some(pos) => (combined[..=pos].to_vec(), combined[pos + 1..].to_vec()),
        None => (Vec::new(), combined),
    };
    let consumed = complete.len().saturating_sub(leftover.len());
    let lines = String::from_utf8_lossy(&complete)
        .lines()
        .map(|l| l.to_string())
        .collect();

    Ok(Drained {
        lines,
        offset: offset + consumed as u64,
        leftover: new_leftover,
        bytes_read,
    })
}

// ---------------------------------------------------------------------------
// JSONL -> HarnessEvent
// ---------------------------------------------------------------------------

/// Per-session fold state for mapping raw lines.
struct CodexMapper {
    session_id: String,
    project: Option<String>,
    session_started: bool,
    ended: bool,
    last_ts: i64,
    /// `call_id -> tool name`, so a result can carry the tool it belongs to.
    call_names: HashMap<String, String>,
}

impl CodexMapper {
    fn new(session_id: String, project: Option<String>) -> Self {
        Self {
            session_id,
            project,
            session_started: false,
            ended: false,
            last_ts: now_millis(),
            call_names: HashMap::new(),
        }
    }

    fn make(
        &self,
        ts: i64,
        kind: HarnessEventKind,
        status: Option<HarnessActivity>,
        tool: Option<ToolInfo>,
        tokens: Option<TokenUsage>,
        text: Option<String>,
    ) -> HarnessEvent {
        HarnessEvent {
            harness: Harness::Codex,
            session_id: self.session_id.clone(),
            project: self.project.clone(),
            ts,
            kind,
            status,
            tool,
            tokens,
            text,
        }
    }

    fn stale_event(&mut self) -> Option<HarnessEvent> {
        if self.ended {
            return None;
        }
        self.ended = true;
        Some(self.make(
            self.last_ts,
            HarnessEventKind::SessionEnd,
            Some(HarnessActivity::Stale),
            None,
            None,
            None,
        ))
    }

    fn map_line(&mut self, line: &str, on_event: &mut dyn FnMut(HarnessEvent)) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let top = value.get("type").and_then(Value::as_str).unwrap_or("");
        let payload = value.get("payload");
        let ts = line_timestamp(&value, self.last_ts);

        // `session_meta` must update identity before we synthesize session start.
        if top == "session_meta" {
            if let Some(payload) = payload {
                if let Some(sid) = payload
                    .get("session_id")
                    .or_else(|| payload.get("id"))
                    .and_then(Value::as_str)
                {
                    self.session_id = sid.to_string();
                }
                if let Some(cwd) = payload.get("cwd").and_then(Value::as_str) {
                    self.project = Some(cwd.to_string());
                }
            }
        }

        if !self.session_started {
            self.session_started = true;
            on_event(self.make(
                ts,
                HarnessEventKind::SessionStart,
                Some(HarnessActivity::Running),
                None,
                None,
                None,
            ));
        }

        match top {
            "session_meta" => {}
            "turn_context" => {
                if let Some(cwd) = payload
                    .and_then(|p| p.get("cwd"))
                    .and_then(Value::as_str)
                {
                    self.project = Some(cwd.to_string());
                }
            }
            "event_msg" => self.map_event_msg(payload, ts, on_event),
            "response_item" => self.map_response_item(payload, ts, on_event),
            // `token_usage_record` duplicates `event_msg/token_count`; ignore.
            _ => {}
        }

        if ts > 0 {
            self.last_ts = ts;
        }
    }

    fn map_event_msg(
        &mut self,
        payload: Option<&Value>,
        ts: i64,
        on_event: &mut dyn FnMut(HarnessEvent),
    ) {
        let Some(payload) = payload else { return };
        let ptype = payload.get("type").and_then(Value::as_str).unwrap_or("");
        match ptype {
            "item_completed" => {
                if let Some(item) = payload.get("item") {
                    self.map_item(item, ts, on_event);
                }
            }
            "task_complete" => {
                on_event(self.make(
                    ts,
                    HarnessEventKind::TurnEnd,
                    Some(HarnessActivity::Idle),
                    None,
                    None,
                    None,
                ));
            }
            "task_started" => {
                // Turn boundary marker; no dedicated contract kind.
            }
            "token_count" => {
                let tokens = payload
                    .get("info")
                    .and_then(|info| {
                        info.get("total_token_usage")
                            .or_else(|| info.get("last_token_usage"))
                    })
                    .map(token_usage_from);
                if tokens.is_some() {
                    on_event(self.make(
                        ts,
                        HarnessEventKind::TokenUsage,
                        None,
                        None,
                        tokens,
                        None,
                    ));
                }
            }
            "error" => {
                let text = payload
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                on_event(self.make(
                    ts,
                    HarnessEventKind::Error,
                    Some(HarnessActivity::Error),
                    None,
                    None,
                    text,
                ));
            }
            _ => {}
        }
    }

    fn map_item(&mut self, item: &Value, ts: i64, on_event: &mut dyn FnMut(HarnessEvent)) {
        let itype = item.get("type").and_then(Value::as_str).unwrap_or("");
        match itype {
            "UserMessage" => {
                let text = item_text(item);
                on_event(self.make(
                    ts,
                    HarnessEventKind::User,
                    Some(HarnessActivity::Running),
                    None,
                    None,
                    text,
                ));
            }
            "AgentMessage" => {
                let text = item_text(item);
                on_event(self.make(
                    ts,
                    HarnessEventKind::Assistant,
                    Some(HarnessActivity::Running),
                    None,
                    None,
                    text,
                ));
            }
            "Reasoning" => {
                let text = summary_text(item);
                on_event(self.make(
                    ts,
                    HarnessEventKind::Thinking,
                    Some(HarnessActivity::Thinking),
                    None,
                    None,
                    text,
                ));
            }
            "CommandExecution" => {
                let command = item
                    .get("command")
                    .map(join_command)
                    .unwrap_or_default();
                let cwd = item.get("cwd").and_then(Value::as_str);
                let tool = ToolInfo {
                    name: "shell".to_string(),
                    args: Some(serde_json::json!({ "command": command, "cwd": cwd })),
                };
                on_event(self.make(
                    ts,
                    HarnessEventKind::ToolCall,
                    Some(HarnessActivity::ToolCalling),
                    Some(tool),
                    None,
                    None,
                ));
            }
            "FileChange" => {
                let files: Vec<String> = item
                    .get("changes")
                    .and_then(Value::as_object)
                    .map(|changes| changes.keys().cloned().collect())
                    .unwrap_or_default();
                let tool = ToolInfo {
                    name: "apply_patch".to_string(),
                    args: Some(serde_json::json!({ "files": files })),
                };
                on_event(self.make(
                    ts,
                    HarnessEventKind::ToolCall,
                    Some(HarnessActivity::ToolCalling),
                    Some(tool),
                    None,
                    None,
                ));
            }
            "Extension" => {
                let kind = item.get("kind").and_then(Value::as_str).unwrap_or("extension");
                let tool = ToolInfo {
                    name: extension_tool_name(kind),
                    args: Some(serde_json::json!({ "kind": kind })),
                };
                on_event(self.make(
                    ts,
                    HarnessEventKind::ToolCall,
                    Some(HarnessActivity::ToolCalling),
                    Some(tool),
                    None,
                    None,
                ));
            }
            "Error" | "StreamError" => {
                let text = item
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                on_event(self.make(
                    ts,
                    HarnessEventKind::Error,
                    Some(HarnessActivity::Error),
                    None,
                    None,
                    text,
                ));
            }
            _ => {}
        }
    }

    fn map_response_item(
        &mut self,
        payload: Option<&Value>,
        ts: i64,
        on_event: &mut dyn FnMut(HarnessEvent),
    ) {
        let Some(payload) = payload else { return };
        let rtype = payload.get("type").and_then(Value::as_str).unwrap_or("");
        match rtype {
            "function_call" | "custom_tool_call" => {
                let name = payload
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                if let Some(call_id) = payload.get("call_id").and_then(Value::as_str) {
                    self.call_names.insert(call_id.to_string(), name.clone());
                }
                let args = call_args(payload);
                if is_approval_tool(&name) {
                    let tool = ToolInfo {
                        name,
                        args,
                    };
                    on_event(self.make(
                        ts,
                        HarnessEventKind::Approval,
                        Some(HarnessActivity::WaitingApproval),
                        Some(tool),
                        None,
                        None,
                    ));
                } else if !WRAPPER_TOOLS.contains(&name.as_str()) {
                    let tool = ToolInfo {
                        name,
                        args,
                    };
                    on_event(self.make(
                        ts,
                        HarnessEventKind::ToolCall,
                        Some(HarnessActivity::ToolCalling),
                        Some(tool),
                        None,
                        None,
                    ));
                }
            }
            "function_call_output" | "custom_tool_call_output" => {
                let tool = payload
                    .get("call_id")
                    .and_then(Value::as_str)
                    .and_then(|id| self.call_names.get(id))
                    .map(|name| ToolInfo {
                        name: name.clone(),
                        args: None,
                    });
                on_event(self.make(
                    ts,
                    HarnessEventKind::ToolResult,
                    Some(HarnessActivity::Running),
                    tool,
                    None,
                    None,
                ));
            }
            "error" => {
                on_event(self.make(
                    ts,
                    HarnessEventKind::Error,
                    Some(HarnessActivity::Error),
                    None,
                    None,
                    None,
                ));
            }
            // Messages/reasoning are covered by `event_msg/item_completed`.
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// Small JSON helpers
// ---------------------------------------------------------------------------

fn line_timestamp(value: &Value, fallback: i64) -> i64 {
    if let Some(ts) = value
        .get("timestamp")
        .or_else(|| value.get("payload").and_then(|p| p.get("timestamp")))
        .and_then(Value::as_str)
        .and_then(parse_rfc3339_millis)
    {
        return ts;
    }
    let payload = value.get("payload");
    if let Some(ms) = payload
        .and_then(|p| p.get("started_at_ms").or_else(|| p.get("completed_at_ms")))
        .and_then(Value::as_i64)
    {
        return ms;
    }
    if let Some(secs) = payload
        .and_then(|p| p.get("completed_at").or_else(|| p.get("started_at")))
        .and_then(Value::as_i64)
    {
        return secs.saturating_mul(1000);
    }
    fallback
}

fn token_usage_from(value: &Value) -> TokenUsage {
    TokenUsage {
        input: value.get("input_tokens").and_then(Value::as_u64),
        output: value.get("output_tokens").and_then(Value::as_u64),
    }
}

fn item_text(item: &Value) -> Option<String> {
    let content = item.get("content")?.as_array()?;
    let joined = content
        .iter()
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    (!joined.is_empty()).then_some(joined)
}

fn summary_text(item: &Value) -> Option<String> {
    let array = item
        .get("summary_text")
        .or_else(|| item.get("summary"))?
        .as_array()?;
    let joined = array
        .iter()
        .filter_map(|entry| {
            entry
                .as_str()
                .map(str::to_string)
                .or_else(|| entry.get("text").and_then(Value::as_str).map(str::to_string))
        })
        .collect::<Vec<_>>()
        .join("\n");
    (!joined.is_empty()).then_some(joined)
}

/// `command` is normally an argv array; join it for a readable local label.
fn join_command(value: &Value) -> String {
    match value {
        Value::Array(parts) => parts
            .iter()
            .map(|p| {
                p.as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| p.to_string())
            })
            .collect::<Vec<_>>()
            .join(" "),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn call_args(payload: &Value) -> Option<Value> {
    if let Some(arguments) = payload.get("arguments") {
        if let Some(text) = arguments.as_str() {
            return Some(serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.to_string())));
        }
        return Some(arguments.clone());
    }
    payload.get("input").cloned()
}

fn is_approval_tool(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.contains("request_user_input") || lower.contains("approval")
}

fn extension_tool_name(kind: &str) -> String {
    match kind {
        "web.search" => "web_search".to_string(),
        other => other.replace('.', "_"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_id_extraction() {
        let p = Path::new("C:/x/rollout-2026-10-02T19-19-24-01a0fe0e-9627-75f3-8aed-b13bcab20d69.jsonl");
        assert_eq!(
            session_id_from_path(p).as_deref(),
            Some("01a0fe0e-9627-75f3-8aed-b13bcab20d69")
        );
        assert_eq!(session_id_from_path(Path::new("rollout-x.jsonl")), None);
    }

    #[test]
    fn maps_session_meta_and_items() {
        let mut mapper = CodexMapper::new("fallback".into(), None);
        let mut events = Vec::new();
        let mut push = |e| events.push(e);

        mapper.map_line(
            r#"{"type":"session_meta","payload":{"session_id":"sess-9","cwd":"C:\\repo"}}"#,
            &mut push,
        );
        mapper.map_line(
            r#"{"timestamp":"2026-10-02T19:19:27.098Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution","command":["pwsh","-Command","ls"]}}}"#,
            &mut push,
        );
        mapper.map_line(
            r#"{"timestamp":"2026-10-02T19:19:28.000Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"FileChange","changes":{"C:\\repo\\a.rs":{"type":"update"}}}}}"#,
            &mut push,
        );
        mapper.map_line(
            r#"{"timestamp":"2026-10-02T19:19:29.000Z","type":"response_item","payload":{"type":"function_call","name":"request_user_input_async","call_id":"call_1"}}"#,
            &mut push,
        );

        assert_eq!(events[0].kind, HarnessEventKind::SessionStart);
        assert_eq!(events[0].session_id, "sess-9");
        assert_eq!(events[0].project.as_deref(), Some("C:\\repo"));
        assert_eq!(events[1].kind, HarnessEventKind::ToolCall);
        assert_eq!(events[1].tool.as_ref().unwrap().name, "shell");
        assert_eq!(events[2].tool.as_ref().unwrap().name, "apply_patch");
        assert_eq!(events[3].kind, HarnessEventKind::Approval);
        assert_eq!(events[3].status, Some(HarnessActivity::WaitingApproval));
    }

    #[test]
    fn wrapper_response_calls_are_not_double_counted() {
        let mut mapper = CodexMapper::new("s".into(), None);
        let mut events = Vec::new();
        let mut push = |e| events.push(e);
        mapper.map_line(
            r#"{"type":"session_meta","payload":{"session_id":"s","cwd":"C:\\r"}}"#,
            &mut push,
        );
        mapper.map_line(
            r#"{"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":"text(...)"}}"#,
            &mut push,
        );
        assert_eq!(events.len(), 1, "exec wrapper must not emit a tool_call");
    }

    #[test]
    fn line_timestamp_fallbacks() {
        let v: Value =
            serde_json::from_str(r#"{"payload":{"completed_at":1790968841}}"#).unwrap();
        assert_eq!(line_timestamp(&v, 0), 1_790_968_841_000);
        let v: Value = serde_json::from_str(r#"{"payload":{"started_at_ms":1790968766098}}"#).unwrap();
        assert_eq!(line_timestamp(&v, 0), 1_790_968_766_098);
    }
}
