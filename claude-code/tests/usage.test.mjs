// The seat's plan usage on the Settings tab: the reading Claude Code caches in its
// .claude.json when /usage runs, and the probe that opens claude in its own tmux, types
// /usage and waits for that reading to move. The fake claude writes a real-shaped reading;
// everything runs in a sandbox /data, so no real login is touched.
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { usageReading } from '../rootfs/opt/addon-agent/usage.mjs';
import { AGENT_DIR, sandbox } from './helpers.mjs';

const MODULE = pathToFileURL(join(AGENT_DIR, 'usage.mjs')).href;
// usage.mjs reads ADDON_DATA when it loads: each probe runs in a child node in the sandbox.
function inBox(sb, code, env = {}) {
  const script = `import * as u from ${JSON.stringify(MODULE)};
    const answer = await (async () => { ${code} })();
    process.stdout.write(JSON.stringify(answer));`;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', script], { env: { ...sb.env, ...env }, timeout: 30000 },
      (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(JSON.parse(stdout))));
  });
}

const FAST = '{ settleMs: 400, pollMs: 200, deadlineMs: 4000 }';
const signIn = (sb) =>
  writeFileSync(join(sb.data, 'claude', '.credentials.json'),
    '{"claudeAiOauth":{"accessToken":"fake-x","refreshToken":"r","subscriptionType":"max"}}');
const usageSessions = (sb) =>
  spawnSync('tmux', ['-L', 'usage', 'list-sessions', '-F', '#{session_name}'], { env: sb.env, encoding: 'utf8' }).stdout.trim();
const cleanup = (sb) => sb.cleanup();

const LIMITS = [
  { kind: 'session', group: 'g', percent: 42.4, severity: 'ok', resets_at: '2026-10-20T19:10:00.123456+00:00', is_active: true },
  { kind: 'weekly_all', percent: 81, resets_at: '2026-10-22T13:00:00.654321+00:00' },
  { kind: 'weekly_scoped', percent: 12, resets_at: '2026-10-22T13:00:00+00:00', scope: { model: { display_name: 'Fable' } } },
];

describe('usageReading (what the Settings tab shows from Claude Code\'s cache)', () => {
  test('the 5-hour session, the week, and each model\'s own week', () => {
    const r = usageReading({
      oauthAccount: { accountUuid: 'acct-1', emailAddress: 'someone@example.com' },
      cachedUsageUtilization: { fetchedAtMs: 1792000000000, accountUuid: 'acct-1', utilization: { limits: LIMITS } },
    });
    assert.deepEqual(r, {
      fetchedAtMs: 1792000000000,
      session: { percent: 42.4, resetsAt: '2026-10-20T19:10:00.123456+00:00' },
      week: { percent: 81, resetsAt: '2026-10-22T13:00:00.654321+00:00' },
      models: [{ model: 'Fable', percent: 12, resetsAt: '2026-10-22T13:00:00+00:00' }],
    });
    assert.doesNotMatch(JSON.stringify(r), /acct-1|someone@/, 'nothing about the account is passed on');
  });

  test('nothing cached, or not in the shape Claude Code writes: no reading', () => {
    for (const j of [null, {}, { cachedUsageUtilization: {} }, { cachedUsageUtilization: { utilization: { limits: 'x' } } }]) {
      assert.equal(usageReading(j), null);
    }
  });

  test('odd entries are dropped and a percent is kept between 0 and 100', () => {
    const r = usageReading({
      cachedUsageUtilization: {
        fetchedAtMs: 5,
        utilization: {
          limits: [
            null,
            { kind: 'session', percent: 140, resets_at: null },
            { kind: 'weekly_all', percent: 'lots' },
            { kind: 'weekly_scoped', percent: -3, scope: { model: { display_name: '<b>Opus</b>' } } },
            { kind: 'weekly_scoped', percent: 9, scope: { model: { display_name: 'x'.repeat(41) } } },
            { kind: 'monthly_spend', percent: 50 },
          ],
        },
      },
    });
    assert.deepEqual(r.session, { percent: 100, resetsAt: null });
    assert.equal(r.week, null);
    assert.deepEqual(r.models, [{ model: '<b>Opus</b>', percent: 0, resetsAt: null }], 'a name over 40 characters is dropped');
  });
});

