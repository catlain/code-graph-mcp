//! `.code-graph.toml` parsing.

use serde::Deserialize;

#[derive(Debug, Deserialize, Default)]
pub struct CodeGraphConfig {
    #[serde(default)]
    pub snapshot: SnapshotConfig,
}

#[derive(Debug, Deserialize, Default)]
pub struct SnapshotConfig {
    pub url: Option<String>,
    #[serde(default)]
    pub disabled: bool,
}
