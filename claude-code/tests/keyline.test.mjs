// The remote key: exactly one authorized_keys line, only for one plain ssh-ed25519 key,
// and only from the addresses the remote_allow_from option names.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  allowFrom, hostKeyFingerprint, keyLine, remoteConfig, remoteOff, remoteRemove, remoteStatus, saveRemote,
} from '../rootfs/opt/addon-agent/keyline.mjs';
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

test('remoteStatus: the state, where from and the key\'s comment; never a key or the host key', () => {
  const sb = sandbox({ options: { remote_key: ed25519Line().line, remote_allow_from: ' 192.0.2.10, 192.0.2.0/24 ' } });
  const status = () => remoteStatus(sb.data, sb.run);
  const set = { source: 'option', from: '192.0.2.10,192.0.2.0/24', keyComment: 'remote@box', lastLogin: null, pending: false };
  assert.deepEqual(status(), { state: 'unknown', ...set }, 'nothing written yet: the app is starting');
  writeFileSync(join(sb.run, 'remote'), 'sideways\n');
  assert.deepEqual(status(), { state: 'unknown', ...set });

  writeFileSync(join(sb.run, 'remote'), 'on\n');
  const keyDir = join(sb.data, 'ssh');
  mkdirSync(keyDir, { recursive: true });
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'test host', '-f', join(keyDir, 'ssh_host_ed25519_key')]);
  const want = execFileSync('ssh-keygen', ['-lf', join(keyDir, 'ssh_host_ed25519_key.pub')]).toString().split(' ')[1];
  assert.match(want, /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.deepEqual(status(), { state: 'on', ...set });
  assert.equal(hostKeyFingerprint(sb.data), want, 'the same fingerprint ssh shows');
  const pub = readFileSync(join(keyDir, 'ssh_host_ed25519_key.pub'), 'utf8').split(' ')[1];
  assert.ok(!JSON.stringify(status()).includes(pub.slice(20, 40)), 'never the key itself');

  writeFileSync(join(keyDir, 'ssh_host_ed25519_key.pub'), 'not a key\n');
  assert.equal(hostKeyFingerprint(sb.data), null, 'an odd key file shows no fingerprint');
  writeFileSync(join(sb.data, 'options.json'), JSON.stringify({ remote_key: 'not a key', remote_allow_from: '*' }));
  writeFileSync(join(sb.run, 'remote'), 'refused-key\n');
  assert.deepEqual(status(), { ...set, state: 'refused-key', from: null, keyComment: null }, 'refused: nothing of it shown');
  sb.cleanup();
});

// 0.4.0: the remote console set from Settings › Remote console (kept in /data/remote.json);
// the options still win when remote_key is set.
test('remoteConfig: the options win when remote_key is set, else the page\'s remote.json', () => {
  const { line } = ed25519Line('desk');
  const sb = sandbox({ options: {} });
  assert.deepEqual(remoteConfig(sb.data), { source: 'none', key: null, from: null, enabled: false });
  writeFileSync(join(sb.data, 'remote.json'), JSON.stringify({ key: line, from: FROM, enabled: true }));
  assert.deepEqual(remoteConfig(sb.data), { source: 'page', key: line, from: FROM, enabled: true });
  writeFileSync(join(sb.data, 'remote.json'), JSON.stringify({ key: line, from: FROM, enabled: false }));
  assert.equal(remoteConfig(sb.data).enabled, false);
  writeFileSync(join(sb.data, 'remote.json'), 'not json');
  assert.equal(remoteConfig(sb.data).source, 'none', 'an unreadable file is no setting');
  writeFileSync(join(sb.data, 'options.json'), JSON.stringify({ remote_key: line, remote_allow_from: '192.0.2.99' }));
  assert.deepEqual(remoteConfig(sb.data), { source: 'option', key: line, from: '192.0.2.99', enabled: true });
  sb.cleanup();
});

