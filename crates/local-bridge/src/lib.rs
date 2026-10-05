//! Local tool bridge (M7). Wave 0 placeholder.
//!
//! The server asks the client to run allow-listed local actions over a
//! WebSocket. Read-only actions (M7a) land before input control (M7b).
//! Owned in Wave 2.

/// Bump whenever the bridge frame shape changes.
pub const BRIDGE_PROTOCOL_VERSION: u32 = 0;
