#!/usr/bin/env node
// systemd MCP server for Claude Desktop (Linux).
// Pure Node, no npm deps. Read-only: list units, status, journal, failed units, unit files.
// https://github.com/LukeLamb/claude-systemd-mcp — MIT License.

'use strict';

const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

// ─── System-dep discovery ────────────────────────────────────────────────
function which(bin) {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
const BIN = {
  systemctl: which('systemctl'),
  journalctl: which('journalctl'),
};

// ─── Logging (stderr) ─────────────────────────────────────────────────────
function log(...args) {
  try {
    process.stderr.write('[systemd-mcp] ' + args.map(a =>
      typeof a === 'string' ? a : JSON.stringify(a)
    ).join(' ') + '\n');
  } catch (_) {}
}

// ─── JSON-RPC plumbing ────────────────────────────────────────────────────
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function respond(id, result) { send({ jsonrpc: '2.0', id, result }); }
function error(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined && { data }) } });
}
function textResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}
function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function requireSystemctl() {
  if (!BIN.systemctl) return 'systemctl is not installed (this server is Linux-only and requires systemd).';
  return null;
}
function requireJournalctl() {
  if (!BIN.journalctl) return 'journalctl is not installed (part of systemd).';
  return null;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts });
    let out = Buffer.alloc(0);
    let err = Buffer.alloc(0);
    child.stdout.on('data', (d) => { out = Buffer.concat([out, d]); });
    child.stderr.on('data', (d) => { err = Buffer.concat([err, d]); });
    child.on('error', (e) => resolve({ code: -1, stdout: '', stderr: e.message }));
    child.stdin.end();
    child.on('close', (code) => resolve({
      code,
      stdout: out.toString('utf8'),
      stderr: err.toString('utf8'),
    }));
  });
}

// Map our `scope` arg ("system" | "user") to the right systemctl/journalctl
// flag. Default is "system" — same default the CLI uses without flags.
function scopeFlag(args) {
  if (args && args.scope === 'user') return ['--user'];
  return [];
}

