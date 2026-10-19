// The console: one herdr workspace "claude" whose pane runs console-loop.sh.
//   node console.mjs bootstrap <dir>   make it (closing any other workspace), start the loop
//   node console.mjs check             exit 0 while its pane is alive
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { consolePane, herdr, writeRun } from './lib.mjs';

const LOOP = join(dirname(fileURLToPath(import.meta.url)), 'console-loop.sh');
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export async function bootstrap(dir) {
  // ADDON_CONSOLE=1 lets pane-shell.sh give this pane (only) bash. The test overrides
  // are passed on too; in the add-on they are unset.
  const env = ['CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1', 'ADDON_CONSOLE=1'];
  for (const k of ['ADDON_RUN', 'CLAUDE_BIN']) if (process.env[k]) env.push(`${k}=${process.env[k]}`);
  const made = await herdr('workspace', 'create', '--cwd', dir, '--label', 'claude', '--no-focus',
    ...env.flatMap((e) => ['--env', e]));
  const pane = made.result?.root_pane?.pane_id;
  const ws = made.result?.workspace?.workspace_id;
  if (!pane || !ws) throw new Error('herdr did not create the console workspace');
  // A restored session.json can bring back a stray workspace (a bare shell): close it.
  const list = await herdr('workspace', 'list');
  for (const w of list.result?.workspaces || []) {
    if (w.workspace_id !== ws) await herdr('workspace', 'close', w.workspace_id);
  }
  await herdr('workspace', 'focus', ws);
  writeRun('pane', pane);
  writeRun('workspace', ws);
  writeRun('created', Date.now());
  writeRun('state', 'starting');
  const r = await herdr('pane', 'run', pane, `exec bash -lc ${sq(LOOP)}`);
  if (!r.ok) throw new Error('herdr did not start the console loop');
  return { pane, workspace: ws };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, dir] = process.argv.slice(2);
  if (cmd === 'bootstrap' && dir) {
    const { pane, workspace } = await bootstrap(dir);
    console.log(`[claude-code] Console: herdr workspace ${workspace}, pane ${pane}, in ${dir}.`);
  } else if (cmd === 'check') {
    process.exitCode = (await consolePane()) ? 0 : 1;
  } else {
    console.error('usage: console.mjs bootstrap <dir> | check');
    process.exitCode = 2;
  }
}
