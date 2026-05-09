//! Tool handlers split per family. Each child module adds an `impl McpServer`
//! block that contributes the `tool_*` method called by `handle_tool` in
//! `super::mod`. The dispatcher itself stays in `super::mod` next to the
//! JSON-RPC plumbing.
//!
//! v0.18.4 split: previously one 2354-line file. The split is mechanical (no
//! semantics changed) and bisectable — the matching commit "refactor(mcp):
//! split server/tools.rs into per-tool modules" is the diff target if you're
//! cherry-picking history.

mod advanced;
mod ast_node;
mod ast_search;
mod callgraph;
mod management;
mod overview;
mod project_map;
mod refs;
mod search;
