// Tools (0.4.1): extras Claude may use, switched on Settings › Tools. Each one is a change
// to Claude Code's own settings file (a hook, a deny rule) and keeps every other setting.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// Tools Claude adds (0.4.3): a file each in /data/tools, written by Claude in the Console.
// Each shows in Settings › Tools, off until the user switches it on there.
const toolFile = (sb, id, def) => {
  mkdirSync(join(sb.data, 'tools'), { recursive: true });
  writeFileSync(join(sb.data, 'tools', `${id}.json`), typeof def === 'string' ? def : JSON.stringify(def));
};
const mcpOf = (sb) => JSON.parse(readFileSync(join(sb.data, 'claude', 'addon-mcp.json'), 'utf8'));
const WEATHER = {
  name: 'Weather service', description: 'Reads the forecast.', kind: 'mcp',
  config: { command: 'npx', args: ['weather-mcp'], env: { WEATHER_KEY: 'secret-value-1' } },
};

test('customTools: one per file in /data/tools, off until switched on; a bad file says why; secrets never shown', async () => {
  const sb = sandbox();
  const t = await tools(sb);
  assert.deepEqual(t.customTools(), [], 'no folder: none');
  toolFile(sb, 'weather', WEATHER);
  toolFile(sb, 'remote', { name: 'Remote API', description: 'A hosted server.', kind: 'mcp', config: { type: 'http', url: 'https://mcp.example.com/v1?key=secret-value-2', headers: { Authorization: 'secret-value-3' } } });
  toolFile(sb, 'broken', 'not json');
  toolFile(sb, 'odd', { name: 'Odd', description: 'x', kind: 'shell', config: {} });
  toolFile(sb, 'nofile', { name: 'No file', description: 'x', kind: 'script', config: { file: 'gone.sh' } });
  toolFile(sb, 'Bad Name', WEATHER);
  const list = t.customTools();
  assert.deepEqual(list.map(({ id, on, problem }) => [id, on, problem]), [
    ['broken', false, 'not-json'],
    ['nofile', false, 'no-script'],
    ['odd', false, 'bad-kind'],
    ['remote', false, null],
    ['weather', false, null],
  ], 'sorted; a file name that is not an id is skipped');
  const weather = list.find((x) => x.id === 'weather');
  assert.deepEqual([weather.name, weather.description, weather.kind, weather.summary], ['Weather service', 'Reads the forecast.', 'mcp', 'Runs: npx weather-mcp']);
  assert.equal(list.find((x) => x.id === 'remote').summary, 'Connects to: https://mcp.example.com/v1');
  assert.doesNotMatch(JSON.stringify(list), /secret-value/);
  sb.cleanup();
});

test('saveCustomTool (MCP): on hands the server to Claude, off takes it back; a change by Claude waits for the user', async () => {
  const sb = sandbox();
  const t = await tools(sb);
  toolFile(sb, 'weather', WEATHER);
  assert.deepEqual(t.saveCustomTool({ id: 'weather', on: true }), { changed: true });
  assert.deepEqual(mcpOf(sb), { mcpServers: { weather: WEATHER.config } });
  assert.deepEqual(t.customTools().map(({ id, on, changed }) => [id, on, changed]), [['weather', true, false]]);
  assert.deepEqual(t.saveCustomTool({ id: 'weather', on: true }), { changed: false });

  toolFile(sb, 'weather', { ...WEATHER, config: { command: 'npx', args: ['other-mcp'] } });
  assert.deepEqual(t.customTools().map(({ on, changed }) => [on, changed]), [[true, true]]);
  assert.deepEqual(mcpOf(sb).mcpServers.weather, WEATHER.config, 'still the version the user switched on');
  assert.deepEqual(t.saveCustomTool({ id: 'weather', on: true }), { changed: true }, 'on again takes the new version');
  assert.deepEqual(mcpOf(sb).mcpServers.weather, { command: 'npx', args: ['other-mcp'] });

  rmSync(join(sb.data, 'tools', 'weather.json'));
  assert.deepEqual(t.customTools().map(({ id, on, problem }) => [id, on, problem]), [['weather', true, 'gone']], 'still listed so it can be switched off');
  assert.deepEqual(t.saveCustomTool({ id: 'weather', on: false }), { changed: true });
  assert.deepEqual(mcpOf(sb), { mcpServers: {} });
  assert.deepEqual(t.customTools(), []);

  assert.throws(() => t.saveCustomTool({ id: 'weather', on: true }), { code: 'no-tool' });
  toolFile(sb, 'odd', { name: 'Odd', description: 'x', kind: 'mcp', config: { command: 'x', args: 'not a list' } });
  assert.throws(() => t.saveCustomTool({ id: 'odd', on: true }), { code: 'bad-config' });
  assert.throws(() => t.saveCustomTool({ id: '../x', on: true }), { code: 'bad-tool' });
  assert.throws(() => t.saveCustomTool({ id: 'odd', on: 'yes' }), { code: 'bad-tool' });
  sb.cleanup();
});

