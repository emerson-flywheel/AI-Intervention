// Bots (0.4.5): Settings › Bots lets the user add a bot (grokbot) with its own key and a
// level (Admin by default, Control, Read only). The bot calls the app's Bots door, never
// Home Assistant itself; the app checks the level and makes the call. These are the plan's
// gates (grokbot access plan v4), written before the code, against a stand-in Home
// Assistant and Supervisor.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { sandbox } from './helpers.mjs';

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const readBody = (req) => new Promise((r) => {
  let d = '';
  req.on('data', (c) => (d += c));
  req.on('end', () => r(d ? JSON.parse(d) : {}));
});
const portOpen = (port) => new Promise((r) => {
  const s = net.connect(port, '127.0.0.1');
  s.on('connect', () => {
    s.destroy();
    r(true);
  });
  s.on('error', () => r(false));
});

// What the stand-in Home Assistant knows: two lights in the kitchen, one in the bedroom.
const STATES = [
  { entity_id: 'light.kitchen', state: 'off', attributes: {} },
  { entity_id: 'light.kitchen_strip', state: 'off', attributes: {} },
  { entity_id: 'light.bedroom', state: 'off', attributes: {} },
];
const AREAS = { kitchen: ['light.kitchen', 'light.kitchen_strip'], bedroom: ['light.bedroom'] };
const LABELS = { night: ['light.bedroom'] };

