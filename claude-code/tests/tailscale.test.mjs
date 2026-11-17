// Bots (0.4.5): the Bots door over Tailscale. The app joins the user's Tailscale network as
// its own device and serves only the Bots door there; Funnel (a public address) only when
// the user turns it on. A stand-in tailscale CLI records what it is asked.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { FAKES, runNode, sandbox } from './helpers.mjs';

// Not a real key: the shape Tailscale's admin page gives, with filler.
const KEY = 'tskey-auth-kExample000CNTRL-exampleexampleexample';

describe('tailscale', () => {
  let sb;
  let ts;
  let env;
  const ran = () => (existsSync(env.FAKE_TAILSCALE_LOG)
    ? readFileSync(env.FAKE_TAILSCALE_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  // the commands without the socket flag every one carries
  const verbs = () => ran().map((a) => a.filter((x) => !x.startsWith('--socket=')).join(' '));

  beforeEach(async () => {
    sb = sandbox();
    env = { TAILSCALE_BIN: join(FAKES, 'tailscale'), FAKE_TAILSCALE_LOG: join(sb.root, 'ts.log'), ADDON_BOTS_PORT: '7690' };
    ts = await import('../rootfs/opt/addon-agent/tailscale.mjs');
    ts.setDirs(sb.data, sb.run);
  });
  afterEach(() => sb.cleanup());

  test('the key is kept 0600, never shown, and a bad one is refused', () => {
    assert.throws(() => ts.saveKey('not-a-key'), { code: 'bad-key' });
    assert.throws(() => ts.saveKey(`${KEY}\nmore`), { code: 'bad-key' });
    ts.saveKey(KEY);
    const file = join(sb.data, 'tailscale', 'authkey');
    assert.equal(readFileSync(file, 'utf8').trim(), KEY);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const v = ts.tailscaleView();
    assert.equal(v.keySet, true);
    assert.equal(v.funnel, false);
    assert.equal(JSON.stringify(v).includes(KEY), false);
    assert.ok(existsSync(join(sb.run, 'tailscale-apply')), 'run.sh is asked to apply it');
  });

  test('with no key, apply does nothing and says off', async () => {
    const r = await runNode(sb, 'tailscale.mjs', { args: ['apply'], env });
    assert.equal(r.code, 1);
    assert.deepEqual(ran(), []);
  });

  test('apply: joins as its own device and serves only the Bots door, Funnel off', async () => {
    ts.saveKey(KEY);
    const r = await runNode(sb, 'tailscale.mjs', { args: ['apply'], env });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.includes(KEY) || r.stderr.includes(KEY), false, 'the key is never printed');
    const v = verbs();
    assert.ok(v[0].startsWith('up '), v[0]);
    assert.ok(v[0].includes(`--auth-key=file:${join(sb.data, 'tailscale', 'authkey')}`), 'the key goes by file, never on the command line');
    assert.ok(v[0].includes('--hostname=ai-intervention-bots'));
    assert.ok(!ran().flat().includes(KEY));
    assert.ok(v.includes('funnel --https=443 off'), 'Funnel is turned off');
    assert.ok(v.includes('serve --bg --https=443 http://127.0.0.1:7690'), 'only the door is served');
    // nothing else is served: every serve or funnel names the door's port or turns off
    for (const line of v.filter((x) => /^(serve|funnel) /.test(x))) assert.match(line, /(http:\/\/127\.0\.0\.1:7690|off)$/);
    assert.ok(!v.some((x) => x.startsWith('funnel --bg')));
    assert.equal(ts.tailscaleView().name, 'ai-intervention-bots.tail1234.ts.net');
  });

  test('Funnel on: the door alone gets a public address; off again takes it away', async () => {
    ts.saveKey(KEY);
    ts.setFunnel(true);
    assert.equal(ts.tailscaleView().funnel, true);
    await runNode(sb, 'tailscale.mjs', { args: ['apply'], env });
    assert.ok(verbs().includes('funnel --bg --https=443 http://127.0.0.1:7690'));
    ts.setFunnel(false);
    await runNode(sb, 'tailscale.mjs', { args: ['apply'], env });
    const v = verbs();
    assert.equal(v.filter((x) => x === 'funnel --https=443 off').length, 1);
    assert.equal(v[v.length - 1 - v.slice().reverse().findIndex((x) => x.startsWith('serve '))], 'serve --bg --https=443 http://127.0.0.1:7690');
  });

  test('Forget logs the device out and deletes the key', async () => {
    ts.saveKey(KEY);
    ts.forgetTailscale();
    assert.equal(existsSync(join(sb.data, 'tailscale', 'authkey')), false);
    assert.equal(ts.tailscaleView().keySet, false);
    const r = await runNode(sb, 'tailscale.mjs', { args: ['forget'], env });
    assert.equal(r.code, 0);
    assert.ok(verbs().includes('logout'));
  });
});
