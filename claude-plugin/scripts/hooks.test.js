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

// Spot-check the matchers we expect to exist. Catches accidental deletion
// of a PreToolUse hook (the change that would silently disable all of
// today's lever-#1 work).
test('hooks.json: required hook events are wired up', () => {
  const cfg = loadHooks();
  const have = new Set(Object.keys(cfg.hooks || {}));
  for (const required of ['SessionStart', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit']) {
    assert.ok(have.has(required), `missing required event: ${required}`);
  }
});

test('hooks.json: PreToolUse covers Edit, Bash, Read', () => {
  const cfg = loadHooks();
  const entries = (cfg.hooks && cfg.hooks.PreToolUse) || [];
  const matchers = entries.map(e => e && e.matcher);
  for (const tool of ['Edit', 'Bash', 'Read']) {
    const found = matchers.some(m => m && (m === tool || m.split('|').includes(tool)));
    assert.ok(found, `PreToolUse missing matcher for tool: ${tool}; got ${JSON.stringify(matchers)}`);
  }
});
