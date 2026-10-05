//! Local watcher bridge.
//!
//! Forwards, **over local IPC only**, each session's metadata (`HarnessStatus`)
//! and its most recent activity lines (`ActivityBatch`). The `text` field is
//! rendered in the desktop UI; it is never handed to a network transport and no
//! server sink exists in this crate.
use doty_harness::{
    time::now_millis, Adapter, CodexAdapter, Harness, HarnessActivity, HarnessEvent,
    HarnessEventKind, HarnessStatus, OpenCodeAdapter, PendingQuestion, SessionRef, StreamOptions,
    T3Adapter, ToolInfo, TokenTotals,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, VecDeque},
    path::PathBuf,
    sync::{mpsc, Arc, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, SystemTime},
};
use tauri::{AppHandle, Emitter, State};

const POLL: Duration = Duration::from_secs(2);
const STALE_MS: i64 = 120_000;
const MAX_LINES: usize = 80;
// LOCAL ONLY: caps one activity line's text. Large enough that a chat reply is
// readable, bounded so a replayed batch stays small on the local IPC channel.
const MAX_TEXT: usize = 2_000;

type Statuses = Arc<Mutex<BTreeMap<(Harness, String), HarnessStatus>>>;
type Activity = Arc<Mutex<BTreeMap<(Harness, String), Vec<ActivityLine>>>>;
type Questions = Arc<Mutex<Vec<PendingQuestion>>>;

/// One recent activity line shown when a session is selected.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityLine {
    pub ts: i64,
    pub kind: HarnessEventKind,
    /// Tool name only; never the arguments.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// LOCAL ONLY. Rendered in the desktop UI, never transmitted off-device.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

