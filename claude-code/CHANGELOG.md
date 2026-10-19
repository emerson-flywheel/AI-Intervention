# Changelog

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
