// Tools (0.4.1): extras Claude may use, switched on Settings › Tools. Each one is a change
// to Claude Code's own settings file (a hook, a deny rule) and keeps every other setting.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AGENT_DIR, sandbox } from './helpers.mjs';

async function tools(sb) {
  const m = await import(`../rootfs/opt/addon-agent/tools.mjs?${Date.now()}${Math.random()}`);
  m.setClaudeDir(join(sb.data, 'claude'));
  return m;
}
const settingsOf = (sb) => JSON.parse(readFileSync(join(sb.data, 'claude', 'settings.json'), 'utf8'));

test('toolsState: snapshot off and web search on when nothing is set (as before 0.4.1)', async () => {
  const sb = sandbox();
  const t = await tools(sb);
  assert.deepEqual(t.toolsState().map(({ id, on }) => [id, on]), [['snapshot', false], ['web', true]]);
  for (const x of t.toolsState()) assert.ok(x.label && x.description, x.id);
  sb.cleanup();
});

test('saveTools: a snapshot hook and web deny rules, keeping every other setting; off takes only ours away', async () => {
  const sb = sandbox();
  const t = await tools(sb);
  const file = join(sb.data, 'claude', 'settings.json');
  const theirs = { matcher: 'Bash', hooks: [{ type: 'command', command: '/their/hook.sh' }] };
  writeFileSync(file, JSON.stringify({ model: 'claude-opus-5-5', permissions: { deny: ['Bash(rm:*)'] }, hooks: { PreToolUse: [theirs] } }));

  assert.deepEqual(t.saveTools({ snapshot: true, web: false }), { changed: true });
  let s = settingsOf(sb);
  assert.equal(s.model, 'claude-opus-5-5');
  assert.deepEqual(s.permissions.deny, ['Bash(rm:*)', 'WebSearch', 'WebFetch']);
  assert.equal(s.hooks.PreToolUse.length, 2);
  assert.deepEqual(s.hooks.PreToolUse[0], theirs);
  assert.deepEqual(s.hooks.PreToolUse[1], {
    matcher: 'Edit|MultiEdit|Write|NotebookEdit',
    hooks: [{ type: 'command', command: '/opt/addon-agent/snapshot.sh', timeout: 60 }],
  });
  assert.deepEqual(t.toolsState().map(({ id, on }) => [id, on]), [['snapshot', true], ['web', false]]);
  assert.deepEqual(t.saveTools({ snapshot: true, web: false }), { changed: false }, 'the same again changes nothing');

  t.saveTools({ snapshot: false, web: true });
  s = settingsOf(sb);
  assert.deepEqual(s.permissions.deny, ['Bash(rm:*)']);
  assert.deepEqual(s.hooks.PreToolUse, [theirs]);

  writeFileSync(file, 'not json');
  assert.throws(() => t.saveTools({ snapshot: true, web: true }), { code: 'settings-unreadable' });
  assert.equal(readFileSync(file, 'utf8'), 'not json', 'left alone');
  assert.throws(() => t.saveTools({ snapshot: 'yes', web: true }), { code: 'bad-tools' });
  sb.cleanup();
});

test('snapshot.sh: a commit of the config before an edit, nothing when unchanged, never the database; exit 0 always', () => {
  const sb = sandbox();
  const ha = join(sb.root, 'homeassistant');
  mkdirSync(join(ha, '.storage'), { recursive: true });
  writeFileSync(join(ha, 'automations.yaml'), '- id: a\n');
  writeFileSync(join(ha, 'home-assistant_v2.db'), 'big');
  writeFileSync(join(ha, 'home-assistant.log'), 'noise');
  const env = { ...sb.env, ADDON_HA_DIR: ha };
  const snap = () => spawnSync(join(AGENT_DIR, 'snapshot.sh'), [], { env, input: '{"tool_name":"Edit"}' });
  assert.equal(snap().status, 0);
  const git = (...a) => execFileSync('git', [`--git-dir=${join(sb.data, 'ha-history')}`, `--work-tree=${ha}`, ...a]).toString();
  assert.equal(git('rev-list', '--count', 'HEAD').trim(), '1');
  const files = git('ls-files').trim().split('\n');
  assert.deepEqual(files, ['automations.yaml'], 'no database, no log');
  assert.equal(snap().status, 0);
  assert.equal(git('rev-list', '--count', 'HEAD').trim(), '1', 'unchanged: no new snapshot');
  writeFileSync(join(ha, 'automations.yaml'), '- id: b\n');
  assert.equal(snap().status, 0);
  assert.equal(git('rev-list', '--count', 'HEAD').trim(), '2');
  const gone = spawnSync(join(AGENT_DIR, 'snapshot.sh'), [], { env: { ...env, ADDON_HA_DIR: join(sb.root, 'nope') }, input: '{}' });
  assert.equal(gone.status, 0, 'no config folder: nothing to do, the edit goes on');
  assert.ok(existsSync(join(sb.data, 'ha-history')));
  sb.cleanup();
});
