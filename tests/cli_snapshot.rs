//! CLI smoke tests for `code-graph-mcp snapshot create|inspect`.

use std::process::Command;
use tempfile::TempDir;

fn cli_bin() -> String {
    env!("CARGO_BIN_EXE_code-graph-mcp").to_string()
}

fn init_git_repo() -> TempDir {
    let dir = TempDir::new().unwrap();
    let p = dir.path();
    Command::new("git").args(["init", "-q"]).current_dir(p).status().unwrap();
    Command::new("git").args(["config", "user.email", "t@t"]).current_dir(p).status().unwrap();
    Command::new("git").args(["config", "user.name", "t"]).current_dir(p).status().unwrap();
    std::fs::create_dir_all(p.join("src")).unwrap();
    std::fs::write(p.join("src/lib.rs"), "pub fn h() {}\n").unwrap();
    Command::new("git").args(["add", "."]).current_dir(p).status().unwrap();
    Command::new("git").args(["commit", "-q", "-m", "init"]).current_dir(p).status().unwrap();
    dir
}

#[test]
fn cli_snapshot_create_then_inspect_round_trip() {
    let repo = init_git_repo();
    let out = repo.path().join("snap.db");

    let status = Command::new(cli_bin())
        .args(["snapshot", "create", "--out"])
        .arg(&out)
        .arg("--quiet")
        .arg("--root")
        .arg(repo.path())
        .status()
        .unwrap();
    assert!(status.success(), "create failed");
    assert!(out.exists());

    // Compress and inspect
    let bytes = std::fs::read(&out).unwrap();
    let zst = repo.path().join("snap.db.zst");
    std::fs::write(&zst, zstd::encode_all(&bytes[..], 9).unwrap()).unwrap();

    let output = Command::new(cli_bin())
        .args(["snapshot", "inspect"])
        .arg(&zst)
        .output()
        .unwrap();
    assert!(output.status.success(), "inspect failed: {}", String::from_utf8_lossy(&output.stderr));
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(json["tool_version"].as_str().unwrap().len() > 0);
    assert!(json["schema_version"].as_i64().unwrap() > 0);
    assert!(json["created_at"].as_i64().unwrap() > 0);
    assert_eq!(json["includes_vec"].as_bool(), Some(false));
}

#[test]
fn cli_snapshot_inspect_missing_file_exits_nonzero() {
    let output = Command::new(cli_bin())
        .args(["snapshot", "inspect", "/nonexistent/path.db.zst"])
        .output()
        .unwrap();
    assert!(!output.status.success());
}
