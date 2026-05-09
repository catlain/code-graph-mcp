use anyhow::{anyhow, Result};
use rusqlite::Connection;
use std::collections::HashMap;

use crate::domain::REL_CALLS;

/// Hard cap on recursive CTE depth — protects against CTE blowup on highly
/// connected graphs. Caller-requested depth is clamped to this value silently;
/// `CallGraphResult::depth_capped` flags when that clamp fires so downstream
/// surfaces (MCP / CLI) can warn the agent that deeper chains may exist.
pub const CALL_GRAPH_MAX_DEPTH: i32 = 10;

/// Hard cap on rows returned per direction — keeps wide fan-outs from
/// returning megabytes of JSON. `CallGraphResult::limit_hit` flags when the
/// SQL query returned exactly this many rows (there may be more).
pub const CALL_GRAPH_ROW_LIMIT: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Direction {
    Callees,
    Callers,
}

impl Direction {
    pub fn as_str(&self) -> &'static str {
        match self {
            Direction::Callees => "callees",
            Direction::Callers => "callers",
        }
    }
}

/// A node in a call graph traversal result.
pub struct CallGraphNode {
    pub node_id: i64,
    pub name: String,
    pub node_type: String,
    pub file_path: String,
    pub depth: i32,
    pub direction: Direction,
    /// node_id of the immediate parent in the traversal (the caller for
    /// `Direction::Callers`, the callee for `Direction::Callees`). `None` for
    /// the root (depth=0). When a node is reachable via multiple paths, this
    /// records one parent on the shortest path.
    pub parent_id: Option<i64>,
}

/// Wraps `Vec<CallGraphNode>` with truncation provenance. Returned by
/// `get_call_graph` so MCP / CLI surfaces can tell agents when results are
/// incomplete instead of silently presenting a partial view as the full picture.
pub struct CallGraphResult {
    pub nodes: Vec<CallGraphNode>,
    /// True when at least one direction's recursive CTE hit `CALL_GRAPH_ROW_LIMIT`
    /// — more nodes may exist beyond the returned set. For "both", true if either
    /// callees or callers saturated.
    pub limit_hit: bool,
    /// True when the caller requested depth > `CALL_GRAPH_MAX_DEPTH`; the result
    /// only reflects the first `CALL_GRAPH_MAX_DEPTH` levels, deeper chains may exist.
    pub depth_capped: bool,
    /// Depth actually used by the SQL query (after clamping).
    pub effective_max_depth: i32,
    /// Depth originally requested by the caller (pre-clamp).
    pub requested_max_depth: i32,
}

/// Traverse the call graph starting from a function by name.
///
/// `direction` must be one of: "callers", "callees", "both".
/// `depth` controls the maximum recursion depth (clamped to `CALL_GRAPH_MAX_DEPTH`;
/// `CallGraphResult::depth_capped` flags when the clamp fires).
/// `file_path` optionally disambiguates when multiple functions share the same name.
pub fn get_call_graph(
    conn: &Connection,
    function_name: &str,
    direction: &str,
    max_depth: i32,
    file_path: Option<&str>,
) -> Result<CallGraphResult> {
    let requested_max_depth = max_depth;
    let effective_max_depth = max_depth.min(CALL_GRAPH_MAX_DEPTH);
    let depth_capped = max_depth > CALL_GRAPH_MAX_DEPTH;

    let (nodes, limit_hit) = match direction {
        "callees" => query_direction(conn, function_name, effective_max_depth, file_path, Direction::Callees)?,
        "callers" => query_direction(conn, function_name, effective_max_depth, file_path, Direction::Callers)?,
        "both" => {
            let (callees, c1) = query_direction(conn, function_name, effective_max_depth, file_path, Direction::Callees)?;
            let (callers, c2) = query_direction(conn, function_name, effective_max_depth, file_path, Direction::Callers)?;
            (merge_results(callees, callers), c1 || c2)
        }
        other => return Err(anyhow!("invalid direction '{}': must be callers, callees, or both", other)),
    };
    Ok(CallGraphResult {
        nodes,
        limit_hit,
        depth_capped,
        effective_max_depth,
        requested_max_depth,
    })
}

