//! T3 Code adapter for its versioned orchestration-v2 projection. The projection
//! is read-only and guarded by both table and column checks; unknown schemas
//! produce an empty session list rather than speculative queries.

use crate::adapter::{Adapter, SessionRef, StreamOptions};
use crate::codex::CodexAdapter;
use crate::model::{
    Harness, HarnessActivity, HarnessEvent, HarnessEventKind, TokenUsage, ToolInfo,
};
use crate::opencode::OpenCodeAdapter;
use crate::sqlite::{has_columns, has_tables, open_read_only};
use crate::time::{now_millis, parse_rfc3339_millis};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime};

const TABLES: [&str; 6] = [
    "orchestration_v2_projection_threads",
    "orchestration_v2_projection_runs",
    "orchestration_v2_projection_run_attempts",
    "orchestration_v2_projection_nodes",
    "orchestration_v2_projection_turn_items",
    "orchestration_v2_projection_messages",
];

#[derive(Debug, Clone)]
pub struct T3Adapter {
    db_path: PathBuf,
    poll: std::time::Duration,
}

impl Default for T3Adapter {
    fn default() -> Self {
        Self::new()
    }
}

impl T3Adapter {
    pub fn new() -> Self {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".into());
        Self::with_db(PathBuf::from(home).join(".t3/userdata/statev2.sqlite"))
    }

