// The Console on a phone (Playwright, headless Chromium, 390 px, touch): a finger swipe
// scrolls herdr's scrollback up and down, and a tap then typing still reaches the pane.
// The real herdr and ttyd, the page served by the real server.mjs, inside an iframe
// under an ingress-style path prefix as HA serves it (websocket included).
//
//   HERDR_REAL=/path/to/herdr-0.9.3 TTYD_REAL=/path/to/ttyd-1.7.7 \
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs \
//   node --test tests/browser/console-touch.browser.mjs
//
// Skipped, and said so, without any of the three.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { AGENT_DIR, HERE, sandbox } from '../helpers.mjs';

let chromium = null;
try {
  ({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright'));
} catch {}
const { HERDR_REAL, TTYD_REAL } = process.env;
const skip = !chromium ? 'Playwright is not installed (set PLAYWRIGHT_MODULE)'
  : !HERDR_REAL ? 'no real herdr (set HERDR_REAL)'
  : !TTYD_REAL ? 'no real ttyd (set TTYD_REAL)' : false;
const SHOTS = process.env.SCREENSHOT_DIR || null;
const PREFIX = '/api/hassio_ingress/Tok3n_abc/';
const LINES = 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// "Home Assistant": a page with the add-on in an iframe, and the ingress proxy that strips
// the prefix and forwards to the add-on, websockets too (the Console's terminal is one).
function haServer(addonPort) {
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<!doctype html><title>Home Assistant</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>body{margin:0}iframe{border:0;width:100vw;height:100vh;display:block}</style>
        <iframe src="${PREFIX}"></iframe>`);
    }
    if (!req.url.startsWith(PREFIX)) {
      res.writeHead(404);
      return res.end();
    }
    const up = http.request({ host: '127.0.0.1', port: addonPort, method: req.method,
      path: `/${req.url.slice(PREFIX.length)}`, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.end());
    req.pipe(up);
  });
  server.on('upgrade', (req, sock, head) => {
    const up = net.connect(addonPort, '127.0.0.1', () => {
      const headers = Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
      up.write(`${req.method} /${req.url.slice(PREFIX.length)} HTTP/1.1\r\n${headers}\r\n\r\n`);
      up.write(head);
      sock.pipe(up);
      up.pipe(sock);
    });
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
  });
  return server;
}

describe('The Console on a phone', { skip }, () => {
  let sb, env, home, herdrServer, ttyd, addon, ha, browser, page, con, cdp, box;
  const kids = [];

  // The pane lines on screen: "line N" from the pane's history, and anything typed.
  const screen = () => con.evaluate(() => {
    const t = window.term;
    const b = t.buffer.active;
    const rows = [];
    for (let y = 0; y < t.rows; y++) rows.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '');
    return rows.join('\n');
  });
  const firstLine = async () => Number((await screen()).match(/line (\d+)/)?.[1] ?? NaN);
  const touch = (type, x, y) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  // One finger drag of dy px (positive = down the screen), in steps, as a swipe sends it.
  async function swipe(dy) {
    const x = box.x + box.width / 2;
    const y0 = box.y + box.height / 2 - dy / 2;
    await touch('touchStart', x, y0);
    for (let k = 1; k <= 15; k++) {
      await touch('touchMove', x, y0 + (dy * k) / 15);
      await sleep(16);
    }
    await touch('touchEnd');
    await sleep(300);
  }
  async function until(what, fn) {
    for (let i = 0; i < 60; i++) {
      if (await fn()) return;
      await sleep(150);
    }
    assert.fail(`timed out: ${what}\n--- screen ---\n${await screen()}`);
  }

  before(async () => {
    sb = sandbox();
    // herdr's socket lives under $HOME; keep the path short (sun_path is 108 bytes).
    home = mkdtempSync(join(tmpdir(), 'hr-'));
    // The pane: a history to scroll through, then a shell to type into.
    const fill = join(sb.root, 'fill.sh');
    writeFileSync(fill, `#!/usr/bin/env bash\nfor i in $(seq 1 ${LINES}); do echo "line $i"; done\nexec bash --norc -i\n`);
    chmodSync(fill, 0o755);
    const toml = join(sb.root, 'console.toml');
    writeFileSync(toml, readFileSync(join(HERE, '..', 'rootfs', 'etc', 'herdr', 'console.toml'), 'utf8')
      .replace('/opt/addon-agent/pane-shell.sh', fill));
    env = { ...sb.env, HOME: home, HERDR_CONFIG_PATH: toml, PS1: '$ ' };
    delete env.XDG_CONFIG_HOME;
    // Run from inside a herdr pane, its variables would make the attach a refused nested herdr.
    for (const k of Object.keys(env)) if (k.startsWith('HERDR_') && k !== 'HERDR_CONFIG_PATH') delete env[k];
    const h = (...a) => spawnSync(HERDR_REAL, ['--session', 'claude', ...a], { env }).stdout.toString();
    herdrServer = spawn(HERDR_REAL, ['--session', 'claude', 'server'], { env, stdio: 'ignore', detached: true });
    for (let i = 0; i < 40 && !h('workspace', 'list').includes('workspace_list'); i++) await sleep(250);
    h('workspace', 'create', '--cwd', sb.root, '--label', 'claude');

    // ttyd as run.sh starts it, with a herdr client as console-attach.sh runs it.
    const attach = join(sb.root, 'attach.sh');
    writeFileSync(attach, `#!/usr/bin/env bash\nexec "${HERDR_REAL}" session attach claude\n`);
    chmodSync(attach, 0o755);
    // run.sh's own --client-option flags (the look's are defaults here, so none).
    const runSh = readFileSync(join(HERE, '..', 'run.sh'), 'utf8');
    const clientOpts = [...runSh.matchAll(/--client-option (\w+)=("[^"]*"|\S+)/g)]
      .flatMap(([, k, v]) => ['--client-option', `${k}=${v.replace(/^"|"$/g, '')}`]);
    const ttydPort = await freePort();
    ttyd = spawn(TTYD_REAL, ['--interface', '127.0.0.1', '--port', String(ttydPort), '--base-path', '/console',
      '--writable', ...clientOpts, attach], { env, stdio: 'ignore' });
    const addonPort = await freePort();
    addon = spawn(process.execPath, [join(AGENT_DIR, 'server.mjs')], {
      env: { ...env, ADDON_PORT: String(addonPort), ADDON_TTYD_PORT: String(ttydPort), ADDON_INGRESS_PEER: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise((r) => addon.stdout.on('data', (d) => String(d).includes('Page on') && r()));
    kids.push(ttyd, addon);
    ha = haServer(addonPort);
    const haPort = await freePort();
    await new Promise((r) => ha.listen(haPort, '127.0.0.1', r));

    browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    page = await ctx.newPage();
    cdp = await ctx.newCDPSession(page);
    await page.goto(`http://127.0.0.1:${haPort}/`);
    for (let i = 0; i < 80 && !con; i++) {
      con = page.frames().find((f) => f.url().endsWith('/console/'));
      if (!con) await sleep(250);
    }
    assert.ok(con, 'the Console frame loaded');
    await con.waitForFunction(() => window.term?.buffer.active.length > 0, null, { timeout: 15000 });
    await until(`the pane shows line ${LINES}`, async () => (await screen()).includes(`line ${LINES}`));
    box = await (await con.frameElement()).boundingBox();
  });

  after(async () => {
    await browser?.close();
    for (const k of kids) k?.kill();
    ha?.close();
    try {
      process.kill(-herdrServer.pid);
    } catch {}
    rmSync(home, { recursive: true, force: true });
    sb?.cleanup();
  });

  test('herdr reports the mouse, so the terminal itself ignores touch', async () => {
    const mode = await con.evaluate(() => window.term.modes.mouseTrackingMode);
    assert.notEqual(mode, 'none');
  });

  test('the text gets the whole width: no scrollbar column, no empty strip on the right', async () => {
    // herdr's pane scrollbar is drawn with this glyph down the right edge.
    assert.ok(!(await screen()).includes('▕'), 'no scrollbar column');
    let fit = null;
    await until('the terminal is fitted to the frame', async () => {
      fit = await con.evaluate(() => {
        const cell = window.term._core._renderService.dimensions.css.cell.width;
        const pad = getComputedStyle(window.term.element);
        const room = window.term.element.parentElement.clientWidth
          - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight);
        return { cols: window.term.cols, cell, room, fill: Math.floor(room / cell) };
      });
      return fit.cols === fit.fill;
    }).catch(() => assert.fail(`${fit.cols} columns in room for ${fit.fill} (${JSON.stringify(fit)})`));
    // ttyd's size box (e.g. "54x52") is off, so a fit flashes nothing over the text. ttyd
    // fits on a resize (as when a phone's keyboard opens) and shows the box for 300 ms.
    await page.setViewportSize({ width: 360, height: 844 });
    await sleep(150);
    const sizeBox = await con.evaluate(() => [...window.term.element.children]
      .some((c) => /^\d+x\d+$/.test(c.textContent) && c.style.opacity !== '0'));
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(500);
    assert.equal(sizeBox, false, 'no size box on a resize');
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'console-touch-390-width.png') });
  });

  test('a swipe down scrolls back into the history, a swipe up comes back', async () => {
    const bottom = await firstLine();
    await swipe(300);
    await swipe(300);
    const back = await firstLine();
    assert.ok(back < bottom - 20, `swiping down scrolled back: first line ${bottom} -> ${back}`);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'console-touch-390-scrolled.png') });
    await swipe(-300);
    const fwd = await firstLine();
    assert.ok(fwd > back, `swiping up scrolled forward: first line ${back} -> ${fwd}`);
    for (let i = 0; i < 4; i++) await swipe(-300);
    await until('back at the bottom', async () => (await firstLine()) === bottom);
  });

  test('a tap, then typing, still reaches the pane', async () => {
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height - 40);
    await sleep(200);
    await page.keyboard.type('echo typed-$((40+2))');
    await page.keyboard.press('Enter');
    await until('the typed command ran', async () => (await screen()).includes('typed-42'));
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'console-touch-390-typed.png') });
  });
});
