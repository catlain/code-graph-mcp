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

use anyhow::Context;

const MAX_DECOMPRESSED_BYTES: u64 = 100 * 1024 * 1024; // 100 MB

pub fn try_install(url: &str, root: &Path) -> Result<String> {
    use crate::storage::db::Database;
    use std::time::{SystemTime, UNIX_EPOCH};

    if !(url.starts_with("https://") || url.starts_with("file://")) {
        anyhow::bail!("snapshot url must be https:// (got {url})");
    }

    let cg_dir = root.join(crate::domain::CODE_GRAPH_DIR);
    std::fs::create_dir_all(&cg_dir)?;

    let zst_partial = cg_dir.join(".snapshot.db.zst.partial");
    let db_partial = cg_dir.join(".snapshot.db.partial");

    // Clean up any stale partials from a previous crashed install
    let _ = std::fs::remove_file(&zst_partial);
    let _ = std::fs::remove_file(&db_partial);

    let install_inner = || -> Result<String> {
        download(url, &zst_partial)?;
        decompress_with_cap(&zst_partial, &db_partial, MAX_DECOMPRESSED_BYTES)?;
        validate(&db_partial, root)?;

        // POSIX rename(2) atomically replaces the destination — pre-deleting
        // would open a TOCTOU window where a concurrent reader sees no file.
        let final_db = cg_dir.join("index.db");
        std::fs::rename(&db_partial, &final_db)?;

        // Write consumer-side meta (source_url + fetched_at)
        let db = Database::open(&final_db)?;
        let conn = db.conn();
        super::meta::write_meta(conn, super::meta::META_SNAPSHOT_SOURCE_URL, url)?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        super::meta::write_meta(conn, super::meta::META_SNAPSHOT_FETCHED_AT, &now.to_string())?;

        let commit = super::meta::read_meta(conn, super::meta::META_SNAPSHOT_SOURCE_COMMIT)?
            .unwrap_or_default();
        Ok(commit)
    };

    match install_inner() {
        Ok(commit) => {
            let _ = std::fs::remove_file(&zst_partial);
            Ok(commit)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&zst_partial);
            let _ = std::fs::remove_file(&db_partial);
            // If we got past rename but meta-write failed, remove the final db too
            let final_db = cg_dir.join("index.db");
            if final_db.exists() {
                let _ = std::fs::remove_file(&final_db);
            }
            Err(e)
        }
    }
}

fn download(url: &str, dest: &Path) -> Result<()> {
    if let Some(file_path) = url.strip_prefix("file://") {
        // file:// is test-only and config-controlled; no path sanitisation.
        std::fs::copy(file_path, dest).context("file:// copy")?;
        return Ok(());
    }
    // TODO: stream to disk (reqwest copy_to) and apply MAX_DECOMPRESSED_BYTES
    // cap to the compressed payload too — currently buffers the whole response.
    let bytes = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?
        .get(url)
        .send()?
        .error_for_status()?
        .bytes()?;
    std::fs::write(dest, &bytes).context("write download to disk")?;
    Ok(())
}

fn decompress_with_cap(src: &Path, dst: &Path, cap: u64) -> Result<()> {
    let f = std::fs::File::open(src).context("open compressed")?;
    let mut decoder = zstd::Decoder::new(f).context("zstd decoder init")?;
    let mut out = std::fs::File::create(dst).context("create decompressed")?;
    let mut writer = CapWriter::new(&mut out, cap);
    std::io::copy(&mut decoder, &mut writer).context("zstd decode")?;
    Ok(())
}

struct CapWriter<'a, W: std::io::Write> {
    inner: &'a mut W,
    written: u64,
    cap: u64,
}

impl<'a, W: std::io::Write> CapWriter<'a, W> {
    fn new(inner: &'a mut W, cap: u64) -> Self {
        Self { inner, written: 0, cap }
    }
}

impl<'a, W: std::io::Write> std::io::Write for CapWriter<'a, W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.written + buf.len() as u64 > self.cap {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("snapshot exceeds {} byte cap", self.cap),
            ));
        }
        let n = self.inner.write(buf)?;
        self.written += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

fn validate(db_path: &Path, root: &Path) -> Result<()> {
    use crate::storage::db::Database;
    use crate::storage::schema::SCHEMA_VERSION;

    let db = Database::open(db_path).context("open snapshot for validation")?;
    let conn = db.conn();

    let snap_schema: i32 = super::meta::read_meta(conn, super::meta::META_SNAPSHOT_SCHEMA_VERSION)?
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    if snap_schema > SCHEMA_VERSION {
        anyhow::bail!(
            "snapshot schema v{snap_schema} newer than binary v{SCHEMA_VERSION}, \
             upgrade code-graph-mcp"
        );
    }

    // Warn (not fail) if snapshot commit is not in local history
    if let Some(commit) = super::meta::read_meta(conn, super::meta::META_SNAPSHOT_SOURCE_COMMIT)? {
        if !commit.is_empty() {
            let exists = std::process::Command::new("git")
                .args(["cat-file", "-e", &commit])
                .current_dir(root)
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if !exists {
                tracing::warn!(
                    "snapshot commit {commit} not in local git history (fork/rebase?), continuing"
                );
            }
        }
    }
    Ok(())
}