test('saveCustomTool (script): on lets Claude run that one script without asking; off removes only that rule', async () => {
  const sb = sandbox();
  const t = await tools(sb);
  const file = join(sb.data, 'claude', 'settings.json');
  writeFileSync(file, JSON.stringify({ theme: 'dark', permissions: { allow: ['Bash(ls:*)'] } }));
  toolFile(sb, 'restart', { name: 'Restart Zigbee', description: 'Restarts the Zigbee add-on.', kind: 'script', config: { file: 'restart.sh' } });
  writeFileSync(join(sb.data, 'tools', 'restart.sh'), '#!/bin/sh\n');
  assert.deepEqual(t.customTools().map(({ summary, problem }) => [summary, problem]), [[`Runs: ${join(sb.data, 'tools', 'restart.sh')}`, null]]);
  assert.deepEqual(t.saveCustomTool({ id: 'restart', on: true }), { changed: true });
  const rule = `Bash(${join(sb.data, 'tools', 'restart.sh')}:*)`;
  assert.deepEqual(settingsOf(sb), { theme: 'dark', permissions: { allow: ['Bash(ls:*)', rule] } });
  assert.equal(t.customTools()[0].on, true);
  t.saveCustomTool({ id: 'restart', on: false });
  assert.deepEqual(settingsOf(sb), { theme: 'dark', permissions: { allow: ['Bash(ls:*)'] } });

  toolFile(sb, 'sneaky', { name: 'x', description: 'x', kind: 'script', config: { file: '../claude/settings.json' } });
  assert.equal(t.customTools().find((x) => x.id === 'sneaky').problem, 'bad-config', 'only a script inside /data/tools');
  writeFileSync(file, 'not json');
  assert.throws(() => t.saveCustomTool({ id: 'restart', on: true }), { code: 'settings-unreadable' });
  sb.cleanup();
});

test('ensureMcpFile: an empty server list when the file is missing or broken (Claude will not start without it)', async () => {
  const sb = sandbox();
  const t = await tools(sb);
  const f = join(sb.data, 'claude', 'addon-mcp.json');
  t.ensureMcpFile();
  assert.deepEqual(mcpOf(sb), { mcpServers: {} });
  writeFileSync(f, '{"mcpServers":');
  t.ensureMcpFile();
  assert.deepEqual(mcpOf(sb), { mcpServers: {} });
  writeFileSync(f, JSON.stringify({ mcpServers: { a: { command: 'x' } } }));
  t.ensureMcpFile();
  assert.deepEqual(mcpOf(sb), { mcpServers: { a: { command: 'x' } } }, 'a good file is kept');
  sb.cleanup();
});

test('Jarvis mode keeps Snapshot before edits on: switching it off is refused while Jarvis is on', async () => {
  const sb = sandbox();
  const t = await tools(sb);
  t.saveTools({ snapshot: true, web: true });
  writeFileSync(join(sb.data, 'jarvis.json'), JSON.stringify({ added: ['Bash'] }));
  assert.equal(t.toolsState()[0].locked, true);
  assert.throws(() => t.saveTools({ snapshot: false, web: true }), { code: 'jarvis-snapshot' });
  assert.equal(t.toolsState()[0].on, true);
  rmSync(join(sb.data, 'jarvis.json'));
  assert.equal(t.toolsState()[0].locked, false);
  t.saveTools({ snapshot: false, web: true });
  assert.equal(t.toolsState()[0].on, false);
  sb.cleanup();
});
