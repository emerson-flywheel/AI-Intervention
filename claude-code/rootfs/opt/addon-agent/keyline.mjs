// Writes the remote key's one authorized_keys line and the remote console's state in
// /run/claude-code/remote (on, off, refused-key or refused-from) for the Settings tab.
// The key and its addresses come from the remote_key and remote_allow_from options when
// remote_key is set, else from Settings › Remote console (/data/remote.json).
//   exit 0: written; exit 1: no key, or turned off on the page (no sshd); exit 2: not one
//   plain ssh-ed25519 key; exit 3: the addresses missing or not a plain address list.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA, RUN } from './lib.mjs';

// "ssh-ed25519", one space, the 68-character base64 blob of a 32-byte ed25519 key, and
// at most a plain comment. Nothing that could carry an option, a quote or a second line.
const KEY_RE = /^ssh-ed25519 (AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43})(?: ([A-Za-z0-9@._+-]{1,100}))?$/;
const MAX_FROM = 16;
// The markers the page leaves for run.sh: apply the remote console's setting again, or
// make a new host key. run.sh drops each once done.
export const APPLY = 'remote-apply';
export const RESET = 'hostkey-reset';

export class RemoteError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// One address, or a network with a prefix length; never everywhere (/0), never a name.
function oneFrom(s) {
  const m = s.match(/^([0-9A-Fa-f.:]+)(?:\/(\d{1,3}))?$/);
  if (!m) return false;
  const v = isIP(m[1]);
  if (!v) return false;
  if (m[2] === undefined) return true;
  const bits = Number(m[2]);
  return bits >= 1 && bits <= (v === 4 ? 32 : 128);
}

// remote_allow_from: one or more addresses or networks, comma-separated. Returns the
// list as sshd's from= takes it, or null.
export function allowFrom(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split(',').map((p) => p.trim());
  if (!parts.length || parts.length > MAX_FROM || !parts.every(oneFrom)) return null;
  return parts.join(',');
}

// The key line trimmed and checked, with its comment, or null.
function plainKey(key) {
  if (typeof key !== 'string') return null;
  const m = key.trim().match(KEY_RE);
  if (!m) return null;
  const blob = Buffer.from(m[1], 'base64');
  if (blob.length !== 51 || blob.toString('base64') !== m[1]) return null;
  return { line: key.trim(), blob: m[1], comment: m[2] || null };
}

export function keyLine(key, from) {
  const hosts = allowFrom(from);
  if (!hosts) return null;
  const k = plainKey(key);
  if (!k) return null;
  return `from="${hosts}",restrict,pty,command="node /opt/addon-agent/agent.mjs" ssh-ed25519 ${k.blob}`;
}

function readJson(file) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

// Where the remote console's setting comes from: the options while remote_key is set
// (source "option"), else the page's remote.json ("page"), else nothing ("none").
export function remoteConfig(data = DATA) {
  const opts = readJson(join(data, 'options.json')) || {};
  if (typeof opts.remote_key === 'string' && opts.remote_key.trim() !== '') {
    return { source: 'option', key: opts.remote_key, from: opts.remote_allow_from ?? null, enabled: true };
  }
  const page = readJson(join(data, 'remote.json'));
  if (!page || typeof page.key !== 'string') return { source: 'none', key: null, from: null, enabled: false };
  return { source: 'page', key: page.key, from: typeof page.from === 'string' ? page.from : null, enabled: page.enabled === true };
}

function writePage(data, value) {
  const file = join(data, 'remote.json');
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

function pageOnly(data) {
  const c = remoteConfig(data);
  if (c.source === 'option') throw new RemoteError('by-option');
  return c;
}

// Turn the remote console on from the page: a new key (or the one kept), and the addresses.
export function saveRemote({ key, from } = {}, data = DATA) {
  const c = pageOnly(data);
  const k = plainKey(key ?? c.key);
  if (!k) throw new RemoteError('bad-key');
  const hosts = allowFrom(from);
  if (!hosts) throw new RemoteError('bad-from');
  writePage(data, { key: k.line, from: hosts, enabled: true });
}

// Off keeps the key and addresses for Turn on; remove forgets them.
export function remoteOff(data = DATA) {
  const c = pageOnly(data);
  if (c.source === 'page') writePage(data, { key: c.key, from: c.from, enabled: false });
}

export function remoteRemove(data = DATA) {
  pageOnly(data);
  rmSync(join(data, 'remote.json'), { force: true });
}

// By exit code: 0 on, 1 off, 2 refused-key, 3 refused-from.
const STATES = ['on', 'off', 'refused-key', 'refused-from'];

// The host key's fingerprint as ssh shows it (SHA256:, unpadded base64), or null. Only
// for the page's Show button: the state never carries it.
export function hostKeyFingerprint(data = DATA) {
  try {
    const m = readFileSync(join(data, 'ssh', 'ssh_host_ed25519_key.pub'), 'utf8').trim().match(/^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: |$)/);
    if (!m) return null;
    return `SHA256:${createHash('sha256').update(Buffer.from(m[1], 'base64')).digest('base64').replace(/=+$/, '')}`;
  } catch {
    return null;
  }
}

// The remote console for the Settings tab: its state as keyline.mjs left it at the last
// apply ("unknown" before then), where its setting comes from, the addresses and the key's
// comment (when they pass the checks), the last login, and whether a change still waits
// for run.sh. Never a key, never the host key.
export function remoteStatus(data = DATA, run = RUN) {
  let state = 'unknown';
  try {
    const s = readFileSync(join(run, 'remote'), 'utf8').trim();
    if (STATES.includes(s)) state = s;
  } catch {}
  const c = remoteConfig(data);
  const k = plainKey(c.key);
  const from = allowFrom(c.from);
  const ok = Boolean(k && from) && !state.startsWith('refused');
  let lastLogin = null;
  try {
    const n = Number(readFileSync(join(data, 'ssh', 'last-login'), 'utf8').trim());
    if (Number.isFinite(n) && n > 0) lastLogin = n;
  } catch {}
  return {
    state,
    source: c.source,
    from: ok ? from : null,
    keyComment: ok ? k.comment : null,
    lastLogin,
    pending: existsSync(join(run, APPLY)) || existsSync(join(run, RESET)),
  };
}

// The agent stamps each login, at most once a minute (a dashboard may ask every few seconds).
export function stampLogin(data = DATA, now = Date.now()) {
  const file = join(data, 'ssh', 'last-login');
  try {
    if (now - statSync(file).mtimeMs < 60e3) return;
  } catch {}
  try {
    writeFileSync(file, `${now}\n`);
  } catch {}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = join(DATA, 'ssh');
  const file = join(dir, 'authorized_keys');
  const { source, key, from, enabled } = remoteConfig();
  rmSync(file, { force: true });
  if (source === 'none' || !enabled) {
    process.exitCode = 1;
  } else if (!allowFrom(from)) {
    process.exitCode = 3;
  } else {
    const line = keyLine(key, from);
    if (!line) {
      process.exitCode = 2;
    } else {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      writeFileSync(file, `${line}\n`, { mode: 0o600 });
    }
  }
  mkdirSync(RUN, { recursive: true });
  writeFileSync(join(RUN, 'remote'), `${STATES[process.exitCode ?? 0]}\n`);
}
