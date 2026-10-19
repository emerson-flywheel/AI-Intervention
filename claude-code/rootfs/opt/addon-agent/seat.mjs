// The seat: the add-on's one Claude login (/data/claude) and the sign-in that renews it.
// The sign-in runs `claude auth login --claudeai` in its own tmux server. Only the LENGTH of the access token is ever read; the token, the pane's text and
// the code are never logged, returned or written anywhere.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE, CLAUDE_DIR, RUN, TMUX, options, relaunchConsole, run, sleep } from './lib.mjs';
import { LINK_IN_TEXT_RE, checkCode, checkLoginUrl } from './linkcheck.mjs';

export class LoginError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// The login file's state; only the tokens' LENGTHS are read. signedIn: an access token,
// and either its expiresAt is still ahead (or absent) or there is a refresh token: Claude
// renews a short-lived access token by itself, and blanks the tokens when that fails.
// lapsed: the file is there but the access token is empty, or it is past its expiresAt
// with no refresh token, so a sign-in may renew it. Neither: signed out.
export function readLogin(dir = CLAUDE_DIR) {
  const file = join(dir, '.credentials.json');
  let st;
  try {
    st = statSync(file);
  } catch {
    return { signedIn: false, lapsed: false, plan: null, since: null };
  }
  let length = 0;
  let plan = null;
  let expired = false;
  let refreshLength = 0;
  try {
    const oauth = JSON.parse(readFileSync(file, 'utf8'))?.claudeAiOauth;
    if (typeof oauth?.accessToken === 'string') length = oauth.accessToken.length;
    if (typeof oauth?.refreshToken === 'string') refreshLength = oauth.refreshToken.length;
    if (typeof oauth?.expiresAt === 'number' && oauth.expiresAt <= Date.now()) expired = true;
    if (typeof oauth?.subscriptionType === 'string' && /^[A-Za-z0-9 _-]{1,40}$/.test(oauth.subscriptionType)) {
      plan = oauth.subscriptionType;
    }
  } catch {}
  const signedIn = length > 0 && (!expired || refreshLength > 0);
  return { signedIn, lapsed: !signedIn, plan: signedIn ? plan : null, since: signedIn ? Math.round(st.mtimeMs) : null };
}

const SOCKET = ['-L', 'seat-login'];
const session = (seat) => `seatlogin_${seat}`;
const target = (seat) => `=${session(seat)}:`;
const tmux = (...args) => run(TMUX, [...SOCKET, ...args]);
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

async function paneText(seat) {
  const r = await tmux('capture-pane', '-p', '-J', '-S', '-500', '-t', target(seat));
  return r.code === 0 ? r.stdout : null;
}

const count = (text, word) => text.split(word).length - 1;

// The seat as everyone shows it (seats, seat-status, seat-login, the page): signed in by the
// oauth_token option when it is set (Claude in the Console uses that token, and its value is
// never read here beyond "set"), otherwise by the login file.
export function seatLogin() {
  const token = options().oauth_token;
  if (typeof token === 'string' && token.trim() !== '') {
    return { signedIn: true, lapsed: false, plan: null, since: null, byOption: true };
  }
  return { ...readLogin(), byOption: false };
}

export async function loginWaiting(seat) {
  const text = await paneText(seat);
  return text !== null && !text.includes('LOGIN-EXIT=');
}

export async function seatStatus(seat) {
  const { signedIn } = seatLogin();
  if (await loginWaiting(seat)) return { seat, state: 'waiting', signedIn };
  return { seat, state: signedIn ? 'done' : 'none', signedIn };
}

export async function cancelLogin(seat) {
  await tmux('kill-session', '-t', `=${session(seat)}`);
}

// One sign-in step at a time, across the server and the agent (separate processes).
const LOCK = () => join(RUN, 'login.lock');
function tryLock() {
  mkdirSync(RUN, { recursive: true });
  try {
    mkdirSync(LOCK());
  } catch {
    let pid = 0;
    try {
      pid = Number(readFileSync(join(LOCK(), 'pid'), 'utf8'));
    } catch {}
    try {
      if (pid > 0) {
        process.kill(pid, 0);
        return false;
      }
    } catch {}
    rmSync(LOCK(), { recursive: true, force: true });
    try {
      mkdirSync(LOCK());
    } catch {
      return false;
    }
  }
  writeFileSync(join(LOCK(), 'pid'), String(process.pid));
  return true;
}

export async function withLoginLock(fn, waitMs = 0) {
  const until = Date.now() + waitMs;
  while (!tryLock()) {
    if (Date.now() >= until) throw new LoginError('busy');
    await sleep(250);
  }
  try {
    return await fn();
  } finally {
    rmSync(LOCK(), { recursive: true, force: true });
  }
}

// Start a sign-in; resolves to the checked link. An abandoned sign-in never touches the
// stored login: claude only writes it after a code is taken.
export async function startLogin(seat, { linkWaitMs = 20000 } = {}) {
  await cancelLogin(seat);
  // The sign-in stops by itself after 15 minutes: a watcher ends the tmux session. (Not
  // `timeout`: GNU timeout puts claude in a background process group, where reading the
  // pane stops it, and busybox timeout has no --foreground.)
  const cmd =
    `(sleep 900; ${sq(TMUX)} ${SOCKET.join(' ')} kill-session -t ${sq(`=${session(seat)}`)}) >/dev/null 2>&1 & ` +
    `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN ` +
    `CLAUDE_CONFIG_DIR=${sq(CLAUDE_DIR)} ${sq(CLAUDE)} auth login --claudeai; ` +
    `echo LOGIN-EXIT=$?; sleep 900`;
  const r = await tmux('new-session', '-d', '-s', session(seat), '-x', '400', '-y', '50', cmd);
  if (r.code !== 0) throw new LoginError('no-link');
  const until = Date.now() + linkWaitMs;
  while (Date.now() < until) {
    const text = await paneText(seat);
    if (text === null || text.includes('LOGIN-EXIT=')) break;
    if (text.includes('Paste code here')) {
      const m = text.match(LINK_IN_TEXT_RE);
      if (m && checkLoginUrl(m[0])) return m[0];
      await cancelLogin(seat);
      throw new LoginError('bad-link');
    }
    await sleep(250);
  }
  await cancelLogin(seat);
  throw new LoginError('no-link');
}

// Type the code into the waiting sign-in. Signed in = claude exited 0 AND the stored
// token's length > 0.
export async function submitCode(seat, code, { waitMs = 30000 } = {}) {
  if (!checkCode(code)) throw new LoginError('not-a-code');
  const before = await paneText(seat);
  if (before === null || before.includes('LOGIN-EXIT=')) throw new LoginError('not-waiting');
  const invalidBefore = count(before, 'Invalid code');
  await tmux('send-keys', '-t', target(seat), '-l', '--', code);
  await tmux('send-keys', '-t', target(seat), 'Enter');
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await sleep(250);
    const text = await paneText(seat);
    if (text === null) throw new LoginError('not-finished');
    if (count(text, 'Invalid code') > invalidBefore) throw new LoginError('not-taken');
    const m = text.match(/LOGIN-EXIT=(\d+)/);
    if (m) {
      await cancelLogin(seat);
      if (m[1] === '0' && readLogin().signedIn) return { relaunched: await relaunchConsole() };
      throw new LoginError('not-finished');
    }
  }
  throw new LoginError('not-finished');
}
