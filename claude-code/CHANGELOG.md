# Changelog

## 0.4.0 — 2026-10-25

- **Settings has a menu.** Seat, Console look and Remote console each open on their own,
  with their state beside them in the menu (a row of buttons on a phone). The Console and
  Settings tabs stay as they were.
- **Buttons sit at the bottom right**, the main one (Save, Turn on, Sign in) furthest right.
- **Remote console: off until you ask for it, and set up on the page.** **Enable…** takes
  the other computer's public key and its address; it turns on within a few seconds with
  no restart. Once on, the host key's fingerprint stays hidden until you press **Show**.
  **Reset host key…** makes a new one (it says first what that does to computers that
  already connect), **Remove access** deletes the key and ends any open session, and
  **Turn off** closes the port and keeps the key. The section also shows the last login.
  The `remote_key` / `remote_allow_from` options still work and win while set.

## 0.3.9 — 2026-10-25

- **The Console's text gets the whole width.** No scrollbar down the right (herdr's pane
  scrollbar is off; the wheel or a swipe scrolls), and no empty strip beside it: the
  browser terminal no longer keeps room for a scrollbar of its own, and the page fits it
  again once it has connected. On a phone that is about eight more columns.
- The size box (e.g. "54x52") no longer flashes over the Console when it is resized, as
  when a phone's keyboard opens.
- The remote console's herdr has no scrollbar column either.

## 0.3.8 — 2026-10-25

- **The Console scrolls with a finger** on a phone or tablet (the Home Assistant app,
  Android and iOS). herdr takes the mouse, so the browser terminal ignored touch and a
  swipe did nothing. Now a swipe down goes back through the conversation and a swipe up
  comes forward, as a mouse wheel does. A tap still brings up the keyboard.

## 0.3.7 — 2026-10-22

- **Off-Duty works on a real install.** 0.3.6 looked for Claude by its process name, but
  the app runs Claude Code's npm build, whose process is not called `claude`, so every
  `off` was refused ("it is not at its prompt"). The console loop now records its own
  process id and `off` stops the loop's child, whatever it is called. A sign-in's restart
  of Claude uses the same lookup.
- `off` with no Claude to find now says so (`it found no claude to stop`) instead of
  "not at its prompt".

## 0.3.6 — 2026-10-22

- **Off-Duty for the remote console**: two new agent commands. `off` closes Claude while
  it sits at its prompt, with its conversation saved, and the Console waits Off-Duty
  (no shell); `on`, or Enter on the Console, brings the same conversation back. A remote
  dashboard can use them to rest a console that has had no reply for a while.

## 0.3.5 — 2026-10-19

- **Model versions** on the Settings tab: Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1,
  saved by their full ids, so the version shown is the one that runs. A model set with
  `/model` shows by its version too; a short name saved before (`opus`) is kept and
  shows as *Opus (newest)*.
- **Plan usage** on the Settings tab: bars for the 5-hour session, the week and any
  model's own week, with percent and reset time, the same numbers as Claude's `/usage`.
  Read when Settings opens and the last reading is 25 minutes old, or on Refresh.
- The remote console's ssh server no longer logs "Unsupported option PrintLastLog" at
  start (the app's Alpine build has no lastlog, so the line did nothing).

## 0.3.4 — 2026-10-19

- **Console theme** on the Settings tab: herdr's 17 built-in themes (dark and light),
  each with matching terminal colours, or the app's own look (the default, unchanged).
  The Console reconnects with it in a few seconds; Claude keeps running.
- **Console font size**: 12 to 20 px (13 px is ttyd's default).
- **Remote console** on the Settings tab: on or off (and why), the addresses it takes,
  and the host key's fingerprint to pin on the other computer.
- The Console's own page title says AI Intervention (it still said Claude Code).

## 0.3.3 — 2026-10-19

- **Renamed to AI Intervention** (store, sidebar and page title). It still runs Claude
  Code; the app's id is unchanged, so an installed copy updates in place.
- **Permission mode moved to the Settings tab**, next to Model and Thinking. Save writes
  it into Claude Code's own settings file. Set it again after updating: the old option's
  value is not carried over.
- **The seat name option is gone.** The name on the Settings tab is the seat, and its
  short id for a remote console (*Home Office* is `home-office`; no name is `claude`).

## 0.3.2 — 2026-10-19

- **Provider is a list**: Anthropic (Claude Code) is picked. OpenAI and Grok are listed
  but greyed out ("coming later"): the app does not run them yet.

## 0.3.1 — 2026-10-19

- **The Seat tab is now Settings**, with a **Seat(s)** section. The seat's row reads
  "Seat", its name, and Signed in (plan, since when) or Signed out, on one line.
- **Name the seat**: any name, kept in the app's own folder.
- **Provider** shown: Anthropic (Claude Code), the only one the app runs.
- **Model and thinking level** shown and changeable from the seat. Save writes them to
  Claude Code's own settings file (the one `/model` and `/effort` write), keeps every
  other setting there, and starts Claude in the Console again with the conversation kept.

## 0.3.0 — 2026-10-18

First version shared as an app repository.

- **Install from a repository link** with a ready-made image (amd64 and aarch64), in
  place of copying files into `/addons` and building on the box.
- **New option `start_folder`**: where Claude starts (empty = `/homeassistant`).
- **Seat**: a first start says "Not signed in yet." ("The login ran out." stays for an
  expired login). With no clipboard (Home Assistant on plain `http://`), **Copy the
  link** shows the link in a box, selected.
- **Remote console** (advanced, off by default): the options are now `remote_key` and
  `remote_allow_from`; the addresses the key may log in from are yours to set (names
  and `/0` are refused). `seat_name` defaults to `claude`.
- Docs (the Documentation tab), option labels, an MIT licence, and checks on every
  change: the tests, Home Assistant's app linter and a secret scan.

## 0.2.0 — 2026-10-18

- **herdr replaces tmux for the console.** herdr 0.9.3 is pinned and its sha256 is
  checked at build time. One herdr server holds one workspace whose pane runs Claude;
  any other workspace is closed. When Claude exits you get a shell, and Claude after it.
- **Console and Seat tabs.** A small Node server (no npm dependencies) takes the
  ingress port and proxies the Console to ttyd on `127.0.0.1:7682`.
- **Seat: sign in from the browser.** Shows signed in / sign in needed, the plan and
  when. **Sign in at claude.ai ↗** opens the checked link; paste the code and Claude
  starts again on the new login with `--continue`. The link is checked on both sides
  and fails closed. Only the token's length is ever read.
- **A remote console key** over ssh (port 2248), off unless a key is set: forced into
  the app's agent, no forwarding, no shell.
- ttyd 1.7.7 is pinned by sha256 for both arches (Claude Code from npm stays unpinned on
  purpose, so each build takes Claude's own fixes).

## 0.1.5 — 2026-06-06

- **Auto-resume on restart**: Claude starts with `--continue` when a conversation exists.

## 0.1.4 — 2026-06-06

- **Persistent session** in `tmux`: leaving the panel detaches instead of restarting.

## 0.1.3 — 2026-06-06

- `permission_mode` (`default` / `acceptEdits` / `plan`) replaces `skip_permissions`;
  the terminal drops to a shell when Claude exits.

## 0.1.0 – 0.1.2 — 2026-06-05

- First version: Claude Code as an ingress web terminal with full admin reach;
  start-up fixes (`with-contenv` in place of `bashio`, stray CR stripped).
