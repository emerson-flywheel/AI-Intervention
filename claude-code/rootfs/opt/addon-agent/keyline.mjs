// Writes the remote key's one authorized_keys line from the remote_key and
// remote_allow_from options.
//   exit 0: written; exit 1: remote_key empty (no sshd); exit 2: not one plain
//   ssh-ed25519 key; exit 3: remote_allow_from missing or not a plain address list.
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA, options } from './lib.mjs';

// "ssh-ed25519", one space, the 68-character base64 blob of a 32-byte ed25519 key, and
// at most a plain comment. Nothing that could carry an option, a quote or a second line.
const KEY_RE = /^ssh-ed25519 (AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43})(?: [A-Za-z0-9@._+-]{1,100})?$/;
const MAX_FROM = 16;

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

export function keyLine(key, from) {
  if (typeof key !== 'string') return null;
  const hosts = allowFrom(from);
  if (!hosts) return null;
  const m = key.trim().match(KEY_RE);
  if (!m) return null;
  const blob = Buffer.from(m[1], 'base64');
  if (blob.length !== 51 || blob.toString('base64') !== m[1]) return null;
  return `from="${hosts}",restrict,pty,command="node /opt/addon-agent/agent.mjs" ssh-ed25519 ${m[1]}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = join(DATA, 'ssh');
  const file = join(dir, 'authorized_keys');
  const { remote_key: key, remote_allow_from: from } = options();
  rmSync(file, { force: true });
  if (typeof key !== 'string' || key.trim() === '') {
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
}
