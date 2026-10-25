// Settings › Telegram: the user's own Telegram bot, talking to one chat. The user makes the
// bot in @BotFather (Telegram allows nothing else) and pastes its token on the page; from
// there the app does the rest: checks the token (getMe), fills in the bot's commands and
// description, pairs one private chat by a one-time /start link, sends a test, and can add
// the bot to Home Assistant's own Telegram bot integration in its send-only (broadcast)
// mode, so automations send through it. Telegram lets one program read a bot's updates;
// this app keeps that job and hands Home Assistant what is not for Claude as the same
// telegram_command / telegram_text events HA's integration fires.
//
// /data/telegram.json (0600) holds the token, the bot, the chat, the switches and the
// update offset. The token is never shown, logged or sent anywhere but Telegram (and to
// Home Assistant's own integration when the user turns that on).
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA } from './lib.mjs';

let dataDir = DATA;
// The tests point it at a sandbox.
export function setDataDir(dir) {
  dataDir = dir;
}
const file = () => join(dataDir, 'telegram.json');
const API = () => process.env.ADDON_TELEGRAM_API || 'https://api.telegram.org';
const HA = () => process.env.HA_API || 'http://supervisor/core/api';

export const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
const PAIR_MS = 10 * 60e3;
const TEXT_CAP = 3500;
export const PREFS = { routines: true, waiting: true, login: true, typeToClaude: false };
// The bot's own commands; any other command goes to Home Assistant.
const COMMANDS = [
  { command: 'status', description: 'Is Claude working, waiting or idle' },
  { command: 'routines', description: 'Your routines and their last results' },
  { command: 'run', description: 'Run a routine: /run 1 or /run its name' },
  { command: 'stop', description: 'Stop what Claude is doing (Esc)' },
];

export class TelegramError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function read() {
  try {
    const v = JSON.parse(readFileSync(file(), 'utf8'));
    return v && typeof v === 'object' && typeof v.token === 'string' ? v : null;
  } catch {
    return null;
  }
}

function write(v) {
  mkdirSync(dataDir, { recursive: true });
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(v)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file());
}

function update(fn) {
  const v = read();
  if (!v) throw new TelegramError('no-bot');
  fn(v);
  write(v);
  return v;
}

