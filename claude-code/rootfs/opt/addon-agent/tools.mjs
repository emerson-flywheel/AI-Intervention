// Settings › Tools: extras Claude may use. Each is a change to Claude Code's own settings
// file (/data/claude/settings.json), made and taken back by this page only, keeping every
// other setting in it:
//   snapshot  a PreToolUse hook (snapshot.sh) that saves a local git history of
//             /homeassistant before each file edit Claude makes, so a change can be undone
//   web       Claude Code's web search and fetch; off adds deny rules for them
// A settings file that is not JSON is left alone and nothing is written.
//
// Tools Claude adds (0.4.3): Claude writes one file per tool in /data/tools (the shipped
// skill says how), and each shows in Settings › Tools, off until the user switches it on:
//   mcp     an MCP server; on puts it in addon-mcp.json, which Claude is started with
//           (--mcp-config=), so the user's own MCP setup is never touched
//   script  a script in /data/tools; on adds an allow rule so Claude runs it without asking
// The version the user switched on is kept (addon-tools.json); when Claude changes the file
// later, the page says so and the old version stays in use until the user switches it on again.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_DIR } from './lib.mjs';

let claudeDir = CLAUDE_DIR;
// The tests point it at a sandbox.
export function setClaudeDir(dir) {
  claudeDir = dir;
}
const file = () => join(claudeDir, 'settings.json');
const toolsDir = () => join(dirname(claudeDir), 'tools');
const approvedFile = () => join(claudeDir, 'addon-tools.json');
export const mcpFile = () => join(claudeDir, 'addon-mcp.json');
// Jarvis mode's marker (settings.mjs writes it): while it is there, Snapshot stays on.
export const jarvisFile = () => join(dirname(claudeDir), 'jarvis.json');
const jarvisOn = () => existsSync(jarvisFile());

export const SNAPSHOT = '/opt/addon-agent/snapshot.sh';
const SNAPSHOT_HOOK = {
  matcher: 'Edit|MultiEdit|Write|NotebookEdit',
  hooks: [{ type: 'command', command: SNAPSHOT, timeout: 60 }],
};
const WEB = ['WebSearch', 'WebFetch'];

export const TOOLS = [
  {
    id: 'snapshot',
    label: 'Snapshot before edits',
    description: 'Saves a copy of your config (/homeassistant) before each file Claude changes, in a local history, so any change can be undone. Ask Claude to "undo your last change".',
  },
  {
    id: 'web',
    label: 'Web search',
    description: 'Lets Claude look up integration docs and error messages on the web. It still asks before it opens a page.',
  },
];

export class ToolsError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ours = (entry) => isObject(entry) && Array.isArray(entry.hooks) && entry.hooks.some((h) => h?.command === SNAPSHOT);

