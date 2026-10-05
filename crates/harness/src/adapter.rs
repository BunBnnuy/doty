//! The normalized adapter interface.
//!
//! Each harness persists work differently; every adapter discovers sessions on
//! disk and streams the same [`HarnessEvent`] shape. Nothing downstream knows
//! harness specifics.

use crate::model::{Harness, HarnessEvent};
use anyhow::Result;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

/// A discoverable session, before any parsing.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionRef {
    pub harness: Harness,
    pub session_id: String,
    /// On-disk artifact that the adapter tails (e.g. a Codex `rollout-*.jsonl`).
    pub path: PathBuf,
    pub project: Option<String>,
    pub modified: Option<SystemTime>,
    pub bytes: u64,
}

/// How a stream should behave.
#[derive(Debug, Clone)]
pub struct StreamOptions {
    /// Replay existing content before following.
    pub replay: bool,
    /// Keep tailing after the initial read.
    pub follow: bool,
    /// Silence after which a session is marked `stale`.
    pub stale_after: Duration,
    /// Upper bound on the wait between file reads.
    pub poll: Duration,
}

impl Default for StreamOptions {
    fn default() -> Self {
        Self {
            replay: true,
            follow: true,
            // PLAN: Codex writes on every item, so ~2 minutes of silence means
            // the process is likely gone.
            stale_after: Duration::from_secs(120),
            poll: Duration::from_millis(250),
        }
    }
}

/// One adapter per harness.
pub trait Adapter {
    /// The harness this adapter is for.
    fn harness(&self) -> Harness;

    /// Discover sessions, normally newest first.
    fn discover(&self) -> Result<Vec<SessionRef>>;

    /// Stream normalized events from `session`.
    ///
    /// Blocks while `opts.follow` is set, calling `on_event` for each event as
    /// it appears. Emits a synthesized `session_end`/`stale` event when the
    /// session goes quiet (see [`StreamOptions::stale_after`]).
    fn stream(
        &self,
        session: &SessionRef,
        opts: &StreamOptions,
        on_event: &mut dyn FnMut(HarnessEvent),
    ) -> Result<()>;

    /// Convenience: the most recently modified discovered session.
    fn latest(&self) -> Result<Option<SessionRef>> {
        Ok(self.discover()?.into_iter().next())
    }
}