// systemd unit names contain '.', '-', '_', ':', '@', '\' and a few other
// chars. Reject only patterns that could leak shell injection — the bin
// is invoked via spawn (no shell) so this is belt-and-braces, but it
// cleanly catches typos.
function validUnitName(name) {
  if (typeof name !== 'string' || !name) return 'unit is required (non-empty string)';
  if (name.length > 256) return 'unit name too long (max 256)';
  if (/[\s;|&`$<>"']/.test(name)) return 'unit name contains forbidden characters';
  return null;
}

// Parse the multi-line Key=Value output of `systemctl show`. Some values
// span lines (rare), but `systemctl show` writes one property per line
// with the value already escaped, so a simple split works in practice.
function parseShow(text) {
  const out = {};
  for (const line of (text || '').split('\n')) {
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const k = line.slice(0, eq);
    const v = line.slice(eq + 1);
    out[k] = v;
  }
  return out;
}

// ─── Tool: list_units ─────────────────────────────────────────────────────
async function listUnits(args = {}) {
  const missing = requireSystemctl();
  if (missing) return errorResult(missing);
  const cmd = ['list-units', '--no-pager', '--no-legend', '--output=json', ...scopeFlag(args)];
  if (args.type) cmd.push(`--type=${args.type}`);
  if (args.state) cmd.push(`--state=${args.state}`);
  if (args.all === true) cmd.push('--all');
  const r = await run(BIN.systemctl, cmd);
  if (r.code !== 0) return errorResult(`systemctl list-units failed: ${r.stderr || r.stdout}`);
  let data;
  try { data = JSON.parse(r.stdout); } catch (e) {
    return errorResult(`could not parse list-units JSON: ${e.message}`);
  }
  return textResult({ scope: args.scope || 'system', count: data.length, units: data });
}

// ─── Tool: failed_units ───────────────────────────────────────────────────
async function failedUnits(args = {}) {
  return listUnits({ ...args, state: 'failed' });
}

// ─── Tool: unit_status ────────────────────────────────────────────────────
async function unitStatus(args = {}) {
  const missing = requireSystemctl();
  if (missing) return errorResult(missing);
  const bad = validUnitName(args.unit);
  if (bad) return errorResult(bad);

  const scope = scopeFlag(args);
  // is-active / is-enabled return non-zero exit codes for non-active /
  // disabled units, but they still print the state — capture stdout
  // regardless of exit code.
  const [activeR, enabledR, showR] = await Promise.all([
    run(BIN.systemctl, [...scope, 'is-active', args.unit]),
    run(BIN.systemctl, [...scope, 'is-enabled', args.unit]),
    run(BIN.systemctl, [...scope, 'show', args.unit, '--no-pager']),
  ]);

  const props = parseShow(showR.stdout);
  const recentLog = await tailJournalLines({
    unit: args.unit,
    scope: args.scope || 'system',
    lines: args.recent_log_lines || 20,
  });

  return textResult({
    unit: args.unit,
    scope: args.scope || 'system',
    active_state: (activeR.stdout || activeR.stderr || '').trim(),
    sub_state: props['SubState'] || null,
    load_state: props['LoadState'] || null,
    enabled_state: (enabledR.stdout || enabledR.stderr || '').trim(),
    main_pid: props['MainPID'] && props['MainPID'] !== '0' ? parseInt(props['MainPID'], 10) : null,
    exec_main_status: props['ExecMainStatus'] || null,
    n_restarts: props['NRestarts'] ? parseInt(props['NRestarts'], 10) : null,
    description: props['Description'] || null,
    fragment_path: props['FragmentPath'] || null,
    drop_in_paths: props['DropInPaths'] ? props['DropInPaths'].split(/\s+/).filter(Boolean) : [],
    recent_log: recentLog,
  });
}

async function tailJournalLines({ unit, scope, lines, since, priority }) {
  if (!BIN.journalctl) return [];
  const cmd = ['--no-pager', '-o', 'json', '-n', String(lines)];
  if (scope === 'user') cmd.push('--user');
  if (unit) {
    if (scope === 'user') cmd.push('--user-unit', unit);
    else cmd.push('-u', unit);
  }
  if (since) cmd.push('--since', since);
  if (priority) cmd.push('-p', String(priority));
  const r = await run(BIN.journalctl, cmd);
  if (r.code !== 0 && !r.stdout) return [];
  return r.stdout.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); }
    catch (_) { return null; }
  }).filter(Boolean).map((j) => ({
    timestamp: j.__REALTIME_TIMESTAMP
      ? new Date(parseInt(j.__REALTIME_TIMESTAMP, 10) / 1000).toISOString()
      : null,
    priority: j.PRIORITY ? parseInt(j.PRIORITY, 10) : null,
    unit: j._SYSTEMD_UNIT || j.UNIT || null,
    pid: j._PID ? parseInt(j._PID, 10) : null,
    message: j.MESSAGE || '',
  }));
}

// ─── Tool: unit_show ──────────────────────────────────────────────────────
async function unitShow(args = {}) {
  const missing = requireSystemctl();
  if (missing) return errorResult(missing);
  const bad = validUnitName(args.unit);
  if (bad) return errorResult(bad);
  const scope = scopeFlag(args);
  const r = await run(BIN.systemctl, [...scope, 'show', args.unit, '--no-pager']);
  if (r.code !== 0) return errorResult(`systemctl show failed: ${r.stderr || r.stdout}`);
  return textResult({
    unit: args.unit,
    scope: args.scope || 'system',
    properties: parseShow(r.stdout),
  });
}

// ─── Tool: unit_cat ───────────────────────────────────────────────────────
async function unitCat(args = {}) {
  const missing = requireSystemctl();
  if (missing) return errorResult(missing);
  const bad = validUnitName(args.unit);
  if (bad) return errorResult(bad);
  const scope = scopeFlag(args);
  const r = await run(BIN.systemctl, [...scope, 'cat', args.unit, '--no-pager']);
  if (r.code !== 0) return errorResult(`systemctl cat failed: ${r.stderr || r.stdout}`);
  return textResult({
    unit: args.unit,
    scope: args.scope || 'system',
    text: r.stdout,
  });
}

// ─── Tool: tail_journal ───────────────────────────────────────────────────
async function tailJournal(args = {}) {
  const missing = requireJournalctl();
  if (missing) return errorResult(missing);
  if (args.unit) {
    const bad = validUnitName(args.unit);
    if (bad) return errorResult(bad);
  }
  const lines = Math.max(1, Math.min(2000, Math.floor(args.lines ?? 100)));
  const entries = await tailJournalLines({
    unit: args.unit,
    scope: args.scope || 'system',
    lines,
    since: args.since,
    priority: args.priority,
  });
  return textResult({
    scope: args.scope || 'system',
    unit: args.unit || null,
    requested_lines: lines,
    returned: entries.length,
    entries,
  });
}

// ─── Tool: list_jobs ──────────────────────────────────────────────────────
async function listJobs(args = {}) {
  const missing = requireSystemctl();
  if (missing) return errorResult(missing);
  const scope = scopeFlag(args);
  const r = await run(BIN.systemctl, [...scope, 'list-jobs', '--no-pager', '--no-legend', '--output=json']);
  if (r.code !== 0) return errorResult(`systemctl list-jobs failed: ${r.stderr || r.stdout}`);
  // Empty output = no jobs. JSON mode prints '[]' or empty.
  let jobs = [];
  if (r.stdout.trim()) {
    try { jobs = JSON.parse(r.stdout); } catch (_) { jobs = []; }
  }
  return textResult({ scope: args.scope || 'system', count: jobs.length, jobs });
}

// ─── Tool registry ────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'list_units',
    description: 'List systemd units with optional state and type filters. Returns unit name, load/active/sub state, and description per entry. Default scope is system; pass scope="user" for --user units.',
    annotations: { title: 'List systemd units', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['system', 'user'], description: 'system (default) or user.' },
        type: { type: 'string', description: 'Filter by unit type (e.g. "service", "timer", "socket", "mount", "target").' },
        state: { type: 'string', description: 'Filter by active state (e.g. "running", "failed", "exited", "active", "inactive").' },
        all: { type: 'boolean', description: 'Include inactive units (default: false — only loaded units).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'failed_units',
    description: 'Shortcut for the most common systemd query: list every unit currently in the failed state. Equivalent to list_units with state="failed".',
    annotations: { title: 'List failed units', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['system', 'user'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'unit_status',
    description: 'Detailed per-unit status: active state, sub state, enabled state, main PID, restart count, recent journal lines, and the path to the unit file plus any drop-in overrides. The "is this service healthy?" primitive.',
    annotations: { title: 'Unit status', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        unit: { type: 'string', description: 'Unit name (e.g. "ollama.service" or "ollama"; .service suffix optional).' },
        scope: { type: 'string', enum: ['system', 'user'] },
        recent_log_lines: { type: 'integer', minimum: 0, maximum: 200, description: 'How many recent journal lines to include (default 20, set 0 to skip).' },
      },
      required: ['unit'],
      additionalProperties: false,
    },
  },
  {
    name: 'unit_show',
    description: 'Full property dump from systemctl show (parsed Key=Value). Useful for inspecting Environment vars, ExecStart, Restart policy, drop-ins, dependency relationships. Returns ALL properties — there are typically 100+.',
    annotations: { title: 'Show unit properties', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        unit: { type: 'string' },
        scope: { type: 'string', enum: ['system', 'user'] },
      },
      required: ['unit'],
      additionalProperties: false,
    },
  },
  {
    name: 'unit_cat',
    description: 'Raw text of a unit file plus all its drop-in overrides — exactly what `systemctl cat <unit>` prints. Use this when you need to see what is actually loading (e.g. /etc/systemd/system/<unit>.d/override.conf overrides).',
    annotations: { title: 'Cat unit file', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        unit: { type: 'string' },
        scope: { type: 'string', enum: ['system', 'user'] },
      },
      required: ['unit'],
      additionalProperties: false,
    },
  },
  {
    name: 'tail_journal',
    description: 'Read recent journal entries with optional unit filter, time window, and priority filter. Returns parsed entries with ISO timestamp, priority (0=emerg .. 7=debug), unit, pid, and message text. Default 100 lines, max 2000.',
    annotations: { title: 'Tail journal', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        unit: { type: 'string', description: 'Filter to one unit (optional).' },
        scope: { type: 'string', enum: ['system', 'user'] },
        lines: { type: 'integer', minimum: 1, maximum: 2000, description: 'Number of lines to return (default 100).' },
        since: { type: 'string', description: 'Time window start (e.g. "10 minutes ago", "yesterday", "2026-04-25 09:00:00").' },
        priority: { type: 'integer', minimum: 0, maximum: 7, description: 'Maximum priority (0=emerg, 3=err, 4=warning, 6=info, 7=debug). Pass 3 to see only errors and worse.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_jobs',
    description: 'List queued or running systemd jobs (rare — useful when something is hanging during boot, a service is stuck activating, or you want to know what systemd is currently working on).',
    annotations: { title: 'List systemd jobs', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['system', 'user'] },
      },
      additionalProperties: false,
    },
  },
];

const HANDLERS = {
  list_units: listUnits,
  failed_units: failedUnits,
  unit_status: unitStatus,
  unit_show: unitShow,
  unit_cat: unitCat,
  tail_journal: tailJournal,
  list_jobs: listJobs,
};

// ─── JSON-RPC dispatch ────────────────────────────────────────────────────
async function handle(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    respond(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'systemd-mcp', version: '0.1.0' },
    });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'ping') { respond(id, {}); return; }
  if (method === 'tools/list') { respond(id, { tools: TOOLS }); return; }

  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params || {};
    const handler = HANDLERS[name];
    if (!handler) { error(id, -32601, `unknown tool: ${name}`); return; }
    try {
      const result = await Promise.resolve(handler(args));
      respond(id, result);
    } catch (e) {
      log('tool error:', name, e.message, e.stack);
      respond(id, errorResult(`tool ${name} threw: ${e.message}`));
    }
    return;
  }

  if (id !== undefined && id !== null) error(id, -32601, `method not found: ${method}`);
}

// ─── Main loop ────────────────────────────────────────────────────────────
let inflight = 0;
let stdinClosed = false;
function maybeExit() { if (stdinClosed && inflight === 0) process.exit(0); }

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); }
  catch (e) { log('bad JSON on stdin:', e.message); return; }
  inflight++;
  handle(msg)
    .catch((e) => {
      log('handler crash:', e.message, e.stack);
      if (msg && msg.id !== undefined) error(msg.id, -32603, e.message);
    })
    .finally(() => { inflight--; maybeExit(); });
});
rl.on('close', () => { stdinClosed = true; maybeExit(); });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

log(
  'server started, pid', process.pid,
  'systemctl=' + (BIN.systemctl || 'MISSING'),
  'journalctl=' + (BIN.journalctl || 'MISSING')
);
