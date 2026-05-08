#!/usr/bin/env node
'use strict';
/**
 * Tests for claude-plugin/scripts/mcp-launcher.js — the .mcp.json entry point
 * that resolves the binary (with auto-install fallbacks) and stdio-forwards
 * MCP JSON-RPC. install-e2e.test.js §4.3 covers find-binary in dev mode but
 * doesn't exercise the launcher's full chain (find → spawn → forward).
 *
 * The negative paths (no binary anywhere → npm install + GitHub fallback +
 * exit 1) are intentionally NOT covered here — the network-bound fallbacks
 * have ~150s timeouts and aren't deterministic in CI sandboxes. End-to-end
 * dev-mode coverage is the highest-leverage gap.
 *
 * Run: node --test claude-plugin/scripts/mcp-launcher.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..');
const LAUNCHER = path.join(__dirname, 'mcp-launcher.js');
const BINARY_NAME = process.platform === 'win32' ? 'code-graph-mcp.exe' : 'code-graph-mcp';
const REL_BINARY = path.join(REPO_ROOT, 'target', 'release', BINARY_NAME);

function hasBuiltBinary() {
  return fs.existsSync(REL_BINARY);
}

/**
 * Run the launcher, send one MCP message on stdin, collect stdout/stderr,
 * resolve once we either see a JSON-RPC response on stdout or hit timeout.
 */
function runLauncherInitialize(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [LAUNCHER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      cwd: REPO_ROOT,
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`launcher timed out after ${timeoutMs}ms; stdout=${stdout.slice(0, 400)} stderr=${stderr.slice(0, 400)}`));
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (stdout.includes('"result"') || stdout.includes('"error"')) {
        clearTimeout(timer);
        child.kill('SIGTERM');
        // Wait for the child to actually exit so the test doesn't leave an
        // orphan mid-write (matters on macOS / Windows where SIGTERM
        // delivery is less synchronous than on Linux).
        child.once('exit', () => resolve({ stdout, stderr }));
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });

    const initMsg = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'launcher-test', version: '1.0.0' },
      },
    });
    child.stdin.write(initMsg + '\n');
  });
}

test('mcp-launcher resolves dev binary and forwards MCP JSON-RPC stdin/stdout', async (t) => {
  if (!hasBuiltBinary()) {
    t.skip(`release binary missing at ${REL_BINARY} — run \`cargo build --release\` first`);
    return;
  }

  const { stdout, stderr } = await runLauncherInitialize();

  // Find the JSON-RPC line in the bytes the launcher forwarded from the binary.
  // Stderr may contain "[code-graph] ..." breadcrumbs from the launcher; those
  // are diagnostic and shouldn't break the contract that stdout carries protocol.
  const respLine = stdout.trim().split('\n').find((l) => l.includes('"result"'));
  assert.ok(respLine,
    `expected a JSON-RPC result line on launcher stdout, got: ${stdout.slice(0, 400)} | stderr: ${stderr.slice(0, 400)}`);
  const resp = JSON.parse(respLine);
  assert.equal(resp.jsonrpc, '2.0');
  assert.equal(resp.id, 1);
  assert.ok(resp.result.serverInfo, 'response must carry serverInfo from the binary');
  assert.equal(resp.result.serverInfo.name, 'code-graph-mcp');
});

test('mcp-launcher sets _FIND_BINARY_ROOT from __dirname (does not trust CLAUDE_PLUGIN_ROOT)', () => {
  // Static check: the source must derive _FIND_BINARY_ROOT from __dirname so a
  // sibling plugin's CLAUDE_PLUGIN_ROOT can't redirect us to the wrong binary.
  // Memory: feedback_plugin_env_isolation.md.
  const src = fs.readFileSync(LAUNCHER, 'utf8');
  assert.match(src, /_FIND_BINARY_ROOT\s*=\s*path\.resolve\(__dirname/,
    'launcher must derive _FIND_BINARY_ROOT from __dirname, not CLAUDE_PLUGIN_ROOT');
  // And must NOT read CLAUDE_PLUGIN_ROOT from env.
  assert.doesNotMatch(src, /process\.env\.CLAUDE_PLUGIN_ROOT/,
    'launcher must not trust CLAUDE_PLUGIN_ROOT — it can leak from sibling plugins');
});

test('mcp-launcher rejects executable-permission failure with platform-specific hint', () => {
  // Static check: the macOS quarantine guard must surface xattr/chmod fix
  // commands rather than silently failing on the spawn.
  const src = fs.readFileSync(LAUNCHER, 'utf8');
  assert.match(src, /accessSync\s*\(\s*binary\s*,\s*fs\.constants\.X_OK\s*\)/,
    'launcher must pre-check binary X_OK before spawn');
  assert.match(src, /xattr -d com\.apple\.quarantine/,
    'macOS guard must surface the xattr removal command in stderr');
});
