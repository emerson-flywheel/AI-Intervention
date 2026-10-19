// Test sandbox: a temp /data and /run, the fake herdr and claude, and a private tmux
// socket dir, all passed by env so nothing touches a real add-on, herdr or login.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const AGENT_DIR = join(HERE, '..', 'rootfs', 'opt', 'addon-agent');
export const FAKES = join(HERE, 'fakes');

export function sandbox({ options = {}, herdr = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cc-'));
  const data = join(root, 'data');
  const run = join(root, 'run');
  const tmux = join(root, 'tm');
  for (const d of [data, run, tmux, join(data, 'claude')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(data, 'options.json'), JSON.stringify({ seat_name: 'home', ...options }));
  const state = join(root, 'herdr.json');
  writeFileSync(state, JSON.stringify(herdr ?? { workspaces: [], panes: {} }));
  const env = {
    ...process.env,
    ADDON_DATA: data,
    ADDON_RUN: run,
    HERDR_BIN: join(FAKES, 'herdr'),
    CLAUDE_BIN: join(FAKES, 'claude'),
    FAKE_HERDR_STATE: state,
    TMUX_TMPDIR: tmux,
  };
  delete env.TMUX;
  return {
    root, data, run, env, state,
    herdr: () => JSON.parse(readFileSync(state, 'utf8')),
    setHerdr: (s) => writeFileSync(state, JSON.stringify(s)),
    cleanup() {
      spawn('tmux', ['-L', 'seat-login', 'kill-server'], { env, stdio: 'ignore' }).on('exit', () =>
        rmSync(root, { recursive: true, force: true }));
    },
  };
}

// A console with one pane, as console.mjs leaves it.
export function consoleHerdr({ status = 'idle', lines = ['╭─ Claude Code ─╮', '> '], history = 42 } = {}) {
  return {
    workspaces: [{ id: 'w1', label: 'claude' }],
    panes: { 'w1:p1': { lines, agent_status: status, history, procs: [{ name: 'claude', pid: 999999 }] } },
    next: 1,
  };
}

export function writeRunFiles(sb, files) {
  for (const [k, v] of Object.entries(files)) writeFileSync(join(sb.run, k), `${v}\n`);
}

// Run a node module of the add-on (a CLI) inside the sandbox.
export function runNode(sb, file, { args = [], env = {}, stdin = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(AGENT_DIR, file), ...args], {
      env: { ...sb.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => {});
    if (stdin !== null) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

export const agent = (sb, command, opts = {}) =>
  runNode(sb, 'agent.mjs', { ...opts, env: { SSH_ORIGINAL_COMMAND: command, ...(opts.env || {}) } });

export const GOOD_LINK =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e' +
  '&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback' +
  '&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code' +
  '+user%3Amcp_servers+user%3Afile_upload&code_challenge=Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5' +
  '&code_challenge_method=S256&state=c3RhdGVzdGF0ZXN0YXRlc3RhdGVzdGF0ZQ';
export const GOOD_CODE = 'good-code-0123456789';
