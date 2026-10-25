# AI Intervention

Claude Code, the official one, in your Home Assistant.

## Install

1. Settings › Apps › Install app › ⋮ › **Repositories**, add this app's repository, and
   close the dialog.
2. Find **AI Intervention** in the list, then **Install** and **Start**. Turn on
   **Show in sidebar**.
3. Open it from the sidebar.

You need Home Assistant OS or Supervised (anything with Apps), on a 64-bit Intel/AMD
(amd64) or ARM (aarch64) box, and a Claude Pro or Max plan.

## Sign in (the Settings tab)

1. Open the **Settings** tab and, in **Seat(s)**, press **Sign in at claude.ai ↗**. A new
   tab opens on claude.ai (allow pop-ups for Home Assistant if your browser asks).
2. Sign in there with the account that has your Pro or Max plan, then press
   **Copy Code**.
3. Back in the Settings tab, paste the code and press **Sign in**.

Claude in the Console then starts again on the new login and carries on the last
conversation. The login is kept in the app's own folder and stays through restarts and
updates. A sign-in that is started and not finished stops by itself after 15 minutes and
never touches the login you already have. Signing in from the Console (`claude`, then
`/login`) works too.

Signed in to the wrong Google account in this browser? Press **Copy the link** and open
it in a private window. If your Home Assistant is on plain `http://`, browsers give the
page no clipboard, so the link is shown in a box, already selected, for you to copy.

The seat says **The login ran out.** when the login has expired and can no longer renew
itself; sign in again from there.

## The seat (Settings › Seat(s))

The seat is the Claude login this app uses. Its row reads **Seat**, the seat's name, and
**Signed in** (with the plan and since when) or **Signed out**.

**Plan usage** (signed in at claude.ai): a bar for the 5-hour session, one for the week
across all models, and one for any model with its own weekly limit, each with its percent
and when it resets. A bar turns amber at 75% and red at 100%. The numbers are the ones
Claude's own `/usage` shows: when you open Settings and the last reading is over 25
minutes old, the app opens Claude out of sight, runs `/usage`, and closes it again (about
15 seconds; no message is sent to a model). **Refresh** reads it again, at most once a
minute. A login set by the `oauth_token` option has no plan usage to show.

Under it:

- **Name**: any name you like, up to 40 characters (for example *Home*). It is kept in
  the app's own folder. It is also the seat's short id for a remote console, in lower
  case with spaces as hyphens (*Home Office* is `home-office`). Until you set one, the
  seat is called `claude`.
- **Provider**: a list with **Anthropic** (Claude Code) picked. OpenAI and Grok are in
  the list but greyed out ("coming later"): Anthropic is the only one this app runs today.
- **Model**: *Default* (your plan picks), Opus 5.5, Sonnet 5.5, Haiku 5.5 or Fable 5.1.
  Each is saved by its full id, so the version shown is the one that runs. A model you
  chose in the Console with `/model` shows here too, by its version; a short name such
  as `opus` (saved by version 0.3.4 or earlier) shows as *Opus (newest)*.
- **Thinking**: *Default*, Low, Medium, High or Extra high (Claude Code's effort level).
  `max` lasts one session only in Claude Code, so it is not offered here.
- **Permission mode**: *Default* asks before every action (start here). *Accept edits*
  applies file edits by itself and still asks before commands. *Plan* only reads and
  proposes. The app runs as root, where Claude Code blocks its fully-unattended modes, so
  they are not offered.

**Save** writes the model, thinking level and permission mode into Claude Code's own
settings file (`/data/claude/settings.json`, the same file `/model`, `/effort` and
`/permissions` in the Console write) and keeps every other setting in it. When any of the
three changed, Claude in the Console starts again on them and carries on the
conversation. A new name alone changes nothing in the Console. They can be set before
you sign in; they apply from the first start after.

One seat for now: the section is ready for more, and for other providers (OpenAI, Grok),
but each needs its own program and sign-in in the app first.

The sign-in link is checked twice (by the app and again in the page) before any tab is
sent to it: it must be claude.ai's (or claude.com's) sign-in page for Claude Code, with
Claude's own return address and PKCE, and only the scopes Claude Code asks for today. If
a future Claude Code asks for more, the sign-in stops with a plain message and nothing
changes; update the app (or sign in from the Console) then.

## The Console

