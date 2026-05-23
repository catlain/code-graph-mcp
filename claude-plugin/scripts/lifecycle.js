#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { claudeHome } = require('./claude-config');

const PLUGIN_ID = 'code-graph-mcp@code-graph-mcp';
const OLD_PLUGIN_IDS = [
  'code-graph@sdsrss',           // v1 legacy ID
  'code-graph@sdsrss-code-graph', // v2 legacy ID (pre-rename)
];
const MARKETPLACE_NAME = 'code-graph-mcp';
const CACHE_DIR = path.join(os.homedir(), '.cache', 'code-graph');
// Always derive from __dirname — CLAUDE_PLUGIN_ROOT env var can leak from other
// plugins when hooks run in shared process context (e.g. claude-mem-lite sets it
// to its own marketplace path, polluting all subsequent settings.json hook processes).
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const MANIFEST_FILE = path.join(CACHE_DIR, 'install-manifest.json');
const REGISTRY_FILE = path.join(CACHE_DIR, 'statusline-registry.json');

// Lazy resolvers — Claude Code's config dir can be overridden by CLAUDE_CONFIG_DIR
// (multi-account isolation). Re-read every call so test subprocesses with a
// different env see the right path.
function settingsPath() { return path.join(claudeHome(), 'settings.json'); }
function installedPluginsPath() { return path.join(claudeHome(), 'plugins', 'installed_plugins.json'); }
// Durable mirror outside ~/.cache/ — survives cache cleanup. Captures the
// `_previous` snapshot (pre-install statusline) and any third-party providers
// (GSD, etc.). readRegistry() self-heals from this file when primary is missing.
function providersBackupFile() { return path.join(claudeHome(), 'statusline-providers.json'); }
function pluginsCacheDir() { return path.join(claudeHome(), 'plugins', 'cache'); }

// --- Helpers ---

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, filePath);
}

function readManifest() {
  return readJson(MANIFEST_FILE) || { version: null, config: {} };
}

function writeManifest(manifest) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  writeJsonAtomic(MANIFEST_FILE, manifest);
}

