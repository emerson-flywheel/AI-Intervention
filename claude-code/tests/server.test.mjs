// The page server: ingress-only, relative URLs, the sign-in API (with the fake claude in
// a real tmux), the signed-in rule, and the console/ proxy (HTTP and websocket) to ttyd.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fromIngress } from '../rootfs/opt/addon-agent/server.mjs';
import { readLogin } from '../rootfs/opt/addon-agent/seat.mjs';
import { AGENT_DIR, GOOD_CODE, GOOD_LINK, consoleHerdr, sandbox, writeRunFiles } from './helpers.mjs';

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function startServer(sb, env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [join(AGENT_DIR, 'server.mjs')], {
    env: { ...sb.env, ADDON_PORT: String(port), ADDON_INGRESS_PEER: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 100 && !out.includes('Page on'); i++) await new Promise((r) => setTimeout(r, 50));
  return { port, child, log: () => out };
}

function req(port, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

const post = (port, path, body = {}) =>
  req(port, path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'X-Seat': '1' },
  });

describe('readLogin (the seat\'s state; only the token length is read)', () => {
  test('signed out, lapsed, signed in with plan and time', () => {
    const sb = sandbox();
    const dir = join(sb.data, 'claude');
    const file = join(dir, '.credentials.json');
    assert.deepEqual(readLogin(dir), { signedIn: false, lapsed: false, plan: null, since: null });
    writeFileSync(file, '{"claudeAiOauth":{"accessToken":"","subscriptionType":"max"}}');
    assert.deepEqual(readLogin(dir), { signedIn: false, lapsed: true, plan: null, since: null });
    writeFileSync(file, 'not json');
    assert.equal(readLogin(dir).lapsed, true);
    writeFileSync(file, '{"claudeAiOauth":{"accessToken":"fake-access-token-secret","subscriptionType":"max"}}');
    const s = readLogin(dir);
    assert.equal(s.signedIn, true);
    assert.equal(s.plan, 'max');
    assert.ok(Math.abs(s.since - Date.now()) < 60000);
    assert.ok(!JSON.stringify(s).includes('fake-access-token'));
    writeFileSync(file, '{"claudeAiOauth":{"accessToken":"x","subscriptionType":"<b>evil</b>"}}');
    assert.equal(readLogin(dir).plan, null, 'an odd plan string is not shown');
    writeFileSync(file, '{"claudeAiOauth":{"accessToken":"fake-access-token-secret","expiresAt":1000}}');
    assert.deepEqual(readLogin(dir), { signedIn: false, lapsed: true, plan: null, since: null }, 'past, no refresh = lapsed');
    writeFileSync(file, '{"claudeAiOauth":{"accessToken":"fake-access-token-secret","refreshToken":"","expiresAt":1000}}');
    assert.equal(readLogin(dir).lapsed, true, 'past, empty refresh = lapsed');
    writeFileSync(file, '{"claudeAiOauth":{"accessToken":"fake-access-token-secret","refreshToken":"fake-refresh-value","expiresAt":1000}}');
    const refreshed = readLogin(dir);
    assert.equal(refreshed.signedIn, true, 'past with a refresh token = signed in');
    assert.ok(!JSON.stringify(refreshed).includes('fake-refresh-value'));
    writeFileSync(file, '{"claudeAiOauth":{"accessToken":"","refreshToken":"fake-refresh-value","expiresAt":9999999999999}}');
    assert.equal(readLogin(dir).lapsed, true, 'an empty access token = lapsed, refresh or not');
    writeFileSync(file, `{"claudeAiOauth":{"accessToken":"t","expiresAt":${Date.now() + 3600e3}}}`);
    assert.equal(readLogin(dir).signedIn, true, 'expiresAt ahead = signed in');
    sb.cleanup();
  });
});

test('fromIngress: only 172.30.32.2 (HA ingress), plain or IPv4-mapped', () => {
  assert.equal(fromIngress('172.30.32.2'), true);
  assert.equal(fromIngress('::ffff:172.30.32.2'), true);
  for (const a of ['172.30.32.1', '127.0.0.1', '192.0.2.10', '::1', '', undefined]) assert.equal(fromIngress(a), false);
});

