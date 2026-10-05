//! Read-only SQLite helpers shared by the database-backed adapters.

use anyhow::{Context, Result};
use rusqlite::{Connection, OpenFlags};
use std::path::Path;

/// Open a SQLite database with URI handling and `mode=ro`. Setting
/// `immutable=0` is intentional: SQLite must replay the WAL for a consistent,
/// current view while a harness is writing.
pub fn open_read_only(path: &Path) -> Result<Connection> {
    let native = path.to_string_lossy().replace('\\', "/");
    let encoded = native
        .replace('%', "%25")
        .replace('#', "%23")
        .replace('?', "%3F")
        .replace(' ', "%20");
    let uri = if encoded.starts_with('/') {
        format!("file://{encoded}?mode=ro&immutable=0")
    } else {
        format!("file:///{encoded}?mode=ro&immutable=0")
    };
    Connection::open_with_flags(
        uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("open read-only SQLite database {}", path.display()))
}

/// Check table presence using sqlite_master before any adapter query.
pub fn has_tables(conn: &Connection, tables: &[&str]) -> Result<bool> {
    for table in tables {
        let found: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
            [table],
            |row| row.get(0),
        )?;
        if !found {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Check expected columns in addition to table names; private schema changes
/// fail closed rather than triggering a speculative query.
pub fn has_columns(conn: &Connection, table: &str, columns: &[&str]) -> Result<bool> {
    let mut stmt = conn.prepare(&format!(
        "PRAGMA table_info(\"{}\")",
        table.replace('"', "")
    ))?;
    let actual: std::collections::HashSet<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(columns.iter().all(|column| actual.contains(*column)))
}