function getPluginVersion() {
  const pj = readJson(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'));
  return pj ? pj.version : '0.0.0';
}

function compositeCommand() {
  return `node ${JSON.stringify(path.join(PLUGIN_ROOT, 'scripts', 'statusline-composite.js'))}`;
}

function codeGraphStatuslineCommand() {
  return `node ${JSON.stringify(path.join(PLUGIN_ROOT, 'scripts', 'statusline.js'))}`;
}

function hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function hasInstalledPluginRecord() {
  const installed = readJson(installedPluginsPath());
  return !!(installed && installed.plugins && Array.isArray(installed.plugins[PLUGIN_ID]) && installed.plugins[PLUGIN_ID].length > 0);
}

function isOurComposite(settings) {
  return settings.statusLine &&
    settings.statusLine.command &&
    settings.statusLine.command.includes('statusline-composite');
}

// --- StatusLine Registry ---
// Multiple providers can register. The composite script runs them all.

function readRegistry() {
  const primary = readJson(REGISTRY_FILE);
  if (primary && Array.isArray(primary) && primary.length > 0) return primary;
  // Self-heal: primary missing or empty (e.g. user cleaned ~/.cache/code-graph/).
  // Durable backup in ~/.claude/ retains `_previous` + third-party providers.
  const backup = readJson(providersBackupFile());
  if (backup && Array.isArray(backup) && backup.length > 0) {
    try { writeJsonAtomic(REGISTRY_FILE, backup); } catch { /* ok */ }
    return backup;
  }
  return [];
}

function writeRegistry(registry) {
  if (!registry || registry.length === 0) {
    try { fs.unlinkSync(REGISTRY_FILE); } catch { /* ok */ }
    try { fs.unlinkSync(providersBackupFile()); } catch { /* ok */ }
    return;
  }
  writeJsonAtomic(REGISTRY_FILE, registry);
  // Mirror to durable location so cache cleanup doesn't strand `_previous`
  // or third-party provider entries.
  try { writeJsonAtomic(providersBackupFile(), registry); } catch { /* ok */ }
}

function registerStatuslineProvider(id, command, needsStdin) {
  const registry = readRegistry();
  const idx = registry.findIndex(p => p.id === id);
  const entry = { id, command, needsStdin: !!needsStdin };
  if (idx >= 0) {
    // Update existing entry only if command changed
    if (registry[idx].command === command) return false;
    registry[idx] = entry;
  } else {
    registry.push(entry);
  }
  writeRegistry(registry);
  return true;
}

function unregisterStatuslineProvider(id) {
  const registry = readRegistry();
  const filtered = registry.filter(p => p.id !== id);
  if (filtered.length === registry.length) return false;
  writeRegistry(filtered);
  return true;
}

function isPluginExplicitlyDisabled(settings = readJson(settingsPath()) || {}) {
  return hasOwn(settings.enabledPlugins, PLUGIN_ID) && settings.enabledPlugins[PLUGIN_ID] === false;
}

function isPluginInactive(settings = readJson(settingsPath()) || {}) {
  if (isPluginExplicitlyDisabled(settings)) return true;

  const hasComposite = isOurComposite(settings);
  const hasCodeGraphRegistry = readRegistry().some((provider) => provider.id === 'code-graph');
  if (!hasComposite && !hasCodeGraphRegistry) return false;

  const installed = readJson(installedPluginsPath());
  if (!installed || !installed.plugins) return false;
  return !hasInstalledPluginRecord();
}

function detachStatuslineIntegration(settings) {
  let settingsChanged = false;

  unregisterStatuslineProvider('code-graph');
  const previous = readRegistry().find(p => p.id === '_previous' && p.command);

  // If our composite is still configured while the plugin is disabled/uninstalled,
  // prefer restoring the prior statusline (or removing ours entirely) so the plugin
  // truly stops affecting Claude Code.
  if (isOurComposite(settings)) {
    if (previous) {
      settings.statusLine = { type: 'command', command: previous.command };
    } else {
      delete settings.statusLine;
    }
    settingsChanged = true;
  }

  unregisterStatuslineProvider('_previous');
  return settingsChanged;
}

function cleanupDisabledStatusline() {
  const settings = readJson(settingsPath());
  if (!settings || !isPluginInactive(settings)) {
    return { cleaned: false, settingsChanged: false };
  }

  let settingsChanged = detachStatuslineIntegration(settings);
  if (removeHooksFromSettings(settings)) settingsChanged = true;
  if (settingsChanged) {
    writeJsonAtomic(settingsPath(), settings);
  }

  return { cleaned: true, settingsChanged };
}

// --- Scope Conflict Detection ---

function checkScopeConflict() {
  const installed = readJson(installedPluginsPath());
  if (!installed || !installed.plugins) return null;
  for (const [key, entries] of Object.entries(installed.plugins)) {
    if (key === PLUGIN_ID) continue;
    // Detect any old code-graph plugin IDs still installed
    if (key.startsWith('code-graph@') || key.startsWith('code-graph-mcp@')) {
      return { existingId: key, scope: entries[0] && entries[0].scope, entries };
    }
  }
  return null;
}

// --- Migration: clean up old plugin ID remnants ---

function migrateOldPluginIds(settings) {
  let changed = false;

  for (const oldId of OLD_PLUGIN_IDS) {
    // Clean old ID from enabledPlugins
    if (settings.enabledPlugins && oldId in settings.enabledPlugins) {
      delete settings.enabledPlugins[oldId];
      changed = true;
    }

    // Clean old ID from installed_plugins.json
    const installed = readJson(installedPluginsPath());
    if (installed && installed.plugins && oldId in installed.plugins) {
      delete installed.plugins[oldId];
      writeJsonAtomic(installedPluginsPath(), installed);
    }
  }

  // Clean old marketplace names from extraKnownMarketplaces
  if (settings.extraKnownMarketplaces) {
    for (const oldName of ['sdsrss-code-graph']) {
      if (oldName in settings.extraKnownMarketplaces) {
        delete settings.extraKnownMarketplaces[oldName];
        changed = true;
      }
    }
  }

  // Clean old cache paths
  const cacheRoot = pluginsCacheDir();
  const oldCacheDirs = [
    path.join(cacheRoot, 'sdsrss', 'code-graph'),
    path.join(cacheRoot, 'sdsrss-code-graph', 'code-graph'),
    path.join(cacheRoot, 'sdsrss-code-graph'),
  ];
  for (const dir of oldCacheDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  }

  return changed;
}

// --- Hook identity ---
//
// v0.32.0 ARCHITECTURE CORRECTION (see project_hooks_settings.md / feedback_pretooluse_dark_under_green_health.md):
//
// Empirical finding 2026-05-24: current Claude Code only loads SessionStart
// hooks from cache/<mp>/<plugin>/<ver>/hooks/hooks.json. PreToolUse, PostToolUse,
// UserPromptSubmit, Stop, SessionEnd entries in plugin-cache hooks.json are
// SILENTLY IGNORED. Only ~/.claude/settings.json entries reach CC for those events.
//
// Therefore lifecycle.js now ACTIVELY WRITES non-SessionStart hook entries to
// settings.json (with description markers for cleanup), and the shipped
// claude-plugin/hooks/hooks.json carries only SessionStart. SessionStart entries
// in claude-plugin/hooks/hooks.json continue to be CC-loaded as before.
//
// Pattern mirrors claude-mem-lite's install.mjs (cache hooks.json cleared
// to prevent duplicate registration).

const OUR_HOOK_SCRIPTS = [
  'session-init.js',
  'incremental-index.js',
  'user-prompt-context.js',
  'pre-edit-guide.js',
  'pre-grep-guide.js',   // v0.32.0 — was in plugin-cache only, never fired
  'pre-read-guide.js',   // v0.32.0 — was in plugin-cache only, never fired
];

// Description markers — primary cleanup discriminator (immune to env/path
// pollution per feedback_plugin_env_isolation.md). New v0.32.0 markers carry
// the version so older lifecycle.js still recognizes them as ours.
const SETTINGS_HOOK_DESC = {
  preToolUse:       '[code-graph-mcp v0.32+] PreToolUse re-routed via settings.json (cache hooks.json silently ignored for this event by current CC)',
  postToolUseEdit:  '[code-graph-mcp v0.32+] PostToolUse Write|Edit incremental-index update',
  userPromptSubmit: '[code-graph-mcp v0.32+] UserPromptSubmit context push',
};

const OUR_DESCRIPTIONS = [
  // Legacy v0.7.x / 0.8.x descriptions — kept so very-old installs still get cleaned up.
  'StatusLine self-heal, lifecycle sync, project map injection',
  'Auto-inject impact analysis when editing functions with 2+ callers',
  'Auto-update code graph index after file edits',
  'Inject code-graph structural context based on user intent',
  // v0.32.0 — new re-route markers
  SETTINGS_HOOK_DESC.preToolUse,
  SETTINGS_HOOK_DESC.postToolUseEdit,
  SETTINGS_HOOK_DESC.userPromptSubmit,
];

function isOurHookEntry(entry) {
  if (!entry || !entry.hooks) return false;
  // Primary: match by description (immune to path pollution).
  if (entry.description && OUR_DESCRIPTIONS.includes(entry.description)) return true;
  // Fallback: script name + MARKETPLACE_NAME in path. v0.32.1: tightened from
  // bare 'code-graph' (which would claim a user's own ~/code-graph/foo.js) to
  // the actual marketplace dir name 'code-graph-mcp' — Requirement 3 says
  // foreign-entry strip is unacceptable, so be conservative.
  return entry.hooks.some(h =>
    h.command && OUR_HOOK_SCRIPTS.some(s => h.command.includes(s)) &&
    h.command.includes(MARKETPLACE_NAME)
  );
}

function removeHooksFromSettings(settings) {
  if (!settings.hooks) return false;
  let changed = false;

  for (const event of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[event])) continue;
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter(e => !isOurHookEntry(e));
    if (settings.hooks[event].length !== before) changed = true;
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  return changed;
}

