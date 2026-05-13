'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  isSourceFile, dirOf, recordRead, shouldHint, markHint,
  buildHint, isSilenced,
  FANOUT_THRESHOLD, COOLDOWN_MS, STATE_TTL_MS,
  loadState, saveState, statePath,
} = require('./pre-read-guide');

// ── isSourceFile ────────────────────────────────────────────────────

test('isSourceFile: .rs is source', () => {
  assert.equal(isSourceFile('src/main.rs'), true);
});

test('isSourceFile: .py is source', () => {
  assert.equal(isSourceFile('backend/app/services/foo.py'), true);
});

test('isSourceFile: .ts and .tsx are source', () => {
  assert.equal(isSourceFile('src/index.ts'), true);
  assert.equal(isSourceFile('src/App.tsx'), true);
});

test('isSourceFile: .js .jsx .mjs .cjs are source', () => {
  assert.equal(isSourceFile('lib/a.js'), true);
  assert.equal(isSourceFile('lib/b.jsx'), true);
  assert.equal(isSourceFile('lib/c.mjs'), true);
  assert.equal(isSourceFile('lib/d.cjs'), true);
});

test('isSourceFile: .go .java .kt .rb .php .cs are source', () => {
  for (const ext of ['go', 'java', 'kt', 'rb', 'php', 'cs']) {
    assert.equal(isSourceFile('app/x.' + ext), true, ext + ' should be source');
  }
});

test('isSourceFile: .md is NOT source', () => {
  assert.equal(isSourceFile('CHANGELOG.md'), false);
});

test('isSourceFile: .json is NOT source', () => {
  assert.equal(isSourceFile('package.json'), false);
});

test('isSourceFile: .toml .lock .yml are NOT source', () => {
  assert.equal(isSourceFile('Cargo.toml'), false);
  assert.equal(isSourceFile('package-lock.json'), false);
  assert.equal(isSourceFile('.github/workflows/ci.yml'), false);
});

test('isSourceFile: .log is NOT source', () => {
  assert.equal(isSourceFile('logs/app.log'), false);
});

test('isSourceFile: empty / non-string returns false', () => {
  assert.equal(isSourceFile(''), false);
  assert.equal(isSourceFile(null), false);
  assert.equal(isSourceFile(undefined), false);
  assert.equal(isSourceFile(42), false);
});

test('isSourceFile: extensionless file returns false', () => {
  assert.equal(isSourceFile('Makefile'), false);
});

// ── dirOf ───────────────────────────────────────────────────────────

test('dirOf: relative path returns parent dir', () => {
  assert.equal(dirOf('src/storage/queries.rs'), 'src/storage');
});

test('dirOf: top-level file returns "."', () => {
  assert.equal(dirOf('main.rs'), '.');
});

test('dirOf: empty / non-string returns ""', () => {
  assert.equal(dirOf(''), '');
  assert.equal(dirOf(null), '');
});

// ── recordRead + shouldHint ─────────────────────────────────────────

test('shouldHint: first read does NOT hint', () => {
  const s = { by_dir: {} };
  recordRead(s, 'src/foo', 1000);
  assert.equal(shouldHint(s, 'src/foo', 1000), false);
});

test('shouldHint: 4 reads do NOT hint (threshold = 5)', () => {
  const s = { by_dir: {} };
  for (let i = 0; i < 4; i++) recordRead(s, 'src/foo', 1000 + i);
  assert.equal(shouldHint(s, 'src/foo', 1004), false);
});

test('shouldHint: 5th read DOES hint', () => {
  const s = { by_dir: {} };
  for (let i = 0; i < 5; i++) recordRead(s, 'src/foo', 1000 + i);
  assert.equal(shouldHint(s, 'src/foo', 1004), true);
});

test('shouldHint: cooldown suppresses re-fire', () => {
  const s = { by_dir: {} };
  for (let i = 0; i < 6; i++) recordRead(s, 'src/foo', 1000 + i);
  markHint(s, 'src/foo', 1005);
  // 1 sec later — still in cooldown
  recordRead(s, 'src/foo', 1005 + 1000);
  assert.equal(shouldHint(s, 'src/foo', 1005 + 1000), false);
});

test('shouldHint: past cooldown re-fires', () => {
  const s = { by_dir: {} };
  for (let i = 0; i < 5; i++) recordRead(s, 'src/foo', 1000 + i);
  markHint(s, 'src/foo', 1005);
  // COOLDOWN_MS + 1 later, plus one more read
  const after = 1005 + COOLDOWN_MS + 1;
  recordRead(s, 'src/foo', after);
  assert.equal(shouldHint(s, 'src/foo', after), true);
});

test('shouldHint: different dirs tracked independently', () => {
  const s = { by_dir: {} };
  for (let i = 0; i < 5; i++) recordRead(s, 'src/foo', 1000 + i);
  for (let i = 0; i < 2; i++) recordRead(s, 'src/bar', 2000 + i);
  assert.equal(shouldHint(s, 'src/foo', 1005), true);
  assert.equal(shouldHint(s, 'src/bar', 2002), false);
});

