'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Regression gate for v0.31.1: hooks.json matchers must be Claude Code's
// literal/regex form, NOT the expression DSL `tool == "X"`. The earlier
// matchers parsed as regex against tool names, never matched anything,
// and left every PreToolUse hook silently inert from v0.25.0 through
// v0.31.0. The bug was invisible to the existing unit tests because they
// spawn the hook scripts directly via stdin, bypassing Claude Code's
// matcher dispatch.

const HOOKS_JSON = path.resolve(__dirname, '..', 'hooks', 'hooks.json');

function loadHooks() {
  const raw = fs.readFileSync(HOOKS_JSON, 'utf8');
  return JSON.parse(raw);
}

function* iterMatchers(hooksByEvent) {
  for (const [event, entries] of Object.entries(hooksByEvent || {})) {
    if (!Array.isArray(entries)) continue;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      yield { event, idx: i, matcher: e && e.matcher };
    }
  }
}

test('hooks.json: file parses as JSON', () => {
  assert.doesNotThrow(loadHooks);
});

test('hooks.json: every entry has a string matcher', () => {
  const cfg = loadHooks();
  let count = 0;
  for (const { event, idx, matcher } of iterMatchers(cfg.hooks)) {
    assert.equal(typeof matcher, 'string',
      `hooks.${event}[${idx}].matcher should be a string, got ${typeof matcher}`);
    count++;
  }
  assert.ok(count > 0, 'expected at least one matcher in hooks.json');
});

// The actual regression gate. Each banned token reflects a specific
// failure mode we hit and want to keep out forever.
const BANNED_TOKENS = [
  // The original v0.25.0 → v0.31.0 bug: expression-style matcher treated
  // as regex against tool name → never matched.
  { token: '==', why: 'expression DSL (e.g. `tool == "Edit"`) is not supported; use literal tool name' },
  // `tool ==` or `tool name == "X"` — same family, different spelling.
  { token: 'tool ', why: 'expression DSL with `tool` variable is not supported' },
  // Boolean ORs as expression operators (regex uses `|`, not `||`).
  { token: '||', why: 'use `|` for pipe-list (e.g. `Write|Edit`), not `||`' },
  // Boolean AND has no meaning in tool-name matching.
  { token: '&&', why: '`&&` has no meaning in matchers' },
  // Double-quotes inside the matcher are a strong hint of expression DSL
  // (the broken syntax was `"tool == \"Edit\""`).
  { token: '"', why: 'literal double-quote in matcher is almost always a copy-paste of expression DSL' },
];

test('hooks.json: matchers avoid banned expression-DSL tokens', () => {
  const cfg = loadHooks();
  const offenders = [];
  for (const { event, idx, matcher } of iterMatchers(cfg.hooks)) {
    for (const { token, why } of BANNED_TOKENS) {
      if (matcher.includes(token)) {
        offenders.push(`hooks.${event}[${idx}].matcher = ${JSON.stringify(matcher)} — contains banned ${JSON.stringify(token)} (${why})`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    'hooks.json matcher syntax regression — see v0.31.1 CHANGELOG:\n  ' + offenders.join('\n  '));
});

// v0.32.0 architecture: plugin-cache hooks.json ONLY carries SessionStart.
// PreToolUse / PostToolUse / UserPromptSubmit are registered into
// ~/.claude/settings.json by lifecycle.js (current Claude Code silently
// ignores plugin-cache hooks.json entries for those events — confirmed
// 2026-05-24 via session jsonl, see feedback_pretooluse_dark_under_green_health.md).
test('hooks.json: contains SessionStart only (v0.32.0)', () => {
  const cfg = loadHooks();
  assert.deepEqual(Object.keys(cfg.hooks || {}), ['SessionStart'],
    'plugin-cache hooks.json must contain only SessionStart; other events go via settings.json. ' +
    'Adding entries here for PreToolUse/PostToolUse/UserPromptSubmit would be dead config — CC does not load them.');
});

test('hooks.json: SessionStart wires session-init.js', () => {
  const cfg = loadHooks();
  const entries = (cfg.hooks && cfg.hooks.SessionStart) || [];
  assert.ok(entries.length > 0, 'SessionStart entry missing');
  const cmd = entries[0].hooks && entries[0].hooks[0] && entries[0].hooks[0].command;
  assert.match(cmd || '', /session-init\.js/);
});

// Cross-validate that lifecycle.js's buildSettingsHookEntries covers the
// matchers we removed from hooks.json — keeps the migration whole. If a
// future refactor accidentally drops a matcher in one place, this fails.
test('lifecycle.buildSettingsHookEntries covers PreToolUse Edit/Bash/Read', () => {
  const { buildSettingsHookEntries } = require('./lifecycle');
  const desired = buildSettingsHookEntries();
  const ptu = (desired.PreToolUse || []).map(e => e.matcher);
  for (const tool of ['Edit', 'Bash', 'Read']) {
    assert.ok(ptu.includes(tool), `lifecycle.js PreToolUse missing matcher: ${tool}; got ${JSON.stringify(ptu)}`);
  }
});

test('lifecycle.buildSettingsHookEntries covers PostToolUse Write|Edit + UserPromptSubmit', () => {
  const { buildSettingsHookEntries } = require('./lifecycle');
  const desired = buildSettingsHookEntries();
  const postMatchers = (desired.PostToolUse || []).map(e => e.matcher);
  assert.ok(postMatchers.some(m => m === 'Write|Edit'),
    `PostToolUse must have 'Write|Edit' matcher; got ${JSON.stringify(postMatchers)}`);
  const upsMatchers = (desired.UserPromptSubmit || []).map(e => e.matcher);
  assert.ok(upsMatchers.length > 0, 'UserPromptSubmit must have at least one matcher');
});

test('lifecycle.buildSettingsHookEntries: every entry carries description marker', () => {
  // Description marker is the primary cleanup discriminator (immune to
  // path/env pollution per feedback_plugin_env_isolation.md). If an entry
  // lacks a description, isOurHookEntry falls back to path-fragment match
  // which is less reliable. Force every entry to have one.
  const { buildSettingsHookEntries } = require('./lifecycle');
  const desired = buildSettingsHookEntries();
  for (const [event, entries] of Object.entries(desired)) {
    for (let i = 0; i < entries.length; i++) {
      assert.ok(entries[i].description && entries[i].description.includes('[code-graph-mcp'),
        `${event}[${i}] missing or malformed description marker`);
    }
  }
});

test('lifecycle.buildSettingsHookEntries: hook commands use absolute paths (no env vars)', () => {
  // settings.json hook commands run with env pollution risk
  // (feedback_plugin_env_isolation.md). Paths MUST be absolute, derived
  // from __dirname, never from ${CLAUDE_PLUGIN_ROOT}.
  const { buildSettingsHookEntries } = require('./lifecycle');
  const desired = buildSettingsHookEntries();
  for (const entries of Object.values(desired)) {
    for (const e of entries) {
      for (const h of e.hooks) {
        assert.ok(!h.command.includes('${CLAUDE_PLUGIN_ROOT}'),
          `command must not use \${CLAUDE_PLUGIN_ROOT}: ${h.command}`);
        assert.ok(h.command.startsWith('node "/') || h.command.match(/node "[A-Z]:\\/),
          `command path must be absolute: ${h.command}`);
      }
    }
  }
});
