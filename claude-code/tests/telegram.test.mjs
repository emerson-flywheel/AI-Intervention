// Telegram (0.4.2): the user's own bot, set up from Settings › Telegram. The user makes the
// bot in @BotFather and pastes its token here; the app checks it, fills in its commands,
// pairs one chat by a one-time Start link, sends a test, and can add it to Home Assistant
// (send-only) for automations. A stand-in Telegram API and a stand-in Home Assistant here.
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { sandbox } from './helpers.mjs';

const TOKEN = '123456789:AAExampleExampleExampleExample_abcd';
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const body = (req) => new Promise((r) => {
  let d = '';
  req.on('data', (c) => (d += c));
  req.on('end', () => r(d ? JSON.parse(d) : {}));
});

describe('telegram', () => {
  let tg;
  let ha;
  let tgCalls;
  let haCalls;
  let updates;
  let refuseToken;
  let sb;
  let t;
  let ctx;
  let ctxCalls;

  before(async () => {
    tg = http.createServer(async (req, res) => {
      const m = req.url.match(/^\/bot([^/]+)\/(\w+)$/);
      const params = await body(req);
      tgCalls.push({ token: m?.[1], method: m?.[2], params });
      const ok = (result) => res.end(JSON.stringify({ ok: true, result }));
      if (!m || m[1] !== TOKEN || refuseToken) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }));
      }
      if (m[2] === 'getMe') return ok({ id: 42, is_bot: true, first_name: 'Home helper', username: 'my_home_helper_bot' });
      if (m[2] === 'getUpdates') return ok(updates.splice(0));
      if (m[2] === 'sendMessage') return ok({ message_id: tgCalls.length });
      return ok(true);
    });
    ha = http.createServer(async (req, res) => {
      const b = await body(req);
      haCalls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: b });
      const json = (v) => res.end(JSON.stringify(v));
      if (req.url === '/api/config/config_entries/flow' && req.method === 'POST') return json({ flow_id: 'f1', type: 'form', step_id: 'user' });
      if (req.url === '/api/config/config_entries/flow/f1') return json({ type: 'create_entry', result: { entry_id: 'e1', title: 'Home helper' } });
      if (req.url === '/api/config/config_entries/subentries/flow' && req.method === 'POST') return json({ flow_id: 's1', type: 'form', step_id: 'user' });
      if (req.url === '/api/config/config_entries/subentries/flow/s1') return json({ type: 'create_entry' });
      if (req.url === '/api/states') {
        return json(haCalls.some((c) => c.url.endsWith('/subentries/flow/s1'))
          ? [{ entity_id: 'notify.home_helper_sam' }, { entity_id: 'light.porch' }] : [{ entity_id: 'light.porch' }]);
      }
      if (req.url.startsWith('/api/events/')) return json({ message: 'Event fired.' });
      if (req.url === '/api/config/config_entries/entry/e1' && req.method === 'DELETE') return json({ require_restart: false });
      res.statusCode = 404;
      return json({});
    });
    const tgPort = await listen(tg);
    const haPort = await listen(ha);
    process.env.ADDON_TELEGRAM_API = `http://127.0.0.1:${tgPort}`;
    process.env.HA_API = `http://127.0.0.1:${haPort}/api`;
    process.env.SUPERVISOR_TOKEN = 'supervisor-test-token';
  });
  after(() => {
    tg.close();
    ha.close();
    delete process.env.ADDON_TELEGRAM_API;
  });

  async function fresh() {
    tgCalls = [];
    haCalls = [];
    updates = [];
    refuseToken = false;
    sb = sandbox();
    t = await import(`../rootfs/opt/addon-agent/telegram.mjs?${Date.now()}${Math.random()}`);
    t.setDataDir(sb.data);
    ctxCalls = [];
    ctx = {
      consoleState: async () => 'idle',
      typeIntoConsole: async (line) => {
        ctxCalls.push(['type', line]);
        return 'typed';
      },
      pressKey: async (key) => ctxCalls.push(['key', key]),
      listRoutines: () => [{ id: 'morning', name: 'Morning health check', scheduleLabel: 'Every day 7:00 AM', last: { ok: true, summary: 'all fine', fixes: 0 } }],
      runRoutine: async (id) => {
        ctxCalls.push(['run', id]);
        return { ok: true, summary: 'all fine', fixes: 0 };
      },
      seat: () => ({ signedIn: true, plan: 'max' }),
    };
  }
  const sent = () => tgCalls.filter((c) => c.method === 'sendMessage').map((c) => c.params);
  const msg = (text, from = 555, chat = 555) => ({ update_id: Math.floor(Math.random() * 1e6), message: { message_id: 1, date: 1761400000, text, chat: { id: chat, type: 'private', first_name: 'Sam' }, from: { id: from, first_name: 'Sam', last_name: 'L' } } });

  test('the token: its shape checked, then getMe; commands and descriptions filled in; kept 0600 and never shown', async () => {
    await fresh();
    await assert.rejects(t.saveToken('not a token'), { code: 'bad-token' });
    assert.equal(tgCalls.length, 0, 'a bad shape never reaches Telegram');
    refuseToken = true;
    await assert.rejects(t.saveToken(TOKEN), { code: 'token-refused' });
    refuseToken = false;
    const bot = await t.saveToken(` ${TOKEN} `);
    assert.deepEqual(bot, { username: 'my_home_helper_bot', name: 'Home helper' });
    const methods = tgCalls.map((c) => c.method);
    for (const m of ['getMe', 'setMyCommands', 'setMyDescription', 'setMyShortDescription']) assert.ok(methods.includes(m), m);
    assert.deepEqual(tgCalls.find((c) => c.method === 'setMyCommands').params.commands.map((c) => c.command), ['status', 'routines', 'run', 'stop']);
    const file = join(sb.data, 'telegram.json');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const view = t.telegramView();
    assert.deepEqual([view.bot.username, view.chat, view.step], ['my_home_helper_bot', null, 'pair']);
    assert.ok(!JSON.stringify(view).includes(TOKEN.split(':')[1]), 'the token is never in the view');
    sb.cleanup();
  });

  test('pairing: only /start with the one-time code, in a private chat, before it runs out; then only that chat is answered', async () => {
    await fresh();
    await t.saveToken(TOKEN);
    const { link } = t.startPairing();
    const code = link.match(/^https:\/\/t\.me\/my_home_helper_bot\?start=([A-Za-z0-9_-]{16,64})$/)[1];
    updates.push(msg('/start wrong-code-000000000000'), { ...msg(`/start ${code}`), message: { ...msg(`/start ${code}`).message, chat: { id: -100, type: 'group' } } });
    await t.pollOnce(ctx, { timeout: 0 });
    assert.equal(t.telegramView().chat, null, 'a wrong code or a group pairs nothing');
    assert.equal(sent().length, 0, 'and gets no answer');
    updates.push(msg(`/start ${code}`));
    await t.pollOnce(ctx, { timeout: 0 });
    assert.deepEqual(t.telegramView().chat, { name: 'Sam' });
    assert.equal(sent().at(-1).chat_id, 555);
    assert.match(sent().at(-1).text, /Connected/);
    assert.equal(t.telegramView().pairing, null, 'the code is used up');

    const before = sent().length;
    updates.push(msg('/status', 999, 999));
    await t.pollOnce(ctx, { timeout: 0 });
    assert.equal(sent().length, before, 'another chat gets nothing');
    const getUpdates = tgCalls.filter((c) => c.method === 'getUpdates');
    assert.ok(getUpdates.at(-1).params.offset > 0, 'updates are confirmed');
    sb.cleanup();
  });

  test('a code that ran out pairs nothing', async () => {
    await fresh();
    await t.saveToken(TOKEN);
    const { link } = t.startPairing(Date.now() - 11 * 60e3);
    updates.push(msg(`/start ${link.split('=')[1]}`));
    await t.pollOnce(ctx, { timeout: 0 });
    assert.equal(t.telegramView().chat, null);
    sb.cleanup();
  });

  async function paired() {
    await fresh();
    await t.saveToken(TOKEN);
    const { link } = t.startPairing();
    updates.push(msg(`/start ${link.split('=')[1]}`));
    await t.pollOnce(ctx, { timeout: 0 });
  }

  test('commands: /status, /routines, /run, /stop answered here; any other command and plain text go to Home Assistant as events', async () => {
    await paired();
    updates.push(msg('/status'), msg('/routines'), msg('/run 1'), msg('/stop'), msg('/garage open'), msg('hello there'));
    await t.pollOnce(ctx, { timeout: 0 });
    await new Promise((r) => setTimeout(r, 50));
    const texts = sent().map((s) => s.text).join('\n---\n');
    assert.match(texts, /Claude is at its prompt/);
    assert.match(texts, /1\. Morning health check/);
    assert.match(texts, /Morning health check: all fine/);
    assert.deepEqual(ctxCalls.filter((c) => c[0] !== 'type'), [['run', 'morning'], ['key', 'esc']]);
    const events = haCalls.filter((c) => c.url.startsWith('/api/events/'));
    assert.deepEqual(events.map((e) => e.url), ['/api/events/telegram_command', '/api/events/telegram_text']);
    assert.deepEqual([events[0].body.command, events[0].body.args, events[0].body.chat_id, events[0].body.from_first], ['/garage', ['open'], 555, 'Sam']);
    assert.equal(events[1].body.text, 'hello there');
    assert.equal(events[0].auth, 'Bearer supervisor-test-token');
    assert.equal(ctxCalls.filter((c) => c[0] === 'type').length, 0, 'typing to Claude is off by default');

    t.savePrefs({ routines: true, waiting: true, login: true, typeToClaude: true });
    updates.push(msg('check the porch light'));
    await t.pollOnce(ctx, { timeout: 0 });
    assert.deepEqual(ctxCalls.at(-1), ['type', 'check the porch light']);
    sb.cleanup();
  });

  test('Claude waiting for an OK: one message with Yes / No; the press is Enter or Esc in the Console', async () => {
    await paired();
    const before = sent().length;
    await t.watch({ ...ctx, consoleState: async () => 'blocked', screen: async () => ['Do you want to make this edit?', '❯ 1. Yes', '  2. No'] });
    await t.watch({ ...ctx, consoleState: async () => 'blocked', screen: async () => [] });
    const asks = sent().slice(before);
    assert.equal(asks.length, 1, 'once per wait');
    assert.match(asks[0].text, /waiting for your OK/);
    assert.deepEqual(asks[0].reply_markup.inline_keyboard[0].map((b) => b.callback_data), ['ok:yes', 'ok:no']);
    updates.push({ update_id: 900001, callback_query: { id: 'q1', data: 'ok:yes', from: { id: 555 }, message: { chat: { id: 555 } } } });
    await t.pollOnce({ ...ctx, consoleState: async () => 'blocked' }, { timeout: 0 });
    assert.deepEqual(ctxCalls.at(-1), ['key', 'enter']);
    assert.ok(tgCalls.some((c) => c.method === 'answerCallbackQuery'));
    updates.push({ update_id: 900002, callback_query: { id: 'q2', data: 'ok:no', from: { id: 999 }, message: { chat: { id: 999 } } } });
    await t.pollOnce({ ...ctx, consoleState: async () => 'blocked' }, { timeout: 0 });
    assert.deepEqual(ctxCalls.at(-1), ['key', 'enter'], 'a press from another chat does nothing');

    t.savePrefs({ routines: true, waiting: false, login: true, typeToClaude: false });
    await t.watch({ ...ctx, consoleState: async () => 'idle' });
    const n = sent().length;
    await t.watch({ ...ctx, consoleState: async () => 'blocked', screen: async () => [] });
    assert.equal(sent().length, n, 'switched off: nothing sent');
    sb.cleanup();
  });

  test('notify: a routine result and a login that ran out, each only when switched on', async () => {
    await paired();
    const n = sent().length;
    await t.notify('routines', 'Morning health check: all fine');
    await t.watch({ ...ctx, seat: () => ({ signedIn: false, lapsed: true }) });
    await t.watch({ ...ctx, seat: () => ({ signedIn: false, lapsed: true }) });
    assert.deepEqual(sent().slice(n).map((s) => s.text.split('\n')[0]), ['Morning health check: all fine', 'The Claude login ran out. Sign in again on Settings › Seat.']);
    t.savePrefs({ routines: false, waiting: true, login: true, typeToClaude: false });
    await t.notify('routines', 'x');
    assert.equal(sent().length, n + 2);
    sb.cleanup();
  });

  test('Home Assistant: its own Telegram bot integration, send-only, for the paired chat; the new notify entity found; off removes it', async () => {
    await paired();
    const r = await t.setHa(true);
    assert.deepEqual(r, { on: true, entity: 'notify.home_helper_sam' });
    const create = haCalls.find((c) => c.url === '/api/config/config_entries/flow' && c.method === 'POST');
    assert.deepEqual(create.body, { handler: 'telegram_bot' });
    const step = haCalls.find((c) => c.url === '/api/config/config_entries/flow/f1');
    assert.deepEqual(step.body, { platform: 'broadcast', api_key: TOKEN, additional_settings: { api_endpoint: 'https://api.telegram.org' } });
    const sub = haCalls.find((c) => c.url === '/api/config/config_entries/subentries/flow' && c.method === 'POST');
    assert.deepEqual(sub.body, { handler: ['e1', 'allowed_chat_ids'] });
    assert.deepEqual(haCalls.find((c) => c.url.endsWith('/subentries/flow/s1')).body, { chat_id: 555 });
    assert.deepEqual(t.telegramView().ha, { on: true, entity: 'notify.home_helper_sam' });
    assert.deepEqual(await t.setHa(false), { on: false, entity: null });
    assert.ok(haCalls.some((c) => c.method === 'DELETE' && c.url === '/api/config/config_entries/entry/e1'));
    sb.cleanup();
  });

  test('forget: the bot leaves Home Assistant too, and the file is gone', async () => {
    await paired();
    await t.setHa(true);
    await t.forget();
    assert.ok(haCalls.some((c) => c.method === 'DELETE' && c.url === '/api/config/config_entries/entry/e1'));
    assert.equal(t.telegramView().step, 'off');
    assert.throws(() => readFileSync(join(sb.data, 'telegram.json')));
    writeFileSync(join(sb.data, 'telegram.json'), 'not json');
    assert.equal(t.telegramView().step, 'off', 'an unreadable file is no bot');
    sb.cleanup();
  });
});
