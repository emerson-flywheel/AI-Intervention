# Changelog

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
