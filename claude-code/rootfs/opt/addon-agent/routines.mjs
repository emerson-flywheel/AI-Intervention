// Routines: named jobs Claude does, one file each in /data/routines/<id>.md, written by
// Claude in the Console (the routines skill shows it the format):
//
//   ---
//   name: Morning health check
//   description: One line on what it does, shown on Settings › Routines.
//   schedule: daily 07:00        (manual | daily HH:MM | weekdays HH:MM | sun..sat HH:MM)
//   enabled: true                (optional; false keeps it listed but never on a timer)
//   ---
//   The instructions, as you would type them to Claude.
//
// Run now and the schedule run it out of sight with `claude -p` in plan mode, so a run
// only looks and reports; anything it would change waits for "Apply in Console". Its
// result is kept in /data/routines/.results/<id>.json. One run at a time.
//   node routines.mjs tick   runs what is due (the page server calls it every 30 s)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE, DATA, RUN } from './lib.mjs';

let dirs = { data: DATA, run: RUN };
// The tests point it at a sandbox.
export function setDirs(data, run) {
  dirs = { data, run };
}
const folder = () => join(dirs.data, 'routines');
const results = () => join(folder(), '.results');
const RUNNING = 'routine-running';

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAMES = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
// A slot more than an hour old is not run late (the app was stopped): the next one is.
const LATE_MS = 60 * 60e3;
const RUN_CAP_MS = Number(process.env.ADDON_ROUTINE_CAP_MS) || 15 * 60e3;
const TEXT_CAP = 200;
const REPORT_CAP = 64 * 1024;

export class RoutineError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function parseSchedule(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim().toLowerCase();
  if (t === 'manual') return { kind: 'manual' };
  const m = t.match(/^(daily|weekdays|sun|mon|tue|wed|thu|fri|sat) ([01]\d|2[0-3]):([0-5]\d)$/);
  if (!m) return null;
  const at = { hour: Number(m[2]), minute: Number(m[3]) };
  if (m[1] === 'daily' || m[1] === 'weekdays') return { kind: m[1], ...at };
  return { kind: 'weekly', day: DAYS.indexOf(m[1]), ...at };
}

