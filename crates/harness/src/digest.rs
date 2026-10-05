//! Structural digest builder.
//!
//! Derives [`SessionDigest`] from the normalized event stream only — no LLM, no
//! raw content. `HarnessEvent::text` is intentionally never read here: the only
//! harness payload that may reach the online brain is the digest, and its
//! `error_excerpt` stays `None` unless a caller explicitly opts in elsewhere.

use crate::model::{
    DigestOutcome, Harness, HarnessActivity, HarnessEvent, HarnessEventKind, SessionDigest,
    TokenUsage,
};
use std::collections::{BTreeMap, BTreeSet};

/// Incrementally folds events into a [`SessionDigest`].
#[derive(Debug, Default)]
pub struct DigestBuilder {
    harness: Option<Harness>,
    session_id: Option<String>,
    project: Option<String>,
    started_at: Option<i64>,
    last_ts: i64,
    ended_at: Option<i64>,
    end_status: Option<HarnessActivity>,
    turns: u64,
    tool_calls: BTreeMap<String, u64>,
    files: BTreeSet<String>,
    approval_decisions: u64,
    tokens: Option<TokenUsage>,
    saw_error: bool,
    /// A turn is open after a user/assistant/tool event and closed by `turn_end`.
    active_turn: bool,
}

impl DigestBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fold one event. `text` is never inspected.
    pub fn observe(&mut self, event: &HarnessEvent) {
        if self.harness.is_none() {
            self.harness = Some(event.harness);
        }
        if self.session_id.is_none() {
            self.session_id = Some(event.session_id.clone());
        }
        if event.project.is_some() {
            self.project = event.project.clone();
        }
        if self.started_at.is_none() {
            self.started_at = Some(event.ts);
        }
        self.last_ts = event.ts;

        match event.kind {
            HarnessEventKind::SessionStart => {}
            HarnessEventKind::User
            | HarnessEventKind::Assistant
            | HarnessEventKind::Thinking
            | HarnessEventKind::ToolResult => {
                self.active_turn = true;
            }
            HarnessEventKind::ToolCall => {
                self.active_turn = true;
                if let Some(tool) = &event.tool {
                    *self.tool_calls.entry(tool.name.clone()).or_insert(0) += 1;
                    collect_files(&self.project, tool.args.as_ref(), &mut self.files);
                }
            }
            HarnessEventKind::Approval => {
                self.active_turn = true;
                self.approval_decisions += 1;
            }
            HarnessEventKind::TokenUsage => {
                if event.tokens.is_some() {
                    self.tokens = event.tokens.clone();
                }
            }
            HarnessEventKind::TurnEnd => {
                self.turns += 1;
                self.active_turn = false;
            }
            HarnessEventKind::Error => {
                self.saw_error = true;
            }
            HarnessEventKind::SessionEnd => {
                self.ended_at = Some(event.ts);
                self.end_status = event.status;
            }
        }
    }

    pub fn finish(self) -> SessionDigest {
        let harness = self.harness.unwrap_or(Harness::Codex);
        let started_at = self.started_at.unwrap_or(self.last_ts);
        let ended_at = match self.ended_at {
            Some(t) => Some(t),
            None if self.last_ts != 0 => Some(self.last_ts),
            None => None,
        };
        let duration_ms = ended_at.map(|end| (end - started_at).max(0));

        let outcome = if self.saw_error {
            DigestOutcome::Error
        } else if self.active_turn {
            // Live stream ended mid-turn: the harness went quiet before the turn
            // closed.
            DigestOutcome::Interrupted
        } else if self.turns > 0 || self.end_status.is_some() {
            DigestOutcome::Done
        } else {
            DigestOutcome::Interrupted
        };

        SessionDigest {
            harness,
            session_id: self.session_id.unwrap_or_default(),
            project: self.project,
            // Title is never derived from raw content (it crosses the wire).
            title: None,
            started_at,
            ended_at,
            duration_ms,
            turns: self.turns,
            tool_calls: self.tool_calls,
            files_touched: self.files.into_iter().collect(),
            approval_decisions: self.approval_decisions,
            tokens: self.tokens,
            outcome,
            // OPT-IN only: never populated by default.
            error_excerpt: None,
        }
    }
}