- Claude runs in a [herdr](https://github.com/herdrdev/herdr) console. Leaving the page
  detaches; coming back attaches to the same running Claude.
- **Scrolling back**: the mouse wheel, or on a phone or tablet a finger swipe (down to go
  back, up to come forward). There is no scrollbar, so the text uses the full width.
  Tap the Console to type.
- After an app restart Claude resumes the last conversation (`--continue`).
- When Claude exits you get a shell; leave it (`exit`) and Claude starts again.
- **Its look** (Settings › Console): a theme and a font size. The themes are herdr's own
  (Catppuccin, Tokyo Night, Dracula, Nord, Gruvbox, One, Solarized, Kanagawa, Rosé Pine,
  Vesper, with light versions), each with matching terminal colours; *AI Intervention
  (default)* is the app's own look. Save writes `/data/look.json`, and the Console
  reconnects with the new look within a few seconds. Claude keeps running and the
  conversation stays. A remote console's herdr takes the theme from its next attach.

## Options

| Option | Default | What it does |
|---|---|---|
| `start_folder` | empty | The folder Claude starts in, for example a folder of your own notes and a `CLAUDE.md` under `/share`. Empty starts in `/homeassistant`. Your config stays editable either way (`--add-dir /homeassistant`). |
| `oauth_token` | empty | Optional. A token from `claude setup-token` on another computer, to skip the sign-in. It does not renew itself, so the sign-in in Settings is recommended. The seat then shows "Signed in by the oauth_token option". |
| `remote_key` | empty | Advanced, see below. One `ssh-ed25519` public key line. Empty keeps the port closed. |
| `remote_allow_from` | empty | Advanced, see below. The address(es) the key may log in from. |

## What Claude can reach

- `SUPERVISOR_TOKEN` in its environment, for the Core API
  (`http://supervisor/core/api/...`) and the Supervisor API (`http://supervisor/...`):
  `curl -H "Authorization: Bearer $SUPERVISOR_TOKEN" http://supervisor/core/api/states`
- Read-write: `/homeassistant` (your live config), `/addons` (local apps), `/config`
  (this app's own folder), `/ssl`, `/share`, `/media`, `/backup`.
- The `ha` command (`ha core check`, `ha core logs`, ...), `git`, `curl`, `jq`, `node`.

A good first question: "List my unavailable entities and tell me which ones are dead
hardware."

## Remote console (advanced, off by default)

For driving the console from another machine (for example a dashboard of your own
Claude consoles). Leave both options empty and the port stays closed.

- Set `remote_key` to one `ssh-ed25519` public key line and `remote_allow_from` to the
  address or network it logs in from (`192.168.1.20`, `192.168.1.0/24`, or several,
  comma-separated; names and `/0` are refused). Map the port under Network (2248 by
  default) and restart. Anything else is refused, the log says why, and the port stays
  closed.
- The key is written as the only line of `/data/ssh/authorized_keys`:
  `from="<your addresses>",restrict,pty,command="node /opt/addon-agent/agent.mjs" <key>`.
  No forwarding of any kind, keys only, and every login runs the app's agent whatever
  command was asked for. There is no shell.
- The host key is made once in `/data/ssh/` and kept; the log prints its fingerprint at
  start, and Settings › Remote console shows it (with whether the port is open and from
  where), so the remote side can pin it. Installing the app again makes a new one.
- The agent answers these commands (one per login, as the ssh command): `snapshot`,
  `type <console>` (the line on stdin), `interrupt <console>`, `history <console>`,
  `attach <console>`, `off <console>`, `on <console>`, `seats`, `seat-login <seat>`,
  `seat-code <seat>` (the code on stdin), `seat-status <seat>`, `seat-signout <seat>`,
  `seat-use <seat>`. The console is called `claude`. Answers are one JSON line; a refusal
  is one line on stderr (`workspace-agent: refused: <words>`) with exit 2 (bad request) or
  3 (wrong state).
- `off` puts the console Off-Duty. Only while Claude sits at its prompt (no turn running,
  no dialog): Claude exits with its conversation saved, and the Console shows Off-Duty with
  no shell. `on`, or Enter on the Console, starts Claude again with `--continue`, so the
  same conversation comes back. While it is Off-Duty, `type` is refused and `snapshot`
  gives state `off` with `since`. The remote side decides when (for example after a while
  with no reply); the app never goes Off-Duty by itself.
- `attach` is a herdr client with every herdr key unbound, so it cannot open a
  workspace, tab, pane or shell. While it is attached, Claude exiting offers no shell
  (only Enter to start Claude again).

## Updating

New versions show in Settings › Apps like any app. The login and conversations stay.
The image is ready-made, so an update takes about a minute.

## Safety and the rules of use

- This uses **your own** Claude plan through the **official** Claude Code, interactively.
  Keep it supervised; don't turn it into an always-on autonomous service.
- The page answers only Home Assistant's ingress proxy. The sign-in code and the login's
  token are never logged, shown or written anywhere but Claude's own login file; only the
  token's length is read, to tell signed in from signed out.
- This app has **root-level control of your smart home and its host.** Treat access to
  your Home Assistant, and any remote key, accordingly.

Not affiliated with Anthropic or Home Assistant.
