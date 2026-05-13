'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldHint, buildHint, commandHash, isSilenced } = require('./pre-grep-guide');

// ── Should fire: bare grep/rg/ag on indexed source tree ─────────────

test('shouldHint: grep -rn on src/', () => {
  assert.equal(shouldHint('grep -rn "fn fts5_search" src/storage/'), true);
});

test('shouldHint: rg on tests/', () => {
  assert.equal(shouldHint('rg "expand_acronym" tests/'), true);
});

test('shouldHint: grep -n on single file in src/', () => {
  assert.equal(shouldHint('grep -n "fn split_identifier" src/search/tokenizer.rs'), true);
});

test('shouldHint: grep -rn on claude-plugin/', () => {
  assert.equal(shouldHint('grep -rn "computeQuietHooks" claude-plugin/scripts/'), true);
});

test('shouldHint: grep with alternation against src/', () => {
  assert.equal(shouldHint('grep -rn "set_hook\\|panic_handler" src/main.rs src/lib.rs'), true);
});

test('shouldHint: grep with stderr redirect + head pipe (still a source search)', () => {
  // head/tail/sort pipes don't disqualify — the SEARCH operation is grep on src/
  assert.equal(shouldHint('grep -rn "fn fts5_search\\|MATCH" src/storage/ 2>&1 | head -10'), true);
});

test('shouldHint: ag on lib/', () => {
  assert.equal(shouldHint('ag "TODO" lib/'), true);
});

test('shouldHint: env-prefixed grep on src/', () => {
  assert.equal(shouldHint('env LANG=C grep -rn "Foo" src/'), true);
});

// ── Should NOT fire: pipe-grep (output filter, not search) ──────────

test('shouldHint: pipe-grep on cargo test output', () => {
  assert.equal(shouldHint('cargo test 2>&1 | grep "test result"'), false);
});

test('shouldHint: pipe-grep with -E flag', () => {
  assert.equal(shouldHint("cargo test --no-default-features 2>&1 | grep -E 'test result|FAILED'"), false);
});

test('shouldHint: pipe-rg', () => {
  assert.equal(shouldHint("cargo build 2>&1 | rg 'warning|error'"), false);
});

test('shouldHint: pipe-grep with src/ in pattern (still output filter)', () => {
  assert.equal(shouldHint("cargo build 2>&1 | grep 'src/main.rs'"), false);
});

// ── Should NOT fire: already using code-graph-mcp ───────────────────

test('shouldHint: code-graph-mcp grep itself', () => {
  assert.equal(shouldHint('code-graph-mcp grep "fn parse" src/'), false);
});

test('shouldHint: pipe through code-graph-mcp', () => {
  assert.equal(shouldHint('code-graph-mcp show foo | grep src/'), false);
});

// ── Should NOT fire: not source-tree paths ──────────────────────────

test('shouldHint: grep on Cargo.toml only', () => {
  assert.equal(shouldHint('grep "^version" Cargo.toml'), false);
});

test('shouldHint: grep -i docs on .gitignore', () => {
  assert.equal(shouldHint('grep -i docs .gitignore'), false);
});

test('shouldHint: grep on package.json', () => {
  assert.equal(shouldHint('grep "version" package.json'), false);
});

test('shouldHint: grep on a markdown changelog', () => {
  assert.equal(shouldHint('grep "v0.24" CHANGELOG.md'), false);
});

// ── Should NOT fire: not search tools ───────────────────────────────

test('shouldHint: ls src/', () => {
  assert.equal(shouldHint('ls src/storage/'), false);
});

test('shouldHint: cat src/main.rs', () => {
  assert.equal(shouldHint('cat src/main.rs'), false);
});

test('shouldHint: git log on src/', () => {
  assert.equal(shouldHint('git log --oneline -10 src/'), false);
});

test('shouldHint: find on src/ (file path tool, not content search)', () => {
  // find is path-based, not pattern-based. Out of scope for this hook.
  assert.equal(shouldHint('find src/ -name "*.rs"'), false);
});

// ── Edge cases ──────────────────────────────────────────────────────

test('shouldHint: empty command', () => {
  assert.equal(shouldHint(''), false);
});

test('shouldHint: non-string input', () => {
  assert.equal(shouldHint(null), false);
  assert.equal(shouldHint(undefined), false);
  assert.equal(shouldHint(42), false);
});

test('shouldHint: oversize command (>1000 chars)', () => {
  assert.equal(shouldHint('grep -rn "x" src/ ' + 'y'.repeat(1100)), false);
});

// ── Hint content ────────────────────────────────────────────────────

test('buildHint: includes all four code-graph subcommands', () => {
  const out = buildHint();
  assert.match(out, /code-graph-mcp grep/);
  assert.match(out, /code-graph-mcp ast-search/);
  assert.match(out, /code-graph-mcp callgraph/);
  assert.match(out, /code-graph-mcp show/);
});

test('buildHint: stays under 700-byte budget (~175 tokens)', () => {
  const out = buildHint();
  assert.ok(out.length < 700, `hint length ${out.length} exceeds budget`);
});

test('buildHint: mentions repo-wide / LSP boundary', () => {
  assert.match(buildHint(), /Repo-wide index|LSP/);
});

// ── Cooldown hash ───────────────────────────────────────────────────

test('commandHash: deterministic + 12-char', () => {
  const h1 = commandHash('grep -rn "foo" src/');
  const h2 = commandHash('grep -rn "foo" src/');
  assert.equal(h1, h2);
  assert.equal(h1.length, 12);
});

