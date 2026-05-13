#!/usr/bin/env node
'use strict';
// PreToolUse(Bash) hook: detect raw `grep`/`rg`/`ag` on the indexed source tree
// and suggest code-graph CLI alternatives. Closes the "Bash comfort zone" leak —
// pre-training bias has Claude reach for `grep -rn` ~13× more than the indexed
// CLI on bash-heavy days (15-day baseline: 429 raw grep vs 191 functional CLI).
//
// Fires when ALL conditions met:
//   1. Command HEAD is grep/rg/ag (NOT piped — pipe-greps are output filters)
//   2. Args include an indexed source-tree path (src/ tests/ lib/ scripts/ ...)
//   3. Not searching only a config/lockfile (Cargo.toml/.gitignore/*.md/*.json)
//   4. Command doesn't already invoke code-graph-mcp (no double-suggest)
//   5. .code-graph/index.db exists in CWD
//   6. Same command-hash not hinted within last 60s (per-command cooldown)
//
// Exits silently otherwise — zero noise for build greps, log filters, config
// lookups, or the rare legitimate use of raw grep on indexed source.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// --- Pure logic (testable) ---

const GREP_HEAD = /^\s*(?:env\s+\S+=\S+\s+)*(grep|rg|ag)\b/;
// Source-tree prefix list. Expanded v0.27+ Phase C: original `src/tests/lib/...`
// missed real-world backend conventions where the prefix list term is preceded
// by something else (`backend/app/...` — `app/` doesn't match because `/` isn't
// in the lookbehind). 7d audit found 5 of the worst missed sessions used the
// daagu `backend/app/services/...` layout. Added: backend/frontend/services/
// models/domain/controllers/views/handlers/middleware/routes/repositories/
// entities/migrations/tasks/jobs/workers/features/modules/api/web. Generic
// terms like `core`/`utils`/`shared`/`common`/`types` deliberately omitted —
// they appear in too many non-code contexts to be precise enough.
const SRC_PATH = /(?:^|\s|["'])(src|tests|lib|libs|scripts|claude-plugin|tools|pkg|cmd|internal|app|apps|components?|server|client|crates|packages|backend|frontend|services|models|domain|controllers|views|handlers|middleware|routes|repositories|entities|migrations|tasks|jobs|workers|features|modules|api|web)\//;
const PIPE_INTO_GREP = /\|\s*(?:grep|rg|ag)\b/;
const CG_INVOKED = /\bcode-graph-mcp\b/;
// A file argument that ends in a config/lockfile extension AND no source-tree
// path appears elsewhere → grep is searching config, not code.
const CONFIG_TARGET_ONLY =
  /(?:^|\s)[^\s|<>]*\.(toml|md|json|yml|yaml|lock|txt|cfg|env|gitignore|properties)(?:\s|$)/i;

function shouldHint(cmd) {
  if (!cmd || typeof cmd !== 'string') return false;
  if (cmd.length > 1000) return false;             // sanity — oversize commands are noise
  if (CG_INVOKED.test(cmd)) return false;          // already using cg
  if (PIPE_INTO_GREP.test(cmd)) return false;      // `cargo test | grep FAILED` is output filter
  if (!GREP_HEAD.test(cmd)) return false;          // not a search command
  if (!SRC_PATH.test(cmd)) return false;           // not against indexed source tree
  // If a config file appears AND no source path remains after stripping it, skip.
  if (CONFIG_TARGET_ONLY.test(cmd)) {
    const stripped = cmd.replace(CONFIG_TARGET_ONLY, ' ');
    if (!SRC_PATH.test(stripped)) return false;
  }
  return true;
}

function commandHash(cmd) {
  return crypto.createHash('sha1').update(cmd).digest('hex').slice(0, 12);
}

function isOnCooldown(cmd, now = Date.now(), windowMs = 60000) {
  const flag = path.join(os.tmpdir(), `.code-graph-bash-${commandHash(cmd)}`);
  try {
    return now - fs.statSync(flag).mtimeMs < windowMs;
  } catch { return false; }
}

function markCooldown(cmd) {
  const flag = path.join(os.tmpdir(), `.code-graph-bash-${commandHash(cmd)}`);
  try { fs.writeFileSync(flag, ''); } catch { /* ok */ }
}

function buildHint() {
  // Terse, no banner spam. Single message budget ~600 bytes.
  return [
    '[code-graph] Raw `grep`/`rg` on indexed source — consider AST-aware equivalents:',
    '  • code-graph-mcp grep "<pat>" <path>          # grep + containing fn/module per hit',
    '  • code-graph-mcp ast-search "<pat>" --type fn # filter by type/returns/params',
    '  • code-graph-mcp callgraph SYMBOL             # callers + callees, repo-wide',
    '  • code-graph-mcp show SYMBOL                  # one symbol: signature + source',
    'Repo-wide index (LSP only sees open files). Skip this hint if you specifically need raw-text regex.',
  ].join('\n');
}

// --- Main execution (only when run directly) ---

// Kill switch: matches user-prompt-context.js convention. =1 forces silence
// even when the rest of the hook tier is noisy. Default (unset) is noisy here
// — this hook only fires on raw grep against the source tree, which is the
// exact comfort-zone leak it was designed to catch.
function isSilenced(env = process.env) {
  return env.CODE_GRAPH_QUIET_HOOKS === '1';
}

function runMain() {
  if (isSilenced()) return;
  const cwd = process.cwd();
  const dbPath = path.join(cwd, '.code-graph', 'index.db');
  if (!fs.existsSync(dbPath)) return;  // no index — no hint

  let input;
  try {
    input = JSON.parse(fs.readFileSync('/dev/stdin', 'utf8'));
  } catch { return; }

  const cmd = (input.tool_input && input.tool_input.command) || '';
  if (!shouldHint(cmd)) return;
  if (isOnCooldown(cmd)) return;

  markCooldown(cmd);
  process.stdout.write(buildHint() + '\n');
}

if (require.main === module) {
  runMain();
}

module.exports = {
  shouldHint,
  buildHint,
  commandHash,
  isOnCooldown,
  markCooldown,
  isSilenced,
};