test('saveRemote / remoteOff / remoteRemove: checked like the option, 0600, off keeps the key, remove drops it', () => {
  const { line } = ed25519Line('desk');
  const sb = sandbox({ options: {} });
  const file = join(sb.data, 'remote.json');
  assert.throws(() => saveRemote({ key: `command="sh" ${line}`, from: FROM }, sb.data), { code: 'bad-key' });
  assert.throws(() => saveRemote({ key: line, from: '0.0.0.0/0' }, sb.data), { code: 'bad-from' });
  assert.throws(() => saveRemote({ from: FROM }, sb.data), { code: 'bad-key' }, 'no key and none kept');
  assert.equal(existsSync(file), false);

  saveRemote({ key: ` ${line}\n`, from: ' 192.0.2.10, 192.0.2.0/24 ' }, sb.data);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { key: line, from: '192.0.2.10,192.0.2.0/24', enabled: true });
  assert.equal(statSync(file).mode & 0o777, 0o600);

  remoteOff(sb.data);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { key: line, from: '192.0.2.10,192.0.2.0/24', enabled: false });
  saveRemote({ from: FROM }, sb.data);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { key: line, from: FROM, enabled: true }, 'on again with the kept key, new address');

  remoteRemove(sb.data);
  assert.equal(existsSync(file), false);

  writeFileSync(join(sb.data, 'options.json'), JSON.stringify({ remote_key: line, remote_allow_from: FROM }));
  for (const f of [() => saveRemote({ key: line, from: FROM }, sb.data), () => remoteOff(sb.data), () => remoteRemove(sb.data)]) {
    assert.throws(f, { code: 'by-option' }, 'the options decide while remote_key is set');
  }
  sb.cleanup();
});

test('keyline.mjs takes the key from remote.json when the options leave it empty', async () => {
  const { blob, line } = ed25519Line('desk');
  const sb = sandbox({ options: { remote_key: '' } });
  const keys = join(sb.data, 'ssh', 'authorized_keys');
  writeFileSync(join(sb.data, 'remote.json'), JSON.stringify({ key: line, from: FROM, enabled: true }));
  assert.equal((await runNode(sb, 'keyline.mjs')).code, 0);
  assert.equal(readFileSync(keys, 'utf8'), `${PREFIX}${blob}\n`);
  assert.equal(readFileSync(join(sb.run, 'remote'), 'utf8'), 'on\n');

  writeFileSync(join(sb.data, 'remote.json'), JSON.stringify({ key: line, from: FROM, enabled: false }));
  assert.equal((await runNode(sb, 'keyline.mjs')).code, 1, 'turned off on the page');
  assert.equal(existsSync(keys), false, 'and the line is gone, so a running sshd takes no login');
  assert.equal(readFileSync(join(sb.run, 'remote'), 'utf8'), 'off\n');
  sb.cleanup();
});

test('remoteStatus from the page: the kept key while off, the last login, and a change still waiting for run.sh', () => {
  const { line } = ed25519Line('desk');
  const sb = sandbox({ options: {} });
  writeFileSync(join(sb.data, 'remote.json'), JSON.stringify({ key: line, from: FROM, enabled: true }));
  writeFileSync(join(sb.run, 'remote'), 'on\n');
  mkdirSync(join(sb.data, 'ssh'), { recursive: true });
  writeFileSync(join(sb.data, 'ssh', 'last-login'), '1761400000000\n');
  assert.deepEqual(remoteStatus(sb.data, sb.run),
    { state: 'on', source: 'page', from: FROM, keyComment: 'desk', lastLogin: 1761400000000, pending: false });

  writeFileSync(join(sb.data, 'remote.json'), JSON.stringify({ key: line, from: FROM, enabled: false }));
  writeFileSync(join(sb.run, 'remote-apply'), '1\n');
  assert.deepEqual(remoteStatus(sb.data, sb.run),
    { state: 'on', source: 'page', from: FROM, keyComment: 'desk', lastLogin: 1761400000000, pending: true },
    'turned off, run.sh not there yet: still on, pending');
  sb.cleanup();
});
