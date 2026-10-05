//! Rust mirror of `@doty/harness-events` (`packages/harness-events/src/index.ts`).
//!
//! Field names are kept **identical** to the TypeScript contract, so the JSON
//! emitted here deserializes 1:1 on the server/desktop side. Enums serialize to
//! the same lowercase / snake_case string literals as the TS unions.
//!
//! PRIVACY: [`HarnessEvent::text`] is **LOCAL ONLY** and must never be
//! transmitted. Use [`HarnessEvent::to_wire_value`] when handing an event to any
//! transport. [`SessionDigest`] is the only harness payload that may cross the
//! wire, and its `errorExcerpt` is opt-in (we never populate it).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// `export type Harness = 'codex' | 'opencode' | 't3';`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Harness {
    Codex,
    Opencode,
    T3,
}

impl Harness {
    pub fn as_str(self) -> &'static str {
        match self {
            Harness::Codex => "codex",
            Harness::Opencode => "opencode",
            Harness::T3 => "t3",
        }
    }
}

impl std::fmt::Display for Harness {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// `export type HarnessEventKind = ...`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessEventKind {
    SessionStart,
    User,
    Assistant,
    Thinking,
    ToolCall,
    ToolResult,
    TokenUsage,
    Approval,
    Error,
    TurnEnd,
    SessionEnd,
}

/// `export type HarnessActivity = ...`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessActivity {
    Running,
    Thinking,
    ToolCalling,
    WaitingApproval,
    Idle,
    Done,
    Error,
    Stale,
}

/// `tool?: { name: string; args?: unknown }`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolInfo {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Value>,
}

/// `tokens?: { input?: number; output?: number }`
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<u64>,
}

/// `tokens?: { input: number; output: number }` (required, for `HarnessStatus`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenTotals {
    pub input: u64,
    pub output: u64,
}

/// `export interface HarnessEvent`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessEvent {
    pub harness: Harness,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// Epoch millis.
    pub ts: i64,
    pub kind: HarnessEventKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<HarnessActivity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<ToolInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<TokenUsage>,
    /// LOCAL ONLY — never transmitted to the server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

impl HarnessEvent {
    /// Serialize to JSON **without** the LOCAL-ONLY `text` field. This is the
    /// only shape that may be handed to a transport.
    pub fn to_wire_value(&self) -> Value {
        let mut value = serde_json::to_value(self).expect("HarnessEvent serializes");
        if let Some(obj) = value.as_object_mut() {
            obj.remove("text");
        }
        value
    }
}

/// `export interface HarnessStatus` (what the UI shows as a satellite dot).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessStatus {
    pub harness: Harness,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub status: HarnessActivity,
    /// Epoch millis of the last observed event.
    pub last_activity_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<TokenTotals>,
}

/// `outcome: 'done' | 'error' | 'interrupted'`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DigestOutcome {
    Done,
    Error,
    Interrupted,
}

/// `export interface SessionDigest`
///
/// Structurally derived on the client — no LLM, no raw content. This is the only
/// harness payload that reaches the online brain.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDigest {
    pub harness: Harness,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub started_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    #[serde(default)]
    pub turns: u64,
    /// e.g. `{ "shell": 4, "apply_patch": 9 }`
    #[serde(default)]
    pub tool_calls: BTreeMap<String, u64>,
    /// Repo-relative paths where possible.
    #[serde(default)]
    pub files_touched: Vec<String>,
    #[serde(default)]
    pub approval_decisions: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<TokenUsage>,
    pub outcome: DigestOutcome,
    /// OPT-IN only. Never populated by default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_excerpt: Option<String>,
}

/// The subset of a digest that is safe to transmit (mirror of
/// `TRANSMITTED_DIGEST_FIELDS`).
pub const TRANSMITTED_DIGEST_FIELDS: [&str; 13] = [
    "harness",
    "sessionId",
    "project",
    "title",
    "startedAt",
    "endedAt",
    "durationMs",
    "turns",
    "toolCalls",
    "filesTouched",
    "approvalDecisions",
    "tokens",
    "outcome",
];

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_event() -> HarnessEvent {
        HarnessEvent {
            harness: Harness::Codex,
            session_id: "sess-1".into(),
            project: Some("C:/repo".into()),
            ts: 1_700_000_000_000,
            kind: HarnessEventKind::ToolCall,
            status: Some(HarnessActivity::ToolCalling),
            tool: Some(ToolInfo {
                name: "shell".into(),
                args: Some(serde_json::json!({ "command": "ls" })),
            }),
            tokens: Some(TokenUsage {
                input: Some(10),
                output: Some(2),
            }),
            text: Some("SECRET LOCAL TRANSCRIPT".into()),
        }
    }

    #[test]
    fn event_field_names_match_ts_contract() {
        let value = serde_json::to_value(sample_event()).unwrap();
        assert_eq!(value["harness"], "codex");
        assert_eq!(value["sessionId"], "sess-1");
        assert_eq!(value["kind"], "tool_call");
        assert_eq!(value["status"], "tool_calling");
        assert_eq!(value["tool"]["name"], "shell");
        assert_eq!(value["tokens"]["input"], 10);
    }

    #[test]
    fn wire_value_drops_local_only_text() {
        let value = sample_event().to_wire_value();
        assert!(value.get("text").is_none(), "text must never cross the wire");
        // Everything else survives.
        assert_eq!(value["kind"], "tool_call");
    }

    #[test]
    fn enum_strings_match_ts_unions() {
        assert_eq!(serde_json::to_value(Harness::Opencode).unwrap(), "opencode");
        assert_eq!(serde_json::to_value(Harness::T3).unwrap(), "t3");
        assert_eq!(
            serde_json::to_value(HarnessActivity::WaitingApproval).unwrap(),
            "waiting_approval"
        );
        assert_eq!(
            serde_json::to_value(HarnessEventKind::SessionStart).unwrap(),
            "session_start"
        );
        assert_eq!(serde_json::to_value(DigestOutcome::Interrupted).unwrap(), "interrupted");
    }

    #[test]
    fn digest_field_names_match_ts_contract() {
        let digest = SessionDigest {
            harness: Harness::Codex,
            session_id: "sess-1".into(),
            project: None,
            title: None,
            started_at: 1,
            ended_at: Some(2),
            duration_ms: Some(1),
            turns: 3,
            tool_calls: BTreeMap::from([("shell".to_string(), 4)]),
            files_touched: vec!["src/a.rs".into()],
            approval_decisions: 0,
            tokens: None,
            outcome: DigestOutcome::Done,
            error_excerpt: None,
        };
        let value = serde_json::to_value(digest).unwrap();
        assert_eq!(value["sessionId"], "sess-1");
        assert_eq!(value["startedAt"], 1);
        assert_eq!(value["toolCalls"]["shell"], 4);
        assert_eq!(value["filesTouched"][0], "src/a.rs");
        assert_eq!(value["outcome"], "done");
        assert!(value.get("errorExcerpt").is_none());
    }
}
