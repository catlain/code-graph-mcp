//! `find_references` — usage sites by relation kind, with type-definition warning
//! for struct/enum/trait/class targets where method-qualified calls aren't tracked.

use super::super::*;

impl McpServer {
    pub(in crate::mcp::server) fn tool_find_references(&self, args: &serde_json::Value) -> Result<serde_json::Value> {
        // node_id takes precedence — lets callers disambiguate multi-def same-file
        // collisions (e.g. two `fn new()` in one module) that file_path alone can't resolve.
        let node_id = args["node_id"].as_i64();
        let symbol_name_arg = args["symbol_name"].as_str();
        let file_path = args["file_path"].as_str();
        let relation = args["relation"].as_str().unwrap_or("all");
        let compact = args["compact"].as_bool().unwrap_or(false);
        // Default true preserves the "every usage site" contract for rename audits
        // (tests must be renamed too). Pass false for "production callers only".
        let include_tests = args["include_tests"].as_bool().unwrap_or(true);

        if node_id.is_none() && symbol_name_arg.is_none() {
            return Err(anyhow!("symbol_name or node_id is required"));
        }

        if !should_skip_indexing(args) {
            self.ensure_indexed()?;
            self.ensure_file_fresh_opt(file_path)?;
        }

        // Resolve symbol to node_id(s)
        let (target_ids, symbol_name): (Vec<i64>, String) = if let Some(nid) = node_id {
            let node = queries::get_node_by_id(self.db.conn(), nid)?
                .ok_or_else(|| anyhow!("node_id {} not found in index", nid))?;
            (vec![nid], node.name)
        } else if let Some(fp) = file_path {
            let symbol_name = symbol_name_arg.unwrap();
            // Specific file: find the symbol in that file
            let nodes = queries::get_nodes_by_file_path(self.db.conn(), fp)?;
            let matching: Vec<i64> = nodes.iter()
                .filter(|n| n.name == symbol_name)
                .map(|n| n.id)
                .collect();
            if matching.is_empty() {
                return Err(anyhow!("Symbol '{}' not found in file '{}'.", symbol_name, fp));
            }
            // Multi-def in same file — report ambiguity with node_ids and start_lines
            // so callers can pick the specific definition.
            if matching.len() > 1 {
                let suggestions: Vec<_> = nodes.iter()
                    .filter(|n| n.name == symbol_name)
                    .map(|n| json!({
                        "name": n.name,
                        "file_path": fp,
                        "type": n.node_type,
                        "node_id": n.id,
                        "start_line": n.start_line,
                    }))
                    .collect();
                return Ok(json!({
                    "symbol": symbol_name,
                    "error": format!(
                        "Ambiguous symbol '{}' in '{}': {} definitions in the same file. Pass node_id to select one.",
                        symbol_name, fp, suggestions.len()
                    ),
                    "suggestions": suggestions,
                }));
            }
            (matching, symbol_name.to_string())
        } else {
            let symbol_name = symbol_name_arg.unwrap();
            // No file_path: fuzzy resolve
            match self.resolve_fuzzy_name(symbol_name)? {
                FuzzyResolution::Unique(resolved_name) => {
                    let nodes = queries::get_node_ids_by_name(self.db.conn(), &resolved_name)?;
                    let ids: Vec<i64> = nodes.into_iter()
                        .filter(|(_, fp)| !is_test_symbol(&resolved_name, fp))
                        .map(|(id, _)| id)
                        .collect();
                    if ids.is_empty() {
                        return Err(anyhow!("Symbol '{}' not found in index.", symbol_name));
                    }
                    (ids, resolved_name)
                }
                FuzzyResolution::Ambiguous(suggestions) => {
                    return Ok(json!({
                        "symbol": symbol_name,
                        "error": format!("Ambiguous symbol '{}': {} matches. Specify file_path or node_id to disambiguate.", symbol_name, suggestions.len()),
                        "suggestions": suggestions,
                    }));
                }
                FuzzyResolution::NotFound => {
                    return Err(anyhow!("Symbol '{}' not found in index. Use semantic_code_search to find the correct symbol name.", symbol_name));
                }
            }
        };

        use crate::domain::{REL_CALLS, REL_IMPORTS, REL_INHERITS, REL_IMPLEMENTS};
        let relation_filter = match relation {
            "calls" => Some(REL_CALLS),
            "imports" => Some(REL_IMPORTS),
            "inherits" => Some(REL_INHERITS),
            "implements" => Some(REL_IMPLEMENTS),
            _ => None,
        };

        // Collect references for all matching node IDs
        let mut all_refs: Vec<serde_json::Value> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut test_refs_filtered: usize = 0;
        for target_id in &target_ids {
            let refs = queries::get_incoming_references(self.db.conn(), *target_id, relation_filter)?;
            for r in refs {
                // Test filter: caller (r.name + r.file_path) looks like a test node → skip
                // unless caller opted in. Count separately so response shows the hidden total.
                if !include_tests && is_test_symbol(&r.name, &r.file_path) {
                    test_refs_filtered += 1;
                    continue;
                }
                // Deduplicate by (name, file_path, relation)
                let key = (r.name.clone(), r.file_path.clone(), r.relation.clone());
                if seen.insert(key) {
                    if compact {
                        all_refs.push(json!({
                            "name": r.name,
                            "file_path": r.file_path,
                            "start_line": r.start_line,
                            "relation": r.relation,
                            "node_id": r.node_id,
                        }));
                    } else {
                        all_refs.push(json!({
                            "name": r.name,
                            "type": r.node_type,
                            "file_path": r.file_path,
                            "start_line": r.start_line,
                            "relation": r.relation,
                            "node_id": r.node_id,
                        }));
                    }
                }
            }
        }

        // Group by relation for readability
        let mut by_relation: std::collections::HashMap<String, Vec<&serde_json::Value>> = std::collections::HashMap::new();
        for r in &all_refs {
            let rel = r["relation"].as_str().unwrap_or("unknown").to_string();
            by_relation.entry(rel).or_default().push(r);
        }

        let summary: serde_json::Value = by_relation.iter().map(|(rel, refs)| {
            (rel.clone(), json!(refs.len()))
        }).collect::<serde_json::Map<String, serde_json::Value>>().into();

        // Type-definition warning: for structs/enums/traits/types/interfaces/classes,
        // the edge index only captures explicit call/import/inherit/implement edges.
        // Field access, type annotations, and method-qualified calls (e.g. `Type::method()`
        // which binds to the method node, not the type) will not appear here. Tell the
        // caller so rename audits get broader coverage via a second query.
        let type_kinds = ["struct", "enum", "trait", "type", "interface", "class"];
        let target_types: Vec<String> = target_ids.iter()
            .filter_map(|id| queries::get_node_by_id(self.db.conn(), *id).ok().flatten())
            .map(|n| n.node_type)
            .collect();
        let is_type_def = target_types.iter().any(|t| type_kinds.contains(&t.as_str()));

        let mut out = json!({
            "symbol": symbol_name,
            "total_references": all_refs.len(),
            "by_relation": summary,
            "references": all_refs,
        });
        if !include_tests && test_refs_filtered > 0 {
            if let Some(obj) = out.as_object_mut() {
                obj.insert("test_references_filtered".to_string(), json!(test_refs_filtered));
            }
        }
        if is_type_def {
            if let Some(obj) = out.as_object_mut() {
                obj.insert("type_definition_note".to_string(), json!(
                    "Symbol is a type definition (struct/enum/trait/class). References list \
                     captures explicit imports/inherits/implements and struct-literal instantiation, \
                     but NOT method-qualified calls (e.g. `Type::method()`), field access, or type \
                     annotations. For a rename audit, also query find_references on each method of \
                     this type (see module_overview for method list) and grep for the bare name."
                ));
            }
        }
        Ok(out)
    }
}
