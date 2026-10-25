// The Seat sign-in in a real browser (Playwright, headless Chromium), with the page served
// by the real server.mjs and the fake claude, inside an iframe under an ingress-style path
// prefix as HA serves it. claude.com is routed to a stand-in code page with Copy Code.
//
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs \
//   SCREENSHOT_DIR=/some/dir node --test tests/browser/signin.browser.mjs
//
// Skipped, and said so, when Playwright cannot be loaded.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { AGENT_DIR, GOOD_CODE, GOOD_LINK, consoleHerdr, sandbox, writeRunFiles } from '../helpers.mjs';

let chromium = null;
try {
  ({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright'));
} catch {}
const skip = chromium ? false : 'Playwright is not installed (set PLAYWRIGHT_MODULE)';
const SHOTS = process.env.SCREENSHOT_DIR || null;
const PREFIX = '/api/hassio_ingress/Tok3n_abc/';

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function addonServer(sb, env) {
  const port = await freePort();
  const child = spawn(process.execPath, [join(AGENT_DIR, 'server.mjs')], {
    env: { ...sb.env, ADDON_PORT: String(port), ADDON_INGRESS_PEER: '127.0.0.1', ADDON_USAGE_SETTLE_MS: '400',
      ADDON_USAGE_POLL_MS: '200', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((r) => child.stdout.on('data', (d) => String(d).includes('Page on') && r()));
  return { port, child };
}

// "Home Assistant": a page with the add-on in an iframe, and the ingress proxy that
// strips the prefix and forwards to the add-on (from 127.0.0.1, as the ingress peer).
function haServer(getAddonPort) {
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<!doctype html><title>Home Assistant</title>
        <style>body{margin:0}iframe{border:0;width:100vw;height:100vh;display:block}</style>
        <iframe src="${PREFIX}" allow="clipboard-read; clipboard-write"></iframe>`);
    }
    if (!req.url.startsWith(PREFIX)) {
      res.writeHead(404);
      return res.end();
    }
    const up = http.request({ host: '127.0.0.1', port: getAddonPort(), method: req.method,
      path: `/${req.url.slice(PREFIX.length)}`, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    // The tests restart the add-on server; a request caught in that gap gets a 502, as
    // HA's proxy would answer, instead of an unhandled socket error.
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
  return server;
}

const CODE_PAGE = `<!doctype html><title>Claude</title>
  <p>Paste this into Claude Code:</p><code id="code">${GOOD_CODE}</code>
  <button id="copy" onclick="navigator.clipboard.writeText(document.getElementById('code').textContent).then(() => this.textContent = 'Copied')">Copy Code</button>`;

describe('Seat sign-in in a browser', { skip }, () => {
  let sb;
  let addon;
  let ttyd;
  let ha;
  let haPort;
  let browser;
  let addonPort;
  // A stand-in Telegram Bot API (0.4.2): getMe for the one good token, and every call kept.
  const TG_TOKEN = '123456789:AAExampleExampleExampleExample_abcd';
  const tgCalls = [];
  let tgApi;

  before(async () => {
    sb = sandbox({ herdr: consoleHerdr(), seat: null });
    writeRunFiles(sb, { pane: 'w1:p1', workspace: 'w1', state: 'claude' });
    writeFileSync(join(sb.data, 'claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":""}}');
    const ttydPort = await freePort();
    ttyd = http.createServer((q, s) => {
      s.writeHead(200, { 'Content-Type': 'text/html' });
      s.end('<body style="background:#000;color:#0f0;font:14px monospace">console here (stand-in ttyd)</body>');
    }).listen(ttydPort, '127.0.0.1');
    sb.env.ADDON_TTYD_PORT = String(ttydPort);
    const tgPort = await freePort();
    tgApi = http.createServer((q, s) => {
      let b = '';
      q.on('data', (c) => (b += c));
      q.on('end', () => {
        const method = q.url.split('/').pop();
        tgCalls.push({ method, params: b ? JSON.parse(b) : {} });
        if (!q.url.startsWith(`/bot${TG_TOKEN}/`)) {
          s.statusCode = 401;
          return s.end('{"ok":false}');
        }
        const result = method === 'getMe' ? { id: 42, is_bot: true, first_name: 'Home helper', username: 'my_home_helper_bot' }
          : method === 'getUpdates' ? [] : true;
        s.end(JSON.stringify({ ok: true, result }));
      });
    }).listen(tgPort, '127.0.0.1');
    sb.env.ADDON_TELEGRAM_API = `http://127.0.0.1:${tgPort}`;
    addon = await addonServer(sb, {});
    addonPort = addon.port;
    haPort = await freePort();
    ha = haServer(() => addonPort).listen(haPort, '127.0.0.1');
    // The full Chromium in its new headless mode (PW_CHANNEL=chromium) acts like a desktop
    // browser with several tabs; the older headless shell is the default.
    browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
    if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  });

  after(async () => {
    await browser?.close();
    addon?.child.kill();
    ttyd?.close();
    tgApi?.close();
    ha?.close();
    sb?.cleanup();
  });

  async function open({ width = 1280, scheme = 'light' } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, colorScheme: scheme });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://127.0.0.1:${haPort}` });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://claude.com' });
    await context.route('https://claude.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: CODE_PAGE }));
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${haPort}/`);
    const frame = page.frames().find((f) => f.url().includes(PREFIX)) || (await (await page.$('iframe')).contentFrame());
    await frame.waitForSelector('#chip:not(:text("…"))');
    return { context, page, frame };
  }

  async function shot(page, frame, name) {
    if (!SHOTS) return;
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
    const wide = await frame.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(wide <= 0, `${name}: no sideways scroll (${wide}px over)`);
  }

  test('the whole sign-in: a new tab lands on the link, Copy Code, paste, Sign in, Signed in', async () => {
    const { context, page, frame } = await open();
    assert.equal(await frame.textContent('#chip'), 'sign in needed');
    await shot(page, frame, 'console-1280-light');
    await frame.click('#tab-settings');
    await frame.waitForSelector('text=The login ran out.');
    await shot(page, frame, 'seat-lapsed-1280-light');

    const tabPromise = context.waitForEvent('page');
    await frame.click('text=Sign in at claude.ai ↗');
    const tab = await tabPromise;
    await tab.waitForURL((u) => u.href.startsWith('https://claude.com/'));
    assert.equal(tab.url(), GOOD_LINK, 'the new tab landed on the checked link');
    assert.equal(await tab.evaluate(() => window.opener), null, 'the tab has no opener');
    await frame.waitForSelector('#v-code:not([hidden])');
    await shot(page, frame, 'seat-code-1280-light');

    // On "claude.ai": press Copy Code. Back on the add-on page: read the clipboard, paste.
    await tab.click('text=Copy Code');
    await tab.waitForSelector('text=Copied');
    await page.bringToFront();
    const pasted = await frame.evaluate(() => navigator.clipboard.readText());
    assert.equal(pasted, GOOD_CODE);
    await frame.fill('#code', pasted);
    await frame.click('#submit');
    await frame.waitForSelector('text=Signed in. Claude in the Console was started again on the new login.');
    assert.equal(await frame.textContent('#chip'), 'signed in');
    await shot(page, frame, 'seat-done-1280-light');

    await frame.click('text=Open the Console');
    assert.equal(await frame.isVisible('#console iframe'), true);
    const consoleFrame = frame.childFrames()[0];
    await consoleFrame.waitForSelector('text=console here');
    await frame.click('#tab-settings');
    await frame.waitForSelector('#v-signed-in:not([hidden])');
    assert.match(await frame.textContent('#seat-head'), /Seat.*Signed in.*Max plan · since/s);
    assert.match(await frame.textContent('#v-signed-in'), /stored in the add-on's own folder \(\/data\/claude\)/);
    await shot(page, frame, 'seat-signed-in-1280-light');
    await context.close();
  });

  test('never signed in (no login file): "Not signed in yet." and the same button as a lapsed login', async () => {
    rmSync(join(sb.data, 'claude', '.credentials.json'), { force: true });
    const { context, frame } = await open();
    assert.equal(await frame.textContent('#chip'), 'sign in needed');
    await frame.click('#tab-settings');
    await frame.waitForSelector('text=Not signed in yet.');
    assert.equal(await frame.isVisible('text=The login ran out.'), false);
    assert.equal(await frame.isVisible('text=Sign in at claude.ai ↗'), true);
    await context.close();
  });

  test('no clipboard (HA over plain http): Copy the link shows the link in a box, selected', async () => {
    writeFileSync(join(sb.data, 'claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":""}}');
    const { context, frame } = await open();
    // A page that is not a secure context has no navigator.clipboard at all.
    await frame.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }));
    await frame.click('#tab-settings');
    const tab = context.waitForEvent('page');
    await frame.click('text=Sign in at claude.ai ↗');
    await (await tab).close();
    assert.equal(await frame.isVisible('#link-box'), false, 'no box before Copy the link');
    await frame.click('#copy');
    await frame.waitForSelector('#link-box:visible');
    assert.equal(await frame.inputValue('#link-box'), GOOD_LINK);
    assert.equal(await frame.getAttribute('#link-box', 'readonly'), '');
    const selected = await frame.evaluate(() => {
      const b = document.getElementById('link-box');
      return document.activeElement === b && b.selectionStart === 0 && b.selectionEnd === b.value.length;
    });
    assert.equal(selected, true, 'the whole link is selected');
    await frame.click('#cancel');
    await frame.waitForSelector('#link-box', { state: 'hidden' });
    assert.equal(await frame.inputValue('#link-box'), '', 'Cancel hides and empties the box');
    await context.close();
  });

  test('a login past its expiresAt shows the banner; the oauth_token option shows signed in by option', async () => {
    const creds = join(sb.data, 'claude', '.credentials.json');
    writeFileSync(creds, '{"claudeAiOauth":{"accessToken":"fake-x","expiresAt":1000}}');
    let { context, frame } = await open();
    assert.equal(await frame.textContent('#chip'), 'sign in needed');
    await frame.click('#tab-settings');
    await frame.waitForSelector('text=The login ran out.');
    await context.close();

    const opts = join(sb.data, 'options.json');
    writeFileSync(opts, JSON.stringify({ oauth_token: 'fake-option-token-value-secret' }));
    try {
      let page;
      ({ context, page, frame } = await open({ width: 360 }));
      assert.equal(await frame.textContent('#chip'), 'signed in');
      await frame.click('#tab-settings');
      await frame.waitForSelector('#v-signed-in:not([hidden])');
      assert.match(await frame.textContent('#seat-head'), /Signed in.*by the oauth_token option/s);
      assert.match(await frame.textContent('#v-signed-in'), /clear that option and restart the add-on/);
      assert.equal(await frame.isVisible('#again'), false, 'no Sign in again while the option is set');
      assert.doesNotMatch(await frame.textContent('#seat-meta'), /plan/);
      assert.ok(!(await frame.content()).includes('option-secret'));
      await shot(page, frame, 'seat-by-option-360-light');
      await context.close();
    } finally {
      writeFileSync(opts, JSON.stringify({}));
    }
  });

  test('Open the sign-in again ↗ opens the link again; a wrong code gets the plain message', async () => {
    writeFileSync(join(sb.data, 'claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":""}}');
    const { context, frame } = await open();
    await frame.click('#tab-settings');
    const first = context.waitForEvent('page');
    await frame.click('text=Sign in at claude.ai ↗');
    const tab = await first;
    await tab.waitForURL((u) => u.href.startsWith('https://claude.com/'));
    await tab.close();
    const again = context.waitForEvent('page');
    await frame.click('text=Open the sign-in again ↗');
    const tab2 = await again;
    await tab2.waitForURL((u) => u.href.startsWith('https://claude.com/'));
    assert.equal(tab2.url(), GOOD_LINK);

    await frame.fill('#code', 'wrong-code-0123456789');
    await frame.click('#submit');
    await frame.waitForSelector('text=claude.ai did not take that code. Copy all of it and paste it again, or press Sign in at claude.ai for a fresh one.');
    await frame.click('#cancel');
    await context.close();
  });

  test('Settings: the tab, the seat row, provider, and a saved name, model and thinking level', async () => {
    const creds = join(sb.data, 'claude', '.credentials.json');
    const settingsFile = join(sb.data, 'claude', 'settings.json');
    writeFileSync(creds, '{"claudeAiOauth":{"accessToken":"fake-x","refreshToken":"r","subscriptionType":"pro"}}');
    writeFileSync(settingsFile, JSON.stringify({ theme: 'dark' }));
    // The later tests start signed out with no seat file, whatever happens here.
    const contexts = [];
    try {
      const { context, page, frame } = await open();
      contexts.push(context);
      assert.equal(await frame.textContent('#tab-settings'), 'Settings');
      await frame.click('#tab-settings');
      await frame.waitForSelector('#v-signed-in:not([hidden])');
      assert.equal(await frame.textContent('#settings h1'), 'Seat(s)');
      // "Seat", its name and the signed-in text sit on one row.
      const tops = await frame.evaluate(() =>
        ['.seat-head .label', '#seat-name', '#seat-chip'].map((q) => Math.round(document.querySelector(q).getBoundingClientRect().top)));
      assert.ok(Math.max(...tops) - Math.min(...tops) <= 4, `one row: ${tops}`);
      assert.equal(await frame.textContent('#seat-name'), 'claude', 'no name yet: the seat id');
      assert.match(await frame.textContent('#seat-meta'), /^Pro plan · since /);
      // Provider is a list: Anthropic picked; OpenAI and Grok shown but greyed out.
      assert.equal(await frame.inputValue('#provider'), 'anthropic');
      const providers = await frame.$$eval('#provider option', (os) => os.map((o) => [o.value, o.textContent, o.disabled]));
      assert.deepEqual(providers, [
        ['anthropic', 'Anthropic · Claude Code', false],
        ['openai', 'OpenAI · coming later', true],
        ['grok', 'Grok · coming later', true],
      ]);
      assert.equal(await frame.inputValue('#model'), '');
      assert.equal(await frame.inputValue('#thinking'), '');
      // Permission levels with names (0.4.3), each with its line underneath.
      assert.equal(await frame.inputValue('#level'), 'copilot');
      assert.deepEqual(await frame.$$eval('#level option', (os) => os.map((o) => o.textContent)),
        ['Training wheels', 'Co-pilot', 'Autopilot', 'Jarvis mode']);
      assert.match(await frame.textContent('#level-d'), /asks before each change/);

      assert.deepEqual(await frame.$$eval('#model option', (os) => os.map((o) => o.textContent)),
        ['Default (your plan picks)', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5', 'Fable 5.1']);
      await frame.fill('#name', 'Kitchen');
      await frame.selectOption('#model', 'claude-sonnet-5-5');
      await frame.selectOption('#thinking', 'high');
      await frame.selectOption('#level', 'autopilot');
      assert.match(await frame.textContent('#level-d'), /edits files without asking/);
      await frame.click('#save');
      await frame.waitForSelector('text=Saved. Claude in the Console was started again with these settings; the conversation is kept.');
      // The row takes the new name from the refresh that follows the save.
      await frame.waitForSelector('#seat-name:text-is("Kitchen")');
      assert.equal(await frame.inputValue('#model'), 'claude-sonnet-5-5');
      assert.equal(await frame.inputValue('#thinking'), 'high');
      assert.equal(await frame.inputValue('#level'), 'autopilot');
      const saved = JSON.parse(readFileSync(settingsFile, 'utf8'));
      assert.deepEqual([saved.theme, saved.model, saved.effortLevel, saved.permissions?.defaultMode],
        ['dark', 'claude-sonnet-5-5', 'high', 'acceptEdits']);
      await shot(page, frame, 'settings-saved-1280-light');

      // An edit not saved yet survives a refresh of the page's state.
      await frame.fill('#name', 'Not saved');
      await frame.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await frame.waitForTimeout(300);
      assert.equal(await frame.inputValue('#name'), 'Not saved');
      await context.close();

      // Signed out: the same form, with Sign in at claude.ai beside Save.
      writeFileSync(creds, '{"claudeAiOauth":{"accessToken":""}}');
      const out = await open({ width: 360 });
      contexts.push(out.context);
      await out.frame.click('#tab-settings');
      await out.frame.waitForSelector('#v-signed-out:not([hidden])');
      assert.equal(await out.frame.textContent('#seat-chip'), 'Signed out');
      assert.equal(await out.frame.isVisible('#save'), true);
      assert.equal(await out.frame.isVisible('#start'), true);
      assert.equal(await out.frame.isVisible('#again'), false);
      assert.equal(await out.frame.textContent('#seat-name'), 'Kitchen');
      await shot(out.page, out.frame, 'settings-signed-out-360-light');
    } finally {
      for (const c of contexts) await c.close().catch(() => {});
      writeFileSync(creds, '{"claudeAiOauth":{"accessToken":""}}');
      rmSync(settingsFile, { force: true });
      rmSync(join(sb.data, 'seat.json'), { force: true });
    }
  });

  test('Settings: plan usage, read from Claude\'s /usage when Settings opens, as bars with when each resets', async () => {
    const creds = join(sb.data, 'claude', '.credentials.json');
    const cache = join(sb.data, 'claude', '.claude.json');
    writeFileSync(creds, '{"claudeAiOauth":{"accessToken":"fake-x","refreshToken":"r","subscriptionType":"max"}}');
    rmSync(cache, { force: true });
    // A fresh server: the earlier tests' readings would make this one's first ask "too soon".
    addon.child.kill();
    addon = await addonServer(sb, {});
    addonPort = addon.port;
    const contexts = [];
    try {
      const { context, page, frame } = await open();
      contexts.push(context);
      assert.equal(await frame.isVisible('#usage'), false, 'nothing on the Console tab');
      await frame.click('#tab-settings');
      await frame.waitForSelector('#usage:not([hidden])');
      await frame.waitForSelector('#usage-bars .bar >> nth=2', { timeout: 15000 });
      const bars = await frame.$$eval('#usage-bars .bar', (bs) =>
        bs.map((b) => [b.children[0].textContent, b.querySelector('.pct').textContent, b.querySelector('.fill').className]));
      assert.deepEqual(bars, [
        ['5-hour session', '42%', 'fill'],
        ['Week, all models', '81%', 'fill high'],
        ['Week, Fable', '12%', 'fill'],
      ]);
      assert.match(await frame.textContent('#usage-bars .bar .reset'), /^Resets /);
      assert.equal(await frame.textContent('#usage-at'), 'read just now');
      assert.equal(await frame.isVisible('#usage-note'), false);
      await shot(page, frame, 'settings-usage-1280-light');
      // Refresh within a minute of the last reading is answered "too soon" and keeps the bars.
      await frame.click('#usage-refresh');
      await frame.waitForTimeout(500);
      assert.equal(await frame.$$eval('#usage-bars .bar', (bs) => bs.length), 3);

      const dark = await open({ width: 360, scheme: 'dark' });
      contexts.push(dark.context);
      await dark.frame.click('#tab-settings');
      await dark.frame.waitForSelector('#usage-bars .bar >> nth=2');
      await shot(dark.page, dark.frame, 'settings-usage-360-dark');

      // The oauth_token option: no bars, and why.
      writeFileSync(join(sb.data, 'options.json'), JSON.stringify({ oauth_token: 'fake-option-token-value' }));
      const opt = await open({ width: 360 });
      contexts.push(opt.context);
      await opt.frame.click('#tab-settings');
      await opt.frame.waitForSelector('text=Plan usage is not shown for a login set by the oauth_token option.');
      assert.equal(await opt.frame.$$eval('#usage-bars .bar', (bs) => bs.length), 0);
    } finally {
      for (const c of contexts) await c.close().catch(() => {});
      writeFileSync(join(sb.data, 'options.json'), '{}');
      writeFileSync(creds, '{"claudeAiOauth":{"accessToken":""}}');
      rmSync(cache, { force: true });
    }
  });

  test('a bad link from the server: the blank tab is closed and nothing is opened', async () => {
    addon.child.kill();
    addon = await addonServer(sb, { FAKE_LINK: GOOD_LINK.replace('9d1c250a', '00000000') });
    addonPort = addon.port;
    const { context, frame } = await open();
    await frame.click('#tab-settings');
    const tabPromise = context.waitForEvent('page');
    await frame.click('text=Sign in at claude.ai ↗');
    const tab = await tabPromise;
    if (!tab.isClosed()) await tab.waitForEvent('close', { timeout: 25000 });
    assert.equal(tab.isClosed(), true, 'the blank tab was closed');
    await frame.waitForSelector('text=The sign-in link was not one this add-on accepts');
    assert.equal(context.pages().length, 1);
    await context.close();
  });

  test('the page checks the link itself: a bad link in the answer closes the tab too', async () => {
    addon.child.kill();
    addon = await addonServer(sb, {});
    addonPort = addon.port;
    const { context, frame } = await open();
    await context.route('**/api/login/start', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ url: `${GOOD_LINK}&scope=user%3Aprofile` }) }));
    let landed = false;
    await context.route('https://claude.com/**', (route) => {
      landed = true;
      return route.fulfill({ status: 200, contentType: 'text/html', body: CODE_PAGE });
    });
    await frame.click('#tab-settings');
    const tabPromise = context.waitForEvent('page');
    await frame.click('text=Sign in at claude.ai ↗');
    const tab = await tabPromise;
    if (!tab.isClosed()) await tab.waitForEvent('close', { timeout: 10000 });
    assert.equal(landed, false, 'the tab never went to the bad link');
    await frame.waitForSelector('text=The sign-in link was not one this add-on accepts');
    await context.close();
  });

  test('Settings: the Console\'s theme and font size, saved and shown once ttyd is back; the remote console', async () => {
    const options = join(sb.data, 'options.json');
    const keyDir = join(sb.data, 'ssh');
    const contexts = [];
    try {
      writeFileSync(join(sb.run, 'ttyd.pid'), '100\n');
      writeFileSync(join(sb.run, 'remote'), 'off\n');
      const { context, page, frame } = await open();
      contexts.push(context);
      await frame.click('#tab-settings');
      // 0.4.0: Settings has a menu; one section shows at a time, the Seat first.
      assert.deepEqual(await frame.$$eval('.nav button', (bs) => bs.map((b) => b.dataset.sec)), ['seat', 'look', 'routines', 'tools', 'telegram', 'remote']);
      assert.equal(await frame.isVisible('#sec-seat'), true);
      assert.equal(await frame.isVisible('#sec-look'), false);
      await frame.click('#nav-look');
      assert.equal(await frame.isVisible('#sec-seat'), false);
      await frame.waitForSelector('#theme option', { state: 'attached' });
      const themes = await frame.$$eval('#theme option', (os) => os.map((o) => [o.value, o.textContent]));
      assert.equal(themes.length, 18);
      assert.deepEqual(themes[0], ['', 'AI Intervention (default)']);
      assert.deepEqual(themes.find(([v]) => v === 'catppuccin-latte'), ['catppuccin-latte', 'Catppuccin Latte (light)']);
      assert.equal(await frame.inputValue('#theme'), '');
      assert.deepEqual(await frame.$$eval('#font-size option', (os) => os.map((o) => o.textContent)),
        ['Default (13 px)', '12 px', '14 px', '16 px', '18 px', '20 px']);

      await frame.selectOption('#theme', 'nord');
      await frame.selectOption('#font-size', '16');
      await frame.click('#save-look');
      await frame.waitForSelector('text=Saved. The Console reconnects with the new look in a few seconds; Claude keeps running.');
      assert.equal(readFileSync(join(sb.run, 'ttyd-restart'), 'utf8').trim(), '1', 'run.sh is asked to start ttyd again');
      assert.match(readFileSync(join(sb.run, 'herdr', 'console.toml'), 'utf8'), /^name = "nord"$/m);
      // run.sh's part: ttyd started again with a new process.
      rmSync(join(sb.run, 'ttyd-restart'));
      writeFileSync(join(sb.run, 'ttyd.pid'), '200\n');
      await frame.waitForSelector('text=Saved. The Console has the new look.', { timeout: 8000 });
      assert.equal(await frame.inputValue('#theme'), 'nord');
      assert.equal(await frame.inputValue('#font-size'), '16');
      assert.equal(await frame.$eval('#frame', (f) => getComputedStyle(f).backgroundColor), 'rgb(46, 52, 64)', 'Nord fills the frame');
      await shot(page, frame, 'settings-console-1280-light');

      // The remote console: off and closed by default, Enable opens the form.
      await frame.click('#nav-remote');
      await frame.waitForSelector('#sec-remote:visible');
      assert.equal(await frame.textContent('#remote-chip'), 'Off');
      assert.equal(await frame.textContent('#nav-remote-s'), 'Off');
      assert.equal(await frame.isVisible('#r-form'), false);
      assert.equal(await frame.isVisible('#remote-host'), false, 'no host key while off');
      await frame.click('#r-enable');
      await frame.waitForSelector('#r-form:visible');
      // A fresh ed25519 public key in ssh's format: its type and its 32 bytes, each length-prefixed.
      const field = (b) => Buffer.concat([Buffer.from([0, 0, 0, b.length]), b]);
      const sshKey = () => {
        const raw = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
        return Buffer.concat([field(Buffer.from('ssh-ed25519')), field(raw)]).toString('base64');
      };
      await frame.fill('#r-key', 'not a key');
      await frame.fill('#r-from', '192.0.2.10');
      await frame.click('#r-turn-on');
      await frame.waitForSelector('text=That is not one ssh-ed25519 public key line');
      const key = `ssh-ed25519 ${sshKey()} desk`;
      await frame.fill('#r-key', key);
      await frame.click('#r-turn-on');
      await frame.waitForSelector('#r-pending:visible');
      assert.deepEqual(JSON.parse(readFileSync(join(sb.data, 'remote.json'), 'utf8')), { key, from: '192.0.2.10', enabled: true });
      assert.equal(readFileSync(join(sb.run, 'remote-apply'), 'utf8').trim(), '1', 'run.sh is asked to apply it');
      // run.sh's part: the key line, sshd, and a host key.
      mkdirSync(keyDir, { recursive: true });
      writeFileSync(join(keyDir, 'ssh_host_ed25519_key.pub'), `ssh-ed25519 ${sshKey()} test\n`);
      writeFileSync(join(sb.run, 'remote'), 'on\n');
      rmSync(join(sb.run, 'remote-apply'));
      await frame.waitForSelector('#r-on:visible', { timeout: 8000 });
      assert.equal(await frame.textContent('#remote-chip'), 'On');
      assert.equal(await frame.textContent('#r-from-v'), '192.0.2.10');
      assert.equal(await frame.textContent('#r-key-v'), 'ssh-ed25519 … desk');
      assert.equal(await frame.textContent('#remote-host'), 'SHA256:••••••••••••••', 'hidden until Show');
      await frame.click('#r-show');
      await frame.waitForSelector('#remote-host:text-matches("^SHA256:[A-Za-z0-9+/]{43}$")');
      await frame.click('#r-show');
      assert.equal(await frame.textContent('#remote-host'), 'SHA256:••••••••••••••', 'Hide hides it again');
      // Actions sit bottom right, the main one furthest right.
      const boxes = await frame.$$eval('#r-on .row button', (bs) => bs.map((b) => [b.id, b.getBoundingClientRect().right]));
      const row = await frame.$eval('#r-on .row', (r) => r.getBoundingClientRect().right);
      assert.equal(boxes.at(-1)[0], 'r-off');
      assert.ok(Math.abs(boxes.at(-1)[1] - row) < 2, 'the last button meets the right edge');

      await frame.click('#r-reset');
      await frame.waitForSelector('#confirm[open]');
      assert.match(await frame.textContent('#confirm'), /refuse/);
      await frame.click('#confirm-ok');
      await frame.waitForSelector('#r-pending:visible');
      assert.equal(readFileSync(join(sb.run, 'hostkey-reset'), 'utf8').trim(), '1', 'run.sh makes the new host key');
      rmSync(join(sb.run, 'hostkey-reset'));

      const wide = await open({ width: 360, scheme: 'dark' });
      contexts.push(wide.context);
      await wide.frame.click('#tab-settings');
      await wide.frame.click('#nav-remote');
      await wide.frame.waitForSelector('#r-on:visible');
      await shot(wide.page, wide.frame, 'settings-remote-360-dark');

      await frame.click('#r-off');
      await frame.waitForSelector('#r-pending:visible');
      assert.equal(JSON.parse(readFileSync(join(sb.data, 'remote.json'), 'utf8')).enabled, false, 'off keeps the key');
      writeFileSync(join(sb.run, 'remote'), 'off\n');
      rmSync(join(sb.run, 'remote-apply'));
      await frame.waitForSelector('#r-off-kept:visible', { timeout: 8000 });

      // Set by the options: the page says so and offers no changes, only the host key.
      writeFileSync(options, JSON.stringify({ remote_key: key, remote_allow_from: '192.0.2.10' }));
      writeFileSync(join(sb.run, 'remote'), 'on\n');
      await frame.waitForSelector('#remote-option:visible', { timeout: 8000 });
      for (const id of ['#r-off', '#r-remove', '#r-change']) assert.equal(await frame.isVisible(id), false, id);
      assert.equal(await frame.isVisible('#r-show'), true);
    } finally {
      for (const c of contexts) await c.close().catch(() => {});
      for (const f of ['ttyd.pid', 'ttyd-restart', 'remote', 'remote-apply', 'hostkey-reset']) rmSync(join(sb.run, f), { force: true });
      rmSync(join(sb.run, 'herdr'), { recursive: true, force: true });
      rmSync(join(sb.data, 'look.json'), { force: true });
      rmSync(join(sb.data, 'remote.json'), { force: true });
      rmSync(keyDir, { recursive: true, force: true });
      writeFileSync(options, '{}');
    }
  });

  test('Settings › Routines and Tools: the list with its last result, schedule, Run in Console, starters; the tool switches', async () => {
    const dir = join(sb.data, 'routines');
    const contexts = [];
    try {
      mkdirSync(join(dir, '.results'), { recursive: true });
      writeFileSync(join(dir, 'morning-health-check.md'),
        '---\nname: Morning health check\ndescription: Reads repairs and low batteries, and writes a short report.\nschedule: daily 07:00\n---\nLook around and report.\n');
      writeFileSync(join(dir, '.results', 'morning-health-check.json'), JSON.stringify({
        at: Date.now() - 3600e3, durationMs: 48000, ok: true, summary: '2 things to look at', fixes: 1,
        report: 'Summary: 2 things to look at\nFixes waiting: 1\n\n- Kitchen motion sensor unavailable for 9 h.',
      }));
      const { context, page, frame } = await open();
      contexts.push(context);
      await frame.click('#tab-settings');
      await frame.click('#nav-routines');
      await frame.waitForSelector('.rt[data-id="morning-health-check"]');
      assert.equal(await frame.textContent('#nav-routines-s'), '1');
      const card = '.rt[data-id="morning-health-check"]';
      assert.equal(await frame.textContent(`${card} .n`), 'Morning health check');
      assert.match(await frame.textContent(`${card} .last`), /2 things to look at/);
      assert.match(await frame.textContent(`${card} .last`), /1 fix waiting/);
      assert.equal(await frame.inputValue(`${card} .rt-kind`), 'daily');
      assert.equal(await frame.inputValue(`${card} .rt-time`), '07:00');
      await frame.click(`${card} .rt-report`);
      await frame.waitForSelector(`${card} pre:text("Kitchen motion sensor")`);
      // The main button last, at the right.
      const ids = await frame.$$eval(`${card} .row:last-child button`, (bs) => bs.map((b) => b.className));
      assert.match(ids.at(-1), /primary/);
      // The starters stay offered under the list (0.4.3: eight).
      assert.match(await frame.textContent('#rt-starters-note'), /^More ideas/);
      assert.equal((await frame.$$('[data-starter]:visible')).length, 8);

      await frame.selectOption(`${card} .rt-kind`, 'weekdays');
      await frame.fill(`${card} .rt-time`, '06:30');
      await frame.dispatchEvent(`${card} .rt-time`, 'change');
      await frame.waitForSelector('text=Saved: Weekdays 6:30 AM');
      assert.match(readFileSync(join(dir, 'morning-health-check.md'), 'utf8'), /^schedule: weekdays 06:30$/m);

      const typedBefore = sb.herdr().panes['w1:p1'].lines.length;
      await frame.click(`${card} .rt-apply`);
      await frame.waitForSelector('#console:not([hidden])');
      const typed = sb.herdr().panes['w1:p1'].lines.slice(typedBefore).filter((l) => l.startsWith('typed:'));
      assert.match(typed.join('\n'), /Apply the fixes from the last run of my routine "Morning health check"/);

      const wide = await open({ width: 360, scheme: 'dark' });
      contexts.push(wide.context);
      await wide.frame.click('#tab-settings');
      await wide.frame.click('#nav-routines');
      await wide.frame.waitForSelector(card);
      await shot(wide.page, wide.frame, 'settings-routines-360-dark');

      // No routines: the starters, each typed into the Console as a request to make it.
      rmSync(dir, { recursive: true, force: true });
      await frame.click('#tab-settings');
      await frame.waitForSelector('#rt-empty:visible', { timeout: 8000 });
      assert.equal(await frame.textContent('#nav-routines-s'), 'None');
      const before2 = sb.herdr().panes['w1:p1'].lines.length;
      await frame.click('[data-starter="spook"]');
      await frame.waitForSelector('#console:not([hidden])');
      assert.match(sb.herdr().panes['w1:p1'].lines.slice(before2).join('\n'), /Make a routine called "Fix Spook's repair items"/);

      // Tools: two switches, saved into Claude Code's settings.
      await frame.click('#tab-settings');
      await frame.click('#nav-tools');
      await frame.waitForSelector('#tool-snapshot', { state: 'attached' });
      assert.equal(await frame.isChecked('#tool-snapshot'), false);
      assert.equal(await frame.isChecked('#tool-web'), true);
      assert.equal(await frame.textContent('#nav-tools-s'), '1 on');
      await frame.check('#tool-snapshot');
      await frame.click('#save-tools');
      await frame.waitForSelector('#tools-saved:visible');
      const settings = JSON.parse(readFileSync(join(sb.data, 'claude', 'settings.json'), 'utf8'));
      assert.equal(settings.hooks.PreToolUse.at(-1).hooks[0].command, '/opt/addon-agent/snapshot.sh');
      await frame.waitForSelector('#nav-tools-s:text("2 on")');

      // A tool Claude added: listed, off until switched on here.
      assert.ok(await frame.isVisible('#ct-empty'));
      mkdirSync(join(sb.data, 'tools'), { recursive: true });
      writeFileSync(join(sb.data, 'tools', 'weather.json'), JSON.stringify({
        name: 'Weather service', description: 'Reads the forecast for automations.', kind: 'mcp',
        config: { command: 'npx', args: ['weather-mcp'], env: { WEATHER_KEY: 'do-not-show-me' } },
      }));
      await frame.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      const ct = '.ct[data-tool="weather"]';
      await frame.waitForSelector(ct, { timeout: 8000 });
      assert.equal(await frame.textContent(`${ct} .run`), 'Runs: npx weather-mcp');
      assert.doesNotMatch(await frame.textContent('#sec-tools'), /do-not-show-me/);
      assert.equal(await frame.textContent(`${ct} button`), 'Switch on');
      await shot(page, frame, 'settings-tools-1280-light');
      await frame.click(`${ct} button`);
      await frame.waitForSelector('#ct-saved:visible');
      await frame.waitForSelector(`${ct} button:text("Switch off")`);
      const mcp = JSON.parse(readFileSync(join(sb.data, 'claude', 'addon-mcp.json'), 'utf8'));
      assert.deepEqual(Object.keys(mcp.mcpServers), ['weather']);
      await frame.waitForSelector('#nav-tools-s:text("3 on")');
      await frame.click(`${ct} button`);
      await frame.waitForSelector(`${ct} button:text("Switch on")`);
    } finally {
      for (const c of contexts) await c.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
      rmSync(join(sb.data, 'tools'), { recursive: true, force: true });
      rmSync(join(sb.data, 'claude', 'settings.json'), { force: true });
      rmSync(join(sb.run, 'relaunch'), { force: true });
    }
  });

  test('Jarvis mode: one question first; then every tool allowed and Snapshot locked on', async () => {
    const contexts = [];
    try {
      const { context, page, frame } = await open();
      contexts.push(context);
      await frame.click('#tab-settings');
      await frame.waitForSelector('#level option[value="jarvis"]', { state: 'attached' });
      await frame.selectOption('#level', 'jarvis');
      await frame.click('#save');
      await frame.waitForSelector('#confirm[open]');
      assert.equal(await frame.textContent('#confirm-title'), 'Turn on Jarvis mode?');
      await shot(page, frame, 'settings-jarvis-confirm-1280-light');
      await frame.click('#confirm-cancel');
      await frame.waitForSelector('#confirm:not([open])', { state: 'attached' });
      assert.equal(existsSync(join(sb.data, 'jarvis.json')), false, 'Cancel saves nothing');

      await frame.click('#save');
      await frame.waitForSelector('#confirm[open]');
      await frame.click('#confirm-ok');
      await frame.waitForSelector('#saved:visible');
      const s = JSON.parse(readFileSync(join(sb.data, 'claude', 'settings.json'), 'utf8'));
      assert.equal(s.permissions.defaultMode, 'acceptEdits');
      assert.ok(s.permissions.allow.includes('Bash'));
      await frame.click('#nav-tools');
      await frame.waitForSelector('#tool-snapshot:disabled', { state: 'attached' });
      assert.equal(await frame.isChecked('#tool-snapshot'), true);
      await shot(page, frame, 'settings-tools-jarvis-1280-light');

      await frame.click('#nav-seat');
      await frame.selectOption('#level', 'copilot');
      await frame.click('#save');
      for (let i = 0; i < 50 && existsSync(join(sb.data, 'jarvis.json')); i++) await frame.waitForTimeout(100);
      assert.equal(existsSync(join(sb.data, 'jarvis.json')), false, 'leaving Jarvis needs no question');
      assert.equal(await frame.isVisible('#confirm'), false);
    } finally {
      for (const c of contexts) await c.close().catch(() => {});
      rmSync(join(sb.data, 'jarvis.json'), { force: true });
      rmSync(join(sb.data, 'claude', 'settings.json'), { force: true });
      rmSync(join(sb.run, 'relaunch'), { force: true });
    }
  });

  test('Settings › Telegram: the set-up pop-up (BotFather, token, Start link, test, Home Assistant), then the switches and Forget', async () => {
    const contexts = [];
    const file = join(sb.data, 'telegram.json');
    try {
      const { context, page, frame } = await open();
      contexts.push(context);
      await frame.click('#tab-settings');
      await frame.click('#nav-telegram');
      await frame.waitForSelector('#sec-telegram:visible');
      assert.equal(await frame.textContent('#nav-telegram-s'), 'Off');
      await frame.click('#tg-setup');
      await frame.waitForSelector('#tg-dialog[open]');
      // Step 1: BotFather in Telegram, opened in a new tab; /newbot to copy.
      assert.equal(await frame.getAttribute('#tg-botfather', 'href'), 'https://t.me/BotFather');
      assert.equal(await frame.getAttribute('#tg-botfather', 'target'), '_blank');
      assert.match(await frame.textContent('#tg-step-1'), /\/newbot/);
      await shot(page, frame, 'telegram-step1-1280-light');
      await frame.click('#tg-next');
      // Step 2: the token, checked on the spot; a bad one says so and goes nowhere.
      await frame.waitForSelector('#tg-step-2:visible');
      assert.equal(await frame.getAttribute('#tg-token', 'type'), 'password');
      const calls = tgCalls.length;
      await frame.fill('#tg-token', 'not a token');
      await frame.click('#tg-check');
      await frame.waitForSelector('#tg-error:visible');
      assert.equal(tgCalls.length, calls, 'a bad shape never reaches Telegram');
      await frame.fill('#tg-token', TG_TOKEN);
      await frame.click('#tg-check');
      await frame.waitForSelector('text=Found your bot: Home helper (@my_home_helper_bot)');
      assert.equal(await frame.inputValue('#tg-token'), '', 'the box is emptied once it is kept');
      await frame.click('#tg-next');
      // Step 3: the Start link with its one-time code; connected once the bot hears it.
      await frame.waitForSelector('#tg-step-3:visible');
      await frame.waitForSelector('#tg-open-bot[href]');
      const href = await frame.getAttribute('#tg-open-bot', 'href');
      assert.match(href, /^https:\/\/t\.me\/my_home_helper_bot\?start=[a-f0-9]{24}$/);
      assert.equal(await frame.isEnabled('#tg-next'), false, 'Next waits for the chat');
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      writeFileSync(file, JSON.stringify({ ...saved, chat: { id: 555, name: 'Sam' }, pairing: null }), { mode: 0o600 });
      await frame.waitForSelector("text=Connected to Sam's chat", { timeout: 8000 });
      await frame.click('#tg-next');
      // Step 4: the test message.
      await frame.waitForSelector('#tg-step-4:visible');
      const testSent = () => tgCalls.some((c) => c.method === 'sendMessage' && c.params.chat_id === 555);
      for (let i = 0; i < 30 && !testSent(); i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(testSent(), 'the test message went to the paired chat');
      await frame.click('#tg-next');
      // Step 5: Home Assistant, on by default; Skip leaves it out.
      await frame.waitForSelector('#tg-step-5:visible');
      assert.equal(await frame.isChecked('#tg-ha'), true);
      await shot(page, frame, 'telegram-step5-1280-light');
      await frame.click('#tg-skip');
      await frame.waitForSelector('#tg-dialog:not([open])', { state: 'attached' });
      await frame.waitForSelector('#tg-on:visible');
      assert.equal(await frame.textContent('#nav-telegram-s'), 'On');
      assert.match(await frame.textContent('#tg-bot'), /Home helper \(@my_home_helper_bot\)/);

      // The switches.
      assert.equal(await frame.isChecked('#tg-pref-typeToClaude'), false);
      await frame.uncheck('#tg-pref-routines');
      await frame.click('#tg-save');
      await frame.waitForSelector('#tg-saved:visible');
      assert.equal(JSON.parse(readFileSync(file, 'utf8')).prefs.routines, false);

      const wide = await open({ width: 360, scheme: 'dark' });
      contexts.push(wide.context);
      await wide.frame.click('#tab-settings');
      await wide.frame.click('#nav-telegram');
      await wide.frame.waitForSelector('#tg-on:visible');
      await shot(wide.page, wide.frame, 'settings-telegram-360-dark');

      await frame.click('#tg-forget');
      await frame.waitForSelector('#confirm[open]');
      await frame.click('#confirm-ok');
      await frame.waitForSelector('#tg-off:visible');
      assert.throws(() => readFileSync(file), 'the bot is forgotten');
      assert.ok(!JSON.stringify(tgCalls).includes('"token"'), 'the token never went into a message');
    } finally {
      for (const c of contexts) await c.close().catch(() => {});
      rmSync(file, { force: true });
    }
  });

  test('screenshots at 360 px and 1280 px, light and dark, with no sideways scroll', { skip: SHOTS ? false : 'set SCREENSHOT_DIR' }, async () => {
    for (const width of [360, 1280]) {
      for (const scheme of ['light', 'dark']) {
        const tag = `${width}-${scheme}`;
        writeFileSync(join(sb.data, 'claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":""}}');
        const { context, page, frame } = await open({ width, scheme });
        await shot(page, frame, `console-${tag}`);
        await frame.click('#tab-settings');
        await frame.waitForSelector('text=The login ran out.');
        await shot(page, frame, `seat-lapsed-${tag}`);
        const tabPromise = context.waitForEvent('page');
        await frame.click('text=Sign in at claude.ai ↗');
        const tab = await tabPromise;
        await tab.waitForURL((u) => u.href.startsWith('https://claude.com/'));
        await page.bringToFront();
        await frame.waitForSelector('#v-code:not([hidden])');
        await shot(page, frame, `seat-code-${tag}`);
        await frame.fill('#code', GOOD_CODE);
        await frame.click('#submit');
        await frame.waitForSelector('#v-done:not([hidden])');
        await shot(page, frame, `seat-done-${tag}`);
        await frame.click('text=Open the Console');
        await frame.click('#tab-settings');
        await frame.waitForSelector('#v-signed-in:not([hidden])');
        await shot(page, frame, `seat-signed-in-${tag}`);
        await context.close();
      }
    }
  });
});
