//! Consumer-side snapshot fetch + install pipeline.

use anyhow::Result;
use std::path::Path;

pub fn resolve_snapshot_source(_root: &Path) -> Option<String> {
    None
}

pub fn try_install(_url: &str, _root: &Path) -> Result<String> {
    anyhow::bail!("try_install not implemented")
}
