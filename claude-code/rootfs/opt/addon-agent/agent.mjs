// The remote key: sshd runs this as the key's forced command and it
// reads the verb from SSH_ORIGINAL_COMMAND. The verbs, answers and refusal words are a
// fixed protocol (DOCS.md, "Remote console"), because a remote client parses them.
// A command is never echoed back, and no token, code or pane text is ever logged.
import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ATTACH_CONFIG, CLAUDE_DIR, CONSOLE, HERDR, NAME_RE, SESSION, addGuard, consolePane, consoleState,
  dropGuard, dropRun, guardedShell, herdr, paneLines, readRun, seatName, sleep, stopClaude,
} from './lib.mjs';
import { stampLogin } from './keyline.mjs';
import { LoginError, seatLogin, seatStatus, startLogin, submitCode, withLoginLock } from './seat.mjs';

const BAD = 2;
const STATE = 3;
const TYPE_CAP = 8000;
const CODE_CAP = 600;
const DIALOG = ['Esc to cancel', 'Enter to select', 'Do you want to proceed?'];
// Claude at work on its last rows: "esc to interrupt", or a background shell still running
const BUSY_RE = /esc to interrupt|·\s*\d+\s+shells?\s*·/i;
// how long off and on wait for the console loop to show the change
const DUTY_WAIT_MS = Number(process.env.ADDON_DUTY_WAIT_MS) || 15000;
const NO_NAME = new Set(['snapshot', 'seats']);
const WITH_NAME = new Set([
  'type', 'interrupt', 'history', 'attach', 'off', 'on',
  'seat-login', 'seat-code', 'seat-status', 'seat-signout', 'seat-use',
]);

class Refusal extends Error {
  constructor(words, code) {
    super(words);
    this.words = words;
    this.exit = code;
  }
}
const refuse = (words, code) => {
  throw new Refusal(words, code);
};

function answer(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

export function parse(command) {
  if (typeof command !== 'string' || command.length > 200) refuse('too long', BAD);
  const parts = command.split(' ');
  const verb = parts[0];
  if (!NO_NAME.has(verb) && !WITH_NAME.has(verb)) refuse('unknown verb', BAD);
  const rest = parts.slice(1);
  if (NO_NAME.has(verb)) {
    if (rest.length) refuse('bad name', BAD);
    return { verb, name: null };
  }
  if (rest.length !== 1 || !NAME_RE.test(rest[0])) refuse('bad name', BAD);
  return { verb, name: rest[0] };
}

async function readStdin(cap) {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > cap) refuse('stdin over its cap', BAD);
    chunks.push(chunk);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    refuse('stdin is not text', BAD);
  }
}

