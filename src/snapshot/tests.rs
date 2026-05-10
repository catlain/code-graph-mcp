//! Unit tests for the snapshot module.

use crate::snapshot::meta::{read_meta, write_meta, META_SNAPSHOT_TOOL_VERSION};
use rusqlite::Connection;

fn open_with_meta_table() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);",
    )
    .unwrap();
    conn
}

#[test]
fn write_meta_then_read_returns_same_value() {
    let conn = open_with_meta_table();
    write_meta(&conn, META_SNAPSHOT_TOOL_VERSION, "0.22.2").unwrap();
    let got = read_meta(&conn, META_SNAPSHOT_TOOL_VERSION).unwrap();
    assert_eq!(got, Some("0.22.2".to_string()));
}

#[test]
fn read_meta_returns_none_for_missing_key() {
    let conn = open_with_meta_table();
    let got = read_meta(&conn, "definitely_not_present").unwrap();
    assert_eq!(got, None);
}

#[test]
fn write_meta_overwrites_existing_value() {
    let conn = open_with_meta_table();
    write_meta(&conn, META_SNAPSHOT_TOOL_VERSION, "0.22.0").unwrap();
    write_meta(&conn, META_SNAPSHOT_TOOL_VERSION, "0.22.2").unwrap();
    let got = read_meta(&conn, META_SNAPSHOT_TOOL_VERSION).unwrap();
    assert_eq!(got, Some("0.22.2".to_string()));
}

use crate::snapshot::meta::{
    read_meta as snap_read_meta, META_SNAPSHOT_CREATED_AT, META_SNAPSHOT_INCLUDES_VEC,
    META_SNAPSHOT_SCHEMA_VERSION, META_SNAPSHOT_SOURCE_COMMIT,
};
use crate::storage::db::Database;
use std::process::Command;
use tempfile::TempDir;

fn init_git_fixture() -> TempDir {
    let dir = TempDir::new().unwrap();
    let p = dir.path();
    Command::new("git").args(["init", "-q"]).current_dir(p).status().unwrap();
    Command::new("git").args(["config", "user.email", "t@t"]).current_dir(p).status().unwrap();
    Command::new("git").args(["config", "user.name", "t"]).current_dir(p).status().unwrap();
    std::fs::create_dir_all(p.join("src")).unwrap();
    std::fs::write(p.join("src/lib.rs"), "pub fn hello() {}\npub fn world() { hello(); }\n").unwrap();
    Command::new("git").args(["add", "."]).current_dir(p).status().unwrap();
    Command::new("git").args(["commit", "-q", "-m", "init"]).current_dir(p).status().unwrap();
    dir
}

#[test]
fn create_writes_meta_and_drops_vec_table() {
    let fixture = init_git_fixture();
    let out = fixture.path().join("snapshot.db");
    crate::snapshot::create(fixture.path(), &out, false).unwrap();

    assert!(out.exists(), "snapshot db should exist at {}", out.display());

    let db = Database::open(&out).unwrap();
    let conn = db.conn();

    // node_vectors must NOT exist when include_vec is false
    let has_vec: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='node_vectors'",
        [], |r| r.get(0),
    ).unwrap();
    assert_eq!(has_vec, 0, "node_vectors should be dropped");

    // Five producer-side meta keys present and non-empty
    for key in [
        META_SNAPSHOT_SOURCE_COMMIT,
        META_SNAPSHOT_CREATED_AT,
        META_SNAPSHOT_SCHEMA_VERSION,
        META_SNAPSHOT_INCLUDES_VEC,
    ] {
        let v = snap_read_meta(conn, key).unwrap();
        assert!(v.is_some() && !v.as_ref().unwrap().is_empty(), "meta {key} missing");
    }
    let inc = snap_read_meta(conn, META_SNAPSHOT_INCLUDES_VEC).unwrap().unwrap();
    assert_eq!(inc, "false");
}

#[test]
fn inspect_round_trip() {
    let fixture = init_git_fixture();
    let out_db = fixture.path().join("snapshot.db");
    crate::snapshot::create(fixture.path(), &out_db, false).unwrap();

    // Compress with zstd to mimic what the workflow produces
    let raw = std::fs::read(&out_db).unwrap();
    let compressed = zstd::encode_all(&raw[..], 9).unwrap();
    let zst_path = fixture.path().join("snapshot.db.zst");
    std::fs::write(&zst_path, &compressed).unwrap();

    let meta = crate::snapshot::inspect(&zst_path).unwrap();
    assert_eq!(meta.tool_version, env!("CARGO_PKG_VERSION"));
    assert_eq!(meta.includes_vec, false);
    assert!(meta.created_at > 0);
    assert!(meta.schema_version > 0);
    assert!(meta.file_size_bytes > 0);
}

use crate::snapshot::config::load_config;

#[test]
fn config_load_missing_file_returns_default() {
    let dir = TempDir::new().unwrap();
    let cfg = load_config(dir.path()).unwrap();
    assert_eq!(cfg.snapshot.url, None);
    assert_eq!(cfg.snapshot.disabled, false);
}

#[test]
fn config_load_parses_snapshot_url() {
    let dir = TempDir::new().unwrap();
    std::fs::write(
        dir.path().join(".code-graph.toml"),
        "[snapshot]\nurl = \"https://example.com/x.db.zst\"\n",
    ).unwrap();
    let cfg = load_config(dir.path()).unwrap();
    assert_eq!(cfg.snapshot.url.as_deref(), Some("https://example.com/x.db.zst"));
    assert_eq!(cfg.snapshot.disabled, false);
}

#[test]
fn config_load_parses_disabled() {
    let dir = TempDir::new().unwrap();
    std::fs::write(
        dir.path().join(".code-graph.toml"),
        "[snapshot]\ndisabled = true\n",
    ).unwrap();
    let cfg = load_config(dir.path()).unwrap();
    assert_eq!(cfg.snapshot.disabled, true);
}

#[test]
fn config_load_rejects_malformed_toml() {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join(".code-graph.toml"), "not = valid = toml").unwrap();
    let err = load_config(dir.path()).unwrap_err();
    assert!(err.to_string().to_lowercase().contains("parse")
        || err.to_string().to_lowercase().contains("expected")
        || err.to_string().to_lowercase().contains("invalid"),
        "got error message: {err}");
}

use crate::snapshot::install::resolve_snapshot_source;

#[test]
fn resolve_returns_none_when_no_git_no_toml() {
    let dir = TempDir::new().unwrap();
    assert_eq!(resolve_snapshot_source(dir.path()), None);
}

#[test]
fn resolve_returns_url_from_toml_override() {
    let dir = TempDir::new().unwrap();
    std::fs::write(
        dir.path().join(".code-graph.toml"),
        "[snapshot]\nurl = \"https://example.com/x.db.zst\"\n",
    ).unwrap();
    assert_eq!(
        resolve_snapshot_source(dir.path()),
        Some("https://example.com/x.db.zst".to_string()),
    );
}

#[test]
fn resolve_returns_none_when_disabled() {
    let dir = TempDir::new().unwrap();
    std::fs::write(
        dir.path().join(".code-graph.toml"),
        "[snapshot]\ndisabled = true\n",
    ).unwrap();
    assert_eq!(resolve_snapshot_source(dir.path()), None);
}

#[test]
fn resolve_rejects_http_url_from_toml() {
    let dir = TempDir::new().unwrap();
    std::fs::write(
        dir.path().join(".code-graph.toml"),
        "[snapshot]\nurl = \"http://example.com/x.db.zst\"\n",
    ).unwrap();
    assert_eq!(resolve_snapshot_source(dir.path()), None);
}