/// Returns `(nodes, limit_hit)`. `limit_hit` is true when the SQL query
/// returned exactly `CALL_GRAPH_ROW_LIMIT` rows — more nodes may exist
/// beyond the returned set.
fn query_direction(
    conn: &Connection,
    function_name: &str,
    max_depth: i32,
    file_path: Option<&str>,
    direction: Direction,
) -> Result<(Vec<CallGraphNode>, bool)> {
    let max_depth = max_depth.min(CALL_GRAPH_MAX_DEPTH); // Hard cap to prevent CTE blowup on highly connected graphs
    // Use NULL sentinel: when file_path is None, pass NULL and the filter is always true
    let file_filter = "AND (?2 IS NULL OR f.path = ?2)";
    let file_path_param: Option<&str> = file_path;

    // In the recursive step:
    // - callees: follow edges forward (source_id = current, target_id = next)
    // - callers: follow edges backward (target_id = current, source_id = next)
    let (edge_join, next_node_join) = match direction {
        Direction::Callees => (
            "JOIN edges e ON e.source_id = cg.node_id AND e.relation = ?4",
            "JOIN nodes t ON t.id = e.target_id",
        ),
        Direction::Callers => (
            "JOIN edges e ON e.target_id = cg.node_id AND e.relation = ?4",
            "JOIN nodes t ON t.id = e.source_id",
        ),
    };

    // The CTE tracks `parent_id` (the cg row that produced each new node) so
    // the renderer can show real tree edges instead of inferring nesting from
    // depth alone (which collapses sibling subtrees under the last depth-N
    // entry). On dedup we keep the parent on the shortest path via
    // ROW_NUMBER() ... ORDER BY depth.
    //
    // Truncation ordering: when a hot function (e.g. `conn` in this repo with
    // 51 callers + 72 test) saturates CALL_GRAPH_ROW_LIMIT at depth=3, the
    // pre-LIMIT sort is `depth ASC, caller_count DESC` so high-connectivity
    // subtrees survive the truncation. Without the secondary key, alphabetical
    // / id-order ties would silently drop the most-relevant subtree. The
    // `caller_count` LEFT JOIN is a single non-correlated GROUP BY scan over
    // edges (idx_edges_target_rel covers the predicate); rowcount is bounded
    // by node count, not edge count.
    let sql = format!(
        "WITH RECURSIVE call_graph(node_id, name, type, depth, visited, parent_id) AS (
            SELECT n.id, n.name, n.type, 0, CAST(n.id AS TEXT), NULL
            FROM nodes n
            JOIN files f ON f.id = n.file_id
            WHERE n.name = ?1
            {file_filter}

            UNION ALL

            SELECT t.id, t.name, t.type, cg.depth + 1,
                   cg.visited || ',' || CAST(t.id AS TEXT),
                   cg.node_id
            FROM call_graph cg
            {edge_join}
            {next_node_join}
            WHERE cg.depth < ?3
            AND (',' || cg.visited || ',') NOT LIKE '%,' || CAST(t.id AS TEXT) || ',%'
        ),
        caller_counts AS (
            SELECT target_id AS node_id, COUNT(*) AS callers
            FROM edges
            WHERE relation = ?4
            GROUP BY target_id
        )
        SELECT node_id, name, type, file_path, depth, parent_id FROM (
            SELECT cg.node_id, cg.name, cg.type, f.path AS file_path, cg.depth, cg.parent_id,
                   COALESCE(cc.callers, 0) AS caller_count,
                   ROW_NUMBER() OVER (PARTITION BY cg.node_id ORDER BY cg.depth) AS rn
            FROM call_graph cg
            JOIN nodes n ON n.id = cg.node_id
            JOIN files f ON f.id = n.file_id
            LEFT JOIN caller_counts cc ON cc.node_id = cg.node_id
        ) WHERE rn = 1
        ORDER BY depth ASC, caller_count DESC
        LIMIT {row_limit}",
        row_limit = CALL_GRAPH_ROW_LIMIT,
    );

    let mut stmt = conn.prepare(&sql)?;

    let map_row = move |row: &rusqlite::Row<'_>| -> rusqlite::Result<CallGraphNode> {
        Ok(CallGraphNode {
            node_id: row.get(0)?,
            name: row.get(1)?,
            node_type: row.get(2)?,
            file_path: row.get(3)?,
            depth: row.get(4)?,
            direction,
            parent_id: row.get(5)?,
        })
    };

    let results: Vec<CallGraphNode> = stmt
        .query_map(rusqlite::params![function_name, file_path_param, max_depth, REL_CALLS], map_row)?
        .collect::<Result<Vec<_>, _>>()?;

    let limit_hit = results.len() == CALL_GRAPH_ROW_LIMIT;
    Ok((results, limit_hit))
}