    pub fn with_db(path: impl Into<PathBuf>) -> Self {
        Self {
            db_path: path.into(),
            poll: std::time::Duration::from_millis(750),
        }
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    fn schema_ok(&self, conn: &Connection) -> Result<bool> {
        if !has_tables(conn, &TABLES)? {
            return Ok(false);
        }
        let requirements: [(&str, &[&str]); 6] = [
            (
                TABLES[0],
                &[
                    "thread_id",
                    "project_id",
                    "title",
                    "created_at",
                    "updated_at",
                    "archived_at",
                    "deleted_at",
                    "payload_json",
                ],
            ),
            (
                TABLES[1],
                &[
                    "run_id",
                    "thread_id",
                    "ordinal",
                    "provider",
                    "provider_thread_id",
                    "status",
                    "requested_at",
                    "completed_at",
                    "payload_json",
                ],
            ),
            (
                TABLES[2],
                &[
                    "attempt_id",
                    "thread_id",
                    "run_id",
                    "provider",
                    "provider_thread_id",
                    "status",
                    "payload_json",
                ],
            ),
            (
                TABLES[3],
                &[
                    "node_id",
                    "thread_id",
                    "run_id",
                    "provider_thread_id",
                    "kind",
                    "status",
                    "started_at",
                    "completed_at",
                    "payload_json",
                ],
            ),
            (
                TABLES[4],
                &[
                    "turn_item_id",
                    "thread_id",
                    "run_id",
                    "provider_thread_id",
                    "ordinal",
                    "type",
                    "status",
                    "updated_at",
                    "payload_json",
                ],
            ),
            (
                TABLES[5],
                &[
                    "message_id",
                    "thread_id",
                    "run_id",
                    "role",
                    "streaming",
                    "created_at",
                    "updated_at",
                    "payload_json",
                ],
            ),
        ];
        for (table, columns) in requirements {
            if !has_columns(conn, table, columns)? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn upstream_ids() -> HashSet<String> {
        let mut ids = HashSet::new();
        if let Ok(sessions) = CodexAdapter::new().discover() {
            ids.extend(sessions.into_iter().map(|session| session.session_id));
        }
        if let Ok(sessions) = OpenCodeAdapter::new().discover() {
            ids.extend(sessions.into_iter().map(|session| session.session_id));
        }
        ids
    }

    fn thread_context(
        &self,
        conn: &Connection,
        session_id: &str,
    ) -> Result<Option<(String, Option<String>, Option<String>, Option<String>)>> {
        let mut stmt = conn.prepare("SELECT thread_id, title, created_at, updated_at FROM orchestration_v2_projection_threads WHERE thread_id=?1")?;
        let row = stmt
            .query_row([session_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .optional()?;
        Ok(
            row.map(|(id, title, created, updated)| {
                (id, Some(title), Some(created), Some(updated))
            }),
        )
    }

    /// Omit T3 projection threads whose only provider activity is already
    /// visible through the corresponding Codex/OpenCode adapter. Such threads
    /// would otherwise be duplicate satellites for the same provider session.
    fn has_distinct_activity(
        &self,
        conn: &Connection,
        thread_id: &str,
        upstream_ids: &HashSet<String>,
    ) -> Result<bool> {
        let mut unique = false;
        let mut run_stmt = conn.prepare("SELECT provider, provider_thread_id FROM orchestration_v2_projection_runs WHERE thread_id=?1")?;
        for row in run_stmt.query_map([thread_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })? {
            let (provider, id) = row?;
            if !matches!(provider.as_str(), "codex" | "opencode")
                || id
                    .as_deref()
                    .is_none_or(|id| !matches_upstream_thread(id, upstream_ids))
            {
                unique = true;
            }
        }
        let mut attempt_stmt = conn.prepare("SELECT provider_thread_id FROM orchestration_v2_projection_run_attempts WHERE thread_id=?1")?;
        for row in attempt_stmt.query_map([thread_id], |r| r.get::<_, String>(0))? {
            let id = row?;
            if !matches_upstream_thread(&id, upstream_ids) {
                unique = true;
            }
        }
        let mut node_stmt = conn.prepare(
            "SELECT provider_thread_id FROM orchestration_v2_projection_nodes WHERE thread_id=?1",
        )?;
        for row in node_stmt.query_map([thread_id], |r| r.get::<_, Option<String>>(0))? {
            if row?
                .as_deref()
                .is_none_or(|id| !matches_upstream_thread(id, upstream_ids))
            {
                unique = true;
            }
        }
        let mut item_stmt = conn.prepare("SELECT provider_thread_id FROM orchestration_v2_projection_turn_items WHERE thread_id=?1")?;
        let mut has_items = false;
        for row in item_stmt.query_map([thread_id], |r| r.get::<_, Option<String>>(0))? {
            has_items = true;
            if row?
                .as_deref()
                .is_none_or(|id| !matches_upstream_thread(id, upstream_ids))
            {
                unique = true;
            }
        }
        if !has_items {
            let has_messages: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_messages WHERE thread_id=?1)",
                [thread_id],
                |r| r.get(0),
            )?;
            unique |= has_messages;
        }
        Ok(unique)
    }

    fn emit_thread(
        &self,
        conn: &Connection,
        session: &SessionRef,
        seen: &mut HashSet<String>,
        started: &mut bool,
        on_event: &mut dyn FnMut(HarnessEvent),
    ) -> Result<usize> {
        let mut count = 0usize;
        let started_before_poll = *started;
        let callback = on_event;
        let mut buffered_events = Vec::new();
        let mut on_event = |event| buffered_events.push(event);
        let has_turn_items: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_turn_items WHERE thread_id=?1)",
            [&session.session_id],
            |row| row.get(0),
        )?;
        let upstream_ids = Self::upstream_ids();
        let mut run_stmt = conn.prepare("SELECT run_id, provider, provider_thread_id, status, requested_at, completed_at, payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 ORDER BY requested_at, ordinal")?;
        let runs = run_stmt.query_map([&session.session_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, String>(6)?,
            ))
        })?;
        for row in runs {
            let (id, provider, provider_thread, status, requested, completed, raw) = row?;
            let key = format!("run:{id}:{status}:{}", completed.as_deref().unwrap_or(""));
            if !seen.insert(key) {
                continue;
            }
            // Exact upstream-id matches are suppressed: T3 is only an aggregator
            // for those already-discovered provider sessions, not a second copy.
            if matches!(provider.as_str(), "codex" | "opencode")
                && provider_thread
                    .as_ref()
                    .is_some_and(|id| matches_upstream_thread(id, &upstream_ids))
            {
                continue;
            }
            let ts = completed
                .as_deref()
                .and_then(parse_rfc3339_millis)
                .or_else(|| parse_rfc3339_millis(&requested))
                .unwrap_or_else(now_millis);
            self.ensure_started(session, ts, started, &mut on_event);
            if status == "failed" {
                on_event(make_event(
                    session,
                    provider_thread.as_deref(),
                    ts,
                    HarnessEventKind::Error,
                    Some(HarnessActivity::Error),
                    None,
                    None,
                ));
                on_event(make_event(
                    session,
                    provider_thread.as_deref(),
                    ts,
                    HarnessEventKind::TurnEnd,
                    Some(HarnessActivity::Error),
                    None,
                    None,
                ));
            } else if matches!(status.as_str(), "completed" | "cancelled" | "interrupted") {
                let activity = if status == "completed" {
                    HarnessActivity::Done
                } else {
                    HarnessActivity::Stale
                };
                let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
                if let Some(tokens) = token_usage(&payload) {
                    on_event(make_event(
                        session,
                        provider_thread.as_deref(),
                        ts,
                        HarnessEventKind::TokenUsage,
                        None,
                        None,
                        Some(tokens),
                    ));
                }
                on_event(make_event(
                    session,
                    provider_thread.as_deref(),
                    ts,
                    HarnessEventKind::TurnEnd,
                    Some(activity),
                    None,
                    None,
                ));
            }
            count += 1;
        }

