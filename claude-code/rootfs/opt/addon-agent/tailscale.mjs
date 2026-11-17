// Settings › Bots › Tailscale (0.4.5): how a bot away from home reaches the Bots door. The
// app joins the user's Tailscale network as its own device, "ai-intervention-bots", and
// serves only the door (http://127.0.0.1:7690) on it: never the page, the Console or Home
// Assistant. Funnel, which gives the door a public address for a bot that cannot join the
// network (one run by someone else, in the cloud), is off unless the user turns it on.
//
// The user pastes a Tailscale auth key on the page. It is kept in /data/tailscale/authkey
// (0600), handed to tailscale as a file (never on a command line), and never shown or
// logged. run.sh runs tailscaled (userspace networking, state in /data/tailscale) while a
// key or a joined device is there, and `node tailscale.mjs apply` after each change.
//   apply   up, then serve the door (Funnel on or off); exit 1 when there is nothing to join
//   forget  log the device out of the network
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA, RUN } from './lib.mjs';

let dataDir = DATA;
let runDir = RUN;
// The tests point it at a sandbox.
export function setDirs(data, run) {
  dataDir = data;
  runDir = run;
}

export const HOSTNAME = 'ai-intervention-bots';
const KEY_RE = /^tskey-[A-Za-z0-9-]{10,200}$/;
const dir = () => join(dataDir, 'tailscale');
const keyFile = () => join(dir(), 'authkey');
const prefsFile = () => join(dir(), 'prefs.json');
const stateFile = () => join(dir(), 'tailscaled.state');
const statusFile = () => join(runDir, 'tailscale-status.json');
const socket = () => join(runDir, 'tailscaled.sock');
const doorPort = () => Number(process.env.ADDON_BOTS_PORT) || 7690;

export class TailscaleError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function writePrivate(file, text) {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

function readJson(file) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

// run.sh applies it within a few seconds (tailscaled started, or stopped after Forget).
function ask(marker) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, marker), '');
}

export function saveKey(key) {
  const k = typeof key === 'string' ? key.trim() : '';
  if (!KEY_RE.test(k)) throw new TailscaleError('bad-key');
  writePrivate(keyFile(), `${k}\n`);
  ask('tailscale-apply');
}

export function setFunnel(on) {
  writePrivate(prefsFile(), `${JSON.stringify({ funnel: on === true })}\n`);
  ask('tailscale-apply');
}

export function forgetTailscale() {
  rmSync(keyFile(), { force: true });
  rmSync(prefsFile(), { force: true });
  rmSync(statusFile(), { force: true });
  ask('tailscale-forget');
}

// What the page shows. Never the key.
export function tailscaleView() {
  const st = readJson(statusFile());
  return {
    keySet: existsSync(keyFile()),
    joined: existsSync(stateFile()),
    funnel: readJson(prefsFile()).funnel === true,
    name: typeof st.name === 'string' ? st.name : null,
    online: st.online === true,
    error: typeof st.error === 'string' ? st.error : null,
    port: doorPort(),
  };
}

// --- The CLI run.sh calls ---

function ts(...args) {
  return new Promise((done) => {
    execFile(process.env.TAILSCALE_BIN || 'tailscale', [`--socket=${socket()}`, ...args], { timeout: 60e3 }, (err, stdout) => {
      done({ ok: !err, stdout: String(stdout || '') });
    });
  });
}

function writeStatus(v) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(statusFile(), `${JSON.stringify({ ...v, at: Date.now() })}\n`);
}

export async function apply() {
  const hasKey = existsSync(keyFile());
  if (!hasKey && !existsSync(stateFile())) return 1;
  const up = ['up', `--hostname=${HOSTNAME}`, '--accept-dns=false', '--accept-routes=false'];
  if (hasKey) up.push(`--auth-key=file:${keyFile()}`);
  if (!(await ts(...up)).ok) {
    writeStatus({ online: false, error: 'up-failed' });
    return 2;
  }
  const door = `http://127.0.0.1:${doorPort()}`;
  if (readJson(prefsFile()).funnel === true) {
    if (!(await ts('funnel', '--bg', '--https=443', door)).ok) {
      writeStatus({ online: false, error: 'funnel-failed' });
      return 2;
    }
  } else {
    await ts('funnel', '--https=443', 'off');
    if (!(await ts('serve', '--bg', '--https=443', door)).ok) {
      writeStatus({ online: false, error: 'serve-failed' });
      return 2;
    }
  }
  const st = await ts('status', '--json');
  let name = null;
  let online = false;
  try {
    const j = JSON.parse(st.stdout);
    name = typeof j?.Self?.DNSName === 'string' ? j.Self.DNSName.replace(/\.$/, '') : null;
    online = j?.BackendState === 'Running';
  } catch {}
  writeStatus({ name, online });
  return 0;
}

export async function forget() {
  await ts('logout');
  rmSync(statusFile(), { force: true });
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const verb = process.argv[2];
  const code = verb === 'apply' ? await apply() : verb === 'forget' ? await forget() : 64;
  process.exit(code);
}
