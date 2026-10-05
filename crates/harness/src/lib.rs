//! Doty harness watcher.
//!
//! Normalizes local AI coding harnesses (Codex, OpenCode, T3) into one event
//! stream. This crate is the Rust mirror of `@doty/harness-events`; keep field
//! names in sync (`crates/harness/src/model.rs` vs
//! `packages/harness-events/src/index.ts`).
//!
//! PRIVACY: `HarnessEvent::text` is LOCAL ONLY. Use
//! [`model::HarnessEvent::to_wire_value`] on any transport. Only
//! [`model::SessionDigest`] may cross the wire, and it is derived structurally
//! by [`digest`].
//!
//! Owned by SA-3 in Wave 1. Wave 0 only pins the contract version.

pub mod adapter;
pub mod codex;
pub mod digest;
pub mod model;
pub mod time;

pub use adapter::{Adapter, SessionRef, StreamOptions};
pub use codex::CodexAdapter;
pub use digest::{build_digest, DigestBuilder};
pub use model::{
    DigestOutcome, Harness, HarnessActivity, HarnessEvent, HarnessEventKind, HarnessStatus,
    SessionDigest, TokenTotals, TokenUsage, ToolInfo, TRANSMITTED_DIGEST_FIELDS,
};

/// Bump whenever the mirrored event shape changes.
pub const CONTRACT_VERSION: &str = "0";
