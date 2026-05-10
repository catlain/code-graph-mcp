//! Consumer-side snapshot fetch + install pipeline.

use anyhow::Result;
use std::path::Path;

use super::config::load_config;

/// Resolve where the snapshot lives. Order:
/// 1. `.code-graph.toml` `[snapshot] url` (must be HTTPS)
/// 2. `[snapshot] disabled = true` → None
/// 3. Auto-detect from `git remote get-url origin` → GitHub release asset
pub fn resolve_snapshot_source(root: &Path) -> Option<String> {
    let cfg = load_config(root).ok()?;
    if cfg.snapshot.disabled {
        return None;
    }
    if let Some(url) = cfg.snapshot.url {
        if url.starts_with("https://") {
            return Some(url);
        }
        tracing::warn!("snapshot url in .code-graph.toml is not https, skipping: {url}");
        return None;
    }
    resolve_from_github(root)
}

fn resolve_from_github(root: &Path) -> Option<String> {
    let remote = std::process::Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(root)
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    let url = String::from_utf8_lossy(&remote.stdout).trim().to_string();
    let (owner, repo) = parse_github_remote(&url)?;
    fetch_latest_snapshot_asset_url(&owner, &repo)
}

fn parse_github_remote(url: &str) -> Option<(String, String)> {
    // Supports https://github.com/o/r(.git) and git@github.com:o/r(.git)
    let stripped = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("git@github.com:"))?;
    let stripped = stripped.strip_suffix(".git").unwrap_or(stripped);
    let mut parts = stripped.splitn(2, '/');
    let owner = parts.next()?.to_string();
    let repo = parts.next()?.trim_end_matches('/').to_string();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner, repo))
}

fn fetch_latest_snapshot_asset_url(owner: &str, repo: &str) -> Option<String> {
    // Use `gh api` for uniform auth (public + private). Fail silent on no `gh`.
    let endpoint = format!("repos/{owner}/{repo}/releases/latest");
    let output = std::process::Command::new("gh")
        .args(["api", &endpoint])
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let assets = json.get("assets")?.as_array()?;
    let mut matches: Vec<&str> = assets
        .iter()
        .filter_map(|a| {
            let name = a.get("name")?.as_str()?;
            if name.starts_with("code-graph-snapshot-") && name.ends_with(".db.zst") {
                a.get("browser_download_url")?.as_str()
            } else {
                None
            }
        })
        .collect();
    // Deterministic pick when multiple assets match (lexicographic by URL)
    matches.sort();
    matches.first().map(|s| s.to_string())
}

pub fn try_install(_url: &str, _root: &Path) -> Result<String> {
    anyhow::bail!("try_install not implemented")
}
