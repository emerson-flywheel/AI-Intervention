---
name: ai-intervention
description: Make, change or remove a routine for this Home Assistant app (a named job run by hand or on a schedule, listed on Settings › Routines), add a tool (an MCP server or a script, listed on Settings › Tools), and undo a change from the "Snapshot before edits" history. Use when the user says "make a routine", "make this a routine", "change my routine", "run my routine", "apply the fixes from my routine", "add a tool", "give yourself a tool for ...", "connect to <service>", or "undo your last change".
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

# Tools

A tool is one JSON file in `/data/tools/`, named by its id (lower case, digits and hyphens,
for example `restart-zigbee.json`). The app lists every file there under Settings › Tools ›
Added by Claude. **A new tool is off**: only the user can switch it on, on that page, and
the app then starts you again with it. You cannot switch it on yourself; never edit
`/data/claude/settings.json`, `/data/claude/addon-mcp.json` or `/data/claude/addon-tools.json`
to get around that. Write exactly one of these shapes:

An MCP server the app starts:

```
{
  "name": "Weather service",
  "description": "One plain sentence on what it gives you and why.",
  "kind": "mcp",
  "config": { "command": "npx", "args": ["-y", "some-mcp-server"], "env": { "API_KEY": "..." } }
}
```

An MCP server reached by URL: `"config": { "type": "http", "url": "https://...", "headers": { ... } }`
(`"type": "sse"` for an SSE server).

A script you may then run without asking:

```
{
  "name": "Restart Zigbee",
  "description": "Restarts the Zigbee add-on when devices stop answering.",
  "kind": "script",
  "config": { "file": "restart-zigbee.sh" }
}
```

- The script lives next to its file, in `/data/tools/` (here `/data/tools/restart-zigbee.sh`),
  and must be executable. Switched on, it is allowed as `Bash(/data/tools/restart-zigbee.sh:*)`:
  run it by that full path.
- Keep `name` under 60 characters and `description` to one or two sentences (400 characters
  at most). `env` names are letters, digits and underscores.
- Ask the user before writing a key or password into `env` or `headers`; the page never
  shows those values.
- After writing it, say: "Added the tool <name>. Switch it on in Settings › Tools when you
  want me to use it."
- To change one, edit its file: the page then says it changed, and the old version stays in
  use until the user switches it on again. To remove one, delete its file (and its script).

# Permission levels

The user picks one in Settings › Seat(s): **Training wheels** (plan mode, read only),
**Co-pilot** (asks before each change and command), **Autopilot** (edits without asking,
asks before commands) or **Jarvis mode** (edits and runs commands without asking; Snapshot
before edits stays on). Never change the level yourself; when a job needs a different one,
say so and let the user pick it.

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