describe('the usage probe (fake claude in a real tmux)', () => {
  test('signed in: claude opens on its own tmux, /usage moves the reading, and the pane is closed after', async () => {
    const sb = sandbox();
    signIn(sb);
    writeFileSync(join(sb.data, 'claude', '.claude.json'), JSON.stringify({ theme: 'dark' }));
    const r = await inBox(sb, `return u.probeUsage(${FAST})`);
    assert.deepEqual(r, { ok: true, fresh: true });
    const j = JSON.parse(readFileSync(join(sb.data, 'claude', '.claude.json'), 'utf8'));
    assert.equal(j.theme, 'dark', 'Claude Code\'s other keys are its own; the probe never writes the file');
    const read = await inBox(sb, 'return u.readUsage()');
    assert.deepEqual([read.session.percent, read.week.percent, read.models[0].model], [42, 81, 'Fable']);
    assert.equal(usageSessions(sb), '', 'the probe\'s pane is gone');
    cleanup(sb);
  });

  test('the folder-trust question is answered first', async () => {
    const sb = sandbox();
    signIn(sb);
    const r = await inBox(sb, `return u.probeUsage(${FAST})`, { FAKE_TRUST: '1' });
    assert.deepEqual(r, { ok: true, fresh: true });
    cleanup(sb);
  });

  test('a reading that does not move: the old one stays, marked not fresh', async () => {
    const sb = sandbox();
    signIn(sb);
    writeFileSync(join(sb.data, 'claude', '.claude.json'),
      JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: 1000, utilization: { limits: LIMITS } } }));
    const r = await inBox(sb, `return u.probeUsage(${FAST})`, { FAKE_USAGE_STALE: '1' });
    assert.deepEqual(r, { ok: false, fresh: false, error: 'not-fresh' });
    assert.equal((await inBox(sb, 'return u.readUsage()')).fetchedAtMs, 1000);
    cleanup(sb);
  });

  test('signed out, or signed in by the oauth_token option: no probe is started', async () => {
    const sb = sandbox();
    assert.deepEqual(await inBox(sb, `return u.probeUsage(${FAST})`), { ok: false, fresh: false, error: 'signed-out' });
    writeFileSync(join(sb.data, 'options.json'), JSON.stringify({ oauth_token: 'option-token-value' }));
    assert.deepEqual(await inBox(sb, `return u.probeUsage(${FAST})`), { ok: false, fresh: false, error: 'by-option' });
    assert.equal(usageSessions(sb), '');
    cleanup(sb);
  });

  test('refreshUsage: one probe at a time, none while the reading is under 25 minutes old, a press at most once a minute', async () => {
    const sb = sandbox();
    signIn(sb);
    const r = await inBox(sb, `
      const out = [];
      const t = { settleMs: 400, pollMs: 200, deadlineMs: 4000 };
      out.push(u.refreshUsage({ ...t }));
      out.push(u.refreshUsage({ ...t }));
      out.push(u.usageView().probing);
      await u.usageDone();
      const v = u.usageView();
      out.push(v.probing, v.reading.week.percent, v.error);
      out.push(u.refreshUsage({ ...t }));
      out.push(u.refreshUsage({ ...t, force: true }));
      out.push(u.refreshUsage({ ...t, force: true, now: Date.now() + 61000 }));
      await u.usageDone();
      return out;`);
    assert.deepEqual(r, ['started', 'running', true, false, 81, null, 'fresh', 'too-soon', 'started']);
    cleanup(sb);
  });

  test('usageView: shown only for a login made here, with why not otherwise', async () => {
    const sb = sandbox();
    let v = await inBox(sb, 'return u.usageView()');
    assert.deepEqual([v.show, v.why, v.reading], [false, 'signed-out', null]);
    signIn(sb);
    v = await inBox(sb, 'return u.usageView()');
    assert.deepEqual([v.show, v.why], [true, null]);
    writeFileSync(join(sb.data, 'options.json'), JSON.stringify({ oauth_token: 'option-token-value' }));
    v = await inBox(sb, 'return u.usageView()');
    assert.deepEqual([v.show, v.why], [false, 'by-option']);
    cleanup(sb);
  });
});