impl ActivityLine {
    fn from_event(event: &HarnessEvent) -> Self {
        let text = event
            .text
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(|t| {
                if t.chars().count() > MAX_TEXT {
                    let mut s: String = t.chars().take(MAX_TEXT).collect();
                    s.push('…');
                    s
                } else {
                    t.to_string()
                }
            });
        Self {
            ts: event.ts,
            kind: event.kind,
            tool: event.tool.as_ref().map(|t: &ToolInfo| t.name.clone()),
            text,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityBatch {
    pub harness: Harness,
    pub session_id: String,
    pub events: Vec<ActivityLine>,
}

struct Worker {
    stop: mpsc::Sender<()>,
    join: JoinHandle<()>,
}

pub struct HarnessWatchers {
    statuses: Statuses,
    activity: Activity,
    questions: Questions,
    workers: Mutex<Vec<Worker>>,
}

impl HarnessWatchers {
    pub fn start(app: AppHandle) -> Self {
        let statuses = Arc::new(Mutex::new(BTreeMap::new()));
        let activity = Arc::new(Mutex::new(BTreeMap::new()));
        let questions: Questions = Arc::new(Mutex::new(Vec::new()));
        let mut workers: Vec<Worker> = [Harness::Codex, Harness::Opencode, Harness::T3]
            .into_iter()
            .map(|harness| {
                let (stop, receiver) = mpsc::channel();
                let statuses = statuses.clone();
                let activity = activity.clone();
                let app = app.clone();
                let join = thread::spawn(move || {
                    // Construct adapters on their own thread; no Send contract required.
                    let adapter: Box<dyn Adapter> = match harness {
                        Harness::Codex => Box::new(CodexAdapter::new()),
                        Harness::Opencode => Box::new(OpenCodeAdapter::new()),
                        Harness::T3 => Box::new(T3Adapter::new()),
                    };
                    let mut fingerprints = BTreeMap::new();
                    loop {
                        if receiver.try_recv().is_ok() {
                            break;
                        }
                        if let Ok(sessions) = adapter.discover() {
                            for session in sessions {
                                if receiver.try_recv().is_ok() {
                                    return;
                                }
                                let key = session.session_id.clone();
                                let fingerprint = fingerprint(&session);
                                if fingerprints.get(&key) == Some(&fingerprint) {
                                    continue;
                                }
                                // Finite replay passes are cancellable between sessions.
                                // The frozen Adapter API has no cancellation/cursor handle.
                                let mut status = None;
                                let mut lines: VecDeque<ActivityLine> = VecDeque::new();
                                let result = adapter.stream(
                                    &session,
                                    &StreamOptions {
                                        follow: false,
                                        ..StreamOptions::default()
                                    },
                                    &mut |event| {
                                        let line = ActivityLine::from_event(&event);
                                        fold_status(&mut status, event);
                                        lines.push_back(line);
                                        while lines.len() > MAX_LINES {
                                            lines.pop_front();
                                        }
                                    },
                                );
                                if result.is_ok() {
                                    fingerprints.insert(key, fingerprint);
                                    if let Some(mut status) = status {
                                        mark_stale(&mut status, now_millis());
                                        publish(&app, &statuses, status);
                                    }
                                    publish_activity(
                                        &app,
                                        &activity,
                                        harness,
                                        &session.session_id,
                                        lines.into_iter().collect(),
                                    );
                                }
                                // Do not log adapter errors: their context may contain content.
                            }
                        }
                        expire(&app, &statuses, harness, now_millis());
                        match receiver.recv_timeout(POLL) {
                            Err(mpsc::RecvTimeoutError::Timeout) => {}
                            _ => break,
                        }
                    }
                });
                Worker { stop, join }
            })
            .collect();

        // Pending-question poller for T3. Its own thread keeps the projection
        // read independent from the streaming adapters.
        {
            let (stop, receiver) = mpsc::channel();
            let questions = questions.clone();
            let app = app.clone();
            let join = thread::spawn(move || {
                let db_path = T3Adapter::new().db_path().to_path_buf();
                loop {
                    let next = doty_harness::pending_user_input(&db_path);
                    let changed = {
                        let mut current = questions.lock().unwrap();
                        if *current == next {
                            false
                        } else {
                            *current = next.clone();
                            true
                        }
                    };
                    if changed {
                        let _ = app.emit("harness://questions", &next);
                    }
                    match receiver.recv_timeout(POLL) {
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        _ => break,
                    }
                }
            });
            workers.push(Worker { stop, join });
        }

        Self {
            statuses,
            activity,
            questions,
            workers: Mutex::new(workers),
        }
    }

    pub fn stop(&self) {
        let workers = std::mem::take(&mut *self.workers.lock().unwrap());
        for worker in &workers {
            let _ = worker.stop.send(());
        }
        for worker in workers {
            let _ = worker.join.join();
        }
    }
}

impl Drop for HarnessWatchers {
    fn drop(&mut self) {
        self.stop();
    }
}

#[tauri::command]
pub fn harness_statuses(watchers: State<'_, HarnessWatchers>) -> Vec<HarnessStatus> {
    watchers
        .statuses
        .lock()
        .unwrap()
        .values()
        .cloned()
        .collect()
}

#[tauri::command]
pub fn harness_activity(watchers: State<'_, HarnessWatchers>) -> Vec<ActivityBatch> {
    watchers
        .activity
        .lock()
        .unwrap()
        .iter()
        .map(|((harness, session_id), lines)| ActivityBatch {
            harness: *harness,
            session_id: session_id.clone(),
            events: lines.clone(),
        })
        .collect()
}

/// Pending T3 user-input questions for webview startup/reload hydration.
#[tauri::command]
pub fn harness_questions(watchers: State<'_, HarnessWatchers>) -> Vec<PendingQuestion> {
    watchers.questions.lock().unwrap().clone()
}

/// Answer a pending T3 question by enqueuing T3's `runtime-request.respond`
/// effect. Best effort: T3 validates and processes it. LOCAL ONLY.
#[tauri::command]
pub fn answer_question(
    thread_id: String,
    request_id: String,
    question_id: String,
    value: String,
) -> Result<(), String> {
    let mut answers = std::collections::BTreeMap::new();
    answers.insert(question_id, value);
    let db_path = T3Adapter::new().db_path().to_path_buf();
    doty_harness::respond_to_user_input(&db_path, &thread_id, &request_id, &answers)
        .map_err(|error| error.to_string())
}

// Include the WAL: SQLite writes need not touch the main DB's mtime or size.
fn fingerprint(session: &SessionRef) -> (Option<SystemTime>, u64, Option<(SystemTime, u64)>) {
    let wal = PathBuf::from(format!("{}-wal", session.path.to_string_lossy()));
    let wal = std::fs::metadata(wal)
        .ok()
        .and_then(|m| Some((m.modified().ok()?, m.len())));
    (session.modified, session.bytes, wal)
}

fn fold_status(status: &mut Option<HarnessStatus>, event: HarnessEvent) {
    // Destructure only metadata. tool args are dropped here.
    let HarnessEvent {
        harness,
        session_id,
        project,
        ts,
        kind,
        status: activity,
        tokens,
        ..
    } = event;
    if status.as_ref().is_some_and(|s| ts < s.last_activity_at) {
        return;
    }
    let current = status.get_or_insert_with(|| HarnessStatus {
        harness,
        session_id,
        project: None,
        title: None,
        status: HarnessActivity::Running,
        last_activity_at: ts,
        tokens: None,
    });
    if project.is_some() {
        current.project = project;
    }
    current.last_activity_at = ts;
    // TurnEnd/Idle means a completed turn, not ongoing work. Keep explicit error/stale.
    current.status = match (kind, activity) {
        (HarnessEventKind::TurnEnd, None | Some(HarnessActivity::Idle)) => HarnessActivity::Done,
        (_, Some(activity)) => activity,
        (HarnessEventKind::Thinking, _) => HarnessActivity::Thinking,
        (HarnessEventKind::ToolCall, _) => HarnessActivity::ToolCalling,
        (HarnessEventKind::Approval, _) => HarnessActivity::WaitingApproval,
        (HarnessEventKind::Error, _) => HarnessActivity::Error,
        (HarnessEventKind::SessionEnd, _) => HarnessActivity::Done,
        (HarnessEventKind::TokenUsage, _) => current.status,
        _ => HarnessActivity::Running,
    };
    if let Some(tokens) = tokens {
        let totals = current.tokens.get_or_insert_with(TokenTotals::default);
        if let Some(input) = tokens.input {
            totals.input = input;
        }
        if let Some(output) = tokens.output {
            totals.output = output;
        }
    }
}

fn mark_stale(status: &mut HarnessStatus, now: i64) {
    if matches!(
        status.status,
        HarnessActivity::Running | HarnessActivity::Thinking | HarnessActivity::ToolCalling
    ) && now.saturating_sub(status.last_activity_at) >= STALE_MS
    {
        status.status = HarnessActivity::Stale;
    }
}

fn publish(app: &AppHandle, statuses: &Statuses, status: HarnessStatus) {
    let mut statuses = statuses.lock().unwrap();
    let key = (status.harness, status.session_id.clone());
    if statuses.get(&key) != Some(&status) {
        statuses.insert(key, status.clone());
        let _ = app.emit("harness://status", status);
    }
}

fn publish_activity(
    app: &AppHandle,
    activity: &Activity,
    harness: Harness,
    session_id: &str,
    lines: Vec<ActivityLine>,
) {
    let key = (harness, session_id.to_string());
    {
        let mut map = activity.lock().unwrap();
        if map.get(&key) == Some(&lines) {
            return;
        }
        map.insert(key, lines.clone());
    }
    let _ = app.emit(
        "harness://activity",
        ActivityBatch {
            harness,
            session_id: session_id.to_string(),
            events: lines,
        },
    );
}

fn expire(app: &AppHandle, statuses: &Statuses, harness: Harness, now: i64) {
    let mut statuses = statuses.lock().unwrap();
    for status in statuses.values_mut().filter(|s| s.harness == harness) {
        let old = status.status;
        mark_stale(status, now);
        if old != status.status {
            let _ = app.emit("harness://status", status.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(kind: HarnessEventKind, activity: Option<HarnessActivity>, ts: i64) -> HarnessEvent {
        HarnessEvent {
            harness: Harness::Codex,
            session_id: "s".into(),
            project: Some("C:/repo".into()),
            ts,
            kind,
            status: activity,
            tool: None,
            tokens: None,
            text: Some("PRIVATE TRANSCRIPT".into()),
        }
    }

    #[test]
    fn metadata_only_done_and_out_of_order() {
        let mut status = None;
        fold_status(&mut status, event(HarnessEventKind::Thinking, None, 100));
        fold_status(
            &mut status,
            event(HarnessEventKind::TurnEnd, Some(HarnessActivity::Idle), 200),
        );
        fold_status(&mut status, event(HarnessEventKind::Thinking, None, 50));
        let status = status.unwrap();
        assert_eq!(status.status, HarnessActivity::Done);
        assert_eq!(status.last_activity_at, 200);
        let json = serde_json::to_string(&status).unwrap();
        assert!(!json.contains("PRIVATE"));
        assert!(!json.contains("text"));
    }

    #[test]
    fn stale_keeps_real_last_activity_and_approval_waits() {
        let mut status = None;
        fold_status(&mut status, event(HarnessEventKind::Thinking, None, 100));
        let mut status = status.unwrap();
        mark_stale(&mut status, 120_100);
        assert_eq!(status.status, HarnessActivity::Stale);
        assert_eq!(status.last_activity_at, 100);
        status.status = HarnessActivity::WaitingApproval;
        mark_stale(&mut status, 999_999);
        assert_eq!(status.status, HarnessActivity::WaitingApproval);
    }

    #[test]
    fn activity_line_keeps_text_but_never_tool_args() {
        let mut e = event(HarnessEventKind::ToolCall, Some(HarnessActivity::ToolCalling), 100);
        e.tool = Some(ToolInfo {
            name: "shell".into(),
            args: Some(serde_json::json!({ "command": "rm -rf /" })),
        });
        let line = ActivityLine::from_event(&e);
        assert_eq!(line.tool.as_deref(), Some("shell"));
        assert!(line.text.as_deref().unwrap().contains("PRIVATE TRANSCRIPT"));
        let json = serde_json::to_string(&line).unwrap();
        assert!(!json.contains("rm -rf"));
        assert_eq!(json.contains("\"kind\":\"tool_call\""), true);
    }
}
