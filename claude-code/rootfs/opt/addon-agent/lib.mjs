// Shared by the seat server, the remote agent and the console bootstrap.
// Every path can be moved with an env var so the tests run outside the add-on.
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env;
export const DATA = env.ADDON_DATA || '/data';
export const RUN = env.ADDON_RUN || '/run/claude-code';
export const CLAUDE_DIR = join(DATA, 'claude');
export const HERDR = env.HERDR_BIN || 'herdr';
export const TMUX = env.TMUX_BIN || 'tmux';
export const CLAUDE = env.CLAUDE_BIN || 'claude';
export const CONSOLE_CONFIG = env.ADDON_CONSOLE_CONFIG || '/etc/herdr/console.toml';
export const ATTACH_CONFIG = env.ADDON_ATTACH_CONFIG || '/etc/herdr/attach.toml';
export const SESSION = 'claude';
export const CONSOLE = 'claude';
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function options() {
  try {
    return JSON.parse(readFileSync(join(DATA, 'options.json'), 'utf8'));
  } catch {
    return {};
  }
}

export function seatName() {
  const s = options().seat_name;
  return typeof s === 'string' && NAME_RE.test(s) ? s : 'claude';
}

export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 16 << 20, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

// herdr CLI against the console session. Results are JSON on stdout, errors JSON on
// stderr; send-text/send-keys print nothing; pane read prints the text itself.
export function herdrRaw(...args) {
  return run(HERDR, ['--session', SESSION, ...args], {
    env: { ...env, HERDR_CONFIG_PATH: CONSOLE_CONFIG },
  });
}

export async function herdr(...args) {
  const r = await herdrRaw(...args);
  for (const out of [r.stdout, r.stderr]) {
    try {
      return { ok: r.code === 0, ...JSON.parse(out) };
    } catch {}
  }
  return r.code === 0 ? { ok: true } : { ok: false, error: { code: 'no_json' } };
}

export function writeRun(name, value) {
  mkdirSync(RUN, { recursive: true });
  const tmp = join(RUN, `.${name}.tmp`);
  writeFileSync(tmp, `${value}\n`);
  renameSync(tmp, join(RUN, name));
}

export function readRun(name) {
  try {
    return readFileSync(join(RUN, name), 'utf8').trim();
  } catch {
    return null;
  }
}

// The console's pane, if the herdr server is up and the pane still exists.
export async function consolePane() {
  const pane = readRun('pane');
  if (!pane) return null;
  const r = await herdr('pane', 'get', pane);
  return r.result?.pane?.pane_id === pane ? pane : null;
}

// busy | working | waiting | blocked | idle | done | shell
const AGENT_STATES = { idle: 'idle', working: 'working', blocked: 'blocked', done: 'done' };
export async function consoleState(pane) {
  const loop = readRun('state');
  if (loop === 'shell') return 'shell';
  if (loop === 'prompt') return 'waiting';
  const r = await herdr('agent', 'get', pane);
  if (r.error?.code === 'agent_not_found') return loop === 'claude' ? 'busy' : 'shell';
  return AGENT_STATES[r.result?.agent?.agent_status] || 'busy';
}

// The guard: while a remote client is attached or typing, the console loop offers
// no shell (console-loop.sh reads guard.d). Add the guard first, then read the loop
// state, so either this side sees "shell" or the loop sees the guard.
export function addGuard() {
  mkdirSync(join(RUN, 'guard.d'), { recursive: true });
  writeFileSync(join(RUN, 'guard.d', String(process.pid)), '');
}

export function dropGuard() {
  rmSync(join(RUN, 'guard.d', String(process.pid)), { force: true });
}

export function guardedShell() {
  return readRun('state') === 'shell';
}

export function guardPids() {
  try {
    return readdirSync(join(RUN, 'guard.d'));
  } catch {
    return [];
  }
}

// Start Claude in the console again on a new login, with --continue (the loop adds it).
// Returns "now" when Claude was restarted, "after-shell" when the console is in its
// shell (Claude starts again when the shell is left), or "none" without a console.
export async function relaunchConsole() {
  const pane = await consolePane();
  if (!pane) return 'none';
  const loop = readRun('state');
  if (loop === 'shell') return 'after-shell';
  if (loop === 'prompt') {
    await herdr('pane', 'send-keys', pane, 'enter');
    return 'now';
  }
  const info = await herdr('pane', 'process-info', '--pane', pane);
  const procs = info.result?.process_info?.foreground_processes || [];
  const claude = procs.filter(
    (p) => p.name === 'claude' || /(^|\/)claude$/.test(p.argv?.[0] || '') || /(^|\/)claude$/.test(p.argv?.[1] || ''),
  );
  if (!claude.length) return 'none';
  writeRun('relaunch', '1');
  for (const p of claude) {
    try {
      process.kill(p.pid, 'SIGTERM');
    } catch {}
  }
  return 'now';
}

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export function stripAnsi(s) {
  return s.replace(ANSI_RE, '');
}

export async function paneLines(pane, n) {
  const r = await herdrRaw('pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', String(n));
  if (r.code !== 0) return [];
  const lines = stripAnsi(r.stdout).replace(/\r/g, '').split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.slice(-n);
}
