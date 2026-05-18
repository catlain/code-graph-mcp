'use strict';
const path = require('path');
const os = require('os');

// Resolve Claude Code's config directory. Honors CLAUDE_CONFIG_DIR — when set
// (commonly used to keep multiple accounts isolated, e.g. personal vs work),
// Claude Code reads `settings.json`, `plugins/`, `projects/`, etc. from there
// instead of `~/.claude/`. Our plugin must follow the same override so its
// hook registrations, statusline, adoption files, and cache cleanup land in
// the directory Claude Code is actually using.
//
// Read fresh on every call so per-process env mutation (tests, child procs
// spawned with a different env) takes effect immediately. Unlike
// CLAUDE_PLUGIN_ROOT (which leaks across plugins — see
// feedback_plugin_env_isolation.md), CLAUDE_CONFIG_DIR is user-set and
// process-wide, so reading it is safe.
function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

module.exports = { claudeHome };
