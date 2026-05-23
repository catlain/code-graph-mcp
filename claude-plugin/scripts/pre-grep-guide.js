#!/usr/bin/env node
'use strict';
// PreToolUse(Bash) hook: detect raw `grep`/`rg`/`ag` on the indexed source tree
// and either BLOCK with suggestion (v0.32+) or HINT (legacy path). Closes the
// "Bash comfort zone" leak — pre-training bias has Claude reach for `grep -rn`
// ~13× more than the indexed CLI on bash-heavy days (15-day baseline: 429 raw
// grep vs 191 functional CLI). v0.25.0 hint-only had ~0% transfer rate; v0.32.0
// upgrades the narrowest "I'm searching for a symbol" subset to block-with-reason.
//
// HINT fires when ALL conditions met (shouldHint):
//   1. Command HEAD is grep/rg/ag (NOT piped — pipe-greps are output filters)
//   2. Args include an indexed source-tree path (src/ tests/ lib/ scripts/ ...)
//   3. Not searching only a config/lockfile (Cargo.toml/.gitignore/*.md/*.json)
//   4. Command doesn't already invoke code-graph-mcp (no double-suggest)
//   5. .code-graph/index.db exists in CWD
//   6. Same command-hash not hinted within last 60s (per-command cooldown)
//
// BLOCK fires when shouldHint AND (shouldBlock):
//   7. No precision flag in the command (-l / -A / -B / -C / --include / --exclude)
//   8. Pattern looks identifier-like (CamelCase ≥4ch, or snake_case with _, or
//      a declaration anchor like `fn X` / `class X` / `def X`)
//   9. Pattern is not a bare marker word (TODO/FIXME/XXX/HACK/WARN/ERROR/NOTE)
//  10. CODE_GRAPH_NO_BLOCK_GREP != "1" (block escape, independent of QUIET_HOOKS)
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

// v0.32.0 block tier — strictly narrower than shouldHint. The disqualifying
// flags (-l, -A, -B, -C, --include, --exclude) mean the user is already doing
// precise filtering and a blanket "use cg" suggestion would be wrong. The
// identifier-like check restricts blocks to "I'm looking for a symbol" — the
// exact use case cg replaces. Marker-only patterns (TODO/FIXME) are legit raw
// text scans with no cg equivalent.
// Match any short-flag cluster containing l/L/A/B/C (e.g. `-l`, `-rl`, `-rln`,
// `-A`, `-rA3`). Combined flag clusters are common in real-world usage and the
// "precision intent" applies as soon as ANY of these letters appears.
const BLOCK_DISQUALIFYING_FLAGS =
  /(?:^|\s)-[a-zA-Z]*[lLABC][a-zA-Z]*(?:\s|=|\d|$)|--(?:files-with-matches|files-without-match|include|exclude|exclude-dir|after-context|before-context|context)\b/;
const IDENTIFIER_LIKE =
  /[A-Z][a-zA-Z0-9]{3,}|[a-z][a-z0-9]*_[a-z0-9_]+|\b(?:fn|def|class|function|struct|impl|trait|type)\s+\w/;
const MARKER_ONLY =
  /^[^"']*["']\s*(?:TODO|FIXME|XXX|HACK|WARN|WARNING|ERROR|NOTE)\s*["']/i;

function shouldBlock(cmd) {
  if (!shouldHint(cmd)) return false;             // narrower than hint
  if (BLOCK_DISQUALIFYING_FLAGS.test(cmd)) return false;
  if (MARKER_ONLY.test(cmd)) return false;        // bare TODO/FIXME — no cg equivalent
  if (!IDENTIFIER_LIKE.test(cmd)) return false;   // no symbol-shaped target
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

function buildBlockReason() {
  // Shown to Claude via PreToolUse `decision: block` reason. Must give a
  // concrete alternate command Claude can re-issue without further thinking.
  return [
    '[code-graph] Raw `grep -rn` on indexed source — denied by code-graph hook.',
    'Use the AST-aware equivalent (returns containing fn/module per hit, repo-wide):',
    '  code-graph-mcp grep "<pattern>" <path>          # FTS + AST context per hit',
    '  code-graph-mcp ast-search "<pattern>" --type fn # filter by node type',
    '  code-graph-mcp callgraph SYMBOL                 # callers + callees',
    'For raw-text scans (log/comment/marker), re-run with `CODE_GRAPH_NO_BLOCK_GREP=1` prepended.',
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

// v0.32.0 — independent of QUIET_HOOKS. =1 downgrades block tier to hint
// (legacy v0.25.0–v0.31 behavior). Useful when raw-text scan is intentional
// but the user still wants the hint for future commands.
function isBlockDisabled(env = process.env) {
  return env.CODE_GRAPH_NO_BLOCK_GREP === '1';
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

  if (!isBlockDisabled() && shouldBlock(cmd)) {
    // PreToolUse block via current CC schema (`hookSpecificOutput.permissionDecision`).
    // Verified empirically 2026-05-24: legacy `{decision:"block",reason}` was
    // ignored by Claude Code — the grep ran anyway. The hookSpecificOutput form
    // is the documented modern path. Exit 0 — this is a routing decision, not
    // a hook failure (exit 2 would mark the tool call as "hook errored").
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: buildBlockReason(),
      },
    }) + '\n');
    return;
  }

  process.stdout.write(buildHint() + '\n');
}

if (require.main === module) {
  runMain();
}

module.exports = {
  shouldHint,
  shouldBlock,
  buildHint,
  buildBlockReason,
  commandHash,
  isOnCooldown,
  markCooldown,
  isSilenced,
  isBlockDisabled,
};