// --- v0.32.0: settings.json hook registration ---

// PLUGIN_ROOT (module-level, line 18) is the canonical __dirname-derived
// absolute path — never CLAUDE_PLUGIN_ROOT env (env leaks across plugins
// in settings.json hook execution context per feedback_plugin_env_isolation.md).

function buildSettingsHookEntries() {
  const root = PLUGIN_ROOT;
  const scriptCmd = (name, timeout) => ({
    type: 'command',
    command: `node "${path.join(root, 'scripts', name)}"`,
    timeout,
  });

  return {
    PreToolUse: [
      { description: SETTINGS_HOOK_DESC.preToolUse, matcher: 'Edit', hooks: [scriptCmd('pre-edit-guide.js', 4)] },
      { description: SETTINGS_HOOK_DESC.preToolUse, matcher: 'Bash', hooks: [scriptCmd('pre-grep-guide.js', 3)] },
      { description: SETTINGS_HOOK_DESC.preToolUse, matcher: 'Read', hooks: [scriptCmd('pre-read-guide.js', 3)] },
    ],
    PostToolUse: [
      { description: SETTINGS_HOOK_DESC.postToolUseEdit, matcher: 'Write|Edit', hooks: [scriptCmd('incremental-index.js', 10)] },
    ],
    UserPromptSubmit: [
      { description: SETTINGS_HOOK_DESC.userPromptSubmit, matcher: '', hooks: [scriptCmd('user-prompt-context.js', 5)] },
    ],
  };
}

