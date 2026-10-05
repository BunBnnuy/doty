//! Doty harness watcher.
//!
//! Normalizes local AI coding harnesses (Codex, OpenCode, T3) into one event
//! stream. This crate is the Rust mirror of `@doty/harness-events`; keep field
//! names in sync.
//!
//! Owned by SA-3 in Wave 1. Wave 0 only pins the contract version.

/// Bump whenever the mirrored event shape changes.
pub const CONTRACT_VERSION: &str = "0";