describe('bots', () => {
  let ha;
  let haPort;
  let calls;
  let sb;
  let bots;
  let door;
  let doorPort;
  let now;

  before(async () => {
    ha = http.createServer(async (req, res) => {
      const body = req.method === 'POST' ? await readBody(req) : null;
      calls.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/core/api/states') return res.end(JSON.stringify(STATES));
      if (req.url.startsWith('/core/api/states/')) {
        const s = STATES.find((x) => x.entity_id === req.url.slice('/core/api/states/'.length));
        res.statusCode = s ? 200 : 404;
        return res.end(JSON.stringify(s || {}));
      }
      if (req.url === '/core/api/template') {
        const out = new Set();
        for (const [, a] of body.template.matchAll(/area_entities\('([a-z0-9_]+)'\)/g)) for (const e of AREAS[a] || []) out.add(e);
        for (const [, l] of body.template.matchAll(/label_entities\('([a-z0-9_]+)'\)/g)) for (const e of LABELS[l] || []) out.add(e);
        res.setHeader('Content-Type', 'text/plain');
        return res.end(JSON.stringify([...out]));
      }
      if (req.url.startsWith('/core/api/services/')) return res.end('[]');
      if (req.url.startsWith('/core/api/history/period')) return res.end('[[]]');
      if (req.url.startsWith('/core/api/logbook')) return res.end('[]');
      if (req.url.startsWith('/supervisor/')) return res.end(JSON.stringify({ result: 'ok', data: {} }));
      res.statusCode = 404;
      return res.end('{}');
    });
    haPort = await listen(ha);
    process.env.HA_API = `http://127.0.0.1:${haPort}/core/api`;
    process.env.SUPERVISOR_API = `http://127.0.0.1:${haPort}/supervisor`;
    process.env.SUPERVISOR_TOKEN = 'test-supervisor-token';
    process.env.ADDON_BOTS_SLOW_MS = '1';
    bots = await import('../rootfs/opt/addon-agent/bots.mjs');
    door = await import('../rootfs/opt/addon-agent/door.mjs');
  });
  after(() => {
    ha.close();
    for (const k of ['HA_API', 'SUPERVISOR_API', 'SUPERVISOR_TOKEN', 'ADDON_BOTS_SLOW_MS']) delete process.env[k];
  });

  beforeEach(async () => {
    calls = [];
    sb = sandbox();
    mkdirSync(join(sb.root, 'ha'), { recursive: true });
    writeFileSync(join(sb.root, 'ha', 'configuration.yaml'), 'homeassistant:\n');
    bots.setDataDir(sb.data);
    door.setHaDir(join(sb.root, 'ha'));
    now = Date.UTC(2026, 10, 17, 15, 0);
    bots.setClock(() => now);
    doorPort = await new Promise((r) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = s.address();
        s.close(() => r(port));
      });
    });
    door.setDoorAddress({ port: doorPort, host: '127.0.0.1' });
  });
  afterEach(async () => {
    await door.closeDoor();
    sb.cleanup();
  });

  // One call to the door: a plain web call to a tool.
  function call(key, tool, args = {}) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(args);
      const headers = { 'Content-Type': 'application/json' };
      if (key !== null) headers.Authorization = `Bearer ${key}`;
      const r = http.request({ host: '127.0.0.1', port: doorPort, path: `/v1/tools/${tool}`, method: 'POST', headers }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
      });
      r.on('error', reject);
      r.end(payload);
    });
  }
  function mcp(key, method, params = {}, id = 1, path = '/mcp') {
    return new Promise((resolve, reject) => {
      const r = http.request({
        host: '127.0.0.1', port: doorPort, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${key}` },
      }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
      });
      r.on('error', reject);
      r.end(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }
  const log = () => bots.readLog(1000);
  const serviceCalls = () => calls.filter((c) => c.url.startsWith('/core/api/services/') && !c.url.startsWith('/core/api/services/logbook/'));

  test('with no bots, or every bot paused, nothing listens', async () => {
    assert.equal(await door.syncDoor(), false);
    assert.equal(await portOpen(doorPort), false);
    bots.addBot({ name: 'grokbot' });
    assert.equal(await door.syncDoor(), true);
    assert.equal(await portOpen(doorPort), true);
    bots.pauseBot('grokbot', true);
    assert.equal(await door.syncDoor(), false);
    assert.equal(await portOpen(doorPort), false);
  });

  test('a new bot is Admin unless another level is picked; its key is shown once and only a hash is kept', () => {
    const { key } = bots.addBot({ name: 'grokbot' });
    assert.match(key, /^aib_[A-Za-z0-9_-]{40,}$/);
    const v = bots.botsView();
    assert.equal(v.bots[0].level, 'admin');
    assert.equal(JSON.stringify(v).includes(key), false);
    const file = join(sb.data, 'bots.json');
    assert.equal(readFileSync(file, 'utf8').includes(key), false);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    bots.addBot({ name: 'reader', level: 'read', areas: ['kitchen'] });
    assert.equal(bots.botsView().bots[1].level, 'read');
    assert.throws(() => bots.addBot({ name: 'grokbot' }), { code: 'bot-exists' });
    assert.throws(() => bots.addBot({ name: 'Bad Name!' }), { code: 'bad-name' });
    assert.throws(() => bots.addBot({ name: 'x', level: 'root' }), { code: 'bad-level' });
    assert.throws(() => bots.addBot({ name: 'y', level: 'control' }), { code: 'no-scope' });
  });

  test('no key or a wrong key: refused, logged, and no data returned', async () => {
    bots.addBot({ name: 'grokbot' });
    await door.syncDoor();
    const none = await call(null, 'get_states');
    assert.equal(none.status, 401);
    assert.equal(none.body.result, undefined);
    const wrong = await call('aib_wrongwrongwrongwrongwrongwrongwrongwrongwrong', 'get_states');
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.result, undefined);
    assert.equal(calls.length, 0, 'Home Assistant was never asked');
    const l = log();
    assert.equal(l.length, 2);
    assert.deepEqual(l.map((x) => x.result), ['refused:no-key', 'refused:bad-key']);
    assert.equal(readFileSync(join(sb.data, 'bots.log'), 'utf8').includes('aib_wrong'), false, 'the log never holds a key');
  });

  test('Read only: states of what it was given; a "turn on" call is refused and the light does not change', async () => {
    const { key } = bots.addBot({ name: 'reader', level: 'read', areas: ['kitchen'] });
    await door.syncDoor();
    const s = await call(key, 'get_states');
    assert.equal(s.status, 200);
    assert.deepEqual(s.body.result.map((x) => x.entity_id).sort(), ['light.kitchen', 'light.kitchen_strip']);
    const on = await call(key, 'call_service', { domain: 'light', service: 'turn_on', entity_id: 'light.kitchen' });
    assert.equal(on.status, 403);
    assert.equal(serviceCalls().length, 0);
  });

  test('Control: a light in a picked area works; one outside it, a config edit and a Supervisor call are refused', async () => {
    const { key } = bots.addBot({ name: 'ctl', level: 'control', areas: ['kitchen'] });
    await door.syncDoor();
    const ok = await call(key, 'call_service', { domain: 'light', service: 'turn_on', entity_id: 'light.kitchen' });
    assert.equal(ok.status, 200);
    assert.equal(serviceCalls().length, 1);
    assert.equal(serviceCalls()[0].url, '/core/api/services/light/turn_on');
    assert.deepEqual(serviceCalls()[0].body, { entity_id: ['light.kitchen'] });
    const out = await call(key, 'call_service', { domain: 'light', service: 'turn_on', entity_id: 'light.bedroom' });
    assert.equal(out.status, 403);
    // a target the scope cannot check (an area, all) is refused too
    assert.equal((await call(key, 'call_service', { domain: 'light', service: 'turn_on', data: { area_id: 'bedroom' } })).status, 403);
    assert.equal((await call(key, 'call_service', { domain: 'light', service: 'turn_on', entity_id: 'all' })).status, 403);
    // a service of another domain on an entity in scope
    assert.equal((await call(key, 'call_service', { domain: 'script', service: 'turn_on', entity_id: 'light.kitchen' })).status, 403);
    assert.equal((await call(key, 'write_file', { path: 'configuration.yaml', content: 'x' })).status, 403);
    assert.equal((await call(key, 'supervisor', { method: 'POST', path: '/core/restart' })).status, 403);
    assert.equal(serviceCalls().length, 1, 'only the allowed call reached Home Assistant');
    assert.equal(readFileSync(join(sb.root, 'ha', 'configuration.yaml'), 'utf8'), 'homeassistant:\n');
  });

  test('Admin: a service call, a Supervisor call and a config edit all work, and the edit leaves a snapshot', async () => {
    const { key } = bots.addBot({ name: 'grokbot' });
    await door.syncDoor();
    assert.equal((await call(key, 'call_service', { domain: 'light', service: 'turn_on', entity_id: 'light.bedroom' })).status, 200);
    const sup = await call(key, 'supervisor', { method: 'GET', path: '/addons' });
    assert.equal(sup.status, 200);
    assert.ok(calls.some((c) => c.url === '/supervisor/addons' && c.auth === 'Bearer test-supervisor-token'));
    const ed = await call(key, 'write_file', { path: 'configuration.yaml', content: 'homeassistant:\n  name: Home\n' });
    assert.equal(ed.status, 200);
    assert.equal(readFileSync(join(sb.root, 'ha', 'configuration.yaml'), 'utf8'), 'homeassistant:\n  name: Home\n');
    const hist = join(sb.data, 'ha-history');
    assert.ok(existsSync(hist), 'a snapshot history was made');
    const before = execFileSync('git', ['--git-dir', hist, 'show', 'HEAD:configuration.yaml'], { encoding: 'utf8' });
    assert.equal(before, 'homeassistant:\n', 'the snapshot holds the file as it was before the edit');
    const rd = await call(key, 'read_file', { path: 'configuration.yaml' });
    assert.equal(rd.body.result.content, 'homeassistant:\n  name: Home\n');
    // a change shows in Home Assistant's logbook as done by the bot
    assert.ok(calls.some((c) => c.url === '/core/api/services/logbook/log' && c.body.name === 'grokbot (bot)'));
  });

  test('every level, Admin included: the app\'s private files, its own options and a shell are out of reach', async () => {
    const { key } = bots.addBot({ name: 'grokbot' });
    await door.syncDoor();
    writeFileSync(join(sb.root, 'secret-outside'), 'x');
    for (const path of ['../secret-outside', '/data/bots.json', join(sb.data, 'bots.json'), '/data/claude/.credentials.json', '/data/telegram.json']) {
      assert.equal((await call(key, 'read_file', { path })).status, 403, path);
      assert.equal((await call(key, 'write_file', { path, content: 'x' })).status, 403, path);
    }
    for (const [method, path] of [
      ['GET', '/addons/self/info'], ['GET', '/addons/self/options/config'], ['POST', '/addons/self/options'],
      ['GET', '/addons/5c53de3b_claude_code/info'], ['POST', '/addons/local_claude_code/options'],
      ['GET', '/backups/abc123/download'], ['GET', '/addons/../addons/self/info'],
    ]) {
      assert.equal((await call(key, 'supervisor', { method, path })).status, 403, `${method} ${path}`);
    }
    assert.equal(calls.filter((c) => c.url.startsWith('/supervisor/')).length, 0);
    for (const tool of ['shell', 'run_command', 'bash']) assert.equal((await call(key, tool, { command: 'id' })).status, 404);
    // and the Bots settings are not on the door at all
    for (const p of ['/api/bots/add', '/api/state', '/api/bots/level']) {
      const r = await new Promise((resolve) => {
        const q = http.request({ host: '127.0.0.1', port: doorPort, path: p, method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Seat': '1' } }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        });
        q.end('{"name":"evil","level":"admin"}');
      });
      assert.equal(r, 404, p);
    }
    assert.equal(bots.botsView().bots.length, 1);
  });

  test('a level change or Remove takes effect on the very next call; New key retires the old one', async () => {
    const { key } = bots.addBot({ name: 'grokbot' });
    await door.syncDoor();
    assert.equal((await call(key, 'call_service', { domain: 'light', service: 'turn_on', entity_id: 'light.bedroom' })).status, 200);
    bots.setLevel('grokbot', { level: 'read', areas: ['bedroom'] });
    assert.equal((await call(key, 'call_service', { domain: 'light', service: 'turn_on', entity_id: 'light.bedroom' })).status, 403);
    const { key: key2 } = bots.newKey('grokbot');
    assert.equal((await call(key, 'get_states')).status, 401);
    assert.equal((await call(key2, 'get_states')).status, 200);
    bots.addBot({ name: 'other', level: 'read', labels: ['night'] });
    bots.removeBot('grokbot');
    assert.equal((await call(key2, 'get_states')).status, 401);
  });

  test('after repeated wrong keys even the right key is blocked until the wait ends, and the block is logged', async () => {
    const { key } = bots.addBot({ name: 'grokbot' });
    await door.syncDoor();
    for (let i = 0; i < bots.LOCK.fails; i++) assert.equal((await call(`aib_${'x'.repeat(43)}${i}`, 'get_states')).status, 401);
    const blocked = await call(key, 'get_states');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.result, undefined);
    assert.ok(log().some((x) => x.result === 'refused:blocked'));
    now += bots.LOCK.blockMs + 1000;
    assert.equal((await call(key, 'get_states')).status, 200);
  });

  test('MCP: initialize, the tools of the bot\'s level, and a call', async () => {
    const { key } = bots.addBot({ name: 'reader', level: 'read', areas: ['kitchen'] });
    const { key: adminKey } = bots.addBot({ name: 'grokbot' });
    await door.syncDoor();
    const init = await mcp(key, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.status, 200);
    assert.equal(init.body.result.serverInfo.name, 'ai-intervention-bots');
    assert.ok(init.body.result.capabilities.tools);
    const names = (await mcp(key, 'tools/list')).body.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['get_history', 'get_logbook', 'get_states']);
    const all = (await mcp(adminKey, 'tools/list')).body.result.tools.map((t) => t.name).sort();
    assert.deepEqual(all, ['call_service', 'get_history', 'get_logbook', 'get_states', 'read_file', 'supervisor', 'write_file']);
    const got = await mcp(key, 'tools/call', { name: 'get_states', arguments: {} });
    assert.equal(got.body.result.isError, false);
    assert.match(got.body.result.content[0].text, /light\.kitchen/);
    const no = await mcp(key, 'tools/call', { name: 'call_service', arguments: { domain: 'light', service: 'turn_on', entity_id: 'light.kitchen' } });
    assert.equal(no.body.result.isError, true);
    assert.equal(serviceCalls().length, 0);
  });

  test('every call, allowed or refused, appears exactly once in the log, with the bot, action and target', async () => {
    const { key } = bots.addBot({ name: 'ctl', level: 'control', areas: ['kitchen'] });
    await door.syncDoor();
    await call(key, 'call_service', { domain: 'light', service: 'turn_on', entity_id: 'light.kitchen' });
    await call(key, 'call_service', { domain: 'light', service: 'turn_on', entity_id: 'light.bedroom' });
    await call(key, 'get_states');
    await call('aib_nope', 'get_states');
    await mcp(key, 'tools/list');
    const l = log();
    assert.equal(l.length, 5);
    assert.deepEqual(l.map((x) => [x.bot, x.action, x.result]), [
      ['ctl', 'call_service', 'allowed'],
      ['ctl', 'call_service', 'refused:out-of-scope'],
      ['ctl', 'get_states', 'allowed'],
      [null, 'get_states', 'refused:bad-key'],
      ['ctl', 'tools/list', 'allowed'],
    ]);
    assert.equal(l[0].target, 'light.turn_on light.kitchen');
    assert.equal(bots.botsView().bots[0].lastUsed, now);
  });
});

describe('the Bots settings on the page', () => {
  test('add, level, pause, new key and remove through the ingress API; the key comes back once', async () => {
    const { spawn } = await import('node:child_process');
    const { AGENT_DIR } = await import('./helpers.mjs');
    const sb = sandbox();
    const port = await new Promise((r) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = s.address().port;
        s.close(() => r(p));
      });
    });
    const child = spawn(process.execPath, [join(AGENT_DIR, 'server.mjs')], {
      env: { ...sb.env, ADDON_PORT: String(port), ADDON_INGRESS_PEER: '127.0.0.1', ADDON_BOTS_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    for (let i = 0; i < 100 && !out.includes('Page on'); i++) await new Promise((r) => setTimeout(r, 50));
    const post = (path, body) => new Promise((resolve) => {
      const q = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Seat': '1' } }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
      });
      q.end(JSON.stringify(body));
    });
    const stateNow = () => new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/api/state' }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(JSON.parse(d)));
      });
    });
    try {
      const add = await post('/api/bots/add', { name: 'grokbot' });
      assert.equal(add.status, 200);
      assert.match(add.body.key, /^aib_/);
      const s = await stateNow();
      assert.equal(s.bots.bots[0].name, 'grokbot');
      assert.equal(s.bots.bots[0].level, 'admin');
      assert.equal(JSON.stringify(s).includes(add.body.key), false);
      assert.equal((await post('/api/bots/level', { name: 'grokbot', level: 'read', areas: ['kitchen'] })).status, 200);
      assert.equal((await post('/api/bots/pause', { name: 'grokbot', paused: true })).status, 200);
      assert.equal((await stateNow()).bots.bots[0].paused, true);
      const nk = await post('/api/bots/new-key', { name: 'grokbot' });
      assert.match(nk.body.key, /^aib_/);
      assert.notEqual(nk.body.key, add.body.key);
      assert.equal((await post('/api/bots/remove', { name: 'grokbot' })).status, 200);
      assert.equal((await stateNow()).bots.bots.length, 0);
      assert.equal((await post('/api/bots/add', { name: 'x', level: 'root' })).status, 400);
    } finally {
      child.kill();
      sb.cleanup();
    }
  });
});
