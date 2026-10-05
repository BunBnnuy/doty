//! Local metadata-only watcher bridge. Never serialize a HarnessEvent here.
use doty_harness::{
    time::now_millis, Adapter, CodexAdapter, Harness, HarnessActivity, HarnessEvent,
    HarnessEventKind, HarnessStatus, OpenCodeAdapter, SessionRef, StreamOptions, T3Adapter,
    TokenTotals,
};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{mpsc, Arc, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, SystemTime},
};
use tauri::{AppHandle, Emitter, State};

const POLL: Duration = Duration::from_secs(2);
const STALE_MS: i64 = 120_000;
type Statuses = Arc<Mutex<BTreeMap<(Harness, String), HarnessStatus>>>;

struct Worker {
    stop: mpsc::Sender<()>,
    join: JoinHandle<()>,
}

pub struct HarnessWatchers {
    statuses: Statuses,
    workers: Mutex<Vec<Worker>>,
}

impl HarnessWatchers {
    pub fn start(app: AppHandle) -> Self {
        let statuses = Arc::new(Mutex::new(BTreeMap::new()));
        let workers = [Harness::Codex, Harness::Opencode, Harness::T3]
            .into_iter()
            .map(|harness| {
                let (stop, receiver) = mpsc::channel();
                let statuses = statuses.clone();
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
                                let result = adapter.stream(
                                    &session,
                                    &StreamOptions {
                                        follow: false,
                                        ..StreamOptions::default()
                                    },
                                    &mut |event| fold_status(&mut status, event),
                                );
                                if result.is_ok() {
                                    fingerprints.insert(key, fingerprint);
                                    if let Some(mut status) = status {
                                        mark_stale(&mut status, now_millis());
                                        publish(&app, &statuses, status);
                                    }
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
        Self {
            statuses,
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

// Include the WAL: SQLite writes need not touch the main DB's mtime or size.
fn fingerprint(session: &SessionRef) -> (Option<SystemTime>, u64, Option<(SystemTime, u64)>) {
    let wal = PathBuf::from(format!("{}-wal", session.path.to_string_lossy()));
    let wal = std::fs::metadata(wal)
        .ok()
        .and_then(|m| Some((m.modified().ok()?, m.len())));
    (session.modified, session.bytes, wal)
}

fn fold_status(status: &mut Option<HarnessStatus>, event: HarnessEvent) {
    // Destructure only metadata. text and tool (including args) are dropped here.
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
        // Only HarnessStatus can enter IPC. There is no server/network sink.
        let _ = app.emit("harness://status", status);
    }
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
}