        // Attempts and nodes carry provider-level status that is not always
        // represented by a turn item. Fold terminal failures from those
        // projections as structural errors; their payloads are not surfaced.
        let mut attempt_stmt = conn.prepare("SELECT attempt_id, provider_thread_id, status FROM orchestration_v2_projection_run_attempts WHERE thread_id=?1 ORDER BY attempt_ordinal")?;
        let attempts = attempt_stmt.query_map([&session.session_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        for row in attempts {
            let (id, provider_thread, status) = row?;
            let key = format!("attempt:{id}:{status}");
            if !seen.insert(key) {
                continue;
            }
            if matches_upstream_thread(&provider_thread, &upstream_ids) {
                continue;
            }
            if matches!(status.as_str(), "failed" | "error" | "interrupted") {
                let ts = now_millis();
                self.ensure_started(session, ts, started, &mut on_event);
                on_event(make_event(
                    session,
                    Some(&provider_thread),
                    ts,
                    HarnessEventKind::Error,
                    Some(HarnessActivity::Error),
                    None,
                    None,
                ));
                count += 1;
            }
        }

        let mut node_stmt = conn.prepare("SELECT node_id, provider_thread_id, kind, status, started_at, completed_at FROM orchestration_v2_projection_nodes WHERE thread_id=?1 ORDER BY started_at, node_id")?;
        let nodes = node_stmt.query_map([&session.session_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
            ))
        })?;
        for row in nodes {
            let (id, provider_thread, _kind, status, started_at, completed_at) = row?;
            let key = format!(
                "node:{id}:{status}:{}",
                completed_at.as_deref().unwrap_or("")
            );
            if !seen.insert(key) {
                continue;
            }
            if provider_thread
                .as_ref()
                .is_some_and(|id| matches_upstream_thread(id, &upstream_ids))
            {
                continue;
            }
            if matches!(status.as_str(), "failed" | "error") {
                let ts = completed_at
                    .as_deref()
                    .or(started_at.as_deref())
                    .and_then(parse_rfc3339_millis)
                    .unwrap_or_else(now_millis);
                self.ensure_started(session, ts, started, &mut on_event);
                on_event(make_event(
                    session,
                    provider_thread.as_deref(),
                    ts,
                    HarnessEventKind::Error,
                    Some(HarnessActivity::Error),
                    None,
                    None,
                ));
                count += 1;
            }
        }

