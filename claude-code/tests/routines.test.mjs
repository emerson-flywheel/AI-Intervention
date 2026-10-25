// Routines (0.4.1): named jobs Claude does, defined from the Console as one file each in
// /data/routines, listed on Settings › Routines, run by hand or on a schedule. A scheduled
// or Run-now run is report-only (plan mode); its result is kept for the page.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runNode, sandbox } from './helpers.mjs';

const MORNING = `---
name: Morning health check
description: Reads repairs, the log's errors, unavailable devices and low batteries, and writes a short report.
schedule: daily 07:00
---
Look at Home Assistant's repairs, the log's errors since yesterday, unavailable devices and
batteries under 15%. Give me a short report.
`;

async function routines(sb) {
  return import(`../rootfs/opt/addon-agent/routines.mjs?${Date.now()}${Math.random()}`).then((m) => {
    m.setDirs(sb.data, sb.run);
    return m;
  });
}

function write(sb, id, text) {
  mkdirSync(join(sb.data, 'routines'), { recursive: true });
  writeFileSync(join(sb.data, 'routines', `${id}.md`), text);
}

test('parseSchedule / scheduleLabel: manual, every day, weekdays, one day a week; nothing else', async () => {
  const sb = sandbox();
  const r = await routines(sb);
  assert.deepEqual(r.parseSchedule('manual'), { kind: 'manual' });
  assert.deepEqual(r.parseSchedule('daily 07:00'), { kind: 'daily', hour: 7, minute: 0 });
  assert.deepEqual(r.parseSchedule(' weekdays 18:30 '), { kind: 'weekdays', hour: 18, minute: 30 });
  assert.deepEqual(r.parseSchedule('sun 09:05'), { kind: 'weekly', day: 0, hour: 9, minute: 5 });
  for (const bad of ['', 'daily', 'daily 7', 'daily 24:00', 'daily 07:60', 'hourly', 'sun', 'funday 09:00', '* * * * *', null]) {
    assert.equal(r.parseSchedule(bad), null, JSON.stringify(bad));
  }
  assert.equal(r.scheduleLabel(r.parseSchedule('manual')), 'When I press Run');
  assert.equal(r.scheduleLabel(r.parseSchedule('daily 07:00')), 'Every day 7:00 AM');
  assert.equal(r.scheduleLabel(r.parseSchedule('weekdays 18:30')), 'Weekdays 6:30 PM');
  assert.equal(r.scheduleLabel(r.parseSchedule('sun 00:05')), 'Sundays 12:05 AM');
  sb.cleanup();
});

test('lastSlot / due: the latest scheduled time, run once, and not a stale one after a long stop', async () => {
  const sb = sandbox();
  const r = await routines(sb);
  const at = (s) => new Date(s).getTime();
  const daily = r.parseSchedule('daily 07:00');
  assert.equal(r.lastSlot(daily, at('2026-10-25T07:10:00')), at('2026-10-25T07:00:00'));
  assert.equal(r.lastSlot(daily, at('2026-10-25T06:59:00')), at('2026-10-24T07:00:00'));
  const weekdays = r.parseSchedule('weekdays 07:00');
  assert.equal(r.lastSlot(weekdays, at('2026-10-26T08:00:00')), at('2026-10-26T07:00:00'), 'Monday');
  assert.equal(r.lastSlot(weekdays, at('2026-10-25T08:00:00')), at('2026-10-23T07:00:00'), 'Sunday: Friday\'s');
  const sunday = r.parseSchedule('sun 09:00');
  assert.equal(r.lastSlot(sunday, at('2026-10-31T10:00:00')), at('2026-10-25T09:00:00'));
  assert.equal(r.lastSlot(r.parseSchedule('manual'), Date.now()), null);

  assert.equal(r.due(daily, null, at('2026-10-25T07:00:30')), true, 'never run, inside the slot\'s window');
  assert.equal(r.due(daily, at('2026-10-25T07:00:40'), at('2026-10-25T07:01:00')), false, 'ran for this slot');
  assert.equal(r.due(daily, at('2026-10-24T07:00:10'), at('2026-10-25T07:20:00')), true, 'yesterday\'s run, today\'s slot');
  assert.equal(r.due(daily, at('2026-10-20T07:00:10'), at('2026-10-25T11:00:00')), false, 'over an hour late: skip to the next one');
  assert.equal(r.due(r.parseSchedule('manual'), null, Date.now()), false);
  sb.cleanup();
});

