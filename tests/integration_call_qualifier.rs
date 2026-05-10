//! End-to-end tests for the bare-name call qualifier resolver rules.
//! See docs/superpowers/specs/2026-05-11-bare-name-call-qualifier-design.md.

use code_graph_mcp::indexer::pipeline::run_full_index;
use code_graph_mcp::storage::db::Database;
use std::fs;
use tempfile::TempDir;

fn write(dir: &std::path::Path, rel: &str, content: &str) {
    let p = dir.join(rel);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(&p, content).unwrap();
}

fn callers_of(db: &Database, target_name: &str) -> Vec<String> {
    let mut stmt = db.conn().prepare(
        "SELECT COALESCE(src.qualified_name, src.name) FROM edges e
         JOIN nodes tgt ON tgt.id = e.target_id
         JOIN nodes src ON src.id = e.source_id
         WHERE e.relation = 'calls' AND tgt.name = ?"
    ).unwrap();
    let rows = stmt.query_map([target_name], |r| r.get::<_, String>(0)).unwrap();
    rows.filter_map(|r| r.ok()).collect()
}

fn callers_of_in_file(db: &Database, target_name: &str, file_rel: &str) -> Vec<String> {
    let mut stmt = db.conn().prepare(
        "SELECT COALESCE(src.qualified_name, src.name) FROM edges e
         JOIN nodes tgt ON tgt.id = e.target_id
         JOIN nodes src ON src.id = e.source_id
         JOIN files f ON f.id = tgt.file_id
         WHERE e.relation = 'calls' AND tgt.name = ? AND f.path = ?"
    ).unwrap();
    let rows = stmt.query_map([target_name, file_rel], |r| r.get::<_, String>(0)).unwrap();
    rows.filter_map(|r| r.ok()).collect()
}

#[test]
fn chain_builder_drops_intermediate_callers() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();

    // Project has a function literally named `create` in src/snapshot/mod.rs.
    write(root, "src/snapshot/mod.rs", "pub fn create() {}\n");
    // Caller does a builder chain — `.create(true)` is a method on OpenOptions,
    // NOT the project's snapshot::create.
    write(root, "src/caller.rs", r#"
        use std::fs::OpenOptions;
        pub fn caller() {
            OpenOptions::new().create(true).open("/tmp/x").ok();
        }
    "#);

    let db_path = root.join(".code-graph/graph.db");
    fs::create_dir_all(db_path.parent().unwrap()).unwrap();
    let db = Database::open(&db_path).unwrap();
    run_full_index(&db, root, None, None).unwrap();

    let callers = callers_of(&db, "create");
    assert!(
        !callers.iter().any(|c| c.contains("caller")),
        "snapshot::create must NOT have `caller` as caller (it called .create() in a builder chain), got: {:?}",
        callers
    );
}

#[test]
fn bare_name_qualifier_drops_phantom_callers_for_file_create() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();

    // Project has snapshot::create.
    write(root, "src/snapshot/mod.rs", "pub fn create() {}\n");
    // Caller calls std::fs::File::create — Path qualifier with first segment
    // "File" which is NOT a project module → drop.
    write(root, "src/caller.rs", r#"
        use std::fs::File;
        pub fn caller() { let _ = File::create("/tmp/x"); }
    "#);

    let db_path = root.join(".code-graph/graph.db");
    fs::create_dir_all(db_path.parent().unwrap()).unwrap();
    let db = Database::open(&db_path).unwrap();
    run_full_index(&db, root, None, None).unwrap();

    let callers = callers_of(&db, "create");
    assert!(
        !callers.iter().any(|c| c.contains("caller")),
        "snapshot::create must NOT have `caller` (caller called std::fs::File::create), got: {:?}",
        callers
    );
}

#[test]
fn path_qualifier_picks_module_specific_candidate() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();

    // Two project modules each with a `create` fn.
    write(root, "src/snapshot/mod.rs", "pub fn create() {}\n");
    write(root, "src/builder/mod.rs", "pub fn create() {}\n");
    // Caller explicitly targets snapshot::create.
    write(root, "src/caller.rs", r#"
        pub fn caller() { crate::snapshot::create(); }
    "#);

    let db_path = root.join(".code-graph/graph.db");
    fs::create_dir_all(db_path.parent().unwrap()).unwrap();
    let db = Database::open(&db_path).unwrap();
    run_full_index(&db, root, None, None).unwrap();

    // snapshot::create gets the caller; builder::create does not.
    let snap = callers_of_in_file(&db, "create", "src/snapshot/mod.rs");
    let bld = callers_of_in_file(&db, "create", "src/builder/mod.rs");

    assert!(snap.iter().any(|c| c.contains("caller")),
        "snapshot::create should have caller, got: {:?}", snap);
    assert!(!bld.iter().any(|c| c.contains("caller")),
        "builder::create should NOT have caller (qualifier was snapshot), got: {:?}", bld);
}