// One line to type: newline, CR and tab become a space; any other control character,
// an empty line, or a line that Claude would run as a command (! / #) is refused.
export function cleanLine(raw) {
  const line = raw.replace(/\r?\n$/, '').replace(/[\n\r\t]/g, ' ');
  if (/[\u0000-\u001f\u007f-\u009f]/.test(line)) refuse('control character', BAD);
  if (line.trim() === '') refuse('nothing to type', BAD);
  if (/^\s*[!/#]/.test(line)) refuse('a line may not start with ! / or #', BAD);
  return line;
}

async function needConsole(name) {
  if (name !== CONSOLE) refuse('no such console started here', STATE);
  const pane = await consolePane();
  if (!pane) refuse('no such console started here', STATE);
  return pane;
}

async function loopReaches(ok) {
  for (const end = Date.now() + DUTY_WAIT_MS; Date.now() < end; await sleep(100)) {
    if (ok(readRun('state'))) return true;
  }
  return ok(readRun('state'));
}

function needSeat(name) {
  if (name !== seatName()) refuse('bad name', BAD);
  return name;
}

function lastActivity() {
  let newest = null;
  try {
    for (const f of readdirSync(join(CLAUDE_DIR, 'projects'), { recursive: true })) {
      if (!String(f).endsWith('.jsonl')) continue;
      const t = statSync(join(CLAUDE_DIR, 'projects', String(f))).mtimeMs;
      if (newest === null || t > newest) newest = t;
    }
  } catch {}
  return newest === null ? null : Math.round(newest);
}

const LOGIN_WORDS = {
  'not-a-code': ['not a login code', BAD],
  'not-waiting': ['no login is waiting', STATE],
  'not-taken': ['the code was not taken', STATE],
};
function loginRefusal(err) {
  if (!(err instanceof LoginError)) throw err;
  const [words, code] = LOGIN_WORDS[err.code] || ['the login did not finish', STATE];
  refuse(words, code);
}

const verbs = {
  async snapshot() {
    const consoles = [];
    const pane = await consolePane();
    if (pane) {
      const state = await consoleState(pane);
      consoles.push({
        name: CONSOLE,
        state,
        seat: null,
        created: Number(readRun('created')) || null,
        activity: lastActivity(),
        // Off-Duty: since when
        ...(state === 'off' ? { since: Number(readRun('offduty')) || null } : {}),
        lines: await paneLines(pane, 200),
      });
    }
    answer({ v: 1, at: Date.now(), consoles });
  },

  async type(name) {
    const raw = await readStdin(TYPE_CAP);
    const line = cleanLine(raw);
    const pane = await needConsole(name);
    addGuard();
    try {
      if (readRun('state') === 'off') refuse('it is off-duty', STATE);
      if (guardedShell() ||!['busy', 'working', 'blocked', 'idle', 'done'].includes(await consoleState(pane))) {
        refuse('no terminal', STATE);
      }
      const recent = (await paneLines(pane, 60)).filter((l) => l.trim() !== '').slice(-20).join('\n');
      if (DIALOG.some((d) => recent.includes(d))) refuse('a dialog is on its screen', STATE);
      const sent = await herdr('pane', 'send-text', pane, line);
      if (!sent.ok) refuse('no such console started here', STATE);
      await herdr('pane', 'send-keys', pane, 'enter');
    } finally {
      dropGuard();
    }
    answer({ ok: true, name: CONSOLE });
  },

  async interrupt(name) {
    const pane = await needConsole(name);
    await herdr('pane', 'send-keys', pane, 'esc');
    answer({ ok: true, name: CONSOLE });
  },

  async history(name) {
    const pane = await needConsole(name);
    const info = await herdr('pane', 'get', pane);
    const lines = await paneLines(pane, 2000);
    const rows = info.result?.pane?.scroll?.max_offset_from_bottom;
    answer({ v: 1, at: Date.now(), name: CONSOLE, lines, alternate: false, history: Number.isInteger(rows) ? rows : lines.length });
  },

  // A herdr client on the console with /etc/herdr/attach.toml: no prefix action is bound
  // and the mouse is not captured, so no workspace, tab, pane or shell can be opened from
  // it; while it is attached the console loop offers no shell when Claude exits; any other
  // pane gets no shell (pane-shell.sh); and if the console's pane goes, the attach ends.
  async attach(name) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) refuse('no terminal', BAD);
    await needConsole(name);
    addGuard();
    // Only while the loop runs Claude, waits at its Enter prompt or waits Off-Duty: not while
    // the console is starting (for a moment an interactive bash) or in its shell, or the state
    // is unknown.
    if (!['claude', 'prompt', 'off'].includes(readRun('state'))) {
      dropGuard();
      refuse('no terminal', STATE);
    }
    const ws = readRun('workspace');
    if (ws) await herdr('workspace', 'focus', ws);
    const child = spawn(HERDR, ['session', 'attach', SESSION], {
      stdio: 'inherit',
      env: { ...process.env, HERDR_CONFIG_PATH: ATTACH_CONFIG },
    });
    const stop = () => child.kill('SIGTERM');
    for (const sig of ['SIGHUP', 'SIGTERM', 'SIGINT']) process.on(sig, stop);
    let watching = true;
    (async () => {
      while (watching) {
        await sleep(250);
        if (watching && !(await consolePane())) child.kill('SIGKILL');
      }
    })();
    const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c ?? 1)));
    watching = false;
    dropGuard();
    process.exitCode = code;
  },

  // Off-Duty: Claude exits with its conversation saved, and the console loop waits, with
  // no shell, until `on` (or Enter on the Console) starts it again with --continue. Only at
  // its prompt: never mid-turn, with a dialog up, or in the loop's shell or Enter prompt.
  async off(name) {
    const pane = await needConsole(name);
    const loop = readRun('state');
    if (loop === 'off') refuse('it is off-duty already', STATE);
    const recent = (await paneLines(pane, 60)).filter((l) => l.trim() !== '');
    if (DIALOG.some((d) => recent.slice(-20).join('\n').includes(d))) refuse('a dialog is on its screen', STATE);
    if (loop !== 'claude' || ['working', 'blocked'].includes(await consoleState(pane))
      || BUSY_RE.test(recent.slice(-6).join('\n'))) {
      refuse('it is not at its prompt', STATE);
    }
    const since = Date.now();
    if (!(await stopClaude(pane, 'offduty', since))) refuse('it found no claude to stop', STATE);
    if (!(await loopReaches((s) => s === 'off'))) {
      dropRun('offduty');
      refuse('it did not go off-duty', STATE);
    }
    answer({ ok: true, name: CONSOLE, since });
  },

  async on(name) {
    await needConsole(name);
    if (readRun('state') !== 'off') refuse('it is not off-duty', STATE);
    dropRun('offduty');
    if (!(await loopReaches((s) => s !== 'off'))) refuse('it did not come back', STATE);
    answer({ ok: true, name: CONSOLE });
  },

  async seats() {
    const seat = seatName();
    const { signedIn, lapsed } = seatLogin();
    answer({ v: 1, at: Date.now(), seats: [{ seat, kind: 'claude', signedIn, lapsed }], use: seat });
  },

  async 'seat-login'(name) {
    const seat = needSeat(name);
    if (seatLogin().signedIn) refuse('already signed in', STATE);
    let url;
    try {
      url = await withLoginLock(() => startLogin(seat), 60000);
    } catch (err) {
      loginRefusal(err);
    }
    answer({ ok: true, seat, url });
  },

  async 'seat-code'(name) {
    const seat = needSeat(name);
    const code = (await readStdin(CODE_CAP)).trim();
    try {
      await withLoginLock(() => submitCode(seat, code), 60000);
    } catch (err) {
      loginRefusal(err);
    }
    answer({ ok: true, seat, signedIn: true });
  },

  async 'seat-status'(name) {
    answer(await seatStatus(needSeat(name)));
  },

  async 'seat-signout'(name) {
    needSeat(name);
    refuse('that is the seat this box starts on', STATE);
  },

  async 'seat-use'(name) {
    answer({ ok: true, seat: needSeat(name) });
  },
};

export async function main(command = process.env.SSH_ORIGINAL_COMMAND ?? '') {
  let verb = null;
  // Settings › Remote console shows when the remote side last logged in.
  stampLogin();
  try {
    let name;
    ({ verb, name } = parse(command));
    await verbs[verb](name);
  } catch (err) {
    // Anything unexpected still answers with one of the fixed words, never its message.
    const r = err instanceof Refusal ? err
      : new Refusal(verb?.startsWith('seat') ? 'the login did not finish' : 'no such console started here', STATE);
    process.stderr.write(`workspace-agent: refused: ${r.words}\n`);
    process.exitCode = r.exit;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