test('shouldHint: unknown dir returns false', () => {
  const s = { by_dir: {} };
  assert.equal(shouldHint(s, 'src/unseen', 1000), false);
});

test('shouldHint: empty dir returns false', () => {
  const s = { by_dir: {} };
  assert.equal(shouldHint(s, '', 1000), false);
});

// ── buildHint ───────────────────────────────────────────────────────

test('buildHint: contains the directory + module_overview tool', () => {
  const out = buildHint('src/storage');
  assert.match(out, /src\/storage/);
  assert.match(out, /module_overview|overview/);
});

test('buildHint: stays under 300 bytes (single-line budget)', () => {
  assert.ok(buildHint('src/storage').length < 300,
    `hint length ${buildHint('src/storage').length} exceeds budget`);
});

test('buildHint: starts with [code-graph]', () => {
  assert.match(buildHint('any/dir'), /^\[code-graph\]/);
});

test('buildHint: single line (no embedded newlines)', () => {
  const out = buildHint('src/foo');
  // Trailing newline is added by the caller; the function itself should not embed any.
  assert.equal(out.indexOf('\n'), -1, `hint contains newline: ${JSON.stringify(out)}`);
});

// ── isSilenced ──────────────────────────────────────────────────────

test('isSilenced: default (no env) → not silenced', () => {
  assert.equal(isSilenced({}), false);
});

test('isSilenced: CODE_GRAPH_QUIET_HOOKS=1 → silenced', () => {
  assert.equal(isSilenced({ CODE_GRAPH_QUIET_HOOKS: '1' }), true);
});

test('isSilenced: CODE_GRAPH_QUIET_HOOKS=0 → not silenced', () => {
  assert.equal(isSilenced({ CODE_GRAPH_QUIET_HOOKS: '0' }), false);
});

// ── State load / save / TTL pruning ─────────────────────────────────

function tmpCwd() {
  // Synthesize a unique cwd path so different test runs don't share state.
  const id = crypto.randomBytes(8).toString('hex');
  return `/nonexistent-test-cwd-${id}`;
}

test('loadState: missing file returns empty state', () => {
  const cwd = tmpCwd();
  const s = loadState(cwd);
  assert.deepEqual(s, { by_dir: {} });
});

test('loadState + saveState: round-trip preserves by_dir', () => {
  const cwd = tmpCwd();
  const s1 = { by_dir: { 'src/foo': { reads: 3, last_read_at: 1000, last_hint_at: 0 } } };
  saveState(cwd, s1);
  const s2 = loadState(cwd, 1000);
  assert.equal(s2.by_dir['src/foo'].reads, 3);
  // Cleanup
  try { fs.unlinkSync(statePath(cwd)); } catch { /* ok */ }
});

test('loadState: entries older than STATE_TTL_MS are pruned', () => {
  const cwd = tmpCwd();
  const old = { by_dir: {
    'src/fresh': { reads: 2, last_read_at: 10_000, last_hint_at: 0 },
    'src/stale': { reads: 9, last_read_at: 0,       last_hint_at: 0 },
  }};
  saveState(cwd, old);
  const now = STATE_TTL_MS + 100;  // way past TTL for the stale entry
  const loaded = loadState(cwd, now);
  assert.ok(loaded.by_dir['src/fresh'], 'fresh entry kept');
  assert.equal(loaded.by_dir['src/stale'], undefined, 'stale entry pruned');
  try { fs.unlinkSync(statePath(cwd)); } catch { /* ok */ }
});

test('loadState: malformed JSON returns empty state', () => {
  const cwd = tmpCwd();
  const p = statePath(cwd);
  fs.writeFileSync(p, 'not json {{{', 'utf8');
  const s = loadState(cwd);
  assert.deepEqual(s, { by_dir: {} });
  try { fs.unlinkSync(p); } catch { /* ok */ }
});

// ── Integrated flow ─────────────────────────────────────────────────

test('flow: 5 reads to same dir → hint, 6th read same dir → no hint (cooldown)', () => {
  const s = { by_dir: {} };
  // Reads 1-4: no hint
  for (let i = 0; i < 4; i++) {
    recordRead(s, 'src/foo', 1000 + i);
    assert.equal(shouldHint(s, 'src/foo', 1000 + i), false, `read ${i+1} should not hint`);
  }
  // Read 5: hint
  recordRead(s, 'src/foo', 1004);
  assert.equal(shouldHint(s, 'src/foo', 1004), true);
  markHint(s, 'src/foo', 1004);
  // Read 6 within cooldown: no hint
  recordRead(s, 'src/foo', 1005);
  assert.equal(shouldHint(s, 'src/foo', 1005), false);
});
