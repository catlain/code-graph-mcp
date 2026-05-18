'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const { claudeHome } = require('./claude-config');

test('claudeHome defaults to ~/.claude when CLAUDE_CONFIG_DIR unset', () => {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    assert.strictEqual(claudeHome(), path.join(os.homedir(), '.claude'));
  } finally {
    if (prev !== undefined) process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

test('claudeHome honors CLAUDE_CONFIG_DIR when set', () => {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = '/tmp/work-claude';
  try {
    assert.strictEqual(claudeHome(), '/tmp/work-claude');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

test('claudeHome re-reads env on every call (not cached)', () => {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    const before = claudeHome();
    process.env.CLAUDE_CONFIG_DIR = '/tmp/account-A';
    const during = claudeHome();
    delete process.env.CLAUDE_CONFIG_DIR;
    const after = claudeHome();
    assert.strictEqual(before, path.join(os.homedir(), '.claude'));
    assert.strictEqual(during, '/tmp/account-A');
    assert.strictEqual(after, path.join(os.homedir(), '.claude'));
  } finally {
    if (prev !== undefined) process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

test('claudeHome ignores empty CLAUDE_CONFIG_DIR (falls back to ~/.claude)', () => {
  // Empty string is falsy in JS — sanity-check the `||` fallback path so an
  // accidentally `CLAUDE_CONFIG_DIR=` (unset-style) shell line does not strand
  // us writing to the literal repository root `/`.
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = '';
  try {
    assert.strictEqual(claudeHome(), path.join(os.homedir(), '.claude'));
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});
