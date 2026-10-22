// With the real herdr 0.9.3 binary (HERDR_REAL=/path/to/herdr) and the fake claude:
// the console bootstrap, the console loop (--continue, restart after a sign-in, no shell
// while a remote client is attached), and the attach client's locked keys. Skipped,
// and said so, without HERDR_REAL. Needs tmux.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { AGENT_DIR, FAKES, HERE, agent, runNode, sandbox } from './helpers.mjs';

const REAL = process.env.HERDR_REAL;
const ETC = join(HERE, '..', 'rootfs', 'etc', 'herdr');
const skip = REAL ? false : 'set HERDR_REAL to a herdr 0.9.3 binary to run these';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('real herdr', { skip }, () => {
  let sb;
  let home;
  let env;
  let workdir;
  let consoleToml;
  const h = (...a) => {
    const r = spawnSync(REAL, ['--session', 'claude', ...a], { env: { ...env, HERDR_CONFIG_PATH: consoleToml } });
    return r.stdout.toString();
  };
  const hj = (...a) => JSON.parse(h(...a));
  const screen = () => h('pane', 'read', readFileSync(join(sb.run, 'pane'), 'utf8').trim(), '--source', 'recent-unwrapped', '--lines', '300');
  const pane = () => readFileSync(join(sb.run, 'pane'), 'utf8').trim();
  const state = () => readFileSync(join(sb.run, 'state'), 'utf8').trim();
  const typeRaw = (text) => {
    h('pane', 'send-text', pane(), text);
    h('pane', 'send-keys', pane(), 'enter');
  };
  async function until(fn, what, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (fn()) return;
      await sleep(150);
    }
    assert.fail(`timed out: ${what}\n--- screen ---\n${screen()}`);
  }
  const count = (s, w) => s.split(w).length - 1;

  before(async () => {
    sb = sandbox();
    // herdr's socket lives under $HOME; keep the path short (sun_path is 108 bytes).
    home = mkdtempSync(join(tmpdir(), 'hr-'));
    workdir = join(sb.root, 'work');
    mkdirSync(workdir);
    // console.toml as shipped, with the pane gate at its path in this repo.
    consoleToml = join(sb.root, 'console.toml');
    writeFileSync(consoleToml, readFileSync(join(ETC, 'console.toml'), 'utf8').replace('/opt/addon-agent/', `${AGENT_DIR}/`));
    env = {
      ...sb.env, HOME: home, HERDR_BIN: REAL, ADDON_CONSOLE_CONFIG: consoleToml,
      ADDON_ATTACH_CONFIG: join(ETC, 'attach.toml'), CLAUDE_BIN: join(FAKES, 'claude'),
    };
    delete env.XDG_CONFIG_HOME;
    sb.env = env;
    execFileSync('setsid', ['-f', REAL, '--session', 'claude', 'server'], {
      env: { ...env, HERDR_CONFIG_PATH: consoleToml }, stdio: 'ignore',
    });
    for (let i = 0; i < 40; i++) {
      if (h('workspace', 'list').includes('workspace_list')) break;
      await sleep(250);
    }
    // A stray workspace, as a restored session.json can bring back.
    hj('workspace', 'create', '--cwd', '/tmp', '--label', 'stray', '--no-focus');
    // A conversation exists for the workspace, so Claude starts with --continue.
    const slug = workdir.replace(/^\//, '').replace(/[/\\:]/g, '-');
    mkdirSync(join(sb.data, 'claude', 'projects', slug), { recursive: true });
    writeFileSync(join(sb.data, 'claude', 'projects', slug, 'a.jsonl'), '{}\n');
    writeFileSync(join(sb.run, 'console.env'),
      `WORKDIR=${workdir}\nCLAUDE_CONFIG_DIR=${join(sb.data, 'claude')}\nCLAUDE_ARGS=( --permission-mode plan --add-dir /homeassistant )\n`);
    mkdirSync(join(sb.run, 'guard.d'), { recursive: true });
  });

  after(() => {
    spawnSync('tmux', ['-L', 'hrt', 'kill-server'], { env });
    spawnSync(REAL, ['--session', 'claude', 'server', 'stop'], { env });
    rmSync(home, { recursive: true, force: true });
    sb.cleanup();
  });

  test('bootstrap: one workspace "claude", the stray closed, Claude started with its args and --continue', async () => {
    const r = await runNode(sb, 'console.mjs', { args: ['bootstrap', workdir] });
    assert.equal(r.code, 0, r.stderr);
    const ws = hj('workspace', 'list').result.workspaces;
    assert.deepEqual(ws.map((w) => w.label), ['claude']);
    assert.equal(ws[0].focused, true);
    await until(() => screen().includes('fake-claude args: --permission-mode plan --add-dir /homeassistant --continue'), 'claude started');
    assert.equal(state(), 'claude');
    assert.equal((await runNode(sb, 'console.mjs', { args: ['check'] })).code, 0);
  });

  test('the agent sees the console: snapshot state and lines, type reaches Claude', async () => {
    const snap = JSON.parse((await agent(sb, 'snapshot')).stdout);
    assert.equal(snap.consoles.length, 1);
    assert.ok(['idle', 'busy', 'done'].includes(snap.consoles[0].state), snap.consoles[0].state);
    assert.ok(snap.consoles[0].lines.some((l) => l.includes('fake-claude args')));
    const r = await agent(sb, 'type claude', { stdin: 'hello from a remote client' });
    assert.equal(r.code, 0, r.stderr);
    await until(() => screen().includes('you said: hello from a remote client'), 'typed line');
  });

  test('after a sign-in, Claude in the console is started again on the new login with --continue', async () => {
    const before = count(screen(), 'fake-claude args');
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { relaunchConsole } from '${join(AGENT_DIR, 'lib.mjs')}'; console.log(await relaunchConsole());`], { env });
    assert.equal(r.stdout.toString().trim(), 'now', r.stderr.toString());
    await until(() => count(screen(), 'fake-claude args') === before + 1, 'claude started again');
    assert.match(screen(), /Signed in again: starting Claude on the new login\.\n.*fake-claude args: .*--continue/);
    assert.equal(state(), 'claude');
  });

  test('when Claude exits with no remote client: the console gets a shell, and Claude after it', async () => {
    typeRaw('quit');
    await until(() => state() === 'shell', 'shell state');
    typeRaw('echo SHELL-$((40+2))');
    await until(() => screen().includes('SHELL-42'), 'the shell ran a command');
    assert.equal(JSON.parse((await agent(sb, 'snapshot')).stdout).consoles[0].state, 'shell');
    const r = await agent(sb, 'type claude', { stdin: 'echo NOPE-$((1+1))' });
    assert.equal(r.stderr, 'workspace-agent: refused: no terminal\n', 'type never reaches the shell');
    const before = count(screen(), 'fake-claude args');
    typeRaw('exit');
    await until(() => count(screen(), 'fake-claude args') === before + 1 && state() === 'claude', 'claude after the shell');
    assert.ok(!screen().includes('NOPE-2'));
  });

  test('while a remote client is attached, Claude exiting gives no shell, only Enter to start it again', async () => {
    writeFileSync(join(sb.run, 'guard.d', String(process.pid)), '');
    try {
      typeRaw('quit');
      await until(() => state() === 'prompt', 'prompt state');
      assert.match(screen(), /A remote client is attached, so no shell is offered\./);
      const before = count(screen(), 'fake-claude args');
      typeRaw('echo GUARD-$((40+2))');
      await until(() => count(screen(), 'fake-claude args') === before + 1, 'claude started again');
      assert.ok(!screen().includes('GUARD-42'), 'the line never ran in a shell');
    } finally {
      rmSync(join(sb.run, 'guard.d', String(process.pid)), { force: true });
    }
  });

  test('attach: the real agent in a tty; the client cannot open a workspace, and Claude exiting gives no shell', async () => {
    const tm = (...a) => spawnSync('tmux', ['-L', 'hrt', ...a], { env }).stdout.toString();
    tm('new-session', '-d', '-s', 't', '-x', '120', '-y', '30',
      `env SSH_ORIGINAL_COMMAND='attach claude' ${process.execPath} ${join(AGENT_DIR, 'agent.mjs')}; echo AGENT-EXIT=$?; sleep 60`);
    await until(() => readdirSync(join(sb.run, 'guard.d')).length === 1, 'the attach holds a guard');
    await until(() => tm('capture-pane', '-p', '-t', 't').includes('fake-claude'), 'attached view');
    for (const keys of [['C-a', 'N'], ['C-a', 'c'], ['C-a', 'v'], ['C-a', 'minus'], ['C-b', 'N'], ['C-a', 'w']]) {
      tm('send-keys', '-t', 't', keys[0]);
      tm('send-keys', '-t', 't', keys[1]);
      await sleep(300);
      tm('send-keys', '-t', 't', 'Escape');
    }
    const ws = hj('workspace', 'list').result.workspaces;
    assert.deepEqual(ws.map((w) => [w.label, w.tab_count, w.pane_count]), [['claude', 1, 1]]);
    // Quit Claude from the attached client: the loop must offer no shell.
    tm('send-keys', '-t', 't', 'Enter');
    tm('send-keys', '-t', 't', '-l', 'quit');
    tm('send-keys', '-t', 't', 'Enter');
    await until(() => state() === 'prompt', 'prompt, not a shell');
    tm('send-keys', '-t', 't', '-l', 'echo ATTACH-$((40+2))');
    tm('send-keys', '-t', 't', 'Enter');
    await until(() => state() === 'claude', 'claude again');
    assert.ok(!screen().includes('ATTACH-42'));
    tm('kill-server');
    await until(() => readdirSync(join(sb.run, 'guard.d')).length === 0, 'the guard is dropped when the client goes');
  });

  test('if the console pane itself goes while a remote client is attached: no shell, and the attach ends', async () => {
    const tm = (...a) => spawnSync('tmux', ['-L', 'hrt', ...a], { env }).stdout.toString();
    tm('new-session', '-d', '-s', 'g', '-x', '120', '-y', '30',
      `env SSH_ORIGINAL_COMMAND='attach claude' ${process.execPath} ${join(AGENT_DIR, 'agent.mjs')}; echo AGENT-EXIT=$?; sleep 60`);
    await until(() => readdirSync(join(sb.run, 'guard.d')).length === 1, 'attached');
    await until(() => tm('capture-pane', '-p', '-t', 'g').includes('fake-claude'), 'attached view');
    const info = hj('pane', 'process-info', '--pane', pane()).result.process_info;
    process.kill(info.shell_pid, 'SIGKILL');
    // herdr makes a workspace of its own when the last one closes with a client attached.
    await until(() => {
      const ws = hj('workspace', 'list').result.workspaces;
      return ws.length === 1 && ws[0].label !== 'claude';
    }, 'herdr made its own workspace', 5000);
    await until(() => tm('capture-pane', '-p', '-t', 'g').includes('AGENT-EXIT='), 'the attach ended');
    const other = hj('workspace', 'list').result.workspaces[0].workspace_id;
    const procs = hj('pane', 'process-info', '--pane', `${other}:p1`).result.process_info.foreground_processes;
    assert.ok(procs.some((p) => p.argv.some((a) => a.endsWith('pane-shell.sh'))), JSON.stringify(procs));
    h('pane', 'send-text', `${other}:p1`, 'echo GATE-$((40+2))');
    h('pane', 'send-keys', `${other}:p1`, 'enter');
    await sleep(500);
    const text = h('pane', 'read', `${other}:p1`, '--lines', '20');
    assert.match(text, /no shell here/);
    assert.ok(!text.includes('GATE-42'), 'nothing ran');
    tm('kill-session', '-t', 'g');
    // run.sh's supervisor makes the console again and closes herdr's workspace.
    const r = await runNode(sb, 'console.mjs', { args: ['bootstrap', workdir] });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(hj('workspace', 'list').result.workspaces.map((w) => w.label), ['claude']);
    await until(() => state() === 'claude' && screen().includes('fake-claude args'), 'claude again');
  });

  test('attach is refused while the console is in its shell', async () => {
    typeRaw('quit');
    await until(() => state() === 'shell', 'shell');
    const r = spawnSync('script', ['-qec', `env SSH_ORIGINAL_COMMAND='attach claude' ${process.execPath} ${join(AGENT_DIR, 'agent.mjs')}`, '/dev/null'], { env });
    assert.match(r.stdout.toString() + r.stderr.toString(), /workspace-agent: refused: no terminal/);
    assert.deepEqual(readdirSync(join(sb.run, 'guard.d')), []);
    typeRaw('exit');
    await until(() => state() === 'claude', 'claude again');
  });

  test('Off-Duty: off closes Claude at its prompt, the loop waits with no shell; on or Enter brings it back with --continue', async () => {
    await until(() => state() === 'claude' && screen().trimEnd().endsWith('>'), 'claude at its prompt');
    const before = count(screen(), 'fake-claude args');
    // the loop's own pid, which off uses to find Claude whatever herdr calls it
    const loopPid = Number(readFileSync(join(sb.run, 'loop-pid'), 'utf8'));
    assert.equal(loopPid, hj('pane', 'process-info', '--pane', pane()).result.process_info.shell_pid);
    const off = await agent(sb, 'off claude');
    assert.equal(off.code, 0, off.stderr);
    assert.equal(state(), 'off');
    await until(() => screen().includes('Off-Duty: Claude is closed and its conversation is saved.'), 'the Off-Duty lines');
    assert.equal(JSON.parse((await agent(sb, 'snapshot')).stdout).consoles[0].state, 'off');
    assert.equal((await agent(sb, 'type claude', { stdin: 'hi' })).stderr, 'workspace-agent: refused: it is off-duty\n');
    const on = await agent(sb, 'on claude');
    assert.equal(on.code, 0, on.stderr);
    await until(() => count(screen(), 'fake-claude args') === before + 1 && state() === 'claude', 'claude again');
    assert.match(screen().split('On-Duty: starting Claude with its conversation.').at(-1), /fake-claude args: .*--continue/);
    // Enter on the Console does the same, and a line typed there never runs in a shell
    await until(() => screen().trimEnd().endsWith('>'), 'claude at its prompt again');
    assert.equal((await agent(sb, 'off claude')).code, 0);
    typeRaw('echo OFF-$((40+2))');
    await until(() => count(screen(), 'fake-claude args') === before + 2 && state() === 'claude', 'claude after Enter');
    assert.ok(!screen().includes('OFF-42'), 'nothing ran in a shell');
    assert.ok(!existsSync(join(sb.run, 'offduty')));
  });
});

test('attach.toml unbinds every key action herdr 0.9.3 has, and herdr accepts both configs', { skip }, () => {
  const defaults = execFileSync(REAL, ['--default-config']).toString();
  const keys = defaults.slice(defaults.indexOf('\n[keys]'), defaults.indexOf('\n[server]'));
  const actions = [...keys.matchAll(/^# ([a-z_]+) = /gm)].map((m) => m[1])
    .filter((a) => !['prefix', 'key', 'type', 'command', 'width', 'height', 'tabs', 'workspaces', 'agents'].includes(a));
  assert.ok(actions.length > 50, `found ${actions.length} actions`);
  const attach = readFileSync(join(ETC, 'attach.toml'), 'utf8');
  for (const a of new Set(actions)) assert.match(attach, new RegExp(`^${a} = ""$`, 'm'), a);
  for (const a of ['tabs', 'workspaces', 'agents']) assert.match(attach, new RegExp(`^${a} = ""$`, 'm'));
  assert.match(attach, /^mouse_capture = false$/m);
  assert.ok(!attach.includes('[[keys.command]]'));
  const console = readFileSync(join(ETC, 'console.toml'), 'utf8');
  assert.match(console, /^default_shell = "\/opt\/addon-agent\/pane-shell.sh"$/m);
  for (const f of ['console.toml', 'attach.toml']) {
    const r = execFileSync(REAL, ['config', 'check'], { env: { ...process.env, HERDR_CONFIG_PATH: join(ETC, f) } });
    assert.equal(r.toString().trim(), 'config: ok', f);
  }
});

test('every Console theme gives configs herdr accepts as they are (an unknown name is refused)', { skip }, async () => {
  const { THEMES, herdrConfig } = await import(join(AGENT_DIR, 'look.mjs'));
  const dir = mkdtempSync(join(tmpdir(), 'ht-'));
  const check = (text) => {
    writeFileSync(join(dir, 'c.toml'), text);
    const r = spawnSync(REAL, ['config', 'check'], { env: { ...process.env, HERDR_CONFIG_PATH: join(dir, 'c.toml') } });
    return `${r.stdout}${r.stderr}`.trim();
  };
  const attach = readFileSync(join(ETC, 'attach.toml'), 'utf8');
  assert.match(check(attach.replace(/^\[theme\][^]*$/m, '[theme]\nname = "everforest"\n')), /unknown theme name/,
    'the control: herdr refuses a name it does not have');
  for (const t of THEMES) {
    for (const f of ['console.toml', 'attach.toml']) {
      assert.equal(check(herdrConfig(readFileSync(join(ETC, f), 'utf8'), t.id)), 'config: ok', `${t.id || 'default'} ${f}`);
    }
  }
  rmSync(dir, { recursive: true, force: true });
});
