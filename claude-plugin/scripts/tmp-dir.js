#!/usr/bin/env node
'use strict';
// Shared temp-dir helper for hook + auto-update scripts.
//
// Why this exists: Claude Code overrides $TMPDIR to ~/.claude/tmp/ so it can
// capture process stdout for transcript replay. That makes `os.tmpdir()`
// resolve to the same directory that holds 9000+ transcript subdirs. Putting
// hook cooldown flags directly there has two failure modes:
//
//   1. Diagnostic blindness — every doc / memory / debug query that checks
//      `/tmp/.code-graph-bash-*` for hook firing returns empty even when the
//      hook is working perfectly. v0.32.0's "PreToolUse dark under green
//      health" investigation chased this red herring for ~2 hours before the
//      $TMPDIR override was identified.
//   2. §8 SAFETY recursive-traversal trap — `~/.claude/tmp/<id>.output` is
//      where CC writes captured process output; scattering 0-byte flag files
//      alongside them amplifies the "grep -r ~/.claude/tmp/" footgun.
//
// Fix: pin all hook + auto-update artifacts to a `code-graph-mcp/` subdir of
// whatever `os.tmpdir()` resolves to. Contained, deterministic, easy to GC.
const fs = require('fs');
const os = require('os');
const path = require('path');

const CG_TMP_DIR = path.join(os.tmpdir(), 'code-graph-mcp');

function cgTmpDir() {
  try { fs.mkdirSync(CG_TMP_DIR, { recursive: true }); } catch { /* ok */ }
  return CG_TMP_DIR;
}

module.exports = { cgTmpDir, CG_TMP_DIR };