        let mut item_stmt = conn.prepare("SELECT turn_item_id, provider_thread_id, ordinal, type, status, updated_at, payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 ORDER BY ordinal, updated_at, turn_item_id")?;
        let items = item_stmt.query_map([&session.session_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
            ))
        })?;
        for row in items {
            let (id, provider_thread, _ordinal, kind, status, updated, raw) = row?;
            let key = format!("item:{id}:{status}:{updated}");
            if !seen.insert(key) {
                continue;
            }
            if provider_thread
                .as_ref()
                .is_some_and(|id| matches_upstream_thread(id, &upstream_ids))
            {
                continue;
            }
            let ts = parse_rfc3339_millis(&updated).unwrap_or_else(now_millis);
            self.ensure_started(session, ts, started, &mut on_event);
            let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
            self.map_turn_item(
                session,
                provider_thread.as_deref(),
                ts,
                &kind,
                &status,
                &payload,
                &mut on_event,
            );
            count += 1;
        }

        // Messages are a fallback when this thread has not yet projected turn
        // items. Do not replay message text: only the role/time metadata is used.
        if !has_turn_items {
            let mut msg_stmt = conn.prepare("SELECT message_id, role, streaming, created_at, updated_at, payload_json FROM orchestration_v2_projection_messages WHERE thread_id=?1 ORDER BY created_at, message_id")?;
            let messages = msg_stmt.query_map([&session.session_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, bool>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })?;
            for row in messages {
                let (id, role, streaming, created, updated, raw) = row?;
                let key = format!("message:{id}:{updated}:{streaming}");
                if !seen.insert(key) {
                    continue;
                }
                let ts = parse_rfc3339_millis(&created).unwrap_or_else(now_millis);
                self.ensure_started(session, ts, started, &mut on_event);
                let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
                if role == "user" {
                    on_event(make_event(
                        session,
                        None,
                        ts,
                        HarnessEventKind::User,
                        Some(HarnessActivity::Running),
                        None,
                        None,
                    ));
                } else if role == "assistant" {
                    on_event(make_event(
                        session,
                        None,
                        ts,
                        HarnessEventKind::Assistant,
                        Some(if streaming {
                            HarnessActivity::Thinking
                        } else {
                            HarnessActivity::Running
                        }),
                        None,
                        None,
                    ));
                }
                if let Some(tokens) = token_usage(&payload) {
                    on_event(make_event(
                        session,
                        None,
                        ts,
                        HarnessEventKind::TokenUsage,
                        None,
                        None,
                        Some(tokens),
                    ));
                }
                count += 1;
            }
        }
        drop(on_event);
        if !started_before_poll {
            if let Some(first_activity) = buffered_events
                .iter()
                .filter(|event| event.kind != HarnessEventKind::SessionStart)
                .map(|event| event.ts)
                .min()
            {
                for event in &mut buffered_events {
                    if event.kind == HarnessEventKind::SessionStart {
                        event.ts = first_activity;
                    }
                }
            }
        }
        buffered_events.sort_by_key(|event| event.ts);
        for event in buffered_events {
            callback(event);
        }
        Ok(count)
    }

    fn ensure_started(
        &self,
        session: &SessionRef,
        ts: i64,
        started: &mut bool,
        on_event: &mut dyn FnMut(HarnessEvent),
    ) {
        if !*started {
            *started = true;
            on_event(make_event(
                session,
                None,
                ts,
                HarnessEventKind::SessionStart,
                Some(HarnessActivity::Running),
                None,
                None,
            ));
        }
    }

    fn map_turn_item(
        &self,
        session: &SessionRef,
        provider_thread: Option<&str>,
        ts: i64,
        kind: &str,
        status: &str,
        payload: &Value,
        on_event: &mut dyn FnMut(HarnessEvent),
    ) {
        let (event_kind, activity, tool) = match kind {
            "user_message" => (
                Some(HarnessEventKind::User),
                Some(HarnessActivity::Running),
                None,
            ),
            "assistant_message" => (
                Some(HarnessEventKind::Assistant),
                Some(HarnessActivity::Running),
                None,
            ),
            "reasoning" => (
                Some(HarnessEventKind::Thinking),
                Some(HarnessActivity::Thinking),
                None,
            ),
            "command_execution" => (
                Some(HarnessEventKind::ToolCall),
                Some(HarnessActivity::ToolCalling),
                Some("shell"),
            ),
            "dynamic_tool" => (
                Some(HarnessEventKind::ToolCall),
                Some(HarnessActivity::ToolCalling),
                Some("dynamic_tool"),
            ),
            "file_change" => (
                Some(HarnessEventKind::ToolCall),
                Some(HarnessActivity::ToolCalling),
                Some("apply_patch"),
            ),
            "file_search" => (
                Some(HarnessEventKind::ToolCall),
                Some(HarnessActivity::ToolCalling),
                Some("file_search"),
            ),
            "web_search" => (
                Some(HarnessEventKind::ToolCall),
                Some(HarnessActivity::ToolCalling),
                Some("web_search"),
            ),
            "subagent" => (
                Some(HarnessEventKind::ToolCall),
                Some(HarnessActivity::ToolCalling),
                Some("subagent"),
            ),
            "user_input_request" => (
                Some(HarnessEventKind::Approval),
                Some(HarnessActivity::WaitingApproval),
                None,
            ),
            "run_interrupt_request" | "run_interrupt_result" | "error" => (
                Some(HarnessEventKind::Error),
                Some(HarnessActivity::Error),
                None,
            ),
            "checkpoint" | "todo_list" => (Some(HarnessEventKind::TokenUsage), None, None),
            _ => (None, None, None),
        };
        if let Some(kind) = event_kind {
            let info = tool.map(|name| ToolInfo {
                name: name.into(),
                args: None,
            });
            let mut event = make_event(
                session,
                provider_thread,
                ts,
                kind,
                activity,
                info.clone(),
                None,
            );
            if kind == HarnessEventKind::TokenUsage {
                event.tokens = token_usage(payload);
            }
            on_event(event);
            if tool.is_some() && matches!(status, "completed" | "failed" | "interrupted") {
                on_event(make_event(
                    session,
                    provider_thread,
                    ts,
                    HarnessEventKind::ToolResult,
                    Some(HarnessActivity::Running),
                    info.map(|t| ToolInfo {
                        name: t.name,
                        args: None,
                    }),
                    None,
                ));
            }
        }
    }
}