// Idempotent two-pass: (1) evict ALL our entries (legacy v0.7+/0.8+ markers
// AND v0.32+ markers) across EVERY event — catches legacy SessionStart/
// PostToolUse entries in settings.json pointing to stale plugin-cache paths;
// (2) write fresh v0.32+ entries for the events we own. SessionStart stays
// in plugin-cache hooks.json (it's still loaded from there), so we don't
// re-write it to settings.json.
function registerHooksToSettings(settings) {
  settings.hooks = settings.hooks || {};
  const before = JSON.stringify(settings.hooks);

  // Pass 1: evict our entries across every event.
  for (const event of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[event])) continue;
    settings.hooks[event] = settings.hooks[event].filter(e => !isOurHookEntry(e));
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }

  // Pass 2: write fresh entries for our desired events.
  const desired = buildSettingsHookEntries();
  for (const [event, desiredEntries] of Object.entries(desired)) {
    const existing = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    settings.hooks[event] = [...existing, ...desiredEntries];
  }

  return before !== JSON.stringify(settings.hooks);
}

// --- Install (idempotent) ---

function install() {
  const version = getPluginVersion();
  const manifest = readManifest();
  const settings = readJson(settingsPath()) || {};
  let settingsChanged = false;

  // 0. Migrate from old plugin IDs
  if (migrateOldPluginIds(settings)) {
    settingsChanged = true;
  }

  // 1. StatusLine — composite approach
  //    a. Capture existing statusline as a provider (if not already composite)
  //    b. Register code-graph as a provider
  //    c. Set statusLine to composite script
  if (!isOurComposite(settings)) {
    // Preserve existing statusline as first provider
    if (settings.statusLine && settings.statusLine.command) {
      registerStatuslineProvider('_previous', settings.statusLine.command, true);
    }
    // Set composite as the statusLine
    settings.statusLine = { type: 'command', command: compositeCommand() };
    settingsChanged = true;
    manifest.config.statusLine = true;
  } else {
    // Composite exists — ensure path is correct (may have been polluted by env leak)
    const cmd = compositeCommand();
    if (settings.statusLine.command !== cmd) {
      settings.statusLine.command = cmd;
      settingsChanged = true;
    }
  }

  // Register code-graph provider
  registerStatuslineProvider('code-graph', codeGraphStatuslineCommand(), false);

  // 2. Hooks — v0.32.0: actively write PreToolUse/PostToolUse/UserPromptSubmit
  //    to settings.json. Plugin-cache hooks.json is silently ignored by current
  //    Claude Code for these events (SessionStart still loads from cache).
  //    registerHooksToSettings is idempotent: strips priors then appends fresh.
  const hooksRegistered = registerHooksToSettings(settings);
  if (hooksRegistered) settingsChanged = true;

  // NOTE: enabledPlugins is managed by Claude Code's plugin system, not by lifecycle.
  // Do NOT add enabledPlugins entries here — it causes phantom plugin entries
  // when the ID doesn't match the marketplace name.

  // 3. Write settings atomically if changed
  if (settingsChanged) {
    writeJsonAtomic(settingsPath(), settings);
  }

  // 4. Write manifest with version
  manifest.version = version;
  manifest.installedAt = manifest.installedAt || new Date().toISOString();
  manifest.updatedAt = new Date().toISOString();
  writeManifest(manifest);

  return { version, settingsChanged, statusLineClaimed: manifest.config.statusLine, hooksRegistered };
}

// --- Uninstall (clean all config) ---