// One Bot API call. Errors never carry the token (it is in the URL).
async function call(token, method, params = {}, timeoutMs = 15000) {
  let r;
  try {
    r = await fetch(`${API()}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new TelegramError('no-network');
  }
  const j = await r.json().catch(() => null);
  if (r.status === 401 || r.status === 404) throw new TelegramError('token-refused');
  if (r.status === 409) throw new TelegramError('busy');
  if (!j?.ok) throw new TelegramError('telegram-error');
  return j.result;
}

const clip = (s, n = TEXT_CAP) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

export async function send(text, extra = {}) {
  const v = read();
  if (!v?.chat) return false;
  await call(v.token, 'sendMessage', { chat_id: v.chat.id, text: clip(text), ...extra });
  return true;
}

// What the page shows. Never the token or the chat's id.
export function telegramView(now = Date.now()) {
  const v = read();
  if (!v) return { step: 'off', bot: null, chat: null, pairing: null, prefs: { ...PREFS }, ha: { on: false, entity: null } };
  const pairing = v.pairing && v.pairing.until > now && v.bot
    ? { link: `https://t.me/${v.bot.username}?start=${v.pairing.code}`, until: v.pairing.until } : null;
  return {
    step: v.chat ? 'on' : 'pair',
    bot: v.bot ? { username: v.bot.username, name: v.bot.name } : null,
    chat: v.chat ? { name: v.chat.name } : null,
    pairing,
    prefs: { ...PREFS, ...v.prefs },
    ha: { on: Boolean(v.ha?.entryId), entity: v.ha?.entity || null },
  };
}

// Step 2: the token from BotFather. Checked by shape first (nothing leaves for a typo),
// then by Telegram; the bot's commands and description are filled in.
export async function saveToken(raw) {
  const token = typeof raw === 'string' ? raw.trim() : '';
  if (!TOKEN_RE.test(token)) throw new TelegramError('bad-token');
  const me = await call(token, 'getMe');
  if (!me?.is_bot || typeof me.username !== 'string') throw new TelegramError('token-refused');
  const bot = { id: me.id, username: me.username, name: String(me.first_name || me.username) };
  await call(token, 'setMyCommands', { commands: COMMANDS }).catch(() => {});
  await call(token, 'setMyDescription', {
    description: 'Your Home Assistant\'s AI Intervention app: routine results, Claude waiting for your OK, and your automations\' messages. It answers only the chat it was paired with.',
  }).catch(() => {});
  await call(token, 'setMyShortDescription', { short_description: 'Messages from your Home Assistant\'s AI Intervention app.' }).catch(() => {});
  const old = read();
  write({ token, bot, chat: null, pairing: null, offset: 0, prefs: old?.prefs || { ...PREFS }, ha: null });
  return { username: bot.username, name: bot.name };
}

// Step 3: a one-time code in a /start link; the first private /start with it pairs that chat.
export function startPairing(now = Date.now()) {
  const v = update((x) => {
    x.pairing = { code: randomBytes(12).toString('hex'), until: now + PAIR_MS };
  });
  return { link: `https://t.me/${v.bot.username}?start=${v.pairing.code}`, until: v.pairing.until };
}

export function savePrefs(p = {}) {
  const prefs = {};
  for (const k of Object.keys(PREFS)) {
    if (typeof p[k] !== 'boolean') throw new TelegramError('bad-prefs');
    prefs[k] = p[k];
  }
  update((x) => {
    x.prefs = prefs;
  });
}

export async function sendTest() {
  if (!(await send("Hello from AI Intervention. This is where I'll tell you about your home."))) throw new TelegramError('no-chat');
}

// Home Assistant's event for a message, in the shape its own Telegram bot integration uses.
async function fireEvent(type, message, extra) {
  const from = message.from || {};
  const data = {
    ...extra,
    chat_id: message.chat?.id,
    user_id: from.id,
    from_first: from.first_name || '',
    from_last: from.last_name || '',
    id: message.message_id,
    date: message.date,
  };
  try {
    await fetch(`${HA()}/events/${type}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN || ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(10000),
    });
  } catch {}
}

const STATE_WORDS = {
  busy: 'Claude is working.',
  working: 'Claude is working.',
  blocked: 'Claude is waiting for your OK.',
  idle: 'Claude is at its prompt.',
  done: 'Claude is at its prompt.',
  waiting: 'Claude has stopped; press Enter in the Console to start it again.',
  shell: 'The Console is in its shell.',
  off: 'The Console is Off-Duty.',
};

function routineLine(r, i) {
  const last = r.last ? (r.last.ok ? `✓ ${r.last.summary}` : `✖ ${r.last.summary}`) : 'not run yet';
  return `${i + 1}. ${r.name} (${r.scheduleLabel}): ${last}`;
}

async function command(v, message, ctx) {
  const [cmd, ...args] = message.text.trim().split(/\s+/);
  const name = cmd.split('@')[0].toLowerCase();
  if (name === '/status') {
    const seat = ctx.seat();
    const state = STATE_WORDS[await ctx.consoleState()] || 'The Console is starting.';
    return send(`${state}\nSeat: ${seat.signedIn ? `signed in${seat.plan ? ` (${seat.plan})` : ''}` : 'signed out'}.`);
  }
  if (name === '/routines') {
    const list = ctx.listRoutines();
    return send(list.length ? list.map(routineLine).join('\n') : 'No routines yet. Make one by asking Claude in the Console.');
  }
  if (name === '/run') {
    const list = ctx.listRoutines();
    const want = args.join(' ').toLowerCase();
    const r = /^\d+$/.test(want) ? list[Number(want) - 1] : list.find((x) => x.name.toLowerCase() === want || x.id === want);
    if (!r) return send(`Which one? ${list.length ? list.map((x, i) => `${i + 1}. ${x.name}`).join(', ') : 'There are no routines yet.'}`);
    await send(`Running ${r.name} (report only)…`);
    ctx.runRoutine(r.id)
      .then((res) => send(`${r.name}: ${res.summary}${res.fixes ? `\n${res.fixes} fix${res.fixes === 1 ? '' : 'es'} waiting: Apply in Console on Settings › Routines.` : ''}`))
      .catch(() => send(`${r.name} did not run (another may be running). Try again in a minute.`));
    return;
  }
  if (name === '/stop') {
    await ctx.pressKey('esc');
    return send('Sent Esc to Claude.');
  }
  return fireEvent('telegram_command', message, { command: name, args });
}

async function handle(u, ctx, now) {
  const v = read();
  if (!v) return;
  const cb = u.callback_query;
  if (cb) {
    if (!v.chat || cb.message?.chat?.id !== v.chat.id) return;
    await call(v.token, 'answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
    if ((cb.data === 'ok:yes' || cb.data === 'ok:no') && (await ctx.consoleState()) === 'blocked') {
      await ctx.pressKey(cb.data === 'ok:yes' ? 'enter' : 'esc');
      await send(cb.data === 'ok:yes' ? 'Said yes.' : 'Said no.');
    }
    return;
  }
  const message = u.message;
  if (!message || typeof message.text !== 'string') return;
  if (!v.chat) {
    // Pairing: only "/start <code>" in a private chat, before the code runs out.
    const m = message.text.match(/^\/start(?:@\w+)? ([A-Za-z0-9_-]{16,64})$/);
    if (m && message.chat?.type === 'private' && v.pairing && v.pairing.until > now && m[1] === v.pairing.code) {
      const chat = { id: message.chat.id, name: String(message.chat.first_name || message.from?.first_name || 'you').slice(0, 40) };
      update((x) => {
        x.chat = chat;
        x.pairing = null;
      });
      await send(`Connected. I'll message you here about your home, ${chat.name}. Commands: /status, /routines, /run, /stop.`);
    }
    return;
  }
  if (message.chat?.id !== v.chat.id) return;
  if (message.text.startsWith('/')) {
    // A second /start (the chat is already paired) is ignored; the rest are commands.
    const head = message.text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();
    return head === '/start' ? undefined : command(v, message, ctx);
  }
  if (v.prefs?.typeToClaude) {
    const typed = await ctx.typeIntoConsole(message.text.replace(/[\n\r\t]/g, ' ').slice(0, 2000));
    return send(typed === 'typed' ? 'Typed into the Console.' : `Not typed: ${STATE_WORDS[await ctx.consoleState()] || 'the Console is not ready.'}`);
  }
  return fireEvent('telegram_text', message, { text: message.text });
}

// One long poll: read updates after the last one seen, handle each, confirm them.
export async function pollOnce(ctx, { timeout = 25, now = Date.now() } = {}) {
  const v = read();
  if (!v) return false;
  const updates = await call(v.token, 'getUpdates', {
    offset: v.offset || 0,
    timeout,
    allowed_updates: ['message', 'callback_query'],
  }, (timeout + 10) * 1000);
  let offset = v.offset || 0;
  for (const u of updates || []) {
    offset = Math.max(offset, (u.update_id || 0) + 1);
    try {
      await handle(u, ctx, now);
    } catch {}
  }
  if (offset !== (v.offset || 0)) {
    const again = read();
    if (again) {
      again.offset = offset;
      write(again);
    }
  }
  return true;
}

// A message when a switch is on: "routines", "waiting" or "login".
export async function notify(kind, text, extra) {
  const v = read();
  if (!v?.chat || !{ ...PREFS, ...v.prefs }[kind]) return false;
  return send(text, extra).catch(() => false);
}

// Every few seconds: Claude waiting for an OK (once per wait, with Yes / No), and a login
// that ran out (once).
const seen = { blocked: false, lapsed: false };
export async function watch(ctx) {
  const v = read();
  if (!v?.chat) return;
  const blocked = (await ctx.consoleState()) === 'blocked';
  if (blocked && !seen.blocked) {
    const lines = ctx.screen ? (await ctx.screen()).filter((l) => l.trim()).slice(-12).join('\n') : '';
    await notify('waiting', `Claude is waiting for your OK.${lines ? `\n\n${lines}` : ''}`, {
      reply_markup: { inline_keyboard: [[{ text: 'Yes', callback_data: 'ok:yes' }, { text: 'No', callback_data: 'ok:no' }]] },
    });
  }
  seen.blocked = blocked;
  const lapsed = Boolean(ctx.seat?.().lapsed);
  if (lapsed && !seen.lapsed) await notify('login', 'The Claude login ran out. Sign in again on Settings › Seat.');
  seen.lapsed = lapsed;
}

async function haCall(method, path, body) {
  const r = await fetch(`${HA()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN || ''}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  }).catch(() => null);
  if (!r) throw new TelegramError('no-ha');
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new TelegramError('ha-refused');
  return j;
}

async function notifyEntities() {
  const states = await haCall('GET', '/states');
  return new Set((states || []).map((s) => s.entity_id).filter((id) => typeof id === 'string' && id.startsWith('notify.')));
}

// Step 5: Home Assistant's own Telegram bot integration, send-only (broadcast), with the
// paired chat allowed; the notify entity it makes is found by what is new. Off removes it.
export async function setHa(on) {
  const v = read();
  if (!v) throw new TelegramError('no-bot');
  if (!on) {
    if (v.ha?.entryId) await haCall('DELETE', `/config/config_entries/entry/${encodeURIComponent(v.ha.entryId)}`).catch(() => {});
    update((x) => {
      x.ha = null;
    });
    return { on: false, entity: null };
  }
  if (!v.chat) throw new TelegramError('no-chat');
  if (v.ha?.entryId) return { on: true, entity: v.ha.entity || null };
  const before = await notifyEntities().catch(() => new Set());
  const flow = await haCall('POST', '/config/config_entries/flow', { handler: 'telegram_bot' });
  const done = await haCall('POST', `/config/config_entries/flow/${encodeURIComponent(flow.flow_id)}`, {
    platform: 'broadcast',
    api_key: v.token,
    additional_settings: { api_endpoint: 'https://api.telegram.org' },
  });
  if (done?.type !== 'create_entry' || !done.result?.entry_id) {
    throw new TelegramError(done?.reason === 'already_configured' ? 'ha-already' : 'ha-refused');
  }
  const entryId = done.result.entry_id;
  const sub = await haCall('POST', '/config/config_entries/subentries/flow', { handler: [entryId, 'allowed_chat_ids'] });
  await haCall('POST', `/config/config_entries/subentries/flow/${encodeURIComponent(sub.flow_id)}`, { chat_id: v.chat.id });
  let entity = null;
  for (let i = 0; i < 10 && !entity; i++) {
    const after = await notifyEntities().catch(() => new Set());
    entity = [...after].find((id) => !before.has(id)) || null;
    if (!entity) await new Promise((r) => setTimeout(r, Number(process.env.ADDON_HA_WAIT_MS) || 500));
  }
  update((x) => {
    x.ha = { entryId, entity };
  });
  return { on: true, entity };
}

// Forget the bot: out of Home Assistant too, and the file gone. The token itself stays valid
// at Telegram until the user sends /revoke to @BotFather (the page says so).
export async function forget() {
  const v = read();
  if (v?.ha?.entryId) await setHa(false).catch(() => {});
  rmSync(file(), { force: true });
}