describe('page server', () => {
  let sb;
  let srv;
  let ttyd;
  let ttydPort;
  before(async () => {
    sb = sandbox({ herdr: consoleHerdr() });
    writeRunFiles(sb, { pane: 'w1:p1', workspace: 'w1', state: 'claude' });
    ttydPort = await freePort();
    // A stand-in ttyd: HTTP under /console/, and a websocket-style upgrade that echoes.
    ttyd = http.createServer((q, s) => {
      s.writeHead(200, { 'Content-Type': 'text/plain' });
      s.end(`ttyd ${q.method} ${q.url}`);
    });
    ttyd.on('upgrade', (q, sock) => {
      sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Path: ${q.url}\r\n\r\n`);
      sock.on('data', (d) => sock.write(`echo:${d}`));
    });
    await new Promise((r) => ttyd.listen(ttydPort, '127.0.0.1', r));
    srv = await startServer(sb, { ADDON_TTYD_PORT: String(ttydPort) });
  });
  after(() => {
    srv.child.kill();
    ttyd.close();
    sb.cleanup();
  });

  test('anyone but the ingress proxy is refused, page, API and websocket alike', async () => {
    const other = await startServer(sb, { ADDON_INGRESS_PEER: '172.30.32.2', ADDON_TTYD_PORT: String(ttydPort) });
    try {
      for (const p of ['/', '/api/state', '/console/', '/app.js']) assert.equal((await req(other.port, p)).status, 403, p);
      assert.equal((await post(other.port, '/api/login/start')).status, 403);
      const sock = net.connect(other.port, '127.0.0.1');
      sock.write('GET /console/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      const got = await new Promise((r) => {
        let d = '';
        sock.on('data', (c) => (d += c));
        sock.on('close', () => r(d));
      });
      assert.ok(!got.includes('101'), 'no upgrade');
    } finally {
      other.child.kill();
    }
  });

  test('api/state: expired login is lapsed; the oauth_token option shows signed in by option, never the token', async () => {
    const file = join(sb.data, 'claude', '.credentials.json');
    const { rmSync } = await import('node:fs');
    writeFileSync(file, '{"claudeAiOauth":{"accessToken":"fake-x","expiresAt":1000}}');
    let s = JSON.parse((await req(srv.port, '/api/state')).body);
    assert.equal(s.signedIn, false);
    assert.equal(s.lapsed, true);
    assert.equal(s.byOption, false);
    const opts = join(sb.data, 'options.json');
    const before = readFileSync(opts, 'utf8');
    writeFileSync(opts, JSON.stringify({ seat_name: 'home', oauth_token: 'fake-option-token-value-secret' }));
    const raw = (await req(srv.port, '/api/state')).body;
    s = JSON.parse(raw);
    assert.equal(s.signedIn, true);
    assert.equal(s.lapsed, false);
    assert.equal(s.byOption, true);
    assert.ok(!raw.includes('option-secret'));
    writeFileSync(opts, before);
    rmSync(file, { force: true });
  });

  test('the page uses relative URLs only', async () => {
    const page = await req(srv.port, '/');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-security-policy'], /default-src 'self'/);
    const app = (await req(srv.port, '/app.js')).body;
    for (const text of [page.body, app]) {
      const urls = [...text.matchAll(/(?:src|href)="([^"]+)"|fetch\('([^']+)'|post\('([^']+)'/g)].map((m) => m[1] || m[2] || m[3]);
      assert.ok(urls.length > 0);
      for (const u of urls) assert.ok(!/^(\/|https?:)/.test(u), `relative: ${u}`);
    }
    assert.equal((await req(srv.port, '/linkcheck.mjs')).status, 200);
    assert.equal((await req(srv.port, '/../seat.mjs')).status, 404);
    assert.equal((await req(srv.port, '/seat.mjs')).status, 404);
  });

  test('console/ is proxied to ttyd (HTTP and the websocket); /console redirects relatively', async () => {
    const r = await req(srv.port, '/console/token?x=1');
    assert.equal(r.body, 'ttyd GET /console/token?x=1');
    const redirect = await req(srv.port, '/console');
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.location, 'console/');
    const sock = net.connect(srv.port, '127.0.0.1');
    sock.write('GET /console/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Protocol: tty\r\n\r\n');
    let got = '';
    sock.on('data', (d) => {
      got += d;
      if (got.includes('\r\n\r\n') && !got.includes('echo:')) sock.write('ping');
    });
    for (let i = 0; i < 40 && !got.includes('echo:ping'); i++) await new Promise((r) => setTimeout(r, 50));
    sock.destroy();
    assert.match(got, /^HTTP\/1.1 101/);
    assert.match(got, /X-Path: \/console\/ws/);
    assert.match(got, /echo:ping/);
  });

  test('POSTs need JSON and the page\'s own header', async () => {
    assert.equal((await req(srv.port, '/api/login/start', { method: 'POST', body: 'a=b',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 403);
    assert.equal((await req(srv.port, '/api/login/start', { method: 'POST', body: '{}',
      headers: { 'Content-Type': 'application/json' } })).status, 403);
  });

  test('sign-in through the API: link, wrong code, right code; never the token or code back', async () => {
    let s = JSON.parse((await req(srv.port, '/api/state')).body);
    assert.deepEqual(s, { seat: 'home', signedIn: false, lapsed: false, plan: null, since: null, byOption: false, login: 'none' });

    const start = await post(srv.port, '/api/login/start');
    assert.equal(start.status, 200);
    assert.deepEqual(JSON.parse(start.body), { url: GOOD_LINK });
    assert.equal(JSON.parse((await req(srv.port, '/api/state')).body).login, 'waiting');

    const bad = await post(srv.port, '/api/login/code', { code: 'nope' });
    assert.deepEqual([bad.status, JSON.parse(bad.body)], [400, { error: 'not-a-code' }]);
    const wrong = await post(srv.port, '/api/login/code', { code: 'wrong-code-0123456789' });
    assert.deepEqual([wrong.status, JSON.parse(wrong.body)], [409, { error: 'not-taken' }]);

    const ok = await post(srv.port, '/api/login/code', { code: GOOD_CODE });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { signedIn: true, relaunched: 'now' });
    assert.ok(existsSync(join(sb.run, 'relaunch')));
    s = JSON.parse((await req(srv.port, '/api/state')).body);
    assert.equal(s.signedIn, true);
    assert.equal(s.plan, 'max');
    assert.equal(s.login, 'none');
    const all = JSON.stringify(s) + srv.log();
    assert.ok(!all.includes('tok-0123456789abcdef') && !all.includes(GOOD_CODE) && !all.includes('wrong-code'));

    const late = await post(srv.port, '/api/login/code', { code: GOOD_CODE });
    assert.deepEqual([late.status, JSON.parse(late.body)], [409, { error: 'not-waiting' }]);
  });

  test('cancel closes a waiting sign-in and leaves the stored login alone', async () => {
    const before = readFileSync(join(sb.data, 'claude', '.credentials.json'), 'utf8');
    assert.equal((await post(srv.port, '/api/login/start')).status, 200);
    assert.equal(JSON.parse((await req(srv.port, '/api/state')).body).login, 'waiting');
    assert.equal((await post(srv.port, '/api/login/cancel')).status, 200);
    assert.equal(JSON.parse((await req(srv.port, '/api/state')).body).login, 'none');
    assert.equal(readFileSync(join(sb.data, 'claude', '.credentials.json'), 'utf8'), before);
  });

  test('one sign-in step at a time: a second start while one runs is 409 busy', async () => {
    const slow = await startServer(sb, { ADDON_TTYD_PORT: String(ttydPort), FAKE_LINK_DELAY: '1.5' });
    try {
      const first = post(slow.port, '/api/login/start');
      await new Promise((r) => setTimeout(r, 300));
      const second = await post(slow.port, '/api/login/start');
      assert.deepEqual([second.status, JSON.parse(second.body)], [409, { error: 'busy' }]);
      assert.equal((await first).status, 200);
      await post(slow.port, '/api/login/cancel');
    } finally {
      slow.child.kill();
    }
  });

  test('a link that fails the check is never sent to the page', async () => {
    const evil = await startServer(sb, {
      ADDON_TTYD_PORT: String(ttydPort),
      FAKE_LINK: GOOD_LINK.replace('platform.claude.com', 'evil.example'),
    });
    try {
      const r = await post(evil.port, '/api/login/start');
      assert.deepEqual([r.status, JSON.parse(r.body)], [502, { error: 'bad-link' }]);
      assert.equal(JSON.parse((await req(evil.port, '/api/state')).body).login, 'none');
    } finally {
      evil.child.kill();
    }
  });
});
