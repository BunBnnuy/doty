//! T3 Code adapter for its versioned orchestration-v2 projection. The projection
//! is read-only and guarded by both table and column checks; unknown schemas
//! produce an empty session list rather than speculative queries.

use crate::adapter::{Adapter, SessionRef, StreamOptions};
use crate::codex::CodexAdapter;
use crate::model::{
    Harness, HarnessActivity, HarnessEvent, HarnessEventKind, TokenUsage, ToolInfo,
};
use crate::opencode::OpenCodeAdapter;
use crate::sqlite::{has_columns, has_tables, open_read_only, open_read_write};
use crate::time::{now_millis, parse_rfc3339_millis};
use anyhow::{anyhow, Result};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
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
        // items. Only the final (non-streaming) assistant message carries text.
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
                    let mut event = make_event(
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
                    );
                    if !streaming {
                        event.text = payload_text(&payload);
                    }
                    on_event(event);
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
            // LOCAL ONLY: rendered in the desktop UI. Only a completed assistant
            // message or reasoning block is final, so streaming partials stay
            // text-free.
            if status == "completed"
                && matches!(
                    kind,
                    HarnessEventKind::Assistant | HarnessEventKind::Thinking
                )
            {
                event.text = payload_text(payload);
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

/// LOCAL ONLY. The rendered `text` of an assistant message or reasoning block.
/// It is surfaced through the desktop's local watcher bridge and never leaves
/// the device.
fn payload_text(payload: &Value) -> Option<String> {
    payload
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
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

// ---------------------------------------------------------------------------
// Pending user-input questions (read-only, local-only)
// ---------------------------------------------------------------------------

/// A question a watched T3 thread is waiting for the user to answer.
///
/// LOCAL ONLY: contains the prompt text. It is surfaced to the desktop UI over
/// local IPC and must never be transmitted off-device.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingQuestion {
    pub harness: Harness,
    pub session_id: String,
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_title: Option<String>,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    pub questions: Vec<QuestionPrompt>,
}

/// One prompt within a pending user-input request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionPrompt {
    pub id: String,
    #[serde(default)]
    pub header: String,
    pub question: String,
    #[serde(default)]
    pub options: Vec<QuestionOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multi_select: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_custom_answer: Option<bool>,
}

/// One selectable answer within a prompt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub label: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

/// Runtime-request statuses that mean the question is no longer pending.
const RESOLVED_STATUSES: [&str; 5] = ["resolved", "completed", "cancelled", "failed", "expired"];

/// Pending `user_input` requests across all T3 threads.
///
/// Read-only and fail-closed: a missing table/column or an unknown schema yields
/// an empty list rather than a speculative query. LOCAL ONLY.
pub fn pending_user_input(db_path: &Path) -> Vec<PendingQuestion> {
    let Ok(conn) = open_read_only(db_path) else {
        return Vec::new();
    };
    pending_user_input_conn(&conn).unwrap_or_default()
}

fn pending_user_input_conn(conn: &Connection) -> Result<Vec<PendingQuestion>> {
    if !has_tables(conn, &TABLES)?
        || !has_columns(
            conn,
            "orchestration_v2_projection_runtime_requests",
            &["runtime_request_id", "kind", "status"],
        )?
    {
        return Ok(Vec::new());
    }

    let mut pending: HashSet<String> = HashSet::new();
    {
        let mut stmt = conn.prepare(
            "SELECT runtime_request_id, status FROM orchestration_v2_projection_runtime_requests
             WHERE kind='user_input'",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (id, status) = row?;
            if !RESOLVED_STATUSES.contains(&status.as_str()) {
                pending.insert(id);
            }
        }
    }
    if pending.is_empty() {
        return Ok(Vec::new());
    }

    let mut out = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT ti.thread_id, th.title, ti.payload_json
         FROM orchestration_v2_projection_turn_items ti
         LEFT JOIN orchestration_v2_projection_threads th ON th.thread_id = ti.thread_id
         WHERE ti.type='user_input_request'
         ORDER BY ti.updated_at DESC LIMIT 200",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    for row in rows {
        let (thread_id, thread_title, raw) = row?;
        let Ok(payload) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let Some(request_id) = payload.get("requestId").and_then(Value::as_str) else {
            continue;
        };
        if !pending.contains(request_id) {
            continue;
        }
        let questions = parse_questions(&payload);
        if questions.is_empty() {
            continue;
        }
        out.push(PendingQuestion {
            harness: Harness::T3,
            session_id: thread_id,
            request_id: request_id.to_string(),
            thread_title,
            title: payload
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("User input")
                .to_string(),
            created_at: payload
                .get("startedAt")
                .and_then(Value::as_str)
                .and_then(parse_rfc3339_millis),
            questions,
        });
    }
    Ok(out)
}

