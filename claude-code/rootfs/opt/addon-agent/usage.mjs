// The seat's plan usage on the Settings tab: the 5-hour session, the week, and any model's
// own week. Claude Code caches its last reading in its .claude.json, and only its /usage
// panel refreshes it. So the probe opens claude on its own tmux server, types /usage, waits
// for the cached reading to move, and closes it again: no network call of our own, no
// prompt sent to a model, and only the numbers are read from the file. At most one probe
// runs at a time; the page asks for one when the reading is 25 minutes old, and a press of
// Refresh at most once a minute.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE, CLAUDE_DIR, RUN, TMUX, run, sleep } from './lib.mjs';
import { seatLogin } from './seat.mjs';

export const PROBE_EVERY_MS = 25 * 60e3;
export const MIN_GAP_MS = 60e3;
const SOCKET = ['-L', 'usage'];
const SESSION = 'usage';
const NAME_CAP = 40;

const tmux = (...args) => run(TMUX, [...SOCKET, ...args]);
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : null);
const when = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);

// The reading from a parsed .claude.json, or null when there is none. Only the numbers and
// the reset times are taken; the account's ids and address stay in the file.
export function usageReading(claudeJson) {
  const c = claudeJson?.cachedUsageUtilization;
  const limits = c?.utilization?.limits;
  if (!c || !Array.isArray(limits)) return null;
  const out = { fetchedAtMs: Number.isFinite(c.fetchedAtMs) ? c.fetchedAtMs : null, session: null, week: null, models: [] };
  for (const l of limits) {
    const percent = pct(l?.percent);
    if (percent === null) continue;
    const bucket = { percent, resetsAt: when(l.resets_at) };
    if (l.kind === 'session') out.session = bucket;
    else if (l.kind === 'weekly_all') out.week = bucket;
    else if (l.kind === 'weekly_scoped') {
      const model = l.scope?.model?.display_name;
      if (typeof model === 'string' && model.length > 0 && model.length <= NAME_CAP) out.models.push({ model, ...bucket });
    }
  }
  return out;
}

function readCache() {
  try {
    return JSON.parse(readFileSync(join(CLAUDE_DIR, '.claude.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function readUsage() {
  return usageReading(readCache());
}

// The folder-trust question claude asks in a folder it has not seen: the keys that move the
// marker to "Yes, I trust this folder" and press Enter, or null when it is not asking.
export function trustKeys(screen) {
  if (!/trust this folder/i.test(String(screen ?? ''))) return null;
  const opts = String(screen)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(?:❯\s*)?(?:\d+\.\s*)?(?:Yes|No)\b/.test(l));
  const yes = opts.findIndex((l) => /Yes, I trust this folder/i.test(l));
  if (yes < 0) return null;
  const d = yes - Math.max(0, opts.findIndex((l) => l.startsWith('❯')));
  return [...Array(Math.abs(d)).fill(d > 0 ? 'Down' : 'Up'), 'Enter'];
}

const why = (login) => (login.byOption ? 'by-option' : login.signedIn ? null : 'signed-out');

// One probe: { ok, fresh, error }. error: signed-out / by-option (not started: a token set
// by the option has no usage scope), no-start, login-screen, trust, not-fresh (the reading
// did not move; the old one stays), no-reading.
export async function probeUsage({ settleMs = 8000, pollMs = 2000, deadlineMs = 40000 } = {}) {
  const not = why(seatLogin());
  if (not) return { ok: false, fresh: false, error: not };
  const before = readUsage()?.fetchedAtMs ?? 0;
  const dir = join(RUN, 'usage');
  mkdirSync(dir, { recursive: true });
  await tmux('kill-session', '-t', `=${SESSION}`);
  const cmd = `env CLAUDE_CONFIG_DIR=${sq(CLAUDE_DIR)} ANTHROPIC_API_KEY= ${sq(CLAUDE)} --model haiku`;
  const started = await tmux('new-session', '-d', '-s', SESSION, '-x', '200', '-y', '50', '-c', dir, cmd);
  if (started.code !== 0) return { ok: false, fresh: false, error: 'no-start' };
  const target = `=${SESSION}:`;
  const screen = async () => (await tmux('capture-pane', '-p', '-t', target)).stdout;
  try {
    await sleep(settleMs);
    let text = await screen();
    if (/Select login method|Paste code here|API Usage Billing/i.test(text)) {
      return { ok: false, fresh: false, error: 'login-screen' };
    }
    const keys = trustKeys(text);
    if (keys) {
      await tmux('send-keys', '-t', target, ...keys);
      await sleep(Math.min(settleMs, 4000));
      text = await screen();
      if (/trust this folder/i.test(text)) return { ok: false, fresh: false, error: 'trust' };
    }
    await tmux('send-keys', '-t', target, '/usage', 'Enter');
    for (let waited = 0; waited < deadlineMs; waited += pollMs) {
      await sleep(pollMs);
      const now = readUsage()?.fetchedAtMs ?? 0;
      if (now && now !== before) return { ok: true, fresh: true };
    }
    return readUsage() ? { ok: false, fresh: false, error: 'not-fresh' } : { ok: false, fresh: false, error: 'no-reading' };
  } finally {
    await tmux('kill-session', '-t', `=${SESSION}`);
  }
}

// The page's side: one probe at a time, kept in this process.
let probing = null;
let lastTry = 0;
let lastError = null;

export function usageView() {
  const not = why(seatLogin());
  return { show: !not, why: not, reading: readUsage(), probing: Boolean(probing), error: lastError };
}

// started | running | fresh (the reading is under 25 minutes old) | too-soon (a press within
// a minute of the last probe) | signed-out | by-option. force: a press of Refresh.
export function refreshUsage({ force = false, now = Date.now(), ...timing } = {}) {
  const not = why(seatLogin());
  if (not) return not;
  if (probing) return 'running';
  if (force) {
    if (now - lastTry < MIN_GAP_MS) return 'too-soon';
  } else {
    const at = readUsage()?.fetchedAtMs;
    if (at && now - at < PROBE_EVERY_MS) return 'fresh';
    if (now - lastTry < MIN_GAP_MS) return 'too-soon';
  }
  lastTry = now;
  probing = probeUsage(timing)
    .then((r) => {
      lastError = r.ok ? null : r.error;
    })
    .catch(() => {
      lastError = 'failed';
    })
    .finally(() => {
      probing = null;
    });
  return 'started';
}

// For the tests: wait for the probe running now, if any.
export async function usageDone() {
  if (probing) await probing;
}
