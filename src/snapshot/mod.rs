//! Shared graph snapshot — producer/consumer for `code-graph-snapshot-*.db.zst`
//! GitHub Release artifacts. See docs/superpowers/specs/2026-05-10-shared-graph-snapshot-design.md.

pub mod config;
pub mod install;
pub mod meta;

#[cfg(test)]
mod tests;

pub use install::{resolve_snapshot_source, try_install};
pub use meta::SnapshotMeta;

use anyhow::Result;
use std::path::Path;

/// Build a snapshot at `out` by running a full index in a temp dir, dropping
/// the vec table, vacuuming, writing meta keys, then opening for the caller
/// to zstd-compress externally. The caller is responsible for compression
/// (the workflow template uses `zstd -9` shell command).
pub fn create(_root: &Path, _out: &Path, _include_vec: bool) -> Result<()> {
    anyhow::bail!("snapshot::create not implemented")
}

/// Open a `.db.zst` file, decompress to a temp file, read meta, and return.
pub fn inspect(_file: &Path) -> Result<SnapshotMeta> {
    anyhow::bail!("snapshot::inspect not implemented")
}
