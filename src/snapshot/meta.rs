//! Meta-key constants and `SnapshotMeta` struct for snapshot provenance.

use anyhow::{Context, Result};
use rusqlite::Connection;
use serde::Serialize;

pub const META_SNAPSHOT_SOURCE_COMMIT: &str = "snapshot_source_commit";
pub const META_SNAPSHOT_SOURCE_URL: &str = "snapshot_source_url";
pub const META_SNAPSHOT_CREATED_AT: &str = "snapshot_created_at";
pub const META_SNAPSHOT_TOOL_VERSION: &str = "snapshot_tool_version";
pub const META_SNAPSHOT_SCHEMA_VERSION: &str = "snapshot_schema_version";
pub const META_SNAPSHOT_INCLUDES_VEC: &str = "snapshot_includes_vec";
pub const META_SNAPSHOT_FETCHED_AT: &str = "snapshot_fetched_at";

#[derive(Debug, Serialize)]
pub struct SnapshotMeta {
    pub source_commit: String,
    pub source_url: Option<String>,
    pub created_at: i64,
    pub tool_version: String,
    pub schema_version: i32,
    pub includes_vec: bool,
    pub fetched_at: Option<i64>,
    pub node_count: i64,
    pub edge_count: i64,
    pub file_size_bytes: u64,
}

pub fn write_meta(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES (?1, ?2)",
        rusqlite::params![key, value],
    )
    .with_context(|| format!("write_meta({key})"))?;
    Ok(())
}

pub fn read_meta(conn: &Connection, key: &str) -> Result<Option<String>> {
    conn.query_row(
        "SELECT value FROM meta WHERE key = ?1",
        rusqlite::params![key],
        |row| row.get::<_, String>(0),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(anyhow::anyhow!(other)),
    })
}
