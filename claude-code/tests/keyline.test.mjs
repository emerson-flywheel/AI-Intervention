// The remote key: exactly one authorized_keys line, only for one plain ssh-ed25519 key,
// and only from the addresses the remote_allow_from option names.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { allowFrom, keyLine, remoteStatus } from '../rootfs/opt/addon-agent/keyline.mjs';
import { runNode, sandbox } from './helpers.mjs';

function ed25519Line(comment = 'remote@box') {
  const { publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const field = (b) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    return Buffer.concat([len, b]);
  };
  const blob = Buffer.concat([field(Buffer.from('ssh-ed25519')), field(raw)]).toString('base64');
  return { blob, line: `ssh-ed25519 ${blob}${comment ? ` ${comment}` : ''}` };
}

// 192.0.2.0/24 is the documentation range (RFC 5737): no real host.
const FROM = '192.0.2.10';
const PREFIX = `from="${FROM}",restrict,pty,command="node /opt/addon-agent/agent.mjs" ssh-ed25519 `;

test('a plain ssh-ed25519 key (with or without a comment) gives exactly the restricted line', () => {
  const { blob, line } = ed25519Line();
  assert.equal(keyLine(line, FROM), PREFIX + blob);
  const bare = ed25519Line('');
  assert.equal(keyLine(bare.line, FROM), PREFIX + bare.blob);
  assert.equal(keyLine(`  ${line}\n`, FROM), PREFIX + blob, 'surrounding whitespace is fine');
});

test('anything else is refused', () => {
  const { blob, line } = ed25519Line();
  for (const bad of [
    '',
    'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ== x',
    `command="sh" ${line}`,
    `restrict ${line}`,
    `${line}\n${line}`,
    `${line} extra words`,
    `${line} "quote`,
    `${line},x`,
    `ssh-ed25519  ${blob}`,
    `ssh-ed25519 ${blob.slice(0, -1)}`,
    `ssh-ed25519 ${blob}A`,
    `ssh-ed25519 ${blob.slice(0, -2)}!!`,
    `ssh-ed25519 ${Buffer.from('ssh-ed25519 but not a real blob of the right size!!!').toString('base64')}`,
    `sk-ssh-ed25519@openssh.com ${blob}`,
    null,
  ]) {
    assert.equal(keyLine(bad, FROM), null, JSON.stringify(bad));
  }
});

test('remote_allow_from: one or more plain addresses or networks, nothing else', () => {
  for (const [given, want] of [
    ['192.0.2.10', '192.0.2.10'],
    [' 192.0.2.0/24 ', '192.0.2.0/24'],
    ['192.0.2.10, 192.0.2.11', '192.0.2.10,192.0.2.11'],
    ['2001:db8::1', '2001:db8::1'],
    ['2001:db8::/64', '2001:db8::/64'],
  ]) {
    assert.equal(allowFrom(given), want, given);
  }
  for (const bad of [
    '', ' ', '*', '0.0.0.0/0', '::/0', '192.0.2.10/33', '2001:db8::/129', '192.0.2.0/', '192.0.2.10/8x',
    '300.1.1.1', 'host.example.com', '192.0.2.10"', '192.0.2.10 192.0.2.11', '192.0.2.10,', ',192.0.2.10',
    '!192.0.2.10', '192.0.2.*', `${'192.0.2.1,'.repeat(16)}192.0.2.1`, null, 42,
  ]) {
    assert.equal(allowFrom(bad), null, JSON.stringify(bad));
  }
});

test('a key line is only made with a good address list', () => {
  const { line } = ed25519Line();
  assert.equal(keyLine(line, ''), null);
  assert.equal(keyLine(line, '*'), null);
  assert.equal(keyLine(line, '192.0.2.10"'), null);
  assert.match(keyLine(line, '192.0.2.0/24,2001:db8::1'), /^from="192\.0\.2\.0\/24,2001:db8::1",restrict,/);
});