/// Build a digest from an event slice.
pub fn build_digest<'a, I>(events: I) -> SessionDigest
where
    I: IntoIterator<Item = &'a HarnessEvent>,
{
    let mut builder = DigestBuilder::new();
    for event in events {
        builder.observe(event);
    }
    builder.finish()
}

/// Pull file paths out of a tool's structured args. Convention used by the
/// adapters: `args.files = [..]` (and `args.file`, singular).
fn collect_files(project: &Option<String>, args: Option<&serde_json::Value>, out: &mut BTreeSet<String>) {
    let Some(args) = args else { return };
    let mut push = |value: &serde_json::Value| {
        if let Some(path) = value.as_str() {
            out.insert(relativize(project.as_deref(), path));
        }
    };
    match args.get("files") {
        Some(serde_json::Value::Array(items)) => {
            for item in items {
                push(item);
            }
        }
        Some(other) => push(other),
        None => {}
    }
    if let Some(file) = args.get("file") {
        push(file);
    }
}

/// Repo-relative where possible, with forward slashes.
fn relativize(project: Option<&str>, path: &str) -> String {
    let normalized = path.replace('\\', "/");
    if let Some(project) = project {
        let project = project.replace('\\', "/");
        let project = project.trim_end_matches('/');
        let lower_project = project.to_ascii_lowercase();
        let lower_path = normalized.to_ascii_lowercase();
        if lower_path == lower_project {
            return String::new();
        }
        if lower_path.starts_with(&(lower_project.clone() + "/")) {
            return normalized[project.len() + 1..].to_string();
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{HarnessEventKind, ToolInfo};

    fn ev(kind: HarnessEventKind) -> HarnessEvent {
        HarnessEvent {
            harness: Harness::Codex,
            session_id: "s".into(),
            project: Some("C:/repo".into()),
            ts: 0,
            kind,
            status: None,
            tool: None,
            tokens: None,
            text: Some("LOCAL ONLY".into()),
        }
    }

    #[test]
    fn derives_turns_tools_files_and_outcome() {
        let mut events = vec![ev(HarnessEventKind::SessionStart)];
        events[0].ts = 100;
        events[0].status = Some(HarnessActivity::Running);

        let mut user = ev(HarnessEventKind::User);
        user.ts = 200;
        events.push(user);

        let mut call = ev(HarnessEventKind::ToolCall);
        call.ts = 300;
        call.tool = Some(ToolInfo {
            name: "shell".into(),
            args: Some(serde_json::json!({ "command": "ls" })),
        });
        events.push(call);

        let mut patch = ev(HarnessEventKind::ToolCall);
        patch.ts = 400;
        patch.tool = Some(ToolInfo {
            name: "apply_patch".into(),
            args: Some(serde_json::json!({
                "files": ["C:\\repo\\src\\a.rs", "C:/repo/src/b.rs", "/outside/c.rs"]
            })),
        });
        events.push(patch);

        let mut end = ev(HarnessEventKind::TurnEnd);
        end.ts = 500;
        events.push(end);

        let digest = build_digest(&events);
        assert_eq!(digest.turns, 1);
        assert_eq!(digest.tool_calls.get("shell"), Some(&1));
        assert_eq!(digest.tool_calls.get("apply_patch"), Some(&1));
        assert_eq!(
            digest.files_touched,
            vec!["/outside/c.rs".to_string(), "src/a.rs".into(), "src/b.rs".into()]
        );
        assert_eq!(digest.started_at, 100);
        assert_eq!(digest.ended_at, Some(500));
        assert_eq!(digest.duration_ms, Some(400));
        assert_eq!(digest.outcome, DigestOutcome::Done);
        // Privacy: no text, no excerpt.
        assert!(digest.error_excerpt.is_none());
        let json = serde_json::to_value(&digest).unwrap();
        assert!(json.get("text").is_none());
        assert!(json.get("errorExcerpt").is_none());
    }

    #[test]
    fn open_turn_is_interrupted_and_error_wins() {
        let mut events = vec![ev(HarnessEventKind::User)];
        events[0].ts = 10;
        let digest = build_digest(&events);
        assert_eq!(digest.outcome, DigestOutcome::Interrupted);

        events.push(ev(HarnessEventKind::Error));
        let digest = build_digest(&events);
        assert_eq!(digest.outcome, DigestOutcome::Error);
    }
}