function read() {
  try {
    const v = JSON.parse(readFileSync(file(), 'utf8'));
    return isObject(v) ? { value: v } : { unreadable: true };
  } catch (err) {
    return err.code === 'ENOENT' ? { value: {} } : { unreadable: true };
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function on(settings) {
  const pre = settings.hooks?.PreToolUse;
  const deny = settings.permissions?.deny;
  return {
    snapshot: Array.isArray(pre) && pre.some(ours),
    web: !(Array.isArray(deny) && WEB.some((w) => deny.includes(w))),
  };
}

export function toolsState() {
  const f = read();
  const now = on(f.unreadable ? {} : f.value);
  const locked = jarvisOn();
  return TOOLS.map((t) => ({ ...t, on: now[t.id], locked: t.id === 'snapshot' && locked }));
}

function setSnapshot(next, want) {
  const hooks = isObject(next.hooks) ? next.hooks : {};
  const pre = (Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : []).filter((e) => !ours(e));
  if (want) pre.push(structuredClone(SNAPSHOT_HOOK));
  if (pre.length) hooks.PreToolUse = pre;
  else delete hooks.PreToolUse;
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;
}

// Claude Code settings with the snapshot hook on (Jarvis mode turns it on this way).
export function withSnapshot(settings) {
  const next = structuredClone(settings);
  if (!on(next).snapshot) setSnapshot(next, true);
  return next;
}

// Change permissions.<list>: drop what remove names, then add what add names.
function editRules(next, list, { remove = [], add = [] }) {
  const perms = isObject(next.permissions) ? next.permissions : {};
  const rules = (Array.isArray(perms[list]) ? perms[list] : []).filter((r) => !remove.includes(r));
  for (const r of add) if (!rules.includes(r)) rules.push(r);
  if (rules.length) perms[list] = rules;
  else delete perms[list];
  if (Object.keys(perms).length) next.permissions = perms;
  else delete next.permissions;
}

// Save the switches. changed: Claude in the Console must start again to use them.
export function saveTools({ snapshot, web } = {}) {
  if (typeof snapshot !== 'boolean' || typeof web !== 'boolean') throw new ToolsError('bad-tools');
  if (!snapshot && jarvisOn()) throw new ToolsError('jarvis-snapshot');
  const f = read();
  if (f.unreadable) throw new ToolsError('settings-unreadable');
  const now = on(f.value);
  if (now.snapshot === snapshot && now.web === web) return { changed: false };
  const next = structuredClone(f.value);
  setSnapshot(next, snapshot);
  editRules(next, 'deny', { remove: WEB, add: web ? [] : WEB });
  writeJson(file(), next);
  return { changed: true };
}

// --- Tools Claude adds ---

const TOOL_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SCRIPT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const text = (v, cap) => typeof v === 'string' && v.trim() && v.length <= cap && !CONTROL_RE.test(v);
const strings = (o) => isObject(o) && Object.entries(o).every(([k, v]) => ENV_KEY_RE.test(k) && typeof v === 'string' && v.length <= 2000);

// Only the shapes Claude Code takes for an MCP server: a command it starts, or a server it
// reaches by URL. Anything else is refused before it can reach Claude's start line.
function mcpConfig(c) {
  if (!isObject(c)) return null;
  if (c.type === undefined || c.type === 'stdio') {
    if (!text(c.command, 300)) return null;
    if (c.args !== undefined && !(Array.isArray(c.args) && c.args.every((a) => typeof a === 'string' && a.length <= 1000))) return null;
    if (c.env !== undefined && !strings(c.env)) return null;
    return { command: c.command, ...(c.args && { args: [...c.args] }), ...(c.env && { env: { ...c.env } }) };
  }
  if (c.type !== 'http' && c.type !== 'sse') return null;
  let url;
  try {
    url = new URL(c.url);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const headers = c.headers === undefined ? undefined : isObject(c.headers) && Object.values(c.headers).every((v) => typeof v === 'string') ? c.headers : null;
  if (headers === null) return null;
  return { type: c.type, url: c.url, ...(headers && { headers: { ...headers } }) };
}

const scriptConfig = (c) => (isObject(c) && typeof c.file === 'string' && SCRIPT_RE.test(c.file) ? { file: c.file } : null);
const scriptRule = (config) => `Bash(${join(toolsDir(), config.file)}:*)`;

// What the page shows of a tool: never its env or header values, nor a URL's query.
function summary(kind, config) {
  let s;
  if (kind === 'script') s = `Runs: ${join(toolsDir(), config.file)}`;
  else if (config.command) s = `Runs: ${[config.command, ...(config.args || [])].join(' ')}`;
  else {
    const u = new URL(config.url);
    s = `Connects to: ${u.origin}${u.pathname}`;
  }
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

// One tool's file: null when there is none; otherwise the tool, or why it cannot be used.
function readDef(id) {
  let raw;
  try {
    raw = readFileSync(join(toolsDir(), `${id}.json`), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return { problem: 'not-json' };
  }
  let d;
  try {
    d = JSON.parse(raw);
  } catch {
    return { problem: 'not-json' };
  }
  if (!isObject(d)) return { problem: 'not-json' };
  if (!text(d.name, 60)) return { problem: 'bad-name' };
  if (typeof d.description !== 'string' || d.description.length > 400) return { problem: 'bad-description', name: d.name };
  const base = { name: d.name.trim(), description: d.description.trim(), kind: d.kind };
  if (d.kind !== 'mcp' && d.kind !== 'script') return { ...base, problem: 'bad-kind' };
  const config = d.kind === 'mcp' ? mcpConfig(d.config) : scriptConfig(d.config);
  if (!config) return { ...base, problem: 'bad-config' };
  if (d.kind === 'script' && !existsSync(join(toolsDir(), config.file))) return { ...base, problem: 'no-script' };
  return { ...base, config, problem: null };
}

function readApproved() {
  try {
    const v = JSON.parse(readFileSync(approvedFile(), 'utf8'));
    return isObject(v) ? v : {};
  } catch {
    return {};
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function mcpServers(approved) {
  const out = {};
  for (const [id, t] of Object.entries(approved)) if (t?.kind === 'mcp') out[id] = t.config;
  return { mcpServers: out };
}

export function customTools() {
  let names = [];
  try {
    names = readdirSync(toolsDir());
  } catch {
    // No folder yet: no tools.
  }
  const approved = readApproved();
  const ids = new Set(names.filter((n) => n.endsWith('.json') && TOOL_ID_RE.test(n.slice(0, -5))).map((n) => n.slice(0, -5)));
  for (const id of Object.keys(approved)) if (TOOL_ID_RE.test(id)) ids.add(id);
  return [...ids].sort().map((id) => {
    const def = readDef(id);
    const kept = approved[id];
    if (!def) {
      return { id, name: kept.name, description: '', kind: kept.kind, summary: summary(kept.kind, kept.config), on: true, changed: false, problem: 'gone' };
    }
    const isOn = Boolean(kept);
    return {
      id,
      name: def.name || id,
      description: def.description || '',
      kind: def.kind ?? null,
      summary: def.config ? summary(def.kind, def.config) : '',
      on: isOn,
      changed: isOn && !def.problem && !same(kept.config, def.config),
      problem: def.problem,
    };
  });
}

// Switch one of Claude's tools on or off. changed: Claude must start again to use it.
export function saveCustomTool({ id, on: want } = {}) {
  if (typeof id !== 'string' || !TOOL_ID_RE.test(id) || typeof want !== 'boolean') throw new ToolsError('bad-tool');
  const approved = readApproved();
  const before = approved[id];
  let entry = null;
  if (want) {
    const def = readDef(id);
    if (!def) throw new ToolsError('no-tool');
    if (def.problem) throw new ToolsError(def.problem);
    entry = { kind: def.kind, name: def.name, config: def.config };
    if (before && same(before, entry)) return { changed: false };
  } else if (!before) {
    return { changed: false };
  }
  const remove = before?.kind === 'script' ? [scriptRule(before.config)] : [];
  const add = entry?.kind === 'script' ? [scriptRule(entry.config)] : [];
  if (remove.length || add.length) {
    const f = read();
    if (f.unreadable) throw new ToolsError('settings-unreadable');
    const next = structuredClone(f.value);
    editRules(next, 'allow', { remove, add });
    writeJson(file(), next);
  }
  if (entry) approved[id] = entry;
  else delete approved[id];
  writeJson(approvedFile(), approved);
  writeJson(mcpFile(), mcpServers(approved));
  return { changed: true };
}

// Claude does not start when its --mcp-config file is missing, so run.sh makes sure of it.
export function ensureMcpFile() {
  try {
    if (isObject(JSON.parse(readFileSync(mcpFile(), 'utf8'))?.mcpServers)) return;
  } catch {
    // Missing or broken: written again below.
  }
  writeJson(mcpFile(), mcpServers(readApproved()));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'mcp-file') ensureMcpFile();
  else {
    console.error('usage: tools.mjs mcp-file');
    process.exitCode = 2;
  }
}