impl Adapter for T3Adapter {
    fn harness(&self) -> Harness {
        Harness::T3
    }

    fn discover(&self) -> Result<Vec<SessionRef>> {
        let Ok(conn) = open_read_only(&self.db_path) else {
            return Ok(Vec::new());
        };
        if !self.schema_ok(&conn)? {
            return Ok(Vec::new());
        }
        let metadata = std::fs::metadata(&self.db_path).ok();
        let modified = metadata.as_ref().and_then(|m| m.modified().ok());
        let bytes = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
        let upstream_ids = Self::upstream_ids();
        let mut stmt = conn.prepare("SELECT thread_id, project_id, updated_at FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL ORDER BY updated_at DESC")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        let mut sessions = Vec::new();
        for row in rows {
            let (id, project_id, updated) = row?;
            if !self.has_distinct_activity(&conn, &id, &upstream_ids)? {
                continue;
            }
            let when = parse_rfc3339_millis(&updated).and_then(|millis| {
                (millis >= 0).then(|| {
                    SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(millis as u64)
                })
            });
            let _ = project_id;
            sessions.push(SessionRef {
                harness: Harness::T3,
                session_id: id,
                path: self.db_path.clone(),
                project: None,
                modified: when.or(modified),
                bytes,
            });
        }
        Ok(sessions)
    }

    fn stream(
        &self,
        session: &SessionRef,
        opts: &StreamOptions,
        on_event: &mut dyn FnMut(HarnessEvent),
    ) -> Result<()> {
        let conn = open_read_only(&session.path)?;
        if !self.schema_ok(&conn)? || self.thread_context(&conn, &session.session_id)?.is_none() {
            return Ok(());
        }
        let mut seen = HashSet::new();
        let mut started = false;
        let mut last_activity = Instant::now();
        if !opts.replay {
            // Record the current projection identities and return without
            // emitting them; the next poll only publishes later updates.
            let _ = self.emit_thread(&conn, session, &mut seen, &mut started, &mut |_| {})?;
            started = false;
        }
        loop {
            let count = self.emit_thread(&conn, session, &mut seen, &mut started, on_event)?;
            if count > 0 {
                last_activity = Instant::now();
            }
            let archived_at: Option<String> = conn
                .query_row(
                    "SELECT archived_at FROM orchestration_v2_projection_threads WHERE thread_id=?1",
                    [&session.session_id],
                    |row| row.get(0),
                )
                .optional()?
                .flatten();
            if let Some(ts) = archived_at.as_deref().and_then(parse_rfc3339_millis) {
                on_event(make_event(
                    session,
                    None,
                    ts,
                    HarnessEventKind::SessionEnd,
                    Some(HarnessActivity::Done),
                    None,
                    None,
                ));
                break;
            }
            if !opts.follow {
                break;
            }
            if last_activity.elapsed() >= opts.stale_after {
                on_event(make_event(
                    session,
                    None,
                    now_millis(),
                    HarnessEventKind::SessionEnd,
                    Some(HarnessActivity::Stale),
                    None,
                    None,
                ));
                break;
            }
            std::thread::sleep(
                self.poll
                    .min(opts.stale_after.saturating_sub(last_activity.elapsed())),
            );
        }
        Ok(())
    }
}

fn make_event(
    session: &SessionRef,
    _provider_thread: Option<&str>,
    ts: i64,
    kind: HarnessEventKind,
    status: Option<HarnessActivity>,
    tool: Option<ToolInfo>,
    tokens: Option<TokenUsage>,
) -> HarnessEvent {
    HarnessEvent {
        harness: Harness::T3,
        session_id: session.session_id.clone(),
        project: session.project.clone(),
        ts,
        kind,
        status,
        tool,
        tokens,
        text: None,
    }
}

fn matches_upstream_thread(provider_thread_id: &str, upstream_ids: &HashSet<String>) -> bool {
    upstream_ids.iter().any(|session_id| {
        provider_thread_id == session_id || provider_thread_id.contains(session_id.as_str())
    })
}

fn token_usage(value: &Value) -> Option<TokenUsage> {
    let candidate = value.get("tokens").unwrap_or(value);
    let input = candidate
        .get("input")
        .or_else(|| candidate.get("inputTokens"))
        .or_else(|| candidate.get("input_tokens"))
        .and_then(Value::as_u64);
    let output = candidate
        .get("output")
        .or_else(|| candidate.get("outputTokens"))
        .or_else(|| candidate.get("output_tokens"))
        .and_then(Value::as_u64);
    (input.is_some() || output.is_some()).then_some(TokenUsage { input, output })
}
