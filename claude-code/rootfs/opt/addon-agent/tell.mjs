// Console messages (0.4.4): another computer's consoles send the user a short message from
// the user's own Telegram bot (Settings › Telegram), over a tell key. A tell key is an ssh
// key the user adds under Settings › Telegram › Console messages; sshd forces every login
// with it into this file, with the key's name, so all it can do is
//   send <console>      the text on stdin (at most 4000 bytes, cut to 600 characters)
//   replies <console>   read (once) the user's Telegram Replies to that console's messages
// It cannot type into Claude, read the screen, attach or sign in.
//
// Caps: 5 a minute and 30 an hour per console, 60 an hour per key; the same text from the
// same console within 10 minutes is dropped. Between 22:00 and 07:00 (Home Assistant's
// local time) a message is held and sent at 7:00. /data/tell.log has one line per message:
// time, key, console, length, result, Telegram's message id. Never the text.
//   exit 0: answered (one JSON line); 2: a bad request; 3: refused (no chat, over the cap).
import { createHash } from 'node:crypto';
import {
  appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowFrom, plainKey } from './keyline.mjs';
import { DATA, NAME_RE, RUN } from './lib.mjs';
import { sendForId, setDataDir as setTelegramDir, telegramReady } from './telegram.mjs';

let dataDir = DATA;
let runDir = RUN;
// The tests point it at a sandbox.
export function setDataDir(dir, run = runDir) {
  dataDir = dir;
  runDir = run;
  setTelegramDir(dir);
}

export const CAPS = {
  chars: 600, stdin: 4000, perMinute: 5, perHour: 30, keyPerHour: 60, dupMs: 10 * 60e3,
  keys: 8, keepMs: 7 * 24 * 3600e3, repliesPerConsole: 50, replyChars: 2000,
};
export const NIGHT = { from: 22, to: 7 };
const ICON = '🖥';

export class TellError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const keysFile = () => join(dataDir, 'tell.json');
const stateFile = () => join(dataDir, 'tell-state.json');

function readJson(file, empty) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : empty();
  } catch {
    return empty();
  }
}