function uninstall() {
  const settings = readJson(settingsPath());
  let settingsChanged = false;

  if (settings) {
    // 1. StatusLine: remove code-graph integration and restore prior statusline.
    if (detachStatuslineIntegration(settings)) {
      settingsChanged = true;
    }

    // 2. Hooks: remove from settings.json
    if (removeHooksFromSettings(settings)) {
      settingsChanged = true;
    }

    // 3. Remove all known IDs from enabledPlugins
    if (settings.enabledPlugins) {
      for (const id of [PLUGIN_ID, ...OLD_PLUGIN_IDS]) {
        if (id in settings.enabledPlugins) {
          delete settings.enabledPlugins[id];
          settingsChanged = true;
        }
      }
    }

    // 4. Write settings if changed
    if (settingsChanged) {
      writeJsonAtomic(settingsPath(), settings);
    }
  }

  // 5. Remove all known IDs from installed_plugins.json
  const installedPlugins = readJson(installedPluginsPath());
  if (installedPlugins && installedPlugins.plugins) {
    let ipChanged = false;
    for (const id of [PLUGIN_ID, ...OLD_PLUGIN_IDS]) {
      if (id in installedPlugins.plugins) {
        delete installedPlugins.plugins[id];
        ipChanged = true;
      }
    }
    if (ipChanged) writeJsonAtomic(installedPluginsPath(), installedPlugins);
  }

  // 6. Remove cache directory
  try { fs.rmSync(CACHE_DIR, { recursive: true, force: true }); } catch { /* ok */ }

  // 7. Remove plugin files from cache (all known paths, including parent dirs)
  const cacheRoot = pluginsCacheDir();
  const pluginCacheDirs = [
    path.join(cacheRoot, MARKETPLACE_NAME),
    path.join(cacheRoot, 'sdsrss-code-graph'),
    path.join(cacheRoot, 'sdsrss', 'code-graph'),
  ];
  for (const dir of pluginCacheDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  }

  return { settingsChanged };
}

// --- Update (refresh config points) ---

function update() {
  const version = getPluginVersion();
  const manifest = readManifest();
  const oldVersion = manifest.version;
  const settings = readJson(settingsPath()) || {};
  let settingsChanged = false;

  // 0. Migrate from old plugin IDs
  if (migrateOldPluginIds(settings)) {
    settingsChanged = true;
  }

  // 1. Update composite command path if version changed
  if (isOurComposite(settings)) {
    const cmd = compositeCommand();
    if (settings.statusLine.command !== cmd) {
      settings.statusLine.command = cmd;
      settingsChanged = true;
    }
  }

  // 2. Update code-graph provider in registry
  registerStatuslineProvider('code-graph', codeGraphStatuslineCommand(), false);

  // 3. Hooks — v0.32.0: register PreToolUse/PostToolUse/UserPromptSubmit in
  //    settings.json (idempotent; absolute paths re-anchor on every update).
  const hooksRegistered = registerHooksToSettings(settings);
  if (hooksRegistered) settingsChanged = true;

  // NOTE: enabledPlugins is managed by Claude Code's plugin system, not by lifecycle.

  // 4. Write settings if changed
  if (settingsChanged) {
    writeJsonAtomic(settingsPath(), settings);
  }

  // 5. Clear update-check cache (force re-check after update)
  const updateCache = path.join(CACHE_DIR, 'update-check');
  try { fs.unlinkSync(updateCache); } catch { /* ok */ }

  // 6. Update manifest
  manifest.version = version;
  manifest.updatedAt = new Date().toISOString();
  writeManifest(manifest);

  // 7. Clean up old cached versions (keep latest 3). Claude Code only fires
  //    hooks from the active version (per installed_plugins.json), so older
  //    cache dirs are inert disk clutter, not correctness risks.
  cleanupOldCacheVersions(3);

  return { oldVersion, version, settingsChanged, hooksRegistered };
}

/**
 * Remove old plugin cache versions, keeping the N most recent.
 * Cache layout: ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/
 */
function cleanupOldCacheVersions(keep = 3) {
  const cacheParent = path.join(pluginsCacheDir(), MARKETPLACE_NAME);
  try {
    // List all subdirectories under the marketplace cache
    const entries = fs.readdirSync(cacheParent, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pluginDir = path.join(cacheParent, entry.name);
      try {
        const versions = fs.readdirSync(pluginDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => ({
            name: d.name,
            path: path.join(pluginDir, d.name),
            mtime: fs.statSync(path.join(pluginDir, d.name)).mtimeMs,
          }))
          .sort((a, b) => b.mtime - a.mtime); // newest first

        if (versions.length <= keep) continue;

        const toRemove = versions.slice(keep);
        for (const v of toRemove) {
          try {
            fs.rmSync(v.path, { recursive: true, force: true });
          } catch { /* permission error or in-use — skip */ }
        }
      } catch { /* can't read plugin dir — skip */ }
    }
  } catch { /* cache dir doesn't exist — nothing to clean */ }
}

