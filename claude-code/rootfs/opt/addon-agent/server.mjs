// The add-on's page on the ingress port: Console and Settings tabs, the sign-in and seat
// settings API, and a
// proxy for console/ (HTTP and websocket) to ttyd on 127.0.0.1:7682. No npm dependencies.
// It answers only HA's ingress proxy, and every URL it serves or uses is relative.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APPLY, RESET, RemoteError, hostKeyFingerprint, remoteOff, remoteRemove, remoteStatus, saveRemote,
} from './keyline.mjs';
import {
  consolePane, consoleState, herdr, paneLines, readRun, relaunchConsole, seatName, sleep, typeIntoConsole, writeRun,
} from './lib.mjs';
import { LookError, lookSettings, saveLook, writeConfigs } from './look.mjs';
import {
  RoutineError, listRoutines, readReport, readRoutine, runRoutine, setEnabled, setSchedule, tick,
} from './routines.mjs';
import { LoginError, cancelLogin, loginWaiting, seatLogin, startLogin, submitCode, withLoginLock } from './seat.mjs';
import { SettingsError, saveSeatSettings, seatSettings } from './settings.mjs';
import {
  TelegramError, forget, notify, pollOnce, savePrefs, saveToken, sendTest, setHa, startPairing, telegramView, watch,
} from './telegram.mjs';
import { ToolsError, customTools, saveCustomTool, saveTools, toolsState } from './tools.mjs';
import { refreshUsage, usageView } from './usage.mjs';

// A routine's result to Telegram, when that switch is on.
function tellRoutine(r, result) {
  const fixes = result.fixes ? `\n${result.fixes} fix${result.fixes === 1 ? '' : 'es'} waiting: Apply in Console on Settings › Routines.` : '';
  return notify('routines', `${r.name}: ${result.summary}${fixes}`);
}

// What the Telegram bot reads and does in the Console.
const telegramCtx = {
  consoleState: async () => {
    const pane = await consolePane();
    return pane ? consoleState(pane) : 'none';
  },
  screen: async () => {
    const pane = await consolePane();
    return pane ? paneLines(pane, 30) : [];
  },
  typeIntoConsole,
  pressKey: async (key) => {
    const pane = await consolePane();
    if (pane) await herdr('pane', 'send-keys', pane, key);
  },
  listRoutines,
  runRoutine: (id) => runRoutine(id).then((result) => {
    tellRoutine(readRoutine(id), result);
    return result;
  }),
  seat: seatLogin,
};

// The routines the empty Routines section offers: each is typed into the Console as a
// request to Claude to make it, so it can be adjusted there first.
const STARTERS = {
  health: 'Make a routine called "Morning health check", every day at 7:00: look at Home Assistant\'s repairs, the log\'s errors since yesterday, unavailable devices and batteries under 15%, and give me a short report.',
  spook: 'Make a routine called "Fix Spook\'s repair items", run when I press Run: go through the repair items Spook found (unknown entities in automations, scripts and dashboards), work out each fix, and list them for me to apply.',
  names: 'Make a routine called "Suggest better names", Sundays at 9:00: suggest clearer names for entities, devices and automations, matched to their area, and flag automations that never ran.',
  update: 'Make a routine called "Update review", Fridays at 18:00: list the Home Assistant, add-on and HACS updates waiting, read each one\'s release notes for breaking changes that touch my setup, and tell me which are safe to install and which need care first.',
  backup: 'Make a routine called "Backup check", every day at 8:00: check that a full backup finished in the last 24 hours, that its size is in line with the last few, and that it reached every backup location. Tell me only when something is wrong.',
  logs: 'Make a routine called "Log noise review", Mondays at 9:00: find the warnings and errors that repeat most in the log, group them by integration, and suggest a fix or a quieter log level for each.',
  integrations: 'Make a routine called "Integration health", every day at 7:30: list integrations that failed to load or need signing in again, config entries stuck retrying, and devices or entities unavailable for over a day.',
  silent: 'Make a routine called "Silent stops", every day at 20:00: find sensors that stopped reporting when they usually report, automations that used to run but have not in a week, and batteries dropping faster than usual.',
};

// What Run / Apply in Console, or a starter, types into the Console.
function consoleLine({ id, kind, starter }) {
  if (kind === 'starter') {
    if (!Object.hasOwn(STARTERS, starter)) throw new RoutineError('bad-starter');
    return STARTERS[starter];
  }
  const r = readRoutine(id);
  if (kind === 'run') return `Run my routine "${r.name}" from /data/routines/${r.id}.md now, step by step, and ask before each change.`;
  if (kind === 'apply') {
    return `Apply the fixes from the last run of my routine "${r.name}" (its report is in /data/routines/.results/${r.id}.json). Ask before each change.`;
  }
  throw new RoutineError('bad-kind');
}

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
    routines: listRoutines(),
    tools: toolsState(),
    customTools: customTools(),
    telegram: telegramView(),
    // The Console client's process (run.sh writes it): the page reloads the Console once it changes.
    view: readRun('ttyd.pid'),
  };
}

