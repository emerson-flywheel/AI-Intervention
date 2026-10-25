---
name: ai-intervention
description: Make, change or remove a routine for this Home Assistant app (a named job run by hand or on a schedule, listed on Settings › Routines), and undo a change from the "Snapshot before edits" history. Use when the user says "make a routine", "make this a routine", "change my routine", "run my routine", "apply the fixes from my routine", or "undo your last change".
---

# Routines

A routine is one Markdown file in `/data/routines/`, named by its id (lower case, digits
and hyphens, for example `morning-health-check.md`). The app lists every file there on
Settings › Routines, runs it on its schedule, and shows the last result. Write exactly
this shape:

```
---
name: Morning health check
description: One plain sentence on what it does (shown under the name).
schedule: daily 07:00
---
The instructions, written as the user would ask you: what to look at and what to report.
```

- `schedule` is one of: `manual` (only when the user presses Run), `daily HH:MM`,
  `weekdays HH:MM`, or a day and time such as `sun 09:00` (`sun`..`sat`). 24-hour time,
  Home Assistant's local time. Nothing else is understood.
- Optional `enabled: false` keeps it listed but off the timer.
- Keep `name` under 60 characters and `description` to one sentence.
- After writing it, say: "Saved routine <name> (<schedule in words>). It's in Settings › Routines."
- To change or remove one, edit or delete its file. Never touch `/data/routines/.results/`.

How a routine runs:

- **Run now** and the schedule run it out of sight, report-only (plan mode): it looks and
  reports, and changes nothing. The run is asked to start with `Summary: ...` and
  `Fixes waiting: N`; its report is kept in `/data/routines/.results/<id>.json`.
- **Run in Console** types "Run my routine ..." here: run its instructions step by step and
  ask before each change, as usual.
- **Apply in Console** types "Apply the fixes from the last run of my routine ...": read
  the report from `/data/routines/.results/<id>.json` (its `report` field) and make each
  listed fix, asking before each change.

# Undoing a change (Snapshot before edits)

When Settings › Tools › Snapshot before edits is on, the app saves `/homeassistant` in a
local git history before each file edit you make. Use it with:

```
git --git-dir=/data/ha-history --work-tree=/homeassistant log --oneline -10
git --git-dir=/data/ha-history --work-tree=/homeassistant diff HEAD -- <file>
git --git-dir=/data/ha-history --work-tree=/homeassistant checkout HEAD -- <file>
```

`HEAD` is the state just before your latest edit. Show the user the diff and ask before
restoring a file; then check the config (`ha core check`) and offer to reload.