fn parse_questions(payload: &Value) -> Vec<QuestionPrompt> {
    let Some(items) = payload.get("questions").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut prompts = Vec::new();
    for item in items {
        let Some(question) = item.get("question").and_then(Value::as_str) else {
            continue;
        };
        let options = item
            .get("options")
            .and_then(Value::as_array)
            .map(|options| {
                options
                    .iter()
                    .filter_map(|option| {
                        let label = option.get("label").and_then(Value::as_str)?;
                        Some(QuestionOption {
                            label: label.to_string(),
                            description: option
                                .get("description")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                            value: option
                                .get("value")
                                .and_then(Value::as_str)
                                .map(str::to_owned),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        prompts.push(QuestionPrompt {
            id: item
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("q0")
                .to_string(),
            header: item
                .get("header")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            question: question.to_string(),
            options,
            multi_select: item.get("multiSelect").and_then(Value::as_bool),
            allow_custom_answer: item.get("allowCustomAnswer").and_then(Value::as_bool),
        });
    }
    prompts
}

// ---------------------------------------------------------------------------
// Responding to a pending question (best-effort local write)
// ---------------------------------------------------------------------------

/// Answer a pending T3 `user_input` request by enqueuing the same
/// `runtime-request.respond` effect T3 writes when the user answers in its UI.
///
/// UNSUPPORTED / BEST EFFORT: this writes to T3's private projection database
/// (`orchestration_v2_effect_outbox`), which T3's effect worker polls. The
/// request is validated as still pending first, and the provider session comes
/// from the stored request — never from the caller. LOCAL ONLY.
pub fn respond_to_user_input(
    db_path: &Path,
    thread_id: &str,
    request_id: &str,
    answers: &BTreeMap<String, String>,
) -> Result<()> {
    let conn = open_read_write(db_path)?;
    respond_to_user_input_conn(&conn, thread_id, request_id, answers)
}

fn respond_to_user_input_conn(
    conn: &Connection,
    thread_id: &str,
    request_id: &str,
    answers: &BTreeMap<String, String>,
) -> Result<()> {
    if !has_tables(
        conn,
        &[
            "orchestration_v2_projection_runtime_requests",
            "orchestration_v2_effect_outbox",
        ],
    )? {
        return Err(anyhow!("unexpected T3 schema"));
    }
    let row: Option<(String, String, String, String)> = conn
        .query_row(
            "SELECT thread_id, kind, status, payload_json
             FROM orchestration_v2_projection_runtime_requests WHERE runtime_request_id=?1",
            [request_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((db_thread, kind, status, payload)) = row else {
        return Err(anyhow!("runtime request not found"));
    };
    if db_thread != thread_id {
        return Err(anyhow!("thread does not match the request"));
    }
    if kind != "user_input" || RESOLVED_STATUSES.contains(&status.as_str()) {
        return Err(anyhow!("request is no longer pending"));
    }
    let payload: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
    let provider_session = payload
        .get("responseCapability")
        .and_then(|capability| capability.get("providerSessionId"))
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("request has no live provider session"))?;

    let command_id = unique_id();
    let effect_id = format!("effect:{command_id}:runtime-request.respond:{request_id}");
    let body = serde_json::json!({
        "type": "runtime-request.respond",
        "providerSessionId": provider_session,
        "requestId": request_id,
        "answers": answers,
    });
    conn.execute(
        "INSERT INTO orchestration_v2_effect_outbox
         (effect_id, command_id, thread_id, effect_type, payload_json, status, attempt_count,
          available_at, lease_owner, lease_expires_at, created_at, updated_at, completed_at, last_error)
         VALUES (?1, ?2, ?3, 'runtime-request.respond', ?4, 'pending', 0,
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, NULL,
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, NULL)",
        rusqlite::params![effect_id, command_id, thread_id, body.to_string()],
    )?;
    Ok(())
}

/// A process-unique id; T3 only requires uniqueness here, not a real UUID.
fn unique_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{nanos:016x}-{seq:04x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, title TEXT);
             CREATE TABLE orchestration_v2_projection_runs (id TEXT);
             CREATE TABLE orchestration_v2_projection_run_attempts (id TEXT);
             CREATE TABLE orchestration_v2_projection_nodes (id TEXT);
             CREATE TABLE orchestration_v2_projection_turn_items
               (thread_id TEXT, type TEXT, updated_at TEXT, payload_json TEXT);
             CREATE TABLE orchestration_v2_projection_messages (id TEXT);
             CREATE TABLE orchestration_v2_projection_runtime_requests
               (runtime_request_id TEXT, thread_id TEXT, kind TEXT, status TEXT, payload_json TEXT);
             CREATE TABLE orchestration_v2_effect_outbox
               (effect_id TEXT PRIMARY KEY, command_id TEXT, thread_id TEXT, effect_type TEXT,
                payload_json TEXT, status TEXT, attempt_count INTEGER, available_at TEXT,
                lease_owner TEXT, lease_expires_at TEXT, created_at TEXT, updated_at TEXT,
                completed_at TEXT, last_error TEXT);",
        )
        .unwrap();
        conn
    }

    fn item(request_id: &str, question: &str) -> String {
        format!(
            r#"{{"requestId":"{request_id}","title":"User input",
                "startedAt":"2026-10-05T19:52:38.072Z",
                "questions":[{{"id":"q0","header":"H","question":"{question}",
                "options":[{{"label":"A","description":"d","value":"a"}}]}}]}}"#
        )
    }

    #[test]
    fn unknown_schema_yields_nothing() {
        let conn = Connection::open_in_memory().unwrap();
        assert!(pending_user_input_conn(&conn).unwrap().is_empty());
    }

    #[test]
    fn returns_only_pending_questions_with_options() {
        let conn = fixture();
        conn.execute(
            "INSERT INTO orchestration_v2_projection_threads VALUES ('th1','Doty')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orchestration_v2_projection_runtime_requests VALUES ('req-pending','th1','user_input','pending','{}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orchestration_v2_projection_runtime_requests VALUES ('req-done','th1','user_input','resolved','{}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orchestration_v2_projection_turn_items VALUES ('th1','user_input_request','2026-10-05T19:52:38.072Z',?1)",
            params![item("req-pending", "Seguimos?")],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orchestration_v2_projection_turn_items VALUES ('th1','user_input_request','2026-10-05T19:26:53.303Z',?1)",
            params![item("req-done", "Ya resuelta")],
        )
        .unwrap();

        let pending = pending_user_input_conn(&conn).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].request_id, "req-pending");
        assert_eq!(pending[0].thread_title.as_deref(), Some("Doty"));
        assert_eq!(pending[0].questions.len(), 1);
        assert_eq!(pending[0].questions[0].question, "Seguimos?");
        assert_eq!(pending[0].questions[0].options[0].value.as_deref(), Some("a"));
        // Wire shape keeps camelCase and stays local-only.
        let json = serde_json::to_string(&pending[0]).unwrap();
        assert!(json.contains("\"requestId\":\"req-pending\""));
        assert!(json.contains("\"threadTitle\":\"Doty\""));
    }

    #[test]
    fn responding_enqueues_the_effect_and_validates_state() {
        let conn = fixture();
        let capability = r#"{"responseCapability":{"type":"live","providerSessionId":"provider-session:opencode:shared"}}"#;
        conn.execute(
            "INSERT INTO orchestration_v2_projection_runtime_requests VALUES ('req-1','th1','user_input','pending',?1)",
            params![capability],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orchestration_v2_projection_runtime_requests VALUES ('req-done','th1','user_input','resolved',?1)",
            params![capability],
        )
        .unwrap();

        let mut answers = BTreeMap::new();
        answers.insert("q0".to_string(), "Sí".to_string());
        respond_to_user_input_conn(&conn, "th1", "req-1", &answers).unwrap();

        let row: (String, String, String, String) = conn
            .query_row(
                "SELECT thread_id, effect_type, status, payload_json FROM orchestration_v2_effect_outbox",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(row.0, "th1");
        assert_eq!(row.1, "runtime-request.respond");
        assert_eq!(row.2, "pending");
        assert!(row.3.contains("\"providerSessionId\":\"provider-session:opencode:shared\""));
        assert!(row.3.contains("\"requestId\":\"req-1\""));
        assert!(row.3.contains("\"q0\":\"Sí\""));

        // Resolved requests, unknown ids, and thread mismatches are rejected.
        assert!(respond_to_user_input_conn(&conn, "th1", "req-done", &answers).is_err());
        assert!(respond_to_user_input_conn(&conn, "th1", "missing", &answers).is_err());
        assert!(respond_to_user_input_conn(&conn, "other", "req-1", &answers).is_err());
    }

    #[test]
    fn reasoning_items_carry_text_only_once_completed() {
        let adapter = T3Adapter::with_db(":memory:");
        let session = SessionRef {
            harness: Harness::T3,
            session_id: "th1".into(),
            path: PathBuf::from(":memory:"),
            project: None,
            modified: None,
            bytes: 0,
        };
        let payload = serde_json::json!({ "text": "  check the logs  ", "streaming": false });

        let mut events = Vec::new();
        adapter.map_turn_item(
            &session,
            None,
            100,
            "reasoning",
            "completed",
            &payload,
            &mut |event| events.push(event),
        );
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, HarnessEventKind::Thinking);
        assert_eq!(events[0].text.as_deref(), Some("check the logs"));

        // Streaming partials stay text-free, exactly like assistant messages.
        let mut partial = Vec::new();
        adapter.map_turn_item(
            &session,
            None,
            100,
            "reasoning",
            "streaming",
            &payload,
            &mut |event| partial.push(event),
        );
        assert!(partial[0].text.is_none());
    }
}