test('listRoutines: each file\'s name, explanation, schedule and last result; a bad file is listed as needing a fix', async () => {
  const sb = sandbox();
  const r = await routines(sb);
  assert.deepEqual(r.listRoutines(), []);
  write(sb, 'morning-health-check', MORNING);
  write(sb, 'broken', '---\nname: \nschedule: whenever\n---\nx\n');
  write(sb, 'not-a-routine.txt', 'ignored');
  mkdirSync(join(sb.data, 'routines', '.results'), { recursive: true });
  writeFileSync(join(sb.data, 'routines', '.results', 'morning-health-check.json'),
    JSON.stringify({ at: 1761390000000, ok: true, summary: '2 things to look at', fixes: 0, report: 'long text' }));
  const list = r.listRoutines();
  assert.deepEqual(list.map((x) => x.id), ['broken', 'morning-health-check']);
  const m = list[1];
  assert.deepEqual(
    { name: m.name, description: m.description, schedule: m.schedule, label: m.scheduleLabel, enabled: m.enabled, running: m.running },
    { name: 'Morning health check', description: "Reads repairs, the log's errors, unavailable devices and low batteries, and writes a short report.",
      schedule: 'daily 07:00', label: 'Every day 7:00 AM', enabled: true, running: false },
  );
  assert.deepEqual(m.last, { at: 1761390000000, ok: true, summary: '2 things to look at', fixes: 0 }, 'the list leaves the report out');
  assert.equal(list[0].problem, 'This routine\'s file needs a name and a schedule (ask Claude to fix it).');
  sb.cleanup();
});

test('setSchedule / setEnabled rewrite only those lines; a bad schedule or id is refused', async () => {
  const sb = sandbox();
  const r = await routines(sb);
  write(sb, 'morning-health-check', MORNING);
  r.setSchedule('morning-health-check', 'weekdays 06:45');
  r.setEnabled('morning-health-check', false);
  const text = readFileSync(join(sb.data, 'routines', 'morning-health-check.md'), 'utf8');
  assert.match(text, /^schedule: weekdays 06:45$/m);
  assert.match(text, /^enabled: false$/m);
  assert.ok(text.endsWith('batteries under 15%. Give me a short report.\n'), 'the instructions untouched');
  assert.equal(r.listRoutines()[0].enabled, false);
  assert.throws(() => r.setSchedule('morning-health-check', 'hourly'), { code: 'bad-schedule' });
  for (const id of ['../x', 'nope', '.results', '']) assert.throws(() => r.setEnabled(id, true), { code: 'no-routine' }, id);
  sb.cleanup();
});

test('runRoutine: claude -p in plan mode on the routine\'s instructions; the result is kept, never the login', async () => {
  const sb = sandbox();
  const r = await routines(sb);
  write(sb, 'morning-health-check', MORNING);
  const argsFile = join(sb.root, 'args.txt');
  process.env.FAKE_ARGS_FILE = argsFile;
  process.env.FAKE_RESULT = 'Summary: 2 things to look at\nFixes waiting: 1\n\n- Kitchen motion sensor unavailable for 9 h.';
  try {
    const result = await r.runRoutine('morning-health-check', { claude: sb.env.CLAUDE_BIN, env: sb.env });
    assert.deepEqual([result.ok, result.summary, result.fixes], [true, '2 things to look at', 1]);
    const args = readFileSync(argsFile, 'utf8');
    assert.match(args, /-p/);
    assert.match(args, /--permission-mode plan/);
    assert.match(args, /--output-format json/);
    const saved = JSON.parse(readFileSync(join(sb.data, 'routines', '.results', 'morning-health-check.json'), 'utf8'));
    assert.equal(saved.summary, '2 things to look at');
    assert.match(saved.report, /Kitchen motion sensor/);
    assert.equal(existsSync(join(sb.run, 'routine-running')), false, 'no run marker left');
    assert.ok(Number.isFinite(saved.at) && Number.isFinite(saved.durationMs));

    process.env.FAKE_RESULT_ERROR = '1';
    const bad = await r.runRoutine('morning-health-check', { claude: sb.env.CLAUDE_BIN, env: sb.env });
    assert.deepEqual([bad.ok, bad.summary], [false, 'The run did not finish. Try Run now again, or run it in the Console.']);
  } finally {
    delete process.env.FAKE_ARGS_FILE;
    delete process.env.FAKE_RESULT;
    delete process.env.FAKE_RESULT_ERROR;
  }
  sb.cleanup();
});

test('routines.mjs tick runs what is due, once, and leaves the rest', async () => {
  const sb = sandbox();
  write(sb, 'morning-health-check', MORNING.replace('daily 07:00', 'daily 00:00'));
  write(sb, 'by-hand', MORNING.replace('daily 07:00', 'manual').replace('Morning health check', 'By hand'));
  const env = { FAKE_RESULT: 'Summary: all fine\nFixes waiting: 0', ADDON_ROUTINE_NOW: String(new Date(new Date().setHours(0, 0, 30, 0)).getTime()) };
  assert.equal((await runNode(sb, 'routines.mjs', { args: ['tick'], env })).code, 0);
  const results = join(sb.data, 'routines', '.results');
  assert.equal(JSON.parse(readFileSync(join(results, 'morning-health-check.json'), 'utf8')).summary, 'all fine');
  assert.equal(existsSync(join(results, 'by-hand.json')), false, 'manual: only Run');
  const before = readFileSync(join(results, 'morning-health-check.json'), 'utf8');
  await runNode(sb, 'routines.mjs', { args: ['tick'], env });
  assert.equal(readFileSync(join(results, 'morning-health-check.json'), 'utf8'), before, 'not twice for one slot');
  sb.cleanup();
});
