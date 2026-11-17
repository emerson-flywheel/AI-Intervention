// Console messages (0.4.4): a tell key may only hand over a short message (or read the
// replies to its own), which the app sends from the user's Telegram bot. Caps per console,
// a duplicate drop, night hours held to 7:00, a log without the text, and the user's
// Telegram Reply kept for the console that sent the message. A stand-in Telegram here.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { runNode, sandbox } from './helpers.mjs';

const TOKEN = '123456789:AAExampleExampleExampleExample_abcd';
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl box@ws';
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const body = (req) => new Promise((r) => {
  let d = '';
  req.on('data', (c) => (d += c));
  req.on('end', () => r(d ? JSON.parse(d) : {}));
});
// local times, so the night rule reads the same in any time zone
const DAY = new Date(2026, 10, 16, 14, 0).getTime();
const NIGHT = new Date(2026, 10, 16, 23, 0).getTime();
const MORNING = new Date(2026, 10, 17, 7, 5).getTime();

describe('console messages', () => {
  let tg;
  let tgPort;
  let sent;
  let sb;
  let tell;
  let tgm;

  before(async () => {
    tg = http.createServer(async (req, res) => {
      const m = req.url.match(/^\/bot([^/]+)\/(\w+)$/);
      const params = await body(req);
      if (!m || m[1] !== TOKEN) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ ok: false }));
      }
      if (m[2] === 'sendMessage') {
        sent.push(params);
        return res.end(JSON.stringify({ ok: true, result: { message_id: 1000 + sent.length } }));
      }
      return res.end(JSON.stringify({ ok: true, result: true }));
    });
    tgPort = await listen(tg);
    process.env.ADDON_TELEGRAM_API = `http://127.0.0.1:${tgPort}`;
  });
  after(() => {
    tg.close();
    delete process.env.ADDON_TELEGRAM_API;
  });

  beforeEach(async () => {
    sent = [];
    sb = sandbox();
    writeFileSync(join(sb.data, 'telegram.json'), JSON.stringify({
      token: TOKEN, bot: { id: 42, username: 'home_bot', name: 'Home' }, chat: { id: 777, name: 'Alex' }, offset: 0, prefs: {},
    }));
    const q = `?${Date.now()}${Math.random()}`;
    tell = await import(`../rootfs/opt/addon-agent/tell.mjs${q}`);
    tgm = await import(`../rootfs/opt/addon-agent/telegram.mjs${q}`);
    tell.setDataDir(sb.data, sb.run);
    tgm.setDataDir(sb.data);
  });

  const cli = (label, command, stdin, now = DAY) => runNode(sb, 'tell.mjs', {
    args: [label],
    stdin,
    env: { SSH_ORIGINAL_COMMAND: command, ADDON_TELEGRAM_API: `http://127.0.0.1:${tgPort}`, ADDON_TELL_NOW: String(now) },
  });

  test('send: the message reaches the paired chat with the console\'s name first', async () => {
    const r = await cli('box', 'send ha-kronk-alerts', 'Done. The four alerts are live.');
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { ok: true, result: 'sent' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chat_id, 777);
    assert.equal(sent[0].text, '🖥 ha-kronk-alerts: Done. The four alerts are live.');
  });

  test('the log has one line per message and never its text', async () => {
    await cli('box', 'send ha-inbox', 'secret-looking words here');
    const log = readFileSync(join(sb.data, 'tell.log'), 'utf8');
    assert.equal(log.trim().split('\n').length, 1);
    assert.match(log, /\| box \| ha-inbox \| 25 \| sent \| 1001$/m);
    assert.doesNotMatch(log, /secret-looking/);
  });

  test('a tell key can do nothing but send or read replies', async () => {
    for (const cmd of ['type claude', 'snapshot', 'attach claude', 'seat-login home', 'send', 'send Bad_Name', 'send a b', '']) {
      const r = await cli('box', cmd, 'hello');
      assert.equal(r.code, 2, `${cmd}: ${r.stderr}`);
      assert.match(r.stderr, /refused/);
    }
    assert.equal(sent.length, 0);
  });

  test('the label must be a tell key the user added (the forced command names it)', async () => {
    const r = await cli('Bad Label!', 'send x', 'hello');
    assert.equal(r.code, 2);
    assert.equal(sent.length, 0);
  });

  test('empty text, control characters or too much stdin are refused', async () => {
    assert.equal((await cli('box', 'send c1', '   \n')).code, 2);
    assert.equal((await cli('box', 'send c1', 'a\u0007b')).code, 2);
    assert.equal((await cli('box', 'send c1', 'x'.repeat(5000))).code, 2);
    assert.equal(sent.length, 0);
  });

  test('a long message is cut to 600 characters', async () => {
    const r = await tell.accept({ label: 'box', console: 'c1', text: 'y'.repeat(900), now: DAY });
    assert.equal(r.result, 'sent');
    assert.equal(sent[0].text.length, 600);
    assert.ok(sent[0].text.endsWith('…'));
  });

  test('5 a minute per console: the 6th is refused, another console still gets through', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await tell.accept({ label: 'box', console: 'c1', text: `m${i}`, now: DAY + i })).result, 'sent');
    assert.equal((await tell.accept({ label: 'box', console: 'c1', text: 'm6', now: DAY + 10 })).result, 'capped');
    assert.equal((await tell.accept({ label: 'box', console: 'c2', text: 'other', now: DAY + 11 })).result, 'sent');
    assert.equal(sent.length, 6);
    // a minute later it goes again
    assert.equal((await tell.accept({ label: 'box', console: 'c1', text: 'm7', now: DAY + 61e3 })).result, 'sent');
  });

  test('30 an hour per console', async () => {
    let n = 0;
    for (let i = 0; i < 31; i++) {
      const r = await tell.accept({ label: 'box', console: 'c1', text: `h${i}`, now: DAY + i * 70e3 });
      if (r.result === 'sent') n++;
    }
    assert.equal(n, 30);
  });

  test('the same text from the same console within 10 minutes is dropped', async () => {
    assert.equal((await tell.accept({ label: 'box', console: 'c1', text: 'same', now: DAY })).result, 'sent');
    assert.equal((await tell.accept({ label: 'box', console: 'c1', text: 'same', now: DAY + 5 * 60e3 })).result, 'duplicate');
    assert.equal((await tell.accept({ label: 'box', console: 'c2', text: 'same', now: DAY + 5 * 60e3 })).result, 'sent');
    assert.equal((await tell.accept({ label: 'box', console: 'c1', text: 'same', now: DAY + 11 * 60e3 })).result, 'sent');
    assert.equal(sent.length, 3);
  });

  test('night hours (22:00-07:00): held, then sent at 7:00, oldest first', async () => {
    assert.equal((await tell.accept({ label: 'box', console: 'c1', text: 'first', now: NIGHT })).result, 'held');
    assert.equal((await tell.accept({ label: 'box', console: 'c2', text: 'second', now: NIGHT + 60e3 })).result, 'held');
    assert.equal(sent.length, 0);
    assert.equal(await tell.flushHeld(NIGHT + 3600e3), 0);
    assert.equal(await tell.flushHeld(MORNING), 2);
    assert.deepEqual(sent.map((s) => s.text), ['🖥 c1: first', '🖥 c2: second']);
    assert.equal(await tell.flushHeld(MORNING + 60e3), 0);
  });

  test('no paired chat: refused and nothing kept', async () => {
    writeFileSync(join(sb.data, 'telegram.json'), JSON.stringify({ token: TOKEN, bot: { username: 'home_bot' }, chat: null }));
    const r = await cli('box', 'send c1', 'hello');
    assert.equal(r.code, 3);
    assert.match(r.stderr, /telegram is not set up/);
  });

  test('a capped message tells the console so, with exit 3', async () => {
    for (let i = 0; i < 5; i++) await cli('box', 'send c1', `m${i}`);
    const r = await cli('box', 'send c1', 'one too many');
    assert.equal(r.code, 3);
    assert.match(r.stderr, /over the cap/);
  });

  test('replies: a Telegram Reply to a console\'s message is kept for that console, read once', async () => {
    await tell.accept({ label: 'box', console: 'c1', text: 'Shall I go on?', now: DAY });
    const id = 1001;
    const kept = tell.noteReply({ text: 'yes, go on', date: 1, reply_to_message: { message_id: id } }, DAY + 1000);
    assert.equal(kept, 'c1');
    assert.equal(tell.noteReply({ text: 'stray', reply_to_message: { message_id: 5 } }, DAY), null);
    const r = await cli('box', 'replies c1', '');
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.replies.length, 1);
    assert.equal(out.replies[0].text, 'yes, go on');
    assert.equal(JSON.parse((await cli('box', 'replies c1', '')).stdout).replies.length, 0);
  });

  test('replies are kept only for the key that sent the message', async () => {
    await tell.accept({ label: 'box', console: 'c1', text: 'q', now: DAY });
    tell.noteReply({ text: 'a', reply_to_message: { message_id: 1001 } }, DAY);
    assert.equal(JSON.parse((await cli('other', 'replies c1', '')).stdout).replies.length, 0);
    assert.equal(JSON.parse((await cli('box', 'replies c1', '')).stdout).replies.length, 1);
  });

  test('telegram: a Reply to a console message is passed to it, not to automations', async () => {
    await tell.accept({ label: 'box', console: 'c1', text: 'q', now: DAY });
    const events = [];
    const ctx = { consoleState: async () => 'idle', typeIntoConsole: async () => events.push('typed'), listRoutines: () => [], seat: () => ({}), noteReply: tell.noteReply };
    let polled = [{ update_id: 1, message: { message_id: 9, chat: { id: 777, type: 'private' }, from: { id: 1 }, text: 'ok', reply_to_message: { message_id: 1001 } } }];
    const server2 = http.createServer(async (req, res) => {
      const m = req.url.match(/\/(\w+)$/);
      const p = await body(req);
      if (m[1] === 'getUpdates') return res.end(JSON.stringify({ ok: true, result: polled.splice(0) }));
      if (m[1] === 'sendMessage') sent.push(p);
      return res.end(JSON.stringify({ ok: true, result: { message_id: 2000 } }));
    });
    const port2 = await listen(server2);
    process.env.ADDON_TELEGRAM_API = `http://127.0.0.1:${port2}`;
    try {
      await tgm.pollOnce(ctx, { timeout: 0 });
    } finally {
      process.env.ADDON_TELEGRAM_API = `http://127.0.0.1:${tgPort}`;
      server2.close();
    }
    assert.deepEqual(events, []);
    assert.equal(sent.at(-1).text, 'Passed to c1.');
    assert.equal(tell.takeReplies('box', 'c1')[0].text, 'ok');
  });

  describe('tell keys', () => {
    test('added with a name, one plain ed25519 key and the addresses it may come from', () => {
      tell.addTellKey({ label: 'workspace', key: KEY, from: '192.168.100.50' });
      assert.deepEqual(tell.tellView().keys.map((k) => [k.label, k.from, k.keyComment]), [['workspace', '192.168.100.50', 'box@ws']]);
      assert.ok(existsSync(join(sb.run, 'remote-apply')), 'run.sh is asked to write the key lines again');
      assert.throws(() => tell.addTellKey({ label: 'workspace', key: KEY, from: '10.0.0.1' }), { code: 'tell-exists' });
      assert.throws(() => tell.addTellKey({ label: 'Bad name', key: KEY, from: '10.0.0.1' }), { code: 'bad-label' });
      assert.throws(() => tell.addTellKey({ label: 'x', key: 'ssh-rsa AAAA', from: '10.0.0.1' }), { code: 'bad-key' });
      assert.throws(() => tell.addTellKey({ label: 'x', key: KEY, from: '0.0.0.0/0' }), { code: 'bad-from' });
      assert.throws(() => tell.addTellKey({ label: 'x', key: KEY, from: 'myhost' }), { code: 'bad-from' });
    });

    test('its authorized_keys line: restricted, from= its addresses, forced into tell.mjs with its name', () => {
      tell.addTellKey({ label: 'workspace', key: KEY, from: '192.168.100.50' });
      assert.deepEqual(tell.tellLines(), [
        'from="192.168.100.50",restrict,command="node /opt/addon-agent/tell.mjs workspace" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
      ]);
    });

    test('removed', () => {
      tell.addTellKey({ label: 'workspace', key: KEY, from: '192.168.100.50' });
      tell.removeTellKey('workspace');
      assert.deepEqual(tell.tellLines(), []);
      assert.throws(() => tell.removeTellKey('workspace'), { code: 'no-tell-key' });
    });

    test('keyline.mjs: remote console off and a tell key: exit 4, only the tell line, remote state "off"', async () => {
      tell.addTellKey({ label: 'workspace', key: KEY, from: '192.168.100.50' });
      const r = await runNode(sb, 'keyline.mjs');
      assert.equal(r.code, 4, r.stderr);
      const lines = readFileSync(join(sb.data, 'ssh', 'authorized_keys'), 'utf8').trim().split('\n');
      assert.equal(lines.length, 1);
      assert.match(lines[0], /command="node \/opt\/addon-agent\/tell\.mjs workspace"/);
      assert.equal(readFileSync(join(sb.run, 'remote'), 'utf8').trim(), 'off');
    });

    test('keyline.mjs: no remote console and no tell key: exit 1 as before', async () => {
      const r = await runNode(sb, 'keyline.mjs');
      assert.equal(r.code, 1);
    });
  });
});