/// Merge callee and caller results, deduplicating by (node_id, direction) and keeping the entry
/// with minimum depth (preserving its `parent_id` so the renderer can build a tree).
fn merge_results(callees: Vec<CallGraphNode>, callers: Vec<CallGraphNode>) -> Vec<CallGraphNode> {
    let mut by_key: HashMap<(i64, Direction), CallGraphNode> = HashMap::new();

    for node in callees.into_iter().chain(callers) {
        let key = (node.node_id, node.direction);
        match by_key.entry(key) {
            std::collections::hash_map::Entry::Occupied(mut e) => {
                if node.depth < e.get().depth {
                    e.insert(node);
                }
            }
            std::collections::hash_map::Entry::Vacant(e) => {
                e.insert(node);
            }
        }
    }

    let mut results: Vec<CallGraphNode> = by_key.into_values().collect();
    results.sort_by_key(|n| n.depth);
    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::db::Database;
    use crate::storage::queries::{upsert_file, insert_node, insert_edge, FileRecord, NodeRecord};
    use crate::domain::REL_CALLS;
    use tempfile::TempDir;

    fn test_db() -> (Database, TempDir) {
        let tmp = TempDir::new().unwrap();
        let db = Database::open(&tmp.path().join("test.db")).unwrap();
        (db, tmp)
    }

    fn node(name: &str, file_id: i64) -> NodeRecord {
        NodeRecord {
            file_id,
            node_type: "function".into(),
            name: name.into(),
            qualified_name: None,
            start_line: 1,
            end_line: 5,
            code_content: format!("function {}() {{}}", name),
            signature: None,
            doc_comment: None,
            context_string: None,
            name_tokens: None,
            return_type: None,
            param_types: None,
            is_test: false,
        }
    }

    /// Setup: A→calls→B→calls→C, D→calls→B
    /// Query callees of A depth 2 → should contain B and C
    #[test]
    fn test_get_callees() {
        let (db, _tmp) = test_db();
        let conn = db.conn();

        let fid = upsert_file(conn, &FileRecord {
            path: "test.ts".into(),
            blake3_hash: "h1".into(),
            last_modified: 1,
            language: Some("typescript".into()),
        }).unwrap();

        let a = insert_node(conn, &node("A", fid)).unwrap();
        let b = insert_node(conn, &node("B", fid)).unwrap();
        let c = insert_node(conn, &node("C", fid)).unwrap();
        let d = insert_node(conn, &node("D", fid)).unwrap();

        insert_edge(conn, a, b, REL_CALLS, None).unwrap();
        insert_edge(conn, b, c, REL_CALLS, None).unwrap();
        insert_edge(conn, d, b, REL_CALLS, None).unwrap();

        let result = get_call_graph(conn, "A", "callees", 2, None).unwrap();

        // Should include A (depth 0), B (depth 1), C (depth 2)
        let names: Vec<&str> = result.nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"A"), "should contain root node A");
        assert!(names.contains(&"B"), "should contain callee B");
        assert!(names.contains(&"C"), "should contain callee C");
        assert!(!names.contains(&"D"), "should NOT contain D (not a callee of A)");

        // Verify depths
        let a_node = result.nodes.iter().find(|n| n.name == "A").unwrap();
        assert_eq!(a_node.depth, 0);
        let b_node = result.nodes.iter().find(|n| n.name == "B").unwrap();
        assert_eq!(b_node.depth, 1);
        let c_node = result.nodes.iter().find(|n| n.name == "C").unwrap();
        assert_eq!(c_node.depth, 2);
    }

    /// Query callers of B depth 2 → should contain A and D
    #[test]
    fn test_get_callers() {
        let (db, _tmp) = test_db();
        let conn = db.conn();

        let fid = upsert_file(conn, &FileRecord {
            path: "test.ts".into(),
            blake3_hash: "h1".into(),
            last_modified: 1,
            language: Some("typescript".into()),
        }).unwrap();

        let a = insert_node(conn, &node("A", fid)).unwrap();
        let b = insert_node(conn, &node("B", fid)).unwrap();
        let c = insert_node(conn, &node("C", fid)).unwrap();
        let d = insert_node(conn, &node("D", fid)).unwrap();

        insert_edge(conn, a, b, REL_CALLS, None).unwrap();
        insert_edge(conn, b, c, REL_CALLS, None).unwrap();
        insert_edge(conn, d, b, REL_CALLS, None).unwrap();

        let result = get_call_graph(conn, "B", "callers", 2, None).unwrap();

        let names: Vec<&str> = result.nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"B"), "should contain root node B");
        assert!(names.contains(&"A"), "should contain caller A");
        assert!(names.contains(&"D"), "should contain caller D");
        assert!(!names.contains(&"C"), "should NOT contain C (C is a callee, not caller)");

        // Verify depths
        let b_node = result.nodes.iter().find(|n| n.name == "B").unwrap();
        assert_eq!(b_node.depth, 0);
        let a_node = result.nodes.iter().find(|n| n.name == "A").unwrap();
        assert_eq!(a_node.depth, 1);
        let d_node = result.nodes.iter().find(|n| n.name == "D").unwrap();
        assert_eq!(d_node.depth, 1);
    }

    /// A→B→A mutual recursion. Query callees of A depth 10 → should terminate with <=3 results.
    #[test]
    fn test_cycle_detection() {
        let (db, _tmp) = test_db();
        let conn = db.conn();

        let fid = upsert_file(conn, &FileRecord {
            path: "test.ts".into(),
            blake3_hash: "h1".into(),
            last_modified: 1,
            language: Some("typescript".into()),
        }).unwrap();

        let a = insert_node(conn, &node("A", fid)).unwrap();
        let b = insert_node(conn, &node("B", fid)).unwrap();

        insert_edge(conn, a, b, REL_CALLS, None).unwrap();
        insert_edge(conn, b, a, REL_CALLS, None).unwrap();

        let result = get_call_graph(conn, "A", "callees", 10, None).unwrap();

        // Should terminate and contain at most A and B
        assert!(result.nodes.len() <= 2, "cycle detection should limit results to <=2, got {}", result.nodes.len());

        let names: Vec<&str> = result.nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"A"));
        assert!(names.contains(&"B"));
    }

    /// Query "both" on B → should contain A, D (callers) and C (callees)
    #[test]
    fn test_both_direction() {
        let (db, _tmp) = test_db();
        let conn = db.conn();

        let fid = upsert_file(conn, &FileRecord {
            path: "test.ts".into(),
            blake3_hash: "h1".into(),
            last_modified: 1,
            language: Some("typescript".into()),
        }).unwrap();

        let a = insert_node(conn, &node("A", fid)).unwrap();
        let b = insert_node(conn, &node("B", fid)).unwrap();
        let c = insert_node(conn, &node("C", fid)).unwrap();
        let d = insert_node(conn, &node("D", fid)).unwrap();

        insert_edge(conn, a, b, REL_CALLS, None).unwrap();
        insert_edge(conn, b, c, REL_CALLS, None).unwrap();
        insert_edge(conn, d, b, REL_CALLS, None).unwrap();

        let result = get_call_graph(conn, "B", "both", 2, None).unwrap();

        let names: Vec<&str> = result.nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"B"), "should contain root node B");
        assert!(names.contains(&"A"), "should contain caller A");
        assert!(names.contains(&"D"), "should contain caller D");
        assert!(names.contains(&"C"), "should contain callee C");

        // B should be at depth 0
        let b_node = result.nodes.iter().find(|n| n.name == "B").unwrap();
        assert_eq!(b_node.depth, 0);
    }

    /// Verify parent_id is populated so the renderer can build a real tree.
    /// Setup: A→B→C, D→B. Query callers of C depth 2.
    /// Expected: B has parent_id=C; A and D have parent_id=B.
    #[test]
    fn test_parent_id_populated() {
        let (db, _tmp) = test_db();
        let conn = db.conn();

        let fid = upsert_file(conn, &FileRecord {
            path: "test.ts".into(),
            blake3_hash: "h1".into(),
            last_modified: 1,
            language: Some("typescript".into()),
        }).unwrap();

        let a = insert_node(conn, &node("A", fid)).unwrap();
        let b = insert_node(conn, &node("B", fid)).unwrap();
        let c = insert_node(conn, &node("C", fid)).unwrap();
        let d = insert_node(conn, &node("D", fid)).unwrap();

        insert_edge(conn, a, b, REL_CALLS, None).unwrap();
        insert_edge(conn, b, c, REL_CALLS, None).unwrap();
        insert_edge(conn, d, b, REL_CALLS, None).unwrap();

        let result = get_call_graph(conn, "C", "callers", 2, None).unwrap();

        let c_node = result.nodes.iter().find(|n| n.name == "C").unwrap();
        assert_eq!(c_node.parent_id, None, "root must have no parent");

        let b_node = result.nodes.iter().find(|n| n.name == "B").unwrap();
        assert_eq!(b_node.parent_id, Some(c), "depth-1 caller B's parent is the root C");

        let a_node = result.nodes.iter().find(|n| n.name == "A").unwrap();
        assert_eq!(a_node.parent_id, Some(b), "depth-2 caller A's parent is depth-1 B (NOT C)");
        let d_node = result.nodes.iter().find(|n| n.name == "D").unwrap();
        assert_eq!(d_node.parent_id, Some(b), "depth-2 caller D's parent is depth-1 B (NOT C)");
    }

    /// Within a single depth, results are ordered by caller_count DESC so
    /// high-connectivity subtrees survive CALL_GRAPH_ROW_LIMIT truncation.
    /// Setup: R calls A1, A2, A3 (all depth 1).
    /// Additional callers boost A1 (5 extra) > A2 (1 extra) > A3 (0 extra).
    /// Query callees of R depth 1 → expect order [R, A1, A2, A3].
    #[test]
    fn test_callees_ordered_by_caller_count() {
        let (db, _tmp) = test_db();
        let conn = db.conn();

        let fid = upsert_file(conn, &FileRecord {
            path: "test.ts".into(),
            blake3_hash: "h1".into(),
            last_modified: 1,
            language: Some("typescript".into()),
        }).unwrap();

        let r = insert_node(conn, &node("R", fid)).unwrap();
        let a1 = insert_node(conn, &node("A1", fid)).unwrap();
        let a2 = insert_node(conn, &node("A2", fid)).unwrap();
        let a3 = insert_node(conn, &node("A3", fid)).unwrap();

        // R calls each A_i (gives every A_i one caller from R).
        insert_edge(conn, r, a1, REL_CALLS, None).unwrap();
        insert_edge(conn, r, a2, REL_CALLS, None).unwrap();
        insert_edge(conn, r, a3, REL_CALLS, None).unwrap();

        // External callers: 5 callers for A1, 1 caller for A2, 0 for A3.
        for i in 0..5 {
            let ext = insert_node(conn, &node(&format!("ext_a1_{}", i), fid)).unwrap();
            insert_edge(conn, ext, a1, REL_CALLS, None).unwrap();
        }
        let ext_a2 = insert_node(conn, &node("ext_a2", fid)).unwrap();
        insert_edge(conn, ext_a2, a2, REL_CALLS, None).unwrap();

        let result = get_call_graph(conn, "R", "callees", 1, None).unwrap();

        // Filter to depth=1 only (R itself is depth=0).
        let depth_1: Vec<&str> = result.nodes.iter()
            .filter(|n| n.depth == 1)
            .map(|n| n.name.as_str())
            .collect();
        assert_eq!(depth_1, vec!["A1", "A2", "A3"],
            "depth-1 callees must be ordered by caller_count DESC: A1(6) > A2(2) > A3(1)");
    }

    /// requested depth > CALL_GRAPH_MAX_DEPTH must set depth_capped and clamp
    /// effective_max_depth without silently truncating.
    #[test]
    fn test_depth_capped_signal() {
        let (db, _tmp) = test_db();
        let conn = db.conn();
        let fid = upsert_file(conn, &FileRecord {
            path: "test.ts".into(),
            blake3_hash: "h1".into(),
            last_modified: 1,
            language: Some("typescript".into()),
        }).unwrap();
        let a = insert_node(conn, &node("A", fid)).unwrap();
        let b = insert_node(conn, &node("B", fid)).unwrap();
        insert_edge(conn, a, b, REL_CALLS, None).unwrap();

        let result = get_call_graph(conn, "A", "callees", 99, None).unwrap();
        assert!(result.depth_capped, "depth=99 must trip the cap");
        assert_eq!(result.requested_max_depth, 99);
        assert_eq!(result.effective_max_depth, CALL_GRAPH_MAX_DEPTH);
        assert!(!result.limit_hit, "this fixture has only 2 nodes, must not trigger row limit");

        let small = get_call_graph(conn, "A", "callees", 5, None).unwrap();
        assert!(!small.depth_capped, "depth=5 must not trip the cap");
        assert_eq!(small.requested_max_depth, 5);
        assert_eq!(small.effective_max_depth, 5);
    }
}