async function api(req, res, path) {
  if (req.method === 'GET' && path === '/api/state') return send(res, 200, await state());
  // The host key's fingerprint, only when the page's Show is pressed.
  if (req.method === 'GET' && path === '/api/remote/hostkey') return send(res, 200, { hostKey: hostKeyFingerprint() });
  // A routine's last result with its full report (the state lists only the summary).
  if (req.method === 'GET' && path === '/api/routines/result') {
    try {
      return send(res, 200, { result: readReport(new URL(req.url, 'http://x').searchParams.get('id')) });
    } catch {
      return send(res, 404, { error: 'no-routine' });
    }
  }
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
    // Settings › Remote console: the setting is saved here and run.sh applies it within 5 s
    // (keyline.mjs again, sshd started or stopped), so no restart and Claude keeps running.
    // A new host key is made by run.sh too, as it owns sshd.
    if (path.startsWith('/api/remote/')) {
      const body = await readJson(req);
      const act = {
        '/api/remote/enable': () => saveRemote({ key: body?.key || undefined, from: body?.from }),
        '/api/remote/off': () => remoteOff(),
        '/api/remote/remove': () => remoteRemove(),
      }[path];
      if (act) {
        act();
        writeRun(APPLY, '1');
        return send(res, 200, { saved: true });
      }
      if (path === '/api/remote/reset-hostkey') {
        writeRun(RESET, '1');
        return send(res, 200, { saved: true });
      }
    }
    // Settings › Routines. Run now starts a report-only run out of sight and answers at once;
    // the state shows it running, then its result. Run / Apply in Console type the routine
    // into Claude in the Console, where each step asks first.
    if (path === '/api/routines/run') {
      const body = await readJson(req);
      const r = readRoutine(body?.id);
      if (r.problem) throw new RoutineError('bad-routine');
      if (listRoutines().some((x) => x.running)) throw new RoutineError('busy');
      runRoutine(r.id).then((result) => tellRoutine(r, result)).catch(() => {});
      return send(res, 200, { started: true });
    }
    if (path === '/api/routines/schedule') {
      const body = await readJson(req);
      setSchedule(body?.id, body?.schedule);
      return send(res, 200, { saved: true });
    }
    if (path === '/api/routines/enabled') {
      const body = await readJson(req);
      setEnabled(body?.id, body?.enabled === true);
      return send(res, 200, { saved: true });
    }
    if (path === '/api/routines/console') {
      const body = await readJson(req);
      const line = consoleLine(body || {});
      const typed = await typeIntoConsole(line);
      return typed === 'typed' ? send(res, 200, { typed: true }) : send(res, 409, { error: typed });
    }
    // Settings › Tools: saved into Claude Code's settings; a change starts Claude in the
    // Console again (with --continue) so it uses them.
    if (path === '/api/tools') {
      const body = await readJson(req);
      const relaunched = await withLoginLock(async () => {
        const { changed } = saveTools(body || {});
        return changed ? relaunchConsole() : 'none';
      });
      return send(res, 200, { saved: true, relaunched });
    }
    // Settings › Tools, a tool Claude added: on or off, the same way.
    if (path === '/api/tools/custom') {
      const body = await readJson(req);
      const relaunched = await withLoginLock(async () => {
        const { changed } = saveCustomTool(body || {});
        return changed ? relaunchConsole() : 'none';
      });
      return send(res, 200, { saved: true, relaunched });
    }
    // Settings › Telegram: the set-up pop-up's steps, the switches, and forgetting the bot.
    if (path.startsWith('/api/telegram/')) {
      const body = await readJson(req);
      if (path === '/api/telegram/token') return send(res, 200, { bot: await saveToken(body?.token) });
      if (path === '/api/telegram/pair') return send(res, 200, startPairing());
      if (path === '/api/telegram/test') {
        await sendTest();
        return send(res, 200, { sent: true });
      }
      if (path === '/api/telegram/prefs') {
        savePrefs(body || {});
        return send(res, 200, { saved: true });
      }
      if (path === '/api/telegram/ha') return send(res, 200, await setHa(body?.on === true));
      if (path === '/api/telegram/forget') {
        await forget();
        return send(res, 200, { saved: true });
      }
    }
  } catch (err) {
    if (err instanceof LoginError) return send(res, STATUS[err.code] || 409, { error: err.code });
    if (err instanceof TelegramError) {
      return send(res, { 'bad-token': 400, 'bad-prefs': 400, 'token-refused': 400, 'no-network': 502, 'no-ha': 502 }[err.code] || 409, {
        error: err.code,
      });
    }
    if (err instanceof RoutineError) {
      return send(res, { 'no-routine': 404, busy: 409, 'bad-routine': 409 }[err.code] || 400, { error: err.code });
    }
    if (err instanceof ToolsError) return send(res, err.code === 'no-tool' ? 404 : 400, { error: err.code });
    if (err instanceof RemoteError) return send(res, err.code === 'by-option' ? 409 : 400, { error: err.code });
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
  // Routines on a schedule: every 30 s, whatever is due runs (one run at a time).
  let ticking = false;
  setInterval(() => {
    if (ticking) return;
    ticking = true;
    tick(Date.now(), tellRoutine).finally(() => {
      ticking = false;
    });
  }, Number(env.ADDON_ROUTINE_TICK_MS) || 30e3).unref();
  // Telegram: one long poll after another while a bot is set (at most one a second), and a
  // look every 10 s for Claude waiting for an OK or a login that ran out.
  (async () => {
    for (;;) {
      const started = Date.now();
      let polled = false;
      try {
        polled = await pollOnce(telegramCtx);
      } catch {}
      await sleep(polled ? Math.max(0, 1000 - (Date.now() - started)) : 5000);
    }
  })();
  setInterval(() => watch(telegramCtx).catch(() => {}), 10e3).unref();
}