test('commandHash: different commands → different hashes', () => {
  assert.notEqual(commandHash('grep -rn "foo" src/'), commandHash('grep -rn "bar" src/'));
});

// ── Kill switch ─────────────────────────────────────────────────────

test('isSilenced: default (no env) → not silenced (noisy)', () => {
  assert.equal(isSilenced({}), false);
});

test('isSilenced: CODE_GRAPH_QUIET_HOOKS=1 → silenced', () => {
  assert.equal(isSilenced({ CODE_GRAPH_QUIET_HOOKS: '1' }), true);
});

test('isSilenced: CODE_GRAPH_QUIET_HOOKS=0 → not silenced', () => {
  assert.equal(isSilenced({ CODE_GRAPH_QUIET_HOOKS: '0' }), false);
});

test('isSilenced: VERBOSE_HOOKS=1 alone → not silenced (noisy by default already)', () => {
  // pre-grep-guide is noisy-by-default; VERBOSE is irrelevant here.
  assert.equal(isSilenced({ CODE_GRAPH_VERBOSE_HOOKS: '1' }), false);
});

// ── Phase C: extended prefixes (real-world backend / DDD / web conventions) ──

// daagu pattern: `backend/app/services/...` — `app/` is preceded by `backend/`,
// which doesn't satisfy the `(?:^|\s|["'])` lookbehind in the old SRC_PATH.
// 7d audit found 5 of the worst missed sessions used exactly this layout.
test('shouldHint: grep -rn on backend/app/services/ (daagu)', () => {
  assert.equal(
    shouldHint('grep -rn "pct_chg|pct_change" backend/app/services/context_builder.py'),
    true
  );
});

test('shouldHint: grep -rn on backend/app/services/scheduler/', () => {
  assert.equal(
    shouldHint('grep -rn "TASK_ZOMBIE|zombie recovery|reason=age" backend/app/services/scheduler/'),
    true
  );
});

test('shouldHint: grep on services/ (no backend prefix)', () => {
  assert.equal(shouldHint('grep -rn "fetchUser" services/auth/'), true);
});

test('shouldHint: grep on models/ (Rails / Django)', () => {
  assert.equal(shouldHint('grep -rn "before_save" models/user.rb'), true);
});

test('shouldHint: grep on controllers/ (Rails / ASP.NET)', () => {
  assert.equal(shouldHint('grep -rn "def index" controllers/UsersController.rb'), true);
});

test('shouldHint: grep on domain/ (DDD architecture)', () => {
  assert.equal(shouldHint('grep -rn "Aggregate" domain/orders/'), true);
});

test('shouldHint: grep on handlers/ (web server)', () => {
  assert.equal(shouldHint('grep -rn "func New" handlers/api/'), true);
});

test('shouldHint: grep on migrations/ (db schema)', () => {
  assert.equal(shouldHint('grep -rn "add_column" migrations/'), true);
});

test('shouldHint: grep on features/ (modular monolith)', () => {
  assert.equal(shouldHint('grep -rn "useFeature" features/billing/'), true);
});

test('shouldHint: grep on api/ + frontend/', () => {
  assert.equal(shouldHint('grep -rn "POST" api/v1/'), true);
  assert.equal(shouldHint('grep -rn "import React" frontend/'), true);
});

// Precision guards — these MUST still NOT fire after the expansion.

test('shouldHint: grep on web.config (config file ext keeps suppression)', () => {
  assert.equal(shouldHint('grep "<connectionStrings" web.config'), false);
});

test('shouldHint: grep on node_modules/ (NOT in src list)', () => {
  assert.equal(shouldHint('grep -rn "deprecated" node_modules/some-pkg/'), false);
});

test('shouldHint: grep on docs/ (docs trees stay out)', () => {
  // We deliberately did NOT add `docs` to the prefix list — docs are typically
  // markdown and the existing CONFIG_TARGET_ONLY already filters `.md`-only
  // greps. A bare `grep "X" docs/foo.md` would be CONFIG_TARGET_ONLY-suppressed.
  assert.equal(shouldHint('grep "v0.24" docs/CHANGELOG.md'), false);
});

// ── Regression cases from real session telemetry (2026-05-11) ───────

test('regression: grep -n "Error\\|anyhow" src/main.rs (sess 5052e2a1)', () => {
  assert.equal(shouldHint('grep -n "Error\\|anyhow\\|context" src/main.rs'), true);
});

test('regression: grep -rn "fn fts5_search" src/storage/ (sess 25fa8050)', () => {
  assert.equal(shouldHint('grep -rn "fn fts5_search\\|MATCH\\|fts.*tokenize" src/storage/'), true);
});

test('regression: grep multi-extension MEMORY.md tag search (sess 5052e2a1)', () => {
  // This one targets MEMORY.md files — should NOT fire because the --include flags
  // are for non-source extensions and there's no `src/` etc. in the args.
  assert.equal(shouldHint("grep -rn 'callgraph, impact' --include='*.md'"), false);
});

test('regression: cargo test pipe filter NOT fires (sess 45691293)', () => {
  assert.equal(shouldHint('cargo test --no-default-features 2>&1 | grep -E "test result|FAILED|error\\[" | tail -15'), false);
});

test('regression: grep -m1 "^version" Cargo.toml NOT fires', () => {
  assert.equal(shouldHint('grep -m1 "^version" Cargo.toml'), false);
});
