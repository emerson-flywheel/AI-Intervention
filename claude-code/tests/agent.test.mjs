// The remote agent: command parsing, every refusal (one line, fixed words, exit 2 or
// 3), the answer shapes a remote client parses, and the sign-in through seat-login/seat-code
// with the fake claude in a real tmux.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { AGENT_DIR, FAKES, GOOD_CODE, GOOD_LINK, agent, consoleHerdr, sandbox, writeRunFiles } from './helpers.mjs';

const WORDS = new Set([
  'unknown verb', 'bad name', 'no such console started here', 'a dialog is on its screen',
  'a line may not start with ! / or #', 'control character', 'nothing to type', 'too long',
  'stdin over its cap', 'stdin is not text', 'no terminal', 'already signed in', 'not a login code',
  'no login is waiting', 'the code was not taken', 'the login did not finish',
  'that is the seat this box starts on',
]);

const sandboxes = [];
function box(opts) {
  const sb = sandbox(opts);
  sandboxes.push(sb);
  return sb;
}
after(() => sandboxes.forEach((sb) => sb.cleanup()));

function withConsole(herdrOpts = {}, run = {}) {
  const sb = box({ herdr: consoleHerdr(herdrOpts) });
  writeRunFiles(sb, { pane: 'w1:p1', workspace: 'w1', created: 1760000000000, state: 'claude', ...run });
  return sb;
}

async function refused(sb, command, words, exit, opts) {
  const r = await agent(sb, command, opts);
  assert.equal(r.stdout, '', `${command}: nothing on stdout`);
  assert.equal(r.stderr, `workspace-agent: refused: ${words}\n`, `${command}: one refusal line`);
  assert.ok(WORDS.has(words));
  assert.equal(r.code, exit, `${command}: exit ${exit}`);
  return r;
}

const typed = (sb) => sb.herdr().panes['w1:p1'].lines.filter((l) => l.startsWith('typed:') || l.startsWith('keys:'));

describe('command shape', () => {
  test('unknown verbs, including verbs other consoles have that this app does not offer', async () => {
    const sb = box();
    for (const c of ['', 'start claude', 'stop claude', 'asks', 'answer claude', 'reports', 'plans',
      'lessons-out', 'github-pr x', 'secret-get x', 'tell-claude x', 'SNAPSHOT', 'snapshot\n', ' snapshot']) {
      await refused(sb, c, 'unknown verb', 2);
    }
  });

  test('bad names and shapes: double spaces, a missing or extra name, a name on snapshot', async () => {
    const sb = withConsole();
    for (const c of ['type', 'type  claude', 'type claude ', 'type claude x', 'type Claude', 'type -claude',
      `type ${'a'.repeat(41)}`, 'type claude;id', 'snapshot claude', 'seats home', 'seat-status',
      'seat-status x21', 'seat-login other', 'seat-use other', 'seat-signout other']) {
      await refused(sb, c, 'bad name', 2);
    }
  });

  test('a command over 200 characters is too long, and is never echoed', async () => {
    const r = await refused(box(), `type ${'a'.repeat(300)}`, 'too long', 2);
    assert.ok(!r.stderr.includes('aaaa'));
  });

  test('a console that is not here', async () => {
    await refused(box(), 'type claude', 'no such console started here', 3, { stdin: 'hi' });
    await refused(box(), 'history claude', 'no such console started here', 3);
    await refused(withConsole(), 'interrupt other', 'no such console started here', 3);
    const down = withConsole();
    down.setHerdr({ ...down.herdr(), down: true });
    await refused(down, 'history claude', 'no such console started here', 3);
  });
});

