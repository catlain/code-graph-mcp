//! Shared graph snapshot — producer/consumer for `code-graph-snapshot-*.db.zst`
//! GitHub Release artifacts. See docs/superpowers/specs/2026-05-10-shared-graph-snapshot-design.md.

pub mod config;
pub mod install;
pub mod meta;

#[cfg(test)]
mod tests;

pub use install::{resolve_snapshot_source, try_install};
pub use meta::SnapshotMeta;

use anyhow::{Context, Result};
use std::path::Path;

/// Build a snapshot at `out` by running a full index in a temp dir, dropping
/// the vec table, vacuuming, writing meta keys, then VACUUM INTO the output
/// path.  The caller is responsible for compression (the workflow template
/// uses `zstd -9`).
pub fn create(root: &Path, out: &Path, include_vec: bool) -> Result<()> {
    use crate::indexer::pipeline::run_full_index;
    use crate::storage::db::Database;
    use std::time::{SystemTime, UNIX_EPOCH};

    // Index into a staging DB in a temp dir so we don't clobber the
    // project's own .code-graph/index.db.
    let tmp = tempfile::tempdir().context("create tempdir for snapshot build")?;
    let staging_db = tmp.path().join("staging.db");

    {
        let db = if include_vec {
            Database::open_with_vec(&staging_db)?
        } else {
            Database::open(&staging_db)?
        };

        run_full_index(&db, root, None, None)?;

        let conn = db.conn();

        // Drop vec table when caller doesn't want it (defensive IF EXISTS).
        if !include_vec {
            conn.execute_batch("DROP TABLE IF EXISTS node_vectors;")?;
        }

        // Best-effort git commit hash; empty string if not a git repo.
        let source_commit = std::process::Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(root)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        meta::write_meta(conn, meta::META_SNAPSHOT_SOURCE_COMMIT, &source_commit)?;
        meta::write_meta(conn, meta::META_SNAPSHOT_CREATED_AT, &now.to_string())?;
        meta::write_meta(conn, meta::META_SNAPSHOT_TOOL_VERSION, env!("CARGO_PKG_VERSION"))?;
        meta::write_meta(
            conn,
            meta::META_SNAPSHOT_SCHEMA_VERSION,
            &crate::storage::schema::SCHEMA_VERSION.to_string(),
        )?;
        meta::write_meta(
            conn,
            meta::META_SNAPSHOT_INCLUDES_VEC,
            if include_vec { "true" } else { "false" },
        )?;

        // Merge WAL back into main file so VACUUM INTO produces a single
        // self-contained file with no -wal/-shm sidecars.
        conn.execute_batch("PRAGMA journal_mode = DELETE;")?;
    } // `db` (and its Connection) dropped here — file fully flushed.

    // VACUUM INTO writes a compacted copy to `out`; destination must not exist.
    let conn = rusqlite::Connection::open(&staging_db)?;
    let out_str = out.to_string_lossy().replace('\'', "''");
    conn.execute_batch(&format!("VACUUM INTO '{out_str}';"))
        .with_context(|| format!("VACUUM INTO '{}'", out.display()))?;

    Ok(())
}

/// Open a `.db.zst` file, decompress to a temp file, read meta, and return.
pub fn inspect(file: &Path) -> Result<SnapshotMeta> {
    use crate::storage::db::Database;

    let file_size_bytes = std::fs::metadata(file)?.len();

    // Decompress to a temp file so we can open with rusqlite
    let tmp = tempfile::tempdir().context("inspect tempdir")?;
    let decompressed = tmp.path().join("snapshot.db");
    let compressed = std::fs::read(file).context("read snapshot file")?;
    let raw = zstd::decode_all(&compressed[..]).context("zstd decode")?;
    std::fs::write(&decompressed, &raw).context("write decompressed snapshot")?;

    let db = Database::open(&decompressed)?;
    let conn = db.conn();

    let source_commit = meta::read_meta(conn, meta::META_SNAPSHOT_SOURCE_COMMIT)?.unwrap_or_default();
    let source_url = meta::read_meta(conn, meta::META_SNAPSHOT_SOURCE_URL)?;
    let created_at = meta::read_meta(conn, meta::META_SNAPSHOT_CREATED_AT)?
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);
    let tool_version = meta::read_meta(conn, meta::META_SNAPSHOT_TOOL_VERSION)?.unwrap_or_default();
    let schema_version = meta::read_meta(conn, meta::META_SNAPSHOT_SCHEMA_VERSION)?
        .and_then(|s| s.parse::<i32>().ok())
        .unwrap_or(0);
    let includes_vec = meta::read_meta(conn, meta::META_SNAPSHOT_INCLUDES_VEC)?
        .map(|s| s == "true")
        .unwrap_or(false);
    let fetched_at = meta::read_meta(conn, meta::META_SNAPSHOT_FETCHED_AT)?
        .and_then(|s| s.parse::<i64>().ok());

    let node_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM nodes", [], |r| r.get(0))
        .unwrap_or(0);
    let edge_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM edges", [], |r| r.get(0))
        .unwrap_or(0);

    Ok(SnapshotMeta {
        source_commit,
        source_url,
        created_at,
        tool_version,
        schema_version,
        includes_vec,
        fetched_at,
        node_count,
        edge_count,
        file_size_bytes,
    })
}
