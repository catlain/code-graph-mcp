//! Generic AST helpers shared by language-specific extractors:
//! callee-name extraction across multiple call-expression shapes,
//! depth-bounded string-literal lookup inside an arbitrary subtree.

use super::super::node_text;

pub(super) const MAX_SUBTREE_DEPTH: usize = 32;

pub(super) fn extract_callee_name(node: &tree_sitter::Node, source: &str) -> Option<String> {
    let function = node.child_by_field_name("function")
        .or_else(|| node.named_child(0))?;

    match function.kind() {
        "identifier" | "simple_identifier" => Some(node_text(&function, source).to_string()),
        "member_expression" | "field_expression" => {
            // e.g., obj.method — extract "method" or "obj.method"
            if let Some(prop) = function.child_by_field_name("property")
                .or_else(|| function.child_by_field_name("field")) {
                Some(node_text(&prop, source).to_string())
            } else {
                Some(node_text(&function, source).to_string())
            }
        }
        "scoped_identifier" => {
            // Rust: Self::method(), Module::func(), std::collections::HashMap::new()
            // Extract the rightmost name component (the actual function being called)
            function.child_by_field_name("name")
                .map(|n| node_text(&n, source).to_string())
        }
        "selector_expression" => {
            // Go: receiver.Method(), http.HandleFunc(), etc.
            function.child_by_field_name("field")
                .map(|n| node_text(&n, source).to_string())
        }
        "navigation_expression" => {
            // Kotlin/Swift: obj.method() — last named child is the method name
            // Swift wraps it in navigation_suffix → simple_identifier
            let count = function.named_child_count();
            if count > 0 {
                let last = function.named_child(count - 1)?;
                if last.kind() == "navigation_suffix" {
                    // Swift: navigation_suffix -> simple_identifier
                    last.named_child(0)
                        .map(|n| node_text(&n, source).to_string())
                } else {
                    Some(node_text(&last, source).to_string())
                }
            } else {
                None
            }
        }
        _ => None, // Unknown callee expression — skip to avoid noise in call graph
    }
}

/// Shape of a callee's qualifier. Drives same-language candidate
/// disambiguation in the edge resolver. See
/// `docs/superpowers/specs/2026-05-11-bare-name-call-qualifier-design.md`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)] // variants used in subsequent tasks (T2–T18)
pub(crate) enum CalleeQualifier {
    /// `foo()` — no qualifier (also: any non-Rust language)
    Bare,
    /// `crate::snapshot::create()` / `Module::foo()` / `Type::method()`
    /// Stored with leading `crate`/`super`/`self` segments stripped.
    /// Empty after strip → caller must convert to Bare before serialization.
    Path(Vec<String>),
    /// `Self::method()` — payload is the enclosing impl block's type name.
    SelfType(String),
    /// `self.method()` — payload is the enclosing impl block's type name.
    SelfRecv(String),
    /// `obj.method()` where receiver is a plain identifier of unknown type.
    Receiver(String),
    /// `OpenOptions::new().create(true)` — receiver is a call_expression
    /// (any chain).
    Chain,
}

/// Like `extract_callee_name` but also returns the qualifier shape.
/// Non-Rust languages always return `Bare`. Rust dispatches on the
/// function-node kind to detect scoped_identifier paths.
pub(crate) fn extract_callee(
    node: &tree_sitter::Node,
    source: &str,
    language: &str,
    current_rust_impl: Option<&str>,
) -> Option<(String, CalleeQualifier)> {
    let _ = current_rust_impl; // used in Task 8+
    if language != "rust" {
        return extract_callee_name(node, source).map(|n| (n, CalleeQualifier::Bare));
    }

    let function = node.child_by_field_name("function")
        .or_else(|| node.named_child(0))?;

    match function.kind() {
        // Rust grammar uses "identifier" for bare callees. Other grammars
        // (e.g. Kotlin) use "simple_identifier"; if we ever share this match
        // arm with them, intentionally let "simple_identifier" fall through
        // to the `_` arm where extract_callee_name handles it generically.
        "identifier" => {
            Some((node_text(&function, source).to_string(), CalleeQualifier::Bare))
        }
        "scoped_identifier" => extract_rust_scoped(&function, source),
        // Other kinds added in later tasks (field_expression in T6/T7/T9).
        _ => extract_callee_name(node, source).map(|n| (n, CalleeQualifier::Bare)),
    }
}

/// Walk a scoped_identifier collecting all path segments + final name.
/// `crate::a::b::foo` → segments=["crate","a","b"], name="foo"
fn collect_scoped_path_segments(
    node: &tree_sitter::Node,
    source: &str,
    out: &mut Vec<String>,
) {
    if node.kind() == "scoped_identifier" {
        if let Some(path) = node.child_by_field_name("path") {
            collect_scoped_path_segments(&path, source, out);
        }
        if let Some(name) = node.child_by_field_name("name") {
            out.push(node_text(&name, source).to_string());
        }
    } else if matches!(node.kind(), "identifier" | "type_identifier") {
        out.push(node_text(node, source).to_string());
    }
}

/// Handle Rust scoped_identifier callee. Returns name + Path qualifier with
/// reserved prefixes (crate/super/self) stripped; SelfType detected when first
/// segment is "Self" (added in Task 10 by overriding the qualifier).
fn extract_rust_scoped(
    function: &tree_sitter::Node,
    source: &str,
) -> Option<(String, CalleeQualifier)> {
    let mut all = Vec::new();
    collect_scoped_path_segments(function, source, &mut all);
    if all.is_empty() {
        return None;
    }
    let name = all.pop()?;
    let mut path: Vec<String> = all;
    let skip = path.iter()
        .take_while(|s| matches!(s.as_str(), "crate" | "super" | "self"))
        .count();
    path.drain(..skip);
    if path.is_empty() {
        Some((name, CalleeQualifier::Bare))
    } else {
        Some((name, CalleeQualifier::Path(path)))
    }
}

pub(super) fn extract_string_from_subtree(node: &tree_sitter::Node, source: &str) -> Option<String> {
    extract_string_from_subtree_inner(node, source, 0)
}

fn extract_string_from_subtree_inner(node: &tree_sitter::Node, source: &str, depth: usize) -> Option<String> {
    if depth > MAX_SUBTREE_DEPTH { return None; }
    if node.kind() == "string" {
        let text = node_text(node, source);
        let text = text.trim_start_matches(['f', 'r', 'b', 'u', 'F', 'R', 'B', 'U']);
        return Some(text.trim_matches(|c| c == '\'' || c == '"').to_string());
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if let Some(s) = extract_string_from_subtree_inner(&child, source, depth + 1) {
                return Some(s);
            }
        }
    }
    None
}
