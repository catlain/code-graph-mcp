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