test('keyline.mjs writes the one line (0600) from the options, removes it when empty or refused', async () => {
  const { blob, line } = ed25519Line();
  const sb = sandbox({ options: { remote_key: line, remote_allow_from: FROM } });
  const file = join(sb.data, 'ssh', 'authorized_keys');
  assert.equal((await runNode(sb, 'keyline.mjs')).code, 0);
  assert.equal(readFileSync(file, 'utf8'), `${PREFIX}${blob}\n`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(sb.data, 'ssh')).mode & 0o777, 0o700);
  sb.cleanup();

  const bad = sandbox({ options: { remote_key: `command="sh" ${line}`, remote_allow_from: FROM } });
  assert.equal((await runNode(bad, 'keyline.mjs')).code, 2);
  assert.equal(existsSync(join(bad.data, 'ssh', 'authorized_keys')), false);
  bad.cleanup();

  const empty = sandbox({ options: { remote_key: '' } });
  assert.equal((await runNode(empty, 'keyline.mjs')).code, 1);
  empty.cleanup();

  for (const from of [undefined, '', '*', '0.0.0.0/0']) {
    const nowhere = sandbox({ options: { remote_key: line, ...(from === undefined ? {} : { remote_allow_from: from }) } });
    assert.equal((await runNode(nowhere, 'keyline.mjs')).code, 3, `remote_allow_from ${JSON.stringify(from)}`);
    assert.equal(existsSync(join(nowhere.data, 'ssh', 'authorized_keys')), false);
    nowhere.cleanup();
  }
});

test('keyline.mjs leaves the remote console\'s state in /run for the Settings tab', async () => {
  const { line } = ed25519Line();
  for (const [options, want] of [
    [{ remote_key: line, remote_allow_from: FROM }, 'on'],
    [{ remote_key: '' }, 'off'],
    [{ remote_key: `command="sh" ${line}`, remote_allow_from: FROM }, 'refused-key'],
    [{ remote_key: line, remote_allow_from: '*' }, 'refused-from'],
  ]) {
    const sb = sandbox({ options });
    await runNode(sb, 'keyline.mjs');
    assert.equal(readFileSync(join(sb.run, 'remote'), 'utf8'), `${want}\n`, JSON.stringify(options));
    sb.cleanup();
  }
});

test('remoteStatus: the state, and when on, where from and the host key\'s fingerprint only', () => {
  const sb = sandbox({ options: { remote_key: ed25519Line().line, remote_allow_from: ' 192.0.2.10, 192.0.2.0/24 ' } });
  const status = () => remoteStatus(sb.data, sb.run);
  assert.deepEqual(status(), { state: 'unknown', from: null, hostKey: null }, 'nothing written yet: the app is starting');
  writeFileSync(join(sb.run, 'remote'), 'sideways\n');
  assert.deepEqual(status(), { state: 'unknown', from: null, hostKey: null });

  writeFileSync(join(sb.run, 'remote'), 'on\n');
  assert.deepEqual(status(), { state: 'on', from: '192.0.2.10,192.0.2.0/24', hostKey: null }, 'no host key file yet');
  const keyDir = join(sb.data, 'ssh');
  mkdirSync(keyDir, { recursive: true });
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'test host', '-f', join(keyDir, 'ssh_host_ed25519_key')]);
  const want = execFileSync('ssh-keygen', ['-lf', join(keyDir, 'ssh_host_ed25519_key.pub')]).toString().split(' ')[1];
  assert.match(want, /^SHA256:[A-Za-z0-9+/]{43}$/);
  const on = status();
  assert.equal(on.hostKey, want, 'the same fingerprint ssh shows');
  const pub = readFileSync(join(keyDir, 'ssh_host_ed25519_key.pub'), 'utf8').split(' ')[1];
  assert.ok(!JSON.stringify(on).includes(pub.slice(20, 40)), 'never the key itself');

  writeFileSync(join(keyDir, 'ssh_host_ed25519_key.pub'), 'not a key\n');
  assert.equal(status().hostKey, null, 'an odd key file shows no fingerprint');
  for (const state of ['off', 'refused-key', 'refused-from']) {
    writeFileSync(join(sb.run, 'remote'), `${state}\n`);
    assert.deepEqual(status(), { state, from: null, hostKey: null }, state);
  }
  sb.cleanup();
});
