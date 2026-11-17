// Settings › Bots (0.4.5): other AI agents (grokbot first) reach Home Assistant through the
// app, never with a Home Assistant token of their own. Each bot has a name, its own key and
// a level:
//   admin    (the default) every HA action and service, the Supervisor, config files
//   control  read and control the entities in the areas or labels picked; nothing else
//   read     states, history and logbook of the entities in the areas or labels picked
// The key is shown once when it is made; /data/bots.json (0600) keeps only its sha256.
// Pause stops a bot at once and keeps it; Remove deletes it; New key retires the old key.
// Only the page (ingress) changes bots: the Bots door (door.mjs) only reads them.
//
// Wrong keys: each one is answered more slowly, and after LOCK.fails in LOCK.windowMs the
// whole door refuses every call, a right key too, for LOCK.blockMs. /data/bots.log has one
// JSON line per call: time, bot, action, target, result. Never a key.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DATA, NAME_RE } from './lib.mjs';

let dataDir = DATA;
// The tests point it at a sandbox, and move the clock.
export function setDataDir(dir) {
  dataDir = dir;
  failures = [];
  blockedUntil = 0;
}
export const getDataDir = () => dataDir;
let clock = () => Date.now();
export function setClock(fn) {
  clock = fn;
}

export const LEVELS = ['admin', 'control', 'read'];
export const LOCK = { fails: 10, windowMs: 10 * 60e3, blockMs: 15 * 60e3 };
const CAPS = { bots: 16, scope: 32, logBytes: 1 << 20 };
// An area or label id as Home Assistant makes them.
const SCOPE_RE = /^[a-z0-9_]{1,64}$/;
const KEY_PREFIX = 'aib_';

export class BotsError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const file = () => join(dataDir, 'bots.json');
const logFile = () => join(dataDir, 'bots.log');
const hash = (key) => createHash('sha256').update(key).digest('hex');

function readAll() {
  try {
    const v = JSON.parse(readFileSync(file(), 'utf8'));
    const bots = Array.isArray(v?.bots) ? v.bots.filter((b) => b && NAME_RE.test(b.name) && LEVELS.includes(b.level)) : [];
    return { bots, used: v?.used && typeof v.used === 'object' ? v.used : {} };
  } catch {
    return { bots: [], used: {} };
  }
}

function writeAll(v) {
  mkdirSync(dataDir, { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(v)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file());
}

function scopeList(list) {
  if (list === undefined || list === null || list === '') return [];
  const items = Array.isArray(list) ? list : String(list).split(',');
  const out = [...new Set(items.map((x) => String(x).trim()).filter(Boolean))];
  if (out.length > CAPS.scope || !out.every((x) => SCOPE_RE.test(x))) throw new BotsError('bad-scope');
  return out;
}

// The level and what it covers. Admin covers everything; the others need an area or a label.
function levelOf({ level = 'admin', areas, labels } = {}) {
  if (!LEVELS.includes(level)) throw new BotsError('bad-level');
  if (level === 'admin') return { level, areas: [], labels: [] };
  const a = scopeList(areas);
  const l = scopeList(labels);
  if (!a.length && !l.length) throw new BotsError('no-scope');
  return { level, areas: a, labels: l };
}

const makeKey = () => `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;

function find(v, name) {
  const b = v.bots.find((x) => x.name === name);
  if (!b) throw new BotsError('no-bot');
  return b;
}

// A new bot: its key comes back here, once.
export function addBot({ name, level, areas, labels } = {}) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new BotsError('bad-name');
  const lv = levelOf({ level, areas, labels });
  const v = readAll();
  if (v.bots.some((b) => b.name === name)) throw new BotsError('bot-exists');
  if (v.bots.length >= CAPS.bots) throw new BotsError('bots-full');
  const key = makeKey();
  v.bots.push({ name, ...lv, keyHash: hash(key), paused: false, added: clock() });
  writeAll(v);
  return { key };
}

export function setLevel(name, opts = {}) {
  const v = readAll();
  Object.assign(find(v, name), levelOf(opts));
  writeAll(v);
}

export function pauseBot(name, paused) {
  const v = readAll();
  find(v, name).paused = paused === true;
  writeAll(v);
}

export function newKey(name) {
  const v = readAll();
  const key = makeKey();
  find(v, name).keyHash = hash(key);
  writeAll(v);
  return { key };
}

export function removeBot(name) {
  const v = readAll();
  find(v, name);
  v.bots = v.bots.filter((b) => b.name !== name);
  delete v.used[name];
  writeAll(v);
}

// The door listens only while at least one bot is not paused.
export function doorWanted() {
  return readAll().bots.some((b) => !b.paused);
}

// --- The door's check of a key ---

let failures = [];
let blockedUntil = 0;

// Milliseconds to wait before answering a wrong key: longer with each recent one.
export function slowFor() {
  const unit = Number(process.env.ADDON_BOTS_SLOW_MS ?? 250);
  return Math.min(unit * failures.length, 5000);
}

// { bot } for a right key of a bot that is not paused; otherwise { refused } with why:
// no-key, bad-key (a wrong key, or a paused or removed bot's) or blocked.
export function authenticate(header) {
  const now = clock();
  if (blockedUntil > now) return { refused: 'blocked' };
  failures = failures.filter((t) => now - t < LOCK.windowMs);
  const m = /^Bearer\s+(\S+)$/i.exec(typeof header === 'string' ? header.trim() : '');
  if (!m) return { refused: 'no-key' };
  const want = Buffer.from(hash(m[1]), 'hex');
  const bot = readAll().bots.find((b) => {
    const have = Buffer.from(String(b.keyHash), 'hex');
    return have.length === want.length && timingSafeEqual(have, want);
  });
  if (bot && !bot.paused) return { bot };
  failures.push(now);
  if (failures.length >= LOCK.fails) {
    blockedUntil = now + LOCK.blockMs;
    failures = [];
  }
  return { refused: 'bad-key' };
}

// --- The log ---

export function logCall({ bot = null, action, target = '', result }) {
  const at = clock();
  try {
    mkdirSync(dataDir, { recursive: true });
    try {
      if (statSync(logFile()).size > CAPS.logBytes) {
        const lines = readFileSync(logFile(), 'utf8').split('\n');
        writeFileSync(logFile(), lines.slice(Math.floor(lines.length / 2)).join('\n'), { mode: 0o600 });
      }
    } catch {}
    appendFileSync(logFile(), `${JSON.stringify({ at, bot, action: String(action).slice(0, 60), target: String(target).slice(0, 200), result })}\n`, { mode: 0o600 });
  } catch {}
  if (bot && result === 'allowed') {
    const v = readAll();
    if (v.bots.some((b) => b.name === bot)) {
      v.used[bot] = at;
      writeAll(v);
    }
  }
}

export function readLog(n = 50) {
  try {
    return readFileSync(logFile(), 'utf8').trim().split('\n').filter(Boolean).slice(-n).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

// What the page shows: the bots, the door, the block, the latest calls. Never a key or hash.
export function botsView() {
  const v = readAll();
  const now = clock();
  return {
    bots: v.bots.map((b) => ({
      name: b.name, level: b.level, areas: b.areas, labels: b.labels, paused: b.paused, added: b.added, lastUsed: v.used[b.name] || null,
    })),
    open: v.bots.some((b) => !b.paused),
    blockedUntil: blockedUntil > now ? blockedUntil : null,
    log: readLog(50),
  };
}
