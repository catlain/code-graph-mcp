//! Integration tests for shared graph snapshot. All tests use file:// URLs
//! to keep network out of CI — real GitHub API paths are exercised manually.

use code_graph_mcp::snapshot;
use code_graph_mcp::storage::db::Database;
use std::process::Command;
use tempfile::TempDir;

fn init_git_repo_with_src() -> TempDir {
    let dir = TempDir::new().unwrap();
    let p = dir.path();
    Command::new("git").args(["init", "-q"]).current_dir(p).status().unwrap();
    Command::new("git").args(["config", "user.email", "t@t"]).current_dir(p).status().unwrap();
    Command::new("git").args(["config", "user.name", "t"]).current_dir(p).status().unwrap();
    std::fs::create_dir_all(p.join("src")).unwrap();
    std::fs::write(p.join("src/lib.rs"),
        "pub fn alpha() {}\npub fn beta() { alpha(); }\npub fn gamma() { beta(); }\n").unwrap();
    std::fs::write(p.join("src/main.rs"),
        "fn main() { /* placeholder */ }\n").unwrap();
    Command::new("git").args(["add", "."]).current_dir(p).status().unwrap();
    Command::new("git").args(["commit", "-q", "-m", "init"]).current_dir(p).status().unwrap();
    dir
}

fn build_snapshot_zst(src: &TempDir) -> std::path::PathBuf {
    let raw = src.path().join("snapshot.db");
    snapshot::create(src.path(), &raw, false).unwrap();
    let bytes = std::fs::read(&raw).unwrap();
    let zst = src.path().join("snapshot.db.zst");
    std::fs::write(&zst, zstd::encode_all(&bytes[..], 9).unwrap()).unwrap();
    zst
}

fn count_nodes(db_path: &std::path::Path) -> i64 {
    let db = Database::open(db_path).unwrap();
    db.conn().query_row("SELECT COUNT(*) FROM nodes", [], |r| r.get(0)).unwrap()
}
fn count_edges(db_path: &std::path::Path) -> i64 {
    let db = Database::open(db_path).unwrap();
    db.conn().query_row("SELECT COUNT(*) FROM edges", [], |r| r.get(0)).unwrap()
}

#[test]
fn snapshot_round_trip_node_counts_match() {
    let src = init_git_repo_with_src();
    let zst = build_snapshot_zst(&src);

    let target = init_git_repo_with_src();
    let url = format!("file://{}", zst.display());
    snapshot::try_install(&url, target.path()).unwrap();

    let installed = target.path().join(".code-graph").join("index.db");
    let raw = src.path().join("snapshot.db");
    assert_eq!(count_nodes(&installed), count_nodes(&raw),
        "node count must match between snapshot source and installed");
    assert_eq!(count_edges(&installed), count_edges(&raw),
        "edge count must match between snapshot source and installed");
}

#[test]
fn snapshot_then_incremental_picks_up_drift() {
    use code_graph_mcp::indexer::pipeline::run_incremental_index;

    let src = init_git_repo_with_src();
    let zst = build_snapshot_zst(&src);

    let target = init_git_repo_with_src();
    // Modify a file BEFORE install so incremental sees drift
    std::fs::write(target.path().join("src/lib.rs"),
        "pub fn alpha() {}\npub fn beta() { alpha(); }\npub fn gamma() { beta(); }\npub fn delta() { gamma(); }\n").unwrap();

    let url = format!("file://{}", zst.display());
    snapshot::try_install(&url, target.path()).unwrap();

    let installed = target.path().join(".code-graph").join("index.db");
    let nodes_before = count_nodes(&installed);

    let db = Database::open_with_vec(&installed).unwrap();
    run_incremental_index(&db, target.path(), None, None).unwrap();

    let nodes_after = count_nodes(&installed);
    assert!(nodes_after > nodes_before,
        "expected delta function to add nodes; before={nodes_before} after={nodes_after}");
}