// --- Health Check ---
// Validates all registered paths in settings.json point to existing scripts.
// Returns { healthy, issues, repaired }.

function healthCheck() {
  const settings = readJson(settingsPath()) || {};
  const issues = [];

  // Check statusLine path
  if (isOurComposite(settings)) {
    const m = settings.statusLine.command.match(/node\s+"([^"]+)"/);
    if (m && m[1] && !fs.existsSync(m[1])) {
      issues.push({ type: 'statusLine', path: m[1] });
    }
  }

  // Check hook paths
  if (settings.hooks) {
    for (const [event, entries] of Object.entries(settings.hooks)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!isOurHookEntry(entry) || !entry.hooks) continue;
        for (const h of entry.hooks) {
          const m = h.command && h.command.match(/node\s+"([^"]+)"/);
          if (m && m[1] && !fs.existsSync(m[1])) {
            issues.push({ type: 'hook', event, path: m[1] });
          }
        }
      }
    }
  }

  // Check registry paths
  const registry = readRegistry();
  for (const provider of registry) {
    if (provider.id === '_previous') continue;
    const m = provider.command && provider.command.match(/node\s+"([^"]+)"/);
    if (m && m[1] && !fs.existsSync(m[1])) {
      issues.push({ type: 'registry', id: provider.id, path: m[1] });
    }
  }

  // Auto-repair if issues found
  let repaired = false;
  if (issues.length > 0) {
    install();
    repaired = true;
  }

  return { healthy: issues.length === 0, issues, repaired };
}

module.exports = {
  install, uninstall, update, healthCheck, checkScopeConflict,
  isPluginExplicitlyDisabled, isPluginInactive, cleanupDisabledStatusline,
  readManifest, readJson, writeJsonAtomic,
  readRegistry, writeRegistry,
  getPluginVersion, cleanupOldCacheVersions,
  removeHooksFromSettings, isOurHookEntry,
  registerHooksToSettings, buildSettingsHookEntries,                  // v0.32.0
  SETTINGS_HOOK_DESC, OUR_HOOK_SCRIPTS, OUR_DESCRIPTIONS,              // v0.32.0 — for tests
  PLUGIN_ROOT,                                                         // v0.32.1 — for tests / consumers
  registerStatuslineProvider, unregisterStatuslineProvider,
  PLUGIN_ID, OLD_PLUGIN_IDS, MARKETPLACE_NAME, CACHE_DIR, REGISTRY_FILE,
  settingsPath, installedPluginsPath, providersBackupFile, pluginsCacheDir,
};

// CLI: node lifecycle.js <install|uninstall|update|health>
if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'install') {
    const r = install();
    console.log(`Installed v${r.version} | settings=${r.settingsChanged} | statusLine=${r.statusLineClaimed}`);
  } else if (cmd === 'uninstall') {
    const r = uninstall();
    console.log(`Uninstalled | settings cleaned=${r.settingsChanged}`);
    console.log('  Note: also run `/plugin uninstall code-graph-mcp` inside Claude Code to sync its UI state.');
  } else if (cmd === 'update') {
    const r = update();
    console.log(`Updated ${r.oldVersion} → ${r.version} | settings=${r.settingsChanged}`);
  } else if (cmd === 'health') {
    const r = healthCheck();
    if (r.healthy) {
      console.log('Health: OK — all paths valid');
    } else {
      console.log(`Health: ${r.issues.length} issue(s) found${r.repaired ? ' — repaired' : ''}`);
      for (const issue of r.issues) {
        console.log(`  ${issue.type}: ${issue.path || issue.id}`);
      }
    }
  } else if (cmd === 'doctor') {
    const { runDoctor } = require('./doctor');
    const checkOnly = process.argv.includes('--check-only');
    const { issueCount } = runDoctor({ checkOnly });
    process.exit(issueCount > 0 ? 1 : 0);
  } else {
    console.error('Usage: lifecycle.js <install|uninstall|update|health|doctor>');
    process.exit(1);
  }
}
