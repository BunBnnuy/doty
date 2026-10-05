//! OpenCode's read-only SQLite adapter. The current `session_v2` log is
//! authoritative; the legacy `session/message/part` model is used when a
//! session has no v2 messages.

use crate::adapter::{Adapter, SessionRef, StreamOptions};
use crate::model::{
    Harness, HarnessActivity, HarnessEvent, HarnessEventKind, TokenUsage, ToolInfo,
};
use crate::sqlite::{has_columns, has_tables, open_read_only};
use crate::time::now_millis;
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime};

const V2_TABLES: [&str; 2] = ["session_v2", "session_message"];
const V1_TABLES: [&str; 3] = ["session", "message", "part"];

#[derive(Debug, Clone)]
pub struct OpenCodeAdapter {
    db_path: PathBuf,
    poll: std::time::Duration,
}

impl Default for OpenCodeAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl OpenCodeAdapter {
    pub fn new() -> Self {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".to_string());
        Self::with_db(PathBuf::from(home).join(".local/share/opencode/opencode.db"))
    }

    pub fn with_db(path: impl Into<PathBuf>) -> Self {
        Self {
            db_path: path.into(),
            poll: std::time::Duration::from_millis(500),
        }
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    fn schema(&self, conn: &Connection) -> Result<(bool, bool)> {
        let v2 = has_tables(conn, &V2_TABLES)?
            && has_columns(
                conn,
                "session_v2",
                &[
                    "id",
                    "directory",
                    "time_created",
                    "time_updated",
                    "time_archived",
                ],
            )?
            && has_columns(
                conn,
                "session_message",
                &["id", "session_id", "type", "seq", "time_created", "data"],
            )?;
        let v1 = has_tables(conn, &V1_TABLES)?
            && has_columns(
                conn,
                "session",
                &[
                    "id",
                    "directory",
                    "time_created",
                    "time_updated",
                    "time_archived",
                ],
            )?
            && has_columns(
                conn,
                "message",
                &["id", "session_id", "time_created", "data"],
            )?
            && has_columns(
                conn,
                "part",
                &["id", "message_id", "session_id", "time_created", "data"],
            )?;
        Ok((v2, v1))
    }

    fn session_has_v2(conn: &Connection, id: &str) -> Result<bool> {
        Ok(conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM session_message WHERE session_id=?1)",
            [id],
            |row| row.get(0),
        )?)
    }

    fn read_v2(
        &self,
        conn: &Connection,
        session: &SessionRef,
        after: i64,
        on_event: &mut dyn FnMut(HarnessEvent),
        started: &mut bool,
    ) -> Result<i64> {
        let mut stmt = conn.prepare(
            "SELECT seq, type, time_created, data FROM session_message WHERE session_id=?1 AND seq>?2 ORDER BY seq",
        )?;
        let rows = stmt.query_map((&session.session_id, after), |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        let mut cursor = after;
        for row in rows {
            let (seq, kind, time_created, raw) = row?;
            cursor = cursor.max(seq);
            let Ok(data) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            let ts =
                json_timestamp(data.get("time")).unwrap_or_else(|| sqlite_timestamp(time_created));
            self.ensure_started(session, ts, started, on_event);
            match kind.as_str() {
                "user" => on_event(make_event(
                    session,
                    ts,
                    HarnessEventKind::User,
                    Some(HarnessActivity::Running),
                    None,
                    None,
                    data.get("text").and_then(Value::as_str).map(str::to_string),
                )),
                "assistant" => {
                    let content = data.get("content").and_then(Value::as_array);
                    if let Some(content) = content {
                        for block in content {
                            let block_type =
                                block.get("type").and_then(Value::as_str).unwrap_or("");
                            match block_type {
                                "text" => {
                                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                                        on_event(make_event(
                                            session,
                                            ts,
                                            HarnessEventKind::Assistant,
                                            Some(HarnessActivity::Running),
                                            None,
                                            None,
                                            Some(text.to_string()),
                                        ));
                                    }
                                }
                                "reasoning" => {
                                    on_event(make_event(
                                        session,
                                        ts,
                                        HarnessEventKind::Thinking,
                                        Some(HarnessActivity::Thinking),
                                        None,
                                        None,
                                        block
                                            .get("text")
                                            .and_then(Value::as_str)
                                            .map(str::to_string),
                                    ));
                                }
                                "tool" => self.map_tool_block(session, ts, block, on_event),
                                "patch" => {
                                    let tool = ToolInfo {
                                        name: "apply_patch".into(),
                                        args: None,
                                    };
                                    on_event(make_event(
                                        session,
                                        ts,
                                        HarnessEventKind::ToolCall,
                                        Some(HarnessActivity::ToolCalling),
                                        Some(tool),
                                        None,
                                        None,
                                    ));
                                }
                                _ => {}
                            }
                        }
                    } else {
                        on_event(make_event(
                            session,
                            ts,
                            HarnessEventKind::Assistant,
                            Some(HarnessActivity::Running),
                            None,
                            None,
                            None,
                        ));
                    }
                    if let Some(tokens) = data.get("tokens").and_then(token_usage) {
                        on_event(make_event(
                            session,
                            ts,
                            HarnessEventKind::TokenUsage,
                            None,
                            None,
                            Some(tokens),
                            None,
                        ));
                    }
                    // Error payload strings are intentionally not retained.
                    if data.get("error").is_some_and(|v| !v.is_null()) {
                        on_event(make_event(
                            session,
                            ts,
                            HarnessEventKind::Error,
                            Some(HarnessActivity::Error),
                            None,
                            None,
                            None,
                        ));
                    }
                }
                "idle" => on_event(make_event(
                    session,
                    ts,
                    HarnessEventKind::TurnEnd,
                    Some(HarnessActivity::Idle),
                    None,
                    None,
                    None,
                )),
                _ => {}
            }
        }
        Ok(cursor)
    }

    fn map_tool_block(
        &self,
        session: &SessionRef,
        ts: i64,
        block: &Value,
        on_event: &mut dyn FnMut(HarnessEvent),
    ) {
        let state = block.get("state");
        let name = block
            .get("tool")
            .or_else(|| block.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        // Tool inputs can contain arbitrary prompt text, so expose the tool
        // identity only. Digests remain structural and never carry arguments.
        let tool = ToolInfo { name, args: None };
        let status = state
            .and_then(|s| s.get("status"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if status == "completed" || status == "error" {
            on_event(make_event(
                session,
                ts,
                HarnessEventKind::ToolCall,
                Some(HarnessActivity::ToolCalling),
                Some(tool.clone()),
                None,
                None,
            ));
            on_event(make_event(
                session,
                ts,
                HarnessEventKind::ToolResult,
                Some(HarnessActivity::Running),
                Some(ToolInfo {
                    name: tool.name,
                    args: None,
                }),
                None,
                None,
            ));
        } else {
            on_event(make_event(
                session,
                ts,
                HarnessEventKind::ToolCall,
                Some(HarnessActivity::ToolCalling),
                Some(tool),
                None,
                None,
            ));
        }
    }

    fn read_v1(
        &self,
        conn: &Connection,
        session: &SessionRef,
        seen: &mut HashSet<String>,
        on_event: &mut dyn FnMut(HarnessEvent),
        started: &mut bool,
    ) -> Result<()> {
        let mut messages = conn.prepare("SELECT id, time_created, data FROM message WHERE session_id=?1 ORDER BY time_created, id")?;
        let rows = messages.query_map([&session.session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (message_id, time_created, raw) = row?;
            if !seen.insert(format!("m:{message_id}")) {
                continue;
            }
            let Ok(data) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            let ts =
                json_timestamp(data.get("time")).unwrap_or_else(|| sqlite_timestamp(time_created));
            self.ensure_started(session, ts, started, on_event);
            let role = data.get("role").and_then(Value::as_str).unwrap_or("");
            if role == "user" || role == "assistant" {
                if let Some(tokens) = data.get("tokens").and_then(token_usage) {
                    on_event(make_event(
                        session,
                        ts,
                        HarnessEventKind::TokenUsage,
                        None,
                        None,
                        Some(tokens),
                        None,
                    ));
                }
                if role == "user" {
                    on_event(make_event(
                        session,
                        ts,
                        HarnessEventKind::User,
                        Some(HarnessActivity::Running),
                        None,
                        None,
                        None,
                    ));
                }
            }
            let mut parts = conn.prepare("SELECT id, time_created, data FROM part WHERE message_id=?1 ORDER BY time_created, id")?;
            let part_rows = parts.query_map([&message_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?;
            for part_row in part_rows {
                let (part_id, part_time, part_raw) = part_row?;
                if !seen.insert(format!("p:{part_id}")) {
                    continue;
                }
                let Ok(part) = serde_json::from_str::<Value>(&part_raw) else {
                    continue;
                };
                let pts = sqlite_timestamp(part_time);
                let ptype = part.get("type").and_then(Value::as_str).unwrap_or("");
                match ptype {
                    "text" if role == "assistant" => on_event(make_event(
                        session,
                        pts,
                        HarnessEventKind::Assistant,
                        Some(HarnessActivity::Running),
                        None,
                        None,
                        part.get("text").and_then(Value::as_str).map(str::to_string),
                    )),
                    "reasoning" => on_event(make_event(
                        session,
                        pts,
                        HarnessEventKind::Thinking,
                        Some(HarnessActivity::Thinking),
                        None,
                        None,
                        part.get("text").and_then(Value::as_str).map(str::to_string),
                    )),
                    "tool" => {
                        let tool_state = part.get("state");
                        let name = part
                            .get("tool")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown")
                            .to_string();
                        let tool = ToolInfo {
                            name: name.clone(),
                            args: None,
                        };
                        on_event(make_event(
                            session,
                            pts,
                            HarnessEventKind::ToolCall,
                            Some(HarnessActivity::ToolCalling),
                            Some(tool),
                            None,
                            None,
                        ));
                        let status = tool_state
                            .and_then(|s| s.get("status"))
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        if status == "completed" || status == "error" {
                            on_event(make_event(
                                session,
                                pts,
                                HarnessEventKind::ToolResult,
                                Some(HarnessActivity::Running),
                                Some(ToolInfo { name, args: None }),
                                None,
                                None,
                            ));
                        }
                    }
                    "patch" => on_event(make_event(
                        session,
                        pts,
                        HarnessEventKind::ToolCall,
                        Some(HarnessActivity::ToolCalling),
                        Some(ToolInfo {
                            name: "apply_patch".into(),
                            args: None,
                        }),
                        None,
                        None,
                    )),
                    "step-finish" => on_event(make_event(
                        session,
                        pts,
                        HarnessEventKind::TurnEnd,
                        Some(HarnessActivity::Idle),
                        None,
                        part.get("tokens").and_then(token_usage),
                        None,
                    )),
                    _ => {}
                }
            }
        }
        Ok(())
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
                ts,
                HarnessEventKind::SessionStart,
                Some(HarnessActivity::Running),
                None,
                None,
                None,
            ));
        }
    }
}

impl Adapter for OpenCodeAdapter {
    fn harness(&self) -> Harness {
        Harness::Opencode
    }

    fn discover(&self) -> Result<Vec<SessionRef>> {
        let Ok(conn) = open_read_only(&self.db_path) else {
            return Ok(Vec::new());
        };
        let (v2, v1) = self.schema(&conn)?;
        if !v2 && !v1 {
            return Ok(Vec::new());
        }
        let metadata = std::fs::metadata(&self.db_path).ok();
        let modified = metadata.as_ref().and_then(|m| m.modified().ok());
        let bytes = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
        let mut sessions = Vec::new();
        if v2 {
            let mut stmt = conn.prepare(
                "SELECT id, directory, time_updated FROM session_v2 ORDER BY time_updated DESC",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?;
            for row in rows {
                let (id, directory, updated) = row?;
                sessions.push(SessionRef {
                    harness: Harness::Opencode,
                    session_id: id,
                    path: self.db_path.clone(),
                    project: Some(directory),
                    modified: modified.or_else(|| {
                        Some(
                            SystemTime::UNIX_EPOCH
                                + std::time::Duration::from_millis(updated.max(0) as u64),
                        )
                    }),
                    bytes,
                });
            }
        } else if v1 {
            let mut stmt = conn.prepare(
                "SELECT id, directory, time_updated FROM session ORDER BY time_updated DESC",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?;
            for row in rows {
                let (id, directory, updated) = row?;
                sessions.push(SessionRef {
                    harness: Harness::Opencode,
                    session_id: id,
                    path: self.db_path.clone(),
                    project: Some(directory),
                    modified: modified.or_else(|| {
                        Some(
                            SystemTime::UNIX_EPOCH
                                + std::time::Duration::from_millis(updated.max(0) as u64),
                        )
                    }),
                    bytes,
                });
            }
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
        let (v2, v1) = self.schema(&conn)?;
        if !v2 && !v1 {
            return Ok(());
        }
        let use_v2 = v2 && Self::session_has_v2(&conn, &session.session_id).unwrap_or(false);
        let mut cursor = if use_v2 && !opts.replay {
            conn.query_row(
                "SELECT COALESCE(MAX(seq),0) FROM session_message WHERE session_id=?1",
                [&session.session_id],
                |r| r.get(0),
            )?
        } else {
            0
        };
        let mut seen = HashSet::new();
        if !opts.replay && !use_v2 {
            let mut messages = conn.prepare("SELECT id FROM message WHERE session_id=?1")?;
            for id in messages.query_map([&session.session_id], |row| row.get::<_, String>(0))? {
                seen.insert(format!("m:{}", id?));
            }
            let mut parts = conn.prepare("SELECT id FROM part WHERE session_id=?1")?;
            for id in parts.query_map([&session.session_id], |row| row.get::<_, String>(0))? {
                seen.insert(format!("p:{}", id?));
            }
        }
        let mut started = false;
        let mut last_activity = Instant::now();
        loop {
            let before = cursor;
            let seen_before = seen.len();
            if use_v2 {
                cursor = self.read_v2(&conn, session, cursor, on_event, &mut started)?;
            } else if v1 {
                self.read_v1(&conn, session, &mut seen, on_event, &mut started)?;
            }
            if cursor != before || seen.len() != seen_before {
                last_activity = Instant::now();
            }

            let archived = if v2 {
                conn.query_row(
                    "SELECT time_archived FROM session_v2 WHERE id=?1",
                    [&session.session_id],
                    |r| r.get::<_, Option<i64>>(0),
                )
                .optional()?
                .flatten()
            } else if v1 {
                conn.query_row(
                    "SELECT time_archived FROM session WHERE id=?1",
                    [&session.session_id],
                    |r| r.get::<_, Option<i64>>(0),
                )
                .optional()?
                .flatten()
            } else {
                None
            };
            if let Some(archived) = archived {
                on_event(make_event(
                    session,
                    sqlite_timestamp(archived),
                    HarnessEventKind::SessionEnd,
                    Some(HarnessActivity::Done),
                    None,
                    None,
                    None,
                ));
                return Ok(());
            }
            if !opts.follow {
                return Ok(());
            }
            if last_activity.elapsed() >= opts.stale_after {
                on_event(make_event(
                    session,
                    now_millis(),
                    HarnessEventKind::SessionEnd,
                    Some(HarnessActivity::Stale),
                    None,
                    None,
                    None,
                ));
                return Ok(());
            }
            std::thread::sleep(
                self.poll
                    .min(opts.stale_after.saturating_sub(last_activity.elapsed())),
            );
        }
    }
}

fn make_event(
    session: &SessionRef,
    ts: i64,
    kind: HarnessEventKind,
    status: Option<HarnessActivity>,
    tool: Option<ToolInfo>,
    tokens: Option<TokenUsage>,
    text: Option<String>,
) -> HarnessEvent {
    HarnessEvent {
        harness: Harness::Opencode,
        session_id: session.session_id.clone(),
        project: session.project.clone(),
        ts,
        kind,
        status,
        tool,
        tokens,
        text,
    }
}

fn sqlite_timestamp(value: i64) -> i64 {
    if value.abs() < 100_000_000_000 {
        value.saturating_mul(1000)
    } else {
        value
    }
}

fn json_timestamp(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    if let Some(number) = value.as_i64() {
        return Some(sqlite_timestamp(number));
    }
    value
        .as_str()
        .and_then(|s| crate::time::parse_rfc3339_millis(s))
}

fn token_usage(value: &Value) -> Option<TokenUsage> {
    let input = value
        .get("input")
        .or_else(|| value.get("input_tokens"))
        .or_else(|| value.get("inputTokens"))
        .and_then(Value::as_u64);
    let output = value
        .get("output")
        .or_else(|| value.get("output_tokens"))
        .or_else(|| value.get("outputTokens"))
        .and_then(Value::as_u64);
    (input.is_some() || output.is_some()).then_some(TokenUsage { input, output })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn timestamp_handles_seconds_millis_and_iso() {
        assert_eq!(sqlite_timestamp(1_790_000_000), 1_790_000_000_000);
        assert_eq!(sqlite_timestamp(1_790_000_000_000), 1_790_000_000_000);
        assert!(json_timestamp(Some(&Value::String("2026-10-02T00:00:00Z".into()))).is_some());
    }
}
