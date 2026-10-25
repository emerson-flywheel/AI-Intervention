// The add-on's page on the ingress port: Console and Settings tabs, the sign-in and seat
// settings API, and a
// proxy for console/ (HTTP and websocket) to ttyd on 127.0.0.1:7682. No npm dependencies.
// It answers only HA's ingress proxy, and every URL it serves or uses is relative.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { remoteStatus } from './keyline.mjs';
import { readRun, relaunchConsole, seatName, writeRun } from './lib.mjs';
import { LookError, lookSettings, saveLook, writeConfigs } from './look.mjs';
import { LoginError, cancelLogin, loginWaiting, seatLogin, startLogin, submitCode, withLoginLock } from './seat.mjs';
import { SettingsError, saveSeatSettings, seatSettings } from './settings.mjs';
import { refreshUsage, usageView } from './usage.mjs';

const env = process.env;
const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(env.ADDON_PORT || 7681);
const PEER = env.ADDON_INGRESS_PEER || '172.30.32.2';
const TTYD = { host: '127.0.0.1', port: Number(env.ADDON_TTYD_PORT || 7682) };
// The usage probe's waits; the tests shorten them.
const USAGE_TIMING = {
  ...(env.ADDON_USAGE_SETTLE_MS && { settleMs: Number(env.ADDON_USAGE_SETTLE_MS) }),
  ...(env.ADDON_USAGE_POLL_MS && { pollMs: Number(env.ADDON_USAGE_POLL_MS) }),
};

const FILES = {
  '/': ['page.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/linkcheck.mjs': ['linkcheck.mjs', 'text/javascript; charset=utf-8'],
  '/touchscroll.mjs': ['touchscroll.mjs', 'text/javascript; charset=utf-8'],
};
const PAGE_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-src 'self'; connect-src 'self'; " +
    "frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

const STATUS = { busy: 409, 'not-waiting': 409, 'not-taken': 409, 'not-finished': 409, 'not-a-code': 400, 'bad-link': 502, 'no-link': 502 };

export function fromIngress(addr, peer = PEER) {
  return addr === peer || addr === `::ffff:${peer}`;
}

function send(res, status, body, headers = {}) {
  const json = typeof body !== 'string';
  res.writeHead(status, {
    'Content-Type': json ? 'application/json' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(json ? JSON.stringify(body) : body);
}

function readJson(req, cap = 4096) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

async function state() {
  const seat = seatName();
  const login = seatLogin();
  return {
    seat,
    ...login,
    login: (await loginWaiting(seat)) ? 'waiting' : 'none',
    settings: seatSettings(),
    console: lookSettings(),
    remote: remoteStatus(),
    usage: usageView(),
    // The Console client's process (run.sh writes it): the page reloads the Console once it changes.
    view: readRun('ttyd.pid'),
  };
}

async function api(req, res, path) {
  if (req.method === 'GET' && path === '/api/state') return send(res, 200, await state());
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  // A JSON body and our own header: a form or a plain cross-site request cannot send both.
  if (!String(req.headers['content-type']).startsWith('application/json') || req.headers['x-seat'] !== '1') {
    return send(res, 403, { error: 'forbidden' });
  }
  const seat = seatName();
  try {
    if (path === '/api/login/start') {
      const url = await withLoginLock(() => startLogin(seat));
      return send(res, 200, { url });
    }
    if (path === '/api/login/code') {
      const body = await readJson(req);
      const code = typeof body?.code === 'string' ? body.code.trim() : '';
      const { relaunched } = await withLoginLock(() => submitCode(seat, code));
      return send(res, 200, { signedIn: true, relaunched });
    }
    if (path === '/api/login/cancel') {
      await withLoginLock(() => cancelLogin(seat));
      return send(res, 200, { ok: true });
    }
    // A new model or thinking level starts Claude in the Console again (with --continue, so
    // the conversation stays); a new name alone does not.
    if (path === '/api/seat/settings') {
      const body = await readJson(req);
      const relaunched = await withLoginLock(async () => {
        const { changed } = saveSeatSettings(body || {});
        return changed ? relaunchConsole() : 'none';
      });
      return send(res, 200, { saved: true, relaunched });
    }
    // Read the plan usage again: the page asks when its reading is old, force is a press of
    // Refresh. The probe runs on after the answer; api/state shows it.
    if (path === '/api/usage/refresh') {
      const body = await readJson(req);
      return send(res, 200, { usage: refreshUsage({ force: body?.force === true, ...USAGE_TIMING }) });
    }
    // A new look: herdr's configs are written for it and run.sh starts ttyd again (within
    // 5 s), so the Console's client picks both up. Claude and its conversation keep running.
    if (path === '/api/console/look') {
      const body = await readJson(req);
      const { changed } = saveLook(body || {});
      if (changed) {
        writeConfigs();
        writeRun('ttyd-restart', '1');
      }
      return send(res, 200, { saved: true, reload: changed });
    }
  } catch (err) {
    if (err instanceof LoginError) return send(res, STATUS[err.code] || 409, { error: err.code });
    if (err instanceof SettingsError || err instanceof LookError) return send(res, 400, { error: err.code });
    return send(res, 500, { error: 'failed' });
  }
  return send(res, 404, { error: 'not found' });
}

function proxy(req, res) {
  const up = http.request({ ...TTYD, method: req.method, path: req.url, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', () => send(res, 502, 'The console is starting. Reload in a moment.'));
  req.pipe(up);
}

function upgrade(req, sock, head) {
  if (!fromIngress(req.socket.remoteAddress) || !req.url.startsWith('/console/')) return sock.destroy();
  const up = net.connect(TTYD.port, TTYD.host, () => {
    let lines = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    up.write(`${lines}\r\n`);
    if (head?.length) up.write(head);
    sock.pipe(up).pipe(sock);
  });
  up.on('error', () => sock.destroy());
  sock.on('error', () => up.destroy());
}

export function createServer() {
  const server = http.createServer(async (req, res) => {
    if (!fromIngress(req.socket.remoteAddress)) return send(res, 403, 'Only through Home Assistant.');
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/console') return send(res, 302, '', { Location: 'console/' });
    if (path.startsWith('/console/')) return proxy(req, res);
    if (path.startsWith('/api/')) return api(req, res, path);
    const file = FILES[path === '/index.html' ? '/' : path];
    if (!file || req.method !== 'GET') return send(res, 404, 'Not found.');
    res.writeHead(200, { 'Content-Type': file[1], ...PAGE_HEADERS });
    res.end(readFileSync(join(HERE, file[0])));
  });
  server.on('upgrade', upgrade);
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, '0.0.0.0', () => console.log(`[claude-code] Page on :${PORT} (ingress only).`));
}