function writeJson(file, v) {
  mkdirSync(dataDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(v)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

const emptyState = () => ({ sent: [], msgs: {}, replies: [], held: [], used: {} });
function readState() {
  const s = readJson(stateFile(), emptyState);
  for (const [k, f] of Object.entries(emptyState())) if (typeof s[k] !== typeof f || Array.isArray(s[k]) !== Array.isArray(f)) s[k] = f;
  return s;
}

// One writer at a time: sshd may run several tell.mjs at once, and the page's server flushes
// held messages and keeps replies. A lock left by a process that died is taken after 30 s.
async function locked(fn) {
  const dir = join(dataDir, 'tell.lock');
  mkdirSync(dataDir, { recursive: true });
  for (let i = 0; ; i++) {
    try {
      mkdirSync(dir);
      break;
    } catch {
      try {
        if (Date.now() - statSync(dir).mtimeMs > 30e3) rmSync(dir, { recursive: true, force: true });
      } catch {}
      if (i > 200) throw new TellError('busy');
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function lockedSync(fn) {
  const dir = join(dataDir, 'tell.lock');
  mkdirSync(dataDir, { recursive: true });
  for (let i = 0; ; i++) {
    try {
      mkdirSync(dir);
      break;
    } catch {
      try {
        if (Date.now() - statSync(dir).mtimeMs > 30e3) rmSync(dir, { recursive: true, force: true });
      } catch {}
      if (i > 2000) throw new TellError('busy');
    }
  }
  try {
    return fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
export const isNight = (now) => {
  const h = new Date(now).getHours();
  return h >= NIGHT.from || h < NIGHT.to;
};
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function log(now, label, console, len, result, id = '') {
  try {
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(join(dataDir, 'tell.log'), `${new Date(now).toISOString()} | ${label} | ${console} | ${len} | ${result} | ${id}\n`, { mode: 0o600 });
  } catch {}
}

function prune(s, now) {
  s.sent = s.sent.filter((x) => now - x.at < 3600e3);
  for (const [id, m] of Object.entries(s.msgs)) if (now - m.at > CAPS.keepMs) delete s.msgs[id];
  s.replies = s.replies.filter((r) => now - r.at < CAPS.keepMs);
}

async function deliver(s, item, now) {
  const text = clip(`${ICON} ${item.console}: ${item.text}`, CAPS.chars);
  const id = await sendForId(text);
  s.msgs[String(id)] = { label: item.label, console: item.console, at: now };
  s.used[item.label] = now;
  return id;
}

// One message from a console: sent, held for the morning, a duplicate, or over the cap.
export async function accept({ label, console, text, now = Date.now() }) {
  if (!telegramReady()) {
    log(now, label, console, text.length, 'no-chat');
    throw new TellError('no-chat');
  }
  return locked(async () => {
    const s = readState();
    prune(s, now);
    const mine = s.sent.filter((x) => x.label === label && x.console === console);
    const h = hash(text);
    if (mine.some((x) => x.hash === h && now - x.at < CAPS.dupMs)) {
      log(now, label, console, text.length, 'duplicate');
      return { result: 'duplicate' };
    }
    if (mine.filter((x) => now - x.at < 60e3).length >= CAPS.perMinute
      || mine.length >= CAPS.perHour
      || s.sent.filter((x) => x.label === label).length >= CAPS.keyPerHour) {
      log(now, label, console, text.length, 'capped');
      writeJson(stateFile(), s);
      return { result: 'capped' };
    }
    s.sent.push({ label, console, at: now, hash: h });
    if (isNight(now)) {
      s.held.push({ label, console, text, at: now });
      writeJson(stateFile(), s);
      log(now, label, console, text.length, 'held');
      return { result: 'held' };
    }
    let id;
    try {
      id = await deliver(s, { label, console, text }, now);
    } catch (err) {
      s.sent.pop();
      writeJson(stateFile(), s);
      log(now, label, console, text.length, `failed:${err.code || 'error'}`);
      throw new TellError('telegram');
    }
    writeJson(stateFile(), s);
    log(now, label, console, text.length, 'sent', id);
    return { result: 'sent' };
  });
}

// From the page's server, every minute: once it is day, the night's messages, oldest first.
// Returns how many went out. One that Telegram refuses stays for the next minute.
export async function flushHeld(now = Date.now()) {
  if (isNight(now) || !telegramReady()) return 0;
  return locked(async () => {
    const s = readState();
    if (!s.held.length) return 0;
    let n = 0;
    while (s.held.length) {
      const item = s.held[0];
      try {
        const id = await deliver(s, item, now);
        log(now, item.label, item.console, item.text.length, 'sent-held', id);
      } catch {
        break;
      }
      s.held.shift();
      n++;
    }
    writeJson(stateFile(), s);
    return n;
  });
}

// From the Telegram poll: the user's Reply to a console's message is kept for that console.
// Returns the console's name, or null when it is not a Reply to one.
export function noteReply(message, now = Date.now()) {
  const id = message?.reply_to_message?.message_id;
  if (id === undefined || typeof message.text !== 'string') return null;
  return lockedSync(() => {
    const s = readState();
    prune(s, now);
    const m = s.msgs[String(id)];
    if (!m) return null;
    s.replies.push({ label: m.label, console: m.console, text: message.text.slice(0, CAPS.replyChars), at: now });
    const theirs = s.replies.filter((r) => r.label === m.label && r.console === m.console);
    if (theirs.length > CAPS.repliesPerConsole) s.replies.splice(s.replies.indexOf(theirs[0]), 1);
    writeJson(stateFile(), s);
    return m.console;
  });
}

// The replies kept for one key's console, oldest first; taken, so each is read once.
export function takeReplies(label, console, now = Date.now()) {
  return lockedSync(() => {
    const s = readState();
    prune(s, now);
    const out = s.replies.filter((r) => r.label === label && r.console === console);
    s.replies = s.replies.filter((r) => !(r.label === label && r.console === console));
    writeJson(stateFile(), s);
    return out.map((r) => ({ at: r.at, text: r.text }));
  });
}

// --- The tell keys (Settings › Telegram › Console messages) ---

const readKeys = () => {
  const v = readJson(keysFile(), () => ({ keys: [] }));
  return Array.isArray(v.keys) ? v.keys.filter((k) => k && NAME_RE.test(k.label)) : [];
};

function apply() {
  // run.sh writes the authorized_keys lines again and starts or stops sshd to match.
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'remote-apply'), '');
}

export function addTellKey({ label, key, from } = {}) {
  if (typeof label !== 'string' || !NAME_RE.test(label)) throw new TellError('bad-label');
  const k = plainKey(key);
  if (!k) throw new TellError('bad-key');
  const hosts = allowFrom(from);
  if (!hosts) throw new TellError('bad-from');
  const keys = readKeys();
  if (keys.some((x) => x.label === label)) throw new TellError('tell-exists');
  if (keys.length >= CAPS.keys) throw new TellError('tell-full');
  keys.push({ label, key: k.line, from: hosts, added: Date.now() });
  writeJson(keysFile(), { keys });
  apply();
}

export function removeTellKey(label) {
  const keys = readKeys();
  if (!keys.some((x) => x.label === label)) throw new TellError('no-tell-key');
  writeJson(keysFile(), { keys: keys.filter((x) => x.label !== label) });
  apply();
}

// sshd's lines: no pty, no forwarding (restrict), only from the key's addresses, and forced
// into this file with the key's name.
export function tellLines() {
  const out = [];
  for (const x of readKeys()) {
    const k = plainKey(x.key);
    const hosts = allowFrom(x.from);
    if (k && hosts) out.push(`from="${hosts}",restrict,command="node /opt/addon-agent/tell.mjs ${x.label}" ssh-ed25519 ${k.blob}`);
  }
  return out;
}

// What the page shows: the keys by name, their addresses and comment, when each last sent,
// and how many messages wait for the morning. Never a key.
export function tellView() {
  const s = readState();
  return {
    keys: readKeys().map((x) => ({
      label: x.label, from: x.from, keyComment: plainKey(x.key)?.comment || null, lastUsed: s.used[x.label] || null,
    })),
    held: s.held.length,
  };
}

// --- The forced command ---

const BAD = 2;
const REFUSED = 3;
class Refusal extends Error {
  constructor(words, exit) {
    super(words);
    this.words = words;
    this.exit = exit;
  }
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const c of process.stdin) {
    size += c.length;
    if (size > CAPS.stdin) throw new Refusal('stdin over its cap', BAD);
    chunks.push(c);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new Refusal('stdin is not text', BAD);
  }
}

export async function main(label = process.argv[2], command = process.env.SSH_ORIGINAL_COMMAND ?? '') {
  try {
    if (typeof label !== 'string' || !NAME_RE.test(label)) throw new Refusal('bad key name', BAD);
    if (typeof command !== 'string' || command.length > 100) throw new Refusal('unknown verb', BAD);
    const [verb, console, ...rest] = command.split(' ');
    if (!['send', 'replies'].includes(verb)) throw new Refusal('unknown verb', BAD);
    if (rest.length || !NAME_RE.test(console || '')) throw new Refusal('bad console name', BAD);
    const now = Number(process.env.ADDON_TELL_NOW) || Date.now();
    if (verb === 'replies') {
      process.stdout.write(`${JSON.stringify({ v: 1, replies: takeReplies(label, console, now) })}\n`);
      return;
    }
    const text = (await readStdin()).replace(/\r?\n$/, '').replace(/\r?\n/g, '\n').trim();
    if (!text) throw new Refusal('nothing to send', BAD);
    if (/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(text)) throw new Refusal('control character', BAD);
    let r;
    try {
      r = await accept({ label, console, text, now });
    } catch (err) {
      if (err?.code === 'no-chat') throw new Refusal('telegram is not set up', REFUSED);
      throw new Refusal('telegram did not take it', REFUSED);
    }
    if (r.result === 'capped') throw new Refusal('over the cap', REFUSED);
    process.stdout.write(`${JSON.stringify({ ok: true, result: r.result })}\n`);
  } catch (err) {
    const r = err instanceof Refusal ? err : new Refusal('it did not go', REFUSED);
    process.stderr.write(`tell: refused: ${r.words}\n`);
    process.exitCode = r.exit;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
