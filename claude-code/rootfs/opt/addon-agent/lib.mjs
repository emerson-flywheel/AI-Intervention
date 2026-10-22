// Shared by the seat server, the remote agent and the console bootstrap.
// Every path can be moved with an env var so the tests run outside the add-on.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env;
export const DATA = env.ADDON_DATA || '/data';
export const RUN = env.ADDON_RUN || '/run/claude-code';
export const CLAUDE_DIR = join(DATA, 'claude');
export const HERDR = env.HERDR_BIN || 'herdr';
export const TMUX = env.TMUX_BIN || 'tmux';
export const CLAUDE = env.CLAUDE_BIN || 'claude';
// herdr's configs: the ones look.mjs wrote for the Console's look, else the shipped ones.
const herdrConfig = (name) => (existsSync(join(RUN, 'herdr', name)) ? join(RUN, 'herdr', name) : `/etc/herdr/${name}`);
export const CONSOLE_CONFIG = env.ADDON_CONSOLE_CONFIG || herdrConfig('console.toml');
export const ATTACH_CONFIG = env.ADDON_ATTACH_CONFIG || herdrConfig('attach.toml');
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

// The seat's short id (what a remote console shows) comes from the name given on the
// Settings tab (seat.json): lower case, spaces and underscores as hyphens, other
// characters dropped. No name, or nothing usable left: "claude".
export function seatName() {
  let name = '';
  try {
    name = JSON.parse(readFileSync(join(DATA, 'seat.json'), 'utf8'))?.name;
  } catch {}
  const id = typeof name === 'string'
    ? name.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
    : '';
  return NAME_RE.test(id) ? id : 'claude';
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

export function dropRun(name) {
  rmSync(join(RUN, name), { force: true });
}

// busy | working | waiting | blocked | idle | done | shell | off
const AGENT_STATES = { idle: 'idle', working: 'working', blocked: 'blocked', done: 'done' };
export async function consoleState(pane) {
  const loop = readRun('state');
  if (loop === 'shell') return 'shell';
  if (loop === 'prompt') return 'waiting';
  if (loop === 'off') return 'off';
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
  if (!(await stopClaude(pane, 'relaunch'))) return 'none';
  return 'now';
}

// The console loop's own child processes (console-loop.sh writes its pid to loop-pid): while
// the loop runs Claude, that is Claude, whatever it is called. npm's install runs it as
// claude.exe, which herdr's process names never matched (0.3.6: every off was refused).
export function loopChildren() {
  const loop = Number(readRun('loop-pid'));
  if (!Number.isInteger(loop) || loop <= 1) return [];
  const kids = [];
  let pids = [];
  try {
    pids = readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {}
  for (const pid of pids) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // pid (comm) state ppid ...: comm may hold spaces or brackets, so read after the last ")"
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (ppid === loop) kids.push(Number(pid));
    } catch {}
  }
  return kids;
}

// Ask Claude in the console's pane to exit (SIGTERM; its conversation is already on disk),
// after writing the marker that tells the loop what to do next: "relaunch" or "offduty".
// Claude is the loop's child; with no loop pid (a console started before 0.3.7), what herdr
// names claude in the pane. Returns false, and writes nothing, when no Claude is found.
export async function stopClaude(pane, marker, value = '1') {
  let pids = loopChildren();
  if (!pids.length) {
    const info = await herdr('pane', 'process-info', '--pane', pane);
    const procs = info.result?.process_info?.foreground_processes || [];
    pids = procs
      .filter((p) => p.name === 'claude' || /(^|\/)claude$/.test(p.argv?.[0] || '') || /(^|\/)claude$/.test(p.argv?.[1] || ''))
      .map((p) => p.pid);
  }
  if (!pids.length) return false;
  writeRun(marker, value);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  return true;
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