describe('snapshot and history', () => {
  test('snapshot: v1 shape, state from herdr, up to 200 recent lines with ANSI stripped', async () => {
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i}`);
    lines.push('\x1b[1;32mgreen\x1b[0m done');
    const sb = withConsole({ status: 'working', lines });
    const r = await agent(sb, 'snapshot');
    assert.equal(r.code, 0);
    const s = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(s), ['v', 'at', 'consoles']);
    assert.equal(s.v, 1);
    assert.ok(Math.abs(s.at - Date.now()) < 10000);
    const [c] = s.consoles;
    assert.deepEqual(Object.keys(c), ['name', 'state', 'seat', 'created', 'activity', 'lines']);
    assert.equal(c.name, 'claude');
    assert.equal(c.state, 'working');
    assert.equal(c.seat, null);
    assert.equal(c.created, 1760000000000);
    assert.equal(c.activity, null);
    assert.equal(c.lines.length, 200);
    assert.equal(c.lines.at(-1), 'green done');
  });

  test('snapshot states: herdr idle/done/blocked/unknown, the loop prompt, and a shell', async () => {
    const cases = [
      [{ status: 'idle' }, {}, 'idle'], [{ status: 'done' }, {}, 'done'], [{ status: 'blocked' }, {}, 'blocked'],
      [{ status: 'unknown' }, {}, 'busy'], [{ status: null }, { state: 'shell' }, 'shell'],
      [{ status: null }, { state: 'prompt' }, 'waiting'], [{ status: null }, { state: 'starting' }, 'shell'],
    ];
    for (const [h, run, want] of cases) {
      const r = await agent(withConsole(h, run), 'snapshot');
      assert.equal(JSON.parse(r.stdout).consoles[0].state, want, JSON.stringify([h, run]));
    }
  });

  test('snapshot with no console: an empty list; activity from the newest transcript', async () => {
    assert.deepEqual(JSON.parse((await agent(box(), 'snapshot')).stdout).consoles, []);
    const sb = withConsole();
    const { mkdirSync, utimesSync } = await import('node:fs');
    mkdirSync(join(sb.data, 'claude', 'projects', '-homeassistant'), { recursive: true });
    const f = join(sb.data, 'claude', 'projects', '-homeassistant', 'a.jsonl');
    writeFileSync(f, '{}\n');
    utimesSync(f, 1760000100, 1760000100);
    assert.equal(JSON.parse((await agent(sb, 'snapshot')).stdout).consoles[0].activity, 1760000100000);
  });

  test('history: v1 shape, up to 2000 lines, alternate false, history rows from herdr', async () => {
    const sb = withConsole({ lines: Array.from({ length: 2500 }, (_, i) => `l${i}`), history: 2300 });
    const r = await agent(sb, 'history claude');
    const h = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(h), ['v', 'at', 'name', 'lines', 'alternate', 'history']);
    assert.equal(h.name, 'claude');
    assert.equal(h.lines.length, 2000);
    assert.equal(h.lines[0], 'l500');
    assert.equal(h.alternate, false);
    assert.equal(h.history, 2300);
  });
});

describe('type and interrupt', () => {
  test('type: one line via send-text, then the enter key; newline, CR and tab become a space', async () => {
    const sb = withConsole();
    const r = await agent(sb, 'type claude', { stdin: 'check the\tlights\r\nplease\n' });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { ok: true, name: 'claude' });
    assert.deepEqual(typed(sb), ['typed:check the lights  please', 'keys:enter']);
    assert.deepEqual(readdirSync(join(sb.run, 'guard.d')), [], 'the guard is dropped after typing');
  });

  test('type refusals: control characters, empty, ! / #, stdin caps and non-text', async () => {
    const sb = withConsole();
    await refused(sb, 'type claude', 'control character', 2, { stdin: 'hi\x1b[A' });
    await refused(sb, 'type claude', 'control character', 2, { stdin: 'hi\x00' });
    await refused(sb, 'type claude', 'control character', 2, { stdin: 'hi\u0085' });
    await refused(sb, 'type claude', 'nothing to type', 2, { stdin: '' });
    await refused(sb, 'type claude', 'nothing to type', 2, { stdin: ' \t\n' });
    for (const s of ['!rm -rf /', '/logout', '#remember', '  !id']) {
      await refused(sb, 'type claude', 'a line may not start with ! / or #', 2, { stdin: s });
    }
    await refused(sb, 'type claude', 'stdin over its cap', 2, { stdin: 'a'.repeat(8001) });
    await refused(sb, 'type claude', 'stdin is not text', 2, { stdin: Buffer.from([0x68, 0xff, 0xfe]) });
    assert.deepEqual(typed(sb), [], 'nothing was typed');
    const ok = await agent(sb, 'type claude', { stdin: 'a'.repeat(8000) });
    assert.equal(ok.code, 0, ok.stderr);
  });

  test('type refuses while a dialog is on the last 20 non-empty lines', async () => {
    for (const d of ['Esc to cancel', 'Enter to select', 'Do you want to proceed?']) {
      const sb = withConsole({ lines: ['x', `  ${d}  `, '', ...Array(19).fill('y'), ''] });
      await refused(sb, 'type claude', 'a dialog is on its screen', 3, { stdin: 'yes' });
      assert.deepEqual(typed(sb), []);
    }
    const old = withConsole({ lines: ['Esc to cancel', ...Array(20).fill('y')] });
    assert.equal((await agent(old, 'type claude', { stdin: 'yes' })).code, 0, 'an older dialog line is not on screen');
  });

  test('type never reaches a shell: refused when the loop is in its shell or prompt', async () => {
    for (const state of ['shell', 'prompt']) {
      const sb = withConsole({ status: null }, { state });
      await refused(sb, 'type claude', 'no terminal', 3, { stdin: 'id' });
      assert.deepEqual(typed(sb), []);
    }
  });

  test('interrupt sends esc', async () => {
    const sb = withConsole();
    const r = await agent(sb, 'interrupt claude');
    assert.deepEqual(JSON.parse(r.stdout), { ok: true, name: 'claude' });
    assert.deepEqual(typed(sb), ['keys:esc']);
  });

  test('attach without a terminal is refused', async () => {
    await refused(withConsole(), 'attach claude', 'no terminal', 2);
  });

  // In a real tty (script(1)). Attach goes ahead only while the loop runs Claude or waits at
  // its Enter prompt; while the console is starting (an interactive bash for a moment), in
  // its shell, or the state is unknown, it is refused.
  const attachInTty = (sb) => {
    const r = spawnSync('script', ['-qec', `${process.execPath} ${join(AGENT_DIR, 'agent.mjs')}`, '/dev/null'],
      { env: { ...sb.env, SSH_ORIGINAL_COMMAND: 'attach claude' }, timeout: 15000 });
    return r.stdout.toString().replace(/\r/g, '');
  };
  test('attach in a tty is refused unless the console state is claude or prompt', () => {
    for (const state of ['starting', 'shell', 'something-else']) {
      const sb = withConsole({ status: null }, { state });
      assert.match(attachInTty(sb), /^workspace-agent: refused: no terminal\n?$/m, state);
      assert.ok(!sb.herdr().calls.some((c) => c[0] === 'session'), `${state}: no attach started`);
      assert.deepEqual(readdirSync(join(sb.run, 'guard.d')), [], `${state}: the guard is dropped`);
    }
    const none = withConsole({ status: null }, {});
    writeFileSync(join(none.run, 'state'), '');
    assert.match(attachInTty(none), /refused: no terminal/, 'an empty state');
    for (const state of ['claude', 'prompt']) {
      const sb = withConsole({}, { state });
      assert.doesNotMatch(attachInTty(sb), /refused/, state);
      assert.ok(sb.herdr().calls.some((c) => c[0] === 'session' && c[1] === 'attach'), `${state}: attach started`);
    }
  });
});

describe('seats', () => {
  const creds = (sb, body) => writeFileSync(join(sb.data, 'claude', '.credentials.json'), body);

  test('seats: signed out, lapsed (file with an empty token), signed in; the token is never shown', async () => {
    const sb = box({ options: { seat_name: 'home' } });
    const seats = async () => JSON.parse((await agent(sb, 'seats')).stdout);
    let s = await seats();
    assert.deepEqual(Object.keys(s), ['v', 'at', 'seats', 'use']);
    assert.deepEqual(s.seats, [{ seat: 'home', kind: 'claude', signedIn: false, lapsed: false }]);
    assert.equal(s.use, 'home');
    creds(sb, '{"claudeAiOauth":{"accessToken":"","refreshToken":"r"}}');
    s = await seats();
    assert.deepEqual(s.seats[0], { seat: 'home', kind: 'claude', signedIn: false, lapsed: true });
    creds(sb, '{"claudeAiOauth":{"accessToken":"fake-secret-token-value","subscriptionType":"max"}}');
    const r = await agent(sb, 'seats');
    assert.deepEqual(JSON.parse(r.stdout).seats[0], { seat: 'home', kind: 'claude', signedIn: true, lapsed: false });
    assert.ok(!r.stdout.includes('fake-secret-token') && !r.stderr.includes('fake-secret-token'));
  });

  test('a login past its expiresAt with no refresh token is lapsed, and seat-login renews it', async () => {
    const sb = withConsole();
    creds(sb, JSON.stringify({ claudeAiOauth: { accessToken: 'fake-still-here', refreshToken: '', expiresAt: 1000, subscriptionType: 'max' } }));
    const seat = JSON.parse((await agent(sb, 'seats')).stdout).seats[0];
    assert.deepEqual(seat, { seat: 'home', kind: 'claude', signedIn: false, lapsed: true });
    assert.deepEqual(JSON.parse((await agent(sb, 'seat-status home')).stdout), { seat: 'home', state: 'none', signedIn: false });
    const login = await agent(sb, 'seat-login home');
    assert.equal(login.code, 0, login.stderr);
    assert.equal(JSON.parse(login.stdout).url, GOOD_LINK);
    const done = await agent(sb, 'seat-code home', { stdin: GOOD_CODE });
    assert.equal(done.code, 0, done.stderr);
    assert.deepEqual(JSON.parse((await agent(sb, 'seats')).stdout).seats[0].signedIn, true);
  });

  test('a future expiresAt, none, or a past one with a refresh token, is still signed in', async () => {
    for (const oauth of [{ accessToken: 't', expiresAt: Date.now() + 3600e3 }, { accessToken: 't' },
      { accessToken: 't', expiresAt: 1000, refreshToken: 'fake-refresh-value' }]) {
      const sb = box();
      creds(sb, JSON.stringify({ claudeAiOauth: oauth }));
      const r = await agent(sb, 'seats');
      assert.equal(JSON.parse(r.stdout).seats[0].signedIn, true, JSON.stringify(oauth));
      assert.ok(!r.stdout.includes('fake-refresh-value'));
      assert.deepEqual(JSON.parse((await agent(sb, 'seat-status home')).stdout).signedIn, true);
      await refused(sb, 'seat-login home', 'already signed in', 3);
    }
  });

  test('with the oauth_token option set, the seat is signed in (by option) everywhere; the token is never shown', async () => {
    const sb = box({ options: { oauth_token: 'fake-option-token-value-secret' } });
    const r = await agent(sb, 'seats');
    assert.deepEqual(JSON.parse(r.stdout).seats[0], { seat: 'home', kind: 'claude', signedIn: true, lapsed: false });
    assert.deepEqual(JSON.parse((await agent(sb, 'seat-status home')).stdout), { seat: 'home', state: 'done', signedIn: true });
    await refused(sb, 'seat-login home', 'already signed in', 3);
    for (const v of ['seats', 'seat-status home', 'snapshot']) {
      const o = await agent(sb, v);
      assert.ok(!(o.stdout + o.stderr).includes('option-secret'), v);
    }
  });

  test('seat_name comes from the options', async () => {
    const sb = box({ options: { seat_name: 'home-1' } });
    assert.equal(JSON.parse((await agent(sb, 'seats')).stdout).use, 'home-1');
    assert.deepEqual(JSON.parse((await agent(sb, 'seat-use home-1')).stdout), { ok: true, seat: 'home-1' });
    await refused(sb, 'seat-use home', 'bad name', 2);
  });

  test('with no seat_name (or a bad one) the seat is called claude', async () => {
    for (const seat_name of [undefined, 'Not A Name']) {
      const sb = box({ options: { seat_name } });
      assert.equal(JSON.parse((await agent(sb, 'seats')).stdout).use, 'claude', JSON.stringify(seat_name));
    }
  });

  test('seat-signout of the one seat is refused; seat-use of it answers ok', async () => {
    const sb = box();
    await refused(sb, 'seat-signout home', 'that is the seat this box starts on', 3);
    assert.deepEqual(JSON.parse((await agent(sb, 'seat-use home')).stdout), { ok: true, seat: 'home' });
  });

  test('seat-login is refused when already signed in', async () => {
    const sb = box();
    creds(sb, '{"claudeAiOauth":{"accessToken":"t"}}');
    await refused(sb, 'seat-login home', 'already signed in', 3);
  });

  test('sign-in end to end: link, a wrong code, the right code; status along the way', async () => {
    const sb = withConsole();
    creds(sb, '{"claudeAiOauth":{"accessToken":""}}');
    const status = async () => JSON.parse((await agent(sb, 'seat-status home')).stdout);
    assert.deepEqual(await status(), { seat: 'home', state: 'none', signedIn: false });

    const login = await agent(sb, 'seat-login home');
    assert.equal(login.code, 0, login.stderr);
    assert.deepEqual(JSON.parse(login.stdout), { ok: true, seat: 'home', url: GOOD_LINK });
    assert.deepEqual(await status(), { seat: 'home', state: 'waiting', signedIn: false });

    await refused(sb, 'seat-code home', 'not a login code', 2, { stdin: 'short' });
    await refused(sb, 'seat-code home', 'not a login code', 2, { stdin: 'has space in it' });
    await refused(sb, 'seat-code home', 'stdin over its cap', 2, { stdin: 'a'.repeat(601) });
    await refused(sb, 'seat-code home', 'the code was not taken', 3, { stdin: 'wrong-code-0123456789\n' });
    assert.deepEqual(await status(), { seat: 'home', state: 'waiting', signedIn: false }, 'still waiting after a wrong code');
    await refused(sb, 'seat-code home', 'the code was not taken', 3, { stdin: 'wrong-again-0123456789' });

    const done = await agent(sb, 'seat-code home', { stdin: `${GOOD_CODE}\n` });
    assert.equal(done.code, 0, done.stderr);
    assert.deepEqual(JSON.parse(done.stdout), { ok: true, seat: 'home', signedIn: true });
    assert.deepEqual(await status(), { seat: 'home', state: 'done', signedIn: true });
    assert.ok(existsSync(join(sb.run, 'relaunch')), 'the console was told to start Claude again');
    await refused(sb, 'seat-code home', 'no login is waiting', 3, { stdin: GOOD_CODE });
  });

  test('signed in needs exit 0 AND a token: a token-less exit 0 and a non-zero exit both fail', async () => {
    for (const env of [{ FAKE_TOKEN: '' }, { FAKE_EXIT: '1' }]) {
      const sb = box({});
      sb.env = { ...sb.env, ...env };
      assert.equal((await agent(sb, 'seat-login home')).code, 0);
      await refused(sb, 'seat-code home', 'the login did not finish', 3, { stdin: GOOD_CODE });
      assert.ok(!existsSync(join(sb.run, 'relaunch')), `no restart of the console: ${JSON.stringify(env)}`);
    }
  });

  test('a link that fails the check is never answered, and the sign-in pane is closed', async () => {
    for (const link of [
      GOOD_LINK.replace('9d1c250a', '00000000'),
      GOOD_LINK.replace('+user%3Afile_upload', '+user%3Afile_upload+user%3Anew_thing'),
      `${GOOD_LINK}&scope=user%3Aprofile`,
    ]) {
      const sb = box();
      sb.env = { ...sb.env, FAKE_LINK: link };
      const r = await refused(sb, 'seat-login home', 'the login did not finish', 3);
      assert.ok(!r.stderr.includes('https'));
      assert.equal(JSON.parse((await agent(sb, 'seat-status home')).stdout).state, 'none');
    }
  });

  test('a code with no sign-in waiting', async () => {
    await refused(box(), 'seat-code home', 'no login is waiting', 3, { stdin: GOOD_CODE });
  });

  test('the sign-in runs without the API key and token variables, on /data/claude', async () => {
    const sb = box();
    sb.env = { ...sb.env, ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 'o', CLAUDE_BIN: join(sb.root, 'claude-env') };
    writeFileSync(sb.env.CLAUDE_BIN, `#!/usr/bin/env bash
echo "seen:\${ANTHROPIC_API_KEY:-none}:\${ANTHROPIC_AUTH_TOKEN:-none}:\${CLAUDE_CODE_OAUTH_TOKEN:-none}:$CLAUDE_CONFIG_DIR:$*" > ${sb.root}/env.txt
exec "${join(FAKES, 'claude')}" "$@"
`, { mode: 0o755 });
    assert.equal((await agent(sb, 'seat-login home')).code, 0);
    assert.equal(readFileSync(join(sb.root, 'env.txt'), 'utf8').trim(),
      `seen:none:none:none:${join(sb.data, 'claude')}:auth login --claudeai`);
  });
});