function clock({ hour, minute }) {
  const h = hour % 12 || 12;
  return `${h}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

export function scheduleLabel(s) {
  if (!s || s.kind === 'manual') return 'When I press Run';
  if (s.kind === 'daily') return `Every day ${clock(s)}`;
  if (s.kind === 'weekdays') return `Weekdays ${clock(s)}`;
  return `${DAY_NAMES[s.day]} ${clock(s)}`;
}

// The latest scheduled time at or before now (local time), or null for manual.
export function lastSlot(s, now) {
  if (!s || s.kind === 'manual') return null;
  const d = new Date(now);
  d.setHours(s.hour, s.minute, 0, 0);
  if (d.getTime() > now) d.setDate(d.getDate() - 1);
  for (let i = 0; i < 8; i++) {
    const day = d.getDay();
    if (s.kind === 'daily' || (s.kind === 'weekdays' && day >= 1 && day <= 5) || (s.kind === 'weekly' && day === s.day)) {
      return d.getTime();
    }
    d.setDate(d.getDate() - 1);
  }
  return null;
}

// Due: a slot has passed since the last run, and it is not over an hour old.
export function due(s, lastRunAt, now) {
  const slot = lastSlot(s, now);
  if (slot === null || now - slot > LATE_MS) return false;
  return !(Number.isFinite(lastRunAt) && lastRunAt >= slot);
}

const fileOf = (id) => join(folder(), `${id}.md`);

function checkId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id) || !existsSync(fileOf(id))) throw new RoutineError('no-routine');
  return id;
}

// The front matter's plain "key: value" lines and the instructions after it.
function parse(text) {
  const m = String(text).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: m[2].trim() };
}

const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, TEXT_CAP);

function readResult(id) {
  try {
    return JSON.parse(readFileSync(join(results(), `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

export function readRoutine(id) {
  checkId(id);
  const p = parse(readFileSync(fileOf(id), 'utf8'));
  const schedule = parseSchedule(p?.meta.schedule);
  const name = clean(p?.meta.name);
  return {
    id,
    name: name || id,
    description: clean(p?.meta.description),
    schedule: schedule ? p.meta.schedule.trim().toLowerCase() : null,
    scheduleLabel: scheduleLabel(schedule),
    enabled: p?.meta.enabled !== 'false',
    instructions: p?.body || '',
    ...(!p || !name || !schedule || !p.body ? { problem: "This routine's file needs a name and a schedule (ask Claude to fix it)." } : {}),
  };
}

// What Settings › Routines lists: every routine with its last result (the report itself
// stays in its file; the page asks for it).
export function listRoutines() {
  let names = [];
  try {
    names = readdirSync(folder()).filter((f) => f.endsWith('.md') && ID_RE.test(f.slice(0, -3))).sort();
  } catch {}
  const running = readRunning();
  return names.map((f) => {
    const { instructions, ...r } = readRoutine(f.slice(0, -3));
    const last = readResult(r.id);
    return {
      ...r,
      running: running === r.id,
      last: last ? { at: last.at, ok: last.ok, summary: last.summary, fixes: last.fixes } : null,
    };
  });
}

function rewrite(id, key, value) {
  const file = fileOf(checkId(id));
  const text = readFileSync(file, 'utf8');
  const p = text.match(/^---\n([\s\S]*?)\n---/);
  if (!p) throw new RoutineError('no-routine');
  const lines = p[1].split('\n');
  const at = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (at >= 0) lines[at] = `${key}: ${value}`;
  else lines.push(`${key}: ${value}`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `---\n${lines.join('\n')}\n---${text.slice(p[0].length)}`);
  renameSync(tmp, file);
}

export function setSchedule(id, schedule) {
  if (!parseSchedule(schedule)) throw new RoutineError('bad-schedule');
  rewrite(id, 'schedule', schedule.trim().toLowerCase());
}

export function setEnabled(id, enabled) {
  rewrite(id, 'enabled', enabled ? 'true' : 'false');
}

function readRunning() {
  try {
    const [id, pid] = readFileSync(join(dirs.run, RUNNING), 'utf8').trim().split(' ');
    process.kill(Number(pid), 0);
    return id;
  } catch {
    return null;
  }
}

// The run's text: "Summary: ..." and "Fixes waiting: N" lines (the prompt asks for them),
// else the first line.
export function readOutcome(text) {
  const t = String(text ?? '');
  const summary = t.match(/^\s*Summary:\s*(.+)$/im)?.[1] || t.split('\n').find((l) => l.trim()) || '';
  const fixes = Number(t.match(/^\s*Fixes waiting:\s*(\d+)/im)?.[1] ?? 0);
  return { summary: clean(summary), fixes: Number.isFinite(fixes) ? fixes : 0 };
}

const FAILED = 'The run did not finish. Try Run now again, or run it in the Console.';

function prompt(r) {
  return [
    `Run the routine "${r.name}" now. This is a report-only run: look and report, change nothing.`,
    'Start your answer with one line "Summary: <one short sentence>", then one line "Fixes waiting: <number>"',
    '(the number of changes you would make), then the report. List each fix you would make so it can be applied later.',
    '',
    r.instructions,
  ].join('\n');
}

// Run a routine out of sight, report-only, and keep its result. Resolves with the result.
export async function runRoutine(id, { claude = CLAUDE, env = {}, cwd } = {}) {
  const r = readRoutine(id);
  if (r.problem) throw new RoutineError('bad-routine');
  if (readRunning()) throw new RoutineError('busy');
  mkdirSync(dirs.run, { recursive: true });
  writeFileSync(join(dirs.run, RUNNING), `${id} ${process.pid}\n`);
  const started = Date.now();
  let out = '';
  try {
    out = await new Promise((resolve) => {
      const child = spawn(claude, ['-p', prompt(r), '--permission-mode', 'plan', '--output-format', 'json'], {
        cwd: cwd || (existsSync('/homeassistant') ? '/homeassistant' : dirs.data),
        env: { ...process.env, CLAUDE_CONFIG_DIR: join(dirs.data, 'claude'), ...env },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let buf = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), RUN_CAP_MS);
      child.stdout.on('data', (d) => {
        if (buf.length < REPORT_CAP * 4) buf += d;
      });
      child.on('error', () => resolve(''));
      child.on('close', () => {
        clearTimeout(timer);
        resolve(buf);
      });
    });
  } finally {
    rmSync(join(dirs.run, RUNNING), { force: true });
  }
  let res = null;
  try {
    res = JSON.parse(out.trim().split('\n').pop());
  } catch {}
  const ok = Boolean(res) && res.is_error === false && typeof res.result === 'string' && res.result.trim() !== '';
  const outcome = ok ? readOutcome(res.result) : { summary: FAILED, fixes: 0 };
  const result = {
    at: started,
    durationMs: Date.now() - started,
    ok,
    ...outcome,
    report: ok ? res.result.slice(0, REPORT_CAP) : '',
  };
  mkdirSync(results(), { recursive: true });
  const file = join(results(), `${id}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(result));
  renameSync(`${file}.tmp`, file);
  return result;
}

export function readReport(id) {
  checkId(id);
  return readResult(id);
}

// Run each routine that is due and turned on, one after another; onResult(routine, result)
// after each (the server sends it to Telegram).
export async function tick(now = Date.now(), onResult = () => {}) {
  for (const r of listRoutines()) {
    if (!r.enabled || r.problem || r.running) continue;
    if (due(parseSchedule(r.schedule), r.last?.at ?? null, now)) {
      await runRoutine(r.id).then((result) => onResult(r, result)).catch(() => {});
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'tick') {
  await tick(Number(process.env.ADDON_ROUTINE_NOW) || Date.now());
}
